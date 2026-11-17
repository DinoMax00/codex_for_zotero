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
import hashlib
from functools import lru_cache
from glob import glob
import sys
from pathlib import Path

import pymupdf as fitz

LAYOUT_VERSION = 4
MAP_NAME = "codex-for-zotero-translation.json"
LEADING = 1.24


@lru_cache(maxsize=1)
def font():
    # The bundled macOS UI subset contains only a handful of Chinese glyphs.
    system = "/System/Library/AssetsV2"
    candidates = [*glob(f"{system}/com_apple_MobileAsset_Font*/**/Kaiti.ttc", recursive=True),
                  *glob(f"{system}/PreinstalledAssetsV2/InstallWithOs/com_apple_MobileAsset_Font*/**/Kaiti.ttc", recursive=True),
                  "/System/Library/Fonts/Supplemental/Kaiti.ttc",
                  "/Library/Fonts/Kaiti.ttc",
                  str(Path.home() / "Library/Fonts/LXGWWenKai-Regular.ttf")]
    for candidate in candidates:
        try:
            face = fitz.Font(fontfile=candidate)
            if all(face.has_glyph(ord(c)) for c in "论文译文阅读简体中文"):
                return face
        except (OSError, ValueError, RuntimeError):
            continue
    return fitz.Font("china-s")


def intersects(a, b, tolerance=0.8):
    shared = a & b
    return shared.width > tolerance and shared.height > tolerance


def line_core(rect):
    rect = fitz.Rect(rect)
    inset = rect.height * 0.26
    return fitz.Rect(rect.x0, rect.y0 + inset, rect.x1, rect.y1 - inset)


def protected_art(page):
    boxes = [fitz.Rect(image["bbox"]) for image in page.get_image_info()]
    # A flat, pale rectangle (including a rounded abstract panel) is a background.
    # The text can be typeset over it while larger/multi-colour artwork stays protected.
    drawings = [drawing for drawing in page.get_drawings()
                if not (drawing["type"] == "f" and drawing.get("fill")
                        and min(drawing["fill"]) >= 0.92 and len(drawing["items"]) <= 8)]
    boxes += page.cluster_drawings(drawings=drawings)
    return [box & page.rect for box in boxes if box.width >= 6 and box.height >= 6
            and box.get_area() < page.rect.get_area() * 0.8]

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
    blocks = page.get_text("dict", flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)["blocks"]
    lines = [line for block in blocks if block["type"] == 0 for line in block["lines"]]
    cores = [line_core(line["bbox"]) for line in lines]
    art = protected_art(page)
    units, group = [], []
    bounds = None

    def flush():
        nonlocal bounds
        if not group:
            return
        sizes = [span["size"] for i in group for span in lines[i]["spans"] if span["text"].strip()]
        if sizes and bounds.width > 14 and bounds.height > 4 and bounds in page.rect:
            units.append({"text": join_lines([lines[i] for i in group]), "box": list(bounds),
                          "size": statistics.median(sizes), "lines": list(group)})
        group.clear()
        bounds = None

    for i, line in enumerate(lines):
        text = line_text(line)
        heading = REFERENCE_START.fullmatch(text)
        if APPENDIX_START.match(text):
            in_references = False
        if heading:
            flush()
            in_references = True
        current = fitz.Rect(line["bbox"])
        if (in_references and not heading) or not translatable(line) or any(intersects(cores[i], box) for box in art):
            flush()
            continue
        if group:
            prior = lines[group[-1]]
            previous = fitz.Rect(prior["bbox"])
            prev_size, cur_size = prior["spans"][0]["size"], line["spans"][0]["size"]
            union = bounds | current
            members = {*group, i}
            # A paragraph wrapping beside a figure cannot claim the rectangular
            # area beside its short lines, even if subsequent lines are wide.
            if (not previous.y0 + prev_size * 0.55 < current.y0 <= previous.y1 + prev_size * 0.7
                or abs(current.x0 - previous.x0) > max(10, prev_size * 1.6)
                or abs(prev_size - cur_size) > max(0.8, prev_size * 0.12)
                or (previous.width < current.width * 0.56 and line_text(prior).endswith((".", "!", "?")))
                or any(intersects(union, box) for box in art)
                or any(n not in members and intersects(union, core) for n, core in enumerate(cores))):
                flush()
        group.append(i)
        bounds = current if bounds is None else bounds | current
        if heading:
            flush()
    flush()
    return units, in_references, [list(core) for core in cores], [list(box) for box in art]


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
            units, in_references, lines, art = block_groups(page, in_references)
            for ordinal, unit in enumerate(units):
                unit["id"] = f"p{index + 1}b{ordinal + 1}"
            pages.append({"units": units, "width": page.rect.width, "height": page.rect.height, "lines": lines, "art": art})
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
            if font().text_length(line + word, fontsize=size) <= width:
                line += word
                continue
            if line.strip():
                lines.append(line.rstrip())
            line = ""
            if word.isspace():
                continue
            while font().text_length(word, fontsize=size) > width and len(word) > 1:
                split = 1
                while split < len(word) and font().text_length(word[:split + 1], fontsize=size) <= width:
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
        writer.append((box.x0, box.y0 + size * (0.95 + n * LEADING)), line, font=font(), fontsize=size)
    writer.write_text(page, color=color)


