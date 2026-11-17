#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pymupdf>=1.26,<2"]
# ///
"""Extract and typeset Chinese translations without rewriting the source PDF."""

import json
import os
import re
import statistics
import sys
from pathlib import Path

import pymupdf as fitz

FONT = fitz.Font("china-s")
# Preserve displayed formulas, page labels, author metadata and numeric table cells.
MATH_FONT = re.compile(r"(?:CMSY|CMEX|CMMI|MSAM|MSBM|Math|MTMI|Mathematica)", re.I)
REFERENCE_START = re.compile(r"^\s*(?:\d+\.?\s+)?(?:References|Bibliography|Works Cited)\s*$", re.I)
APPENDIX_START = re.compile(r"^\s*(?:Appendix\b|[A-Z][.\s]+(?:Supplementary|Additional)\b)", re.I)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, data):
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def line_text(line):
    return "".join(span["text"] for span in line["spans"]).strip()


def translatable(line):
    text = line_text(line)
    if not text or abs(line["dir"][1]) > 0.05 or not re.search(r"[A-Za-zÀ-ÖØ-öø-ÿ]{2}", text):
        return False
    if re.match(r"^(?:https?://|www\.|arXiv:|doi:|©|\S+@\S+)", text, re.I):
        return False
    words = re.findall(r"\b[A-Za-z]{2,}\b", text)
    math_chars = sum(len(s["text"]) for s in line["spans"] if MATH_FONT.search(s["font"]))
    if len(words) < 4 and (math_chars > 0 or re.search(r"[=∑∫√≈≤≥→]|\([0-9]+\)$", text)):
        return False
    return not (math_chars > max(4, len(text) * 0.33) and len(words) < 6)


def join_lines(lines):
    text = ""
    for line in lines:
        value = line_text(line)
        if text.endswith("\u00ad"):
            text = text[:-1] + value
        elif re.search(r"[a-z]{3}-$", text) and re.match(r"[a-z]{3}", value):
            text += value
        else:
            text += (" " if text else "") + value
    return text


def block_groups(page, in_references):
    # Native text order keeps most columns together; geometry reconnects lines
    # split into separate PDF blocks without joining columns or distant rows.
    blocks = page.get_text("dict", flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)["blocks"]
    units, group = [], []

    def flush():
        if not group:
            return
        rect = fitz.Rect(group[0]["bbox"])
        for line in group[1:]:
            rect |= fitz.Rect(line["bbox"])
        sizes = [span["size"] for line in group for span in line["spans"] if span["text"].strip()]
        text = join_lines(group)
        if sizes and rect.width > 14 and rect.height > 4 and rect in page.rect:
            units.append({"text": text, "box": list(rect), "size": statistics.median(sizes),
                          "parts": [list(line["bbox"]) for line in group]})
        group.clear()

    for block in blocks:
        if block["type"] != 0:
            flush()
            continue
        for line in block["lines"]:
            text = line_text(line)
            if REFERENCE_START.fullmatch(text):
                flush()
                in_references = True
                group.append(line)
                flush()
                continue
            if APPENDIX_START.match(text):
                in_references = False
            if in_references or not translatable(line):
                flush()
                continue
            if group:
                prior = group[-1]
                prev, cur = fitz.Rect(prior["bbox"]), fitz.Rect(line["bbox"])
                prev_size, cur_size = prior["spans"][0]["size"], line["spans"][0]["size"]
                if (not prev.y0 + prev_size * .55 < cur.y0 <= prev.y1 + prev_size * .7
                    or abs(cur.x0 - prev.x0) > max(10, prev_size * 1.6)
                    or abs(prev_size - cur_size) > max(0.8, prev_size * .12)
                    or (prev.width < cur.width * .56 and line_text(prior).endswith((".", "!", "?")))):
                    flush()
            group.append(line)
    flush()
    return units, in_references


def open_source(path):
    doc = fitz.open(path)
    if not doc.is_pdf or doc.needs_pass or not doc.page_count:
        doc.close()
        raise ValueError("PDF 无法读取、没有页面或需要密码")
    return doc


def extract(source, destination):
    with open_source(source) as doc:
        pages = []
        in_references = False
        for index, page in enumerate(doc):
            if page.rotation:
                page.remove_rotation()
            units, in_references = block_groups(page, in_references)
            for ordinal, unit in enumerate(units):
                unit["id"] = f"p{index + 1}b{ordinal + 1}"
            pages.append({"units": units, "width": page.rect.width, "height": page.rect.height})
        if not any(page["units"] for page in pages):
            raise ValueError("找不到可翻译的文本层；扫描版请先做 OCR")
        write_json(destination, {"pages": pages})


WORDS = re.compile(r"(?:[\x21-\x7e]+|[^\s])[，。！？；：、）》】」』”’]*|\s+")