def fit_text(text, box, preferred, minimum):
    if box.width <= 0 or box.height <= 0:
        return None
    size = preferred
    while True:
        lines = wrap(text, box.width, size)
        height = size * (1.20 + LEADING * (len(lines) - 1))
        if lines and height <= box.height:
            return lines, size, height
        if size <= minimum:
            return None
        size = max(size - 0.4, minimum)


def free_boxes(rect, blockers, page):
    # Try the original column first, then use adjacent whitespace. Never extend
    # across another line, figure, equation or already typeset paragraph.
    for extra_y in (5, 1, 0):
        top = max(page.y0, rect.y0 - extra_y)
        bottom = min(page.y1, rect.y1 + extra_y)
        for block in blockers:
            if block.x0 < rect.x1 - 1 and block.x1 > rect.x0 + 1:
                if block.y1 <= rect.y0 + 2:
                    top = max(top, block.y1 + 1)
                if block.y0 >= rect.y1 - 2:
                    bottom = min(bottom, block.y0 - 1)
        right = min(page.x1 - 6, rect.x1 + 14)
        for block in blockers:
            if block.y0 < bottom and block.y1 > top and block.x0 > rect.x0:
                right = min(right, block.x0 - 2)
        box = fitz.Rect(rect.x0, top, right, bottom)
        if not any(intersects(box, block, 0.2) for block in blockers):
            yield box


def layout_unit(text, rect, blockers, page, original_size):
    preferred = min(34, original_size + (2.5 if original_size >= 9 else 1.6))
    minimum = min(preferred, max(6.5, original_size * 0.62))
    winner = None
    for box in free_boxes(rect, blockers, page):
        fit = fit_text(text, box, preferred, minimum)
        if fit and (not winner or fit[1] > winner[2]):
            lines, size, height = fit
            # Keep the translated ink at the original anchor where possible.
            top = min(max(rect.y0, box.y0), box.y1 - height)
            ink = fitz.Rect(box.x0, top, box.x1, top + height)
            winner = (ink, lines, size)
    return winner