def wrap(text, width, size):
    lines = []
    for paragraph in text.splitlines():
        line = ""
        for word in WORDS.findall(paragraph):
            if not line and word.isspace():
                continue
            if FONT.text_length(line + word, fontsize=size) <= width:
                line += word
                continue
            if line.strip():
                lines.append(line.rstrip())
            line = ""
            if word.isspace():
                continue
            while FONT.text_length(word, fontsize=size) > width and len(word) > 1:
                split = 1
                while split < len(word) and FONT.text_length(word[:split + 1], fontsize=size) <= width:
                    split += 1
                lines.append(word[:split])
                word = word[split:]
            line = word
        if line.strip():
            lines.append(line.rstrip())
    return lines


def draw_text(page, box, lines, size, color=(0.08, 0.08, 0.08)):
    writer = fitz.TextWriter(page.rect)
    for n, line in enumerate(lines):
        writer.append((box.x0, box.y0 + size * (0.97 + n * 1.15)), line, font=FONT, fontsize=size)
    writer.write_text(page, color=color)


def fit_text(text, box, original_size):
    size = min(26, max(6, original_size * 0.95))
    min_size = min(size, max(6, original_size * 0.63))
    while True:
        lines = wrap(text, box.width, size)
        if lines and size * (1.15 * len(lines) + 0.08) <= box.height:
            return lines, size
        if size <= min_size:
            return None
        size = max(size - 0.35, min_size)


def render(source, plan_file, translation_file, output_file, map_file):
    plan = read_json(plan_file)
    translations = read_json(translation_file)
    with open_source(source) as src, fitz.open() as out:
        if len(plan["pages"]) != len(src):
            raise ValueError("PDF 页数与翻译计划不符")
        # Copy the vector page, but never carry over embedded links, annotations or forms.
        out.insert_pdf(src, links=False, annots=False, widgets=False)
        page_map = [{"source": i} for i in range(len(src))]
        supplements = []
        for index, spec in enumerate(plan["pages"]):
            page = out[index]
            if page.rotation:
                page.remove_rotation()
            replacements = []
            for unit in spec["units"]:
                text = translations[unit["id"]]
                rect = fitz.Rect(unit["box"])
                fit = fit_text(text, rect, unit["size"])
                if not fit:
                    label = len(supplements) + 1
                    supplements.append((index, unit, text))
                    fit = fit_text(f"见补译 {label}", rect, unit["size"])
                if fit:
                    for part in unit["parts"]:
                        line = fitz.Rect(part)
                        # Only intersect the center of this text line, not adjacent ascenders.
                        line.y0 += line.height * 0.28
                        line.y1 -= line.height * 0.28
                        page.add_redact_annot(line, fill=False, cross_out=False)
                    replacements.append((rect, *fit))
            if replacements:
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                                      graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                                      text=fitz.PDF_REDACT_TEXT_REMOVE)
                for rect, lines, size in replacements:
                    draw_text(page, rect, lines, size)
        for label, (index, unit, text) in enumerate(supplements, 1):
            target = len(out)
            spec = plan["pages"][index]
            box = fitz.Rect(unit["box"])
            page_map_entry = {"source": index, "supplement": label,
                              "x": box.x0 / spec["width"], "y": box.y0 / spec["height"],
                              "w": box.width / spec["width"], "h": box.height / spec["height"]}
            lines = wrap(text, 488, 11)
            stride = 49
            for start in range(0, len(lines), stride):
                page = out.new_page(width=560, height=735)
                draw_text(page, fitz.Rect(36, 30, 524, 52), [f"补译 {label}  ·  原文第 {index + 1} 页"], 13)
                page.draw_line((36, 55), (524, 55), color=(0.8, 0.8, 0.8), width=0.5)
                draw_text(page, fitz.Rect(36, 70, 524, 708), lines[start:start + stride], 11)
                page_map.append(page_map_entry)
            out[index].insert_link({"kind": fitz.LINK_GOTO, "from": box, "page": target, "to": fitz.Point(0, 0)})
        out.set_metadata({"title": "中文译文", "subject": "GPT-6-Luna translation", "creator": "Codex for Zotero"})
        # MuPDF's font subsetting keeps the embedded CJK font compact and searchable.
        out.subset_fonts()
        out.save(output_file, garbage=4, deflate=True)
    os.chmod(output_file, 0o600)
    with fitz.open(output_file) as verified:
        if verified.page_count != len(page_map):
            raise ValueError("译文 PDF 输出未通过页数校验")
    write_json(map_file, {"sourcePages": len(plan["pages"]), "pages": page_map})


if __name__ == "__main__":
    try:
        operation, *args = sys.argv[1:]
        {"extract": extract, "render": render}[operation](*args)
    except Exception as error:
        sys.exit(str(error))