def source_digest(source):
    digest = hashlib.sha256()
    with open(source, "rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_mapping(source, destination):
    with open_source(source) as pdf:
        if MAP_NAME in pdf.embfile_names():
            data = pdf.embfile_get(MAP_NAME)
            if len(data) > 4 * 1024 * 1024:
                raise ValueError("译文 PDF 的页码索引过大")
            mapping = json.loads(data)
            if (len(mapping["pages"]) != len(pdf)
                or not 1 <= mapping["sourcePages"] <= len(pdf)
                or any(not 0 <= entry["source"] < mapping["sourcePages"] for entry in mapping["pages"])):
                raise ValueError("译文 PDF 的页码索引无效")
            write_json(destination, mapping)
        else:
            write_json(destination, None)


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
            line_boxes = [fitz.Rect(rect) for rect in spec["lines"]]
            art = [fitz.Rect(rect) for rect in spec["art"]]
            used = []
            # Read the left-to-right/top-to-bottom geometry instead of PDF paint order.
            for unit in sorted(spec["units"], key=lambda unit: (unit["box"][1], unit["box"][0])):
                text = translations[unit["id"]]
                rect = fitz.Rect(unit["box"])
                members = set(unit["lines"])
                blockers = [box for i, box in enumerate(line_boxes) if i not in members] + art + used
                fit = layout_unit(text, rect, blockers, page.rect, unit["size"])
                if not fit:
                    label = len(supplements) + 1
                    supplements.append((index, unit, text))
                    fit = layout_unit(f"见补译 {label}", rect, blockers, page.rect, unit["size"])
                if fit:
                    for i in members:
                        page.add_redact_annot(line_boxes[i], fill=False, cross_out=False)
                    replacements.append(fit)
                    used.append(fit[0])
            if replacements:
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                                      graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                                      text=fitz.PDF_REDACT_TEXT_REMOVE)
                for rect, lines, size in replacements:
                    draw_text(page, rect, lines, size)
        supplement_page = None
        last_source = None
        cursor = 0
        for label, (index, unit, text) in enumerate(supplements, 1):
            spec = plan["pages"][index]
            box = fitz.Rect(unit["box"])
            anchor = {"source": index, "supplement": label, "x": box.x0 / spec["width"], "y": box.y0 / spec["height"]}
            width, height = spec["width"], spec["height"]
            lines = wrap(text, width - 72, 12)
            link = None
            while lines:
                if supplement_page is None or last_source != index or cursor + 52 > height - 34:
                    supplement_page = len(out)
                    page = out.new_page(width=width, height=height)
                    draw_text(page, fitz.Rect(36, 30, width - 36, 52), [f"补译 · 原文第 {index + 1} 页"], 15)
                    page.draw_line((36, 57), (width - 36, 57), color=(0.8, 0.8, 0.8), width=0.5)
                    last_source, cursor = index, 69
                    page_map.append({**anchor, "segments": []})
                page = out[supplement_page]
                if link is None:
                    link = {"kind": fitz.LINK_GOTO, "from": box, "page": supplement_page, "to": fitz.Point(36, cursor)}
                page_map[-1]["segments"].append({**anchor, "start": cursor / height})
                draw_text(page, fitz.Rect(36, cursor, width - 36, height - 34), [f"补译 {label}"], 12)
                cursor += 19
                count = max(1, int((height - 34 - cursor) / (12 * LEADING)))
                draw_text(page, fitz.Rect(36, cursor, width - 36, height - 34), lines[:count], 12)
                cursor += count * 12 * LEADING + 14 if len(lines) > count else len(lines) * 12 * LEADING + 14
                lines = lines[count:]
            if link:
                out[index].insert_link(link)
        mapping = {"sourcePages": len(plan["pages"]), "pages": page_map,
                   "layoutVersion": LAYOUT_VERSION, "sourceDigest": source_digest(source)}
        out.embfile_add(MAP_NAME, json.dumps(mapping).encode("utf-8"))
        out.set_metadata({"title": "中文译文", "subject": "GPT-6-Luna translation", "creator": "Codex for Zotero"})
        # MuPDF's font subsetting keeps the embedded CJK font compact and searchable.
        out.subset_fonts()
        out.save(output_file, garbage=4, deflate=True)
    os.chmod(output_file, 0o600)
    with fitz.open(output_file) as verified:
        if verified.page_count != len(page_map):
            raise ValueError("译文 PDF 输出未通过页数校验")
    write_json(map_file, mapping)


if __name__ == "__main__":
    try:
        operation, *args = sys.argv[1:]
        {"extract": extract, "render": render, "mapping": read_mapping}[operation](*args)
    except Exception as error:
        sys.exit(str(error))
