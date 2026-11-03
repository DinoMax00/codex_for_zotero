#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pymupdf>=1.26,<2", "pillow>=10"]
# ///
"""Local Zotero native highlights: extract, anchor, preview, and append safely."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

COLORS = {
    "summary": "#a28ae5",
    "core": "#ffd400",
    "method": "#5fb236",
    "result": "#2ea8e5",
    "limitation": "#f19837",
}
ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def fail(message):
    raise ValueError(message)


def dump(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def save_json(path, value, private=False):
    path = Path(path).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp-" + str(os.getpid()))
    fd = os.open(
        temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600 if private else 0o644
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class APIError(RuntimeError):
    def __init__(self, status, message):
        self.status = status
        super().__init__(f"Zotero HTTP {status}: {message}")


class Client:
    def __init__(
        self, base="http://127.0.0.1:23119", library="users/0", state_dir=None
    ):
        url = urllib.parse.urlsplit(base)
        if (
            url.scheme != "http"
            or url.hostname not in ("127.0.0.1", "localhost", "::1")
            or url.username
            or url.password
            or url.query
            or url.fragment
            or url.path not in ("", "/")
        ):
            fail("只允许本机 Zotero HTTP 地址，不把本地密钥发到其他主机。")
        if not re.fullmatch(r"(users|groups)/\d+", library):
            fail("文库格式须为 users/0 或 groups/<组ID>。")
        self.base, self.library = base.rstrip("/"), library
        self.server_id = None
        self.state_dir = Path(
            state_dir
            or os.environ.get("ZOTERO_ANNOTATOR_STATE_DIR")
            or Path.home() / ".local/state/codex/zotero-paper-annotator"
        )

        # Reject redirects: a localhost response must never forward an API key.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None

        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect()
        )

    @property
    def prefix(self):
        return "/api/" + self.library

    def request(self, route, method="GET", data=None, headers=None, timeout=30):
        h = {"Accept": "application/json", **(headers or {})}
        if self.server_id:
            h["Zotero-Server-ID"] = self.server_id
        if data is not None:
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(
            self.base + route,
            method=method,
            headers=h,
            data=(
                None if data is None else json.dumps(data, ensure_ascii=False).encode()
            ),
        )
        try:
            with self.opener.open(req, timeout=timeout) as response:
                body, rh = response.read().decode("utf-8"), dict(response.headers)
                sid = response.headers.get("Zotero-Server-ID")
                if self.server_id and sid and self.server_id != sid:
                    fail("Zotero 实例已改变，停止操作；请重新提取和准备批注。")
                if sid:
                    self.server_id = sid
                try:
                    return json.loads(body), rh
                except json.JSONDecodeError:
                    return body, rh
        except urllib.error.HTTPError as e:
            message = e.read().decode("utf-8", errors="replace")[:1200]
            # Errors can mention submitted data but must never print credentials.
            for secret in (h.get("Zotero-API-Key"), h.get("Authorization")):
                if secret:
                    message = message.replace(secret, "[redacted]")
            raise APIError(e.code, message) from None

    def item(self, key):
        if not re.fullmatch(r"[A-Z0-9]{8}", key):
            fail("无效的 Zotero 条目键。")
        return self.request(self.prefix + "/items/" + key)[0]

    def children(self, key):
        return self.request(self.prefix + "/items/" + key + "/children")[0]

    def resolve(self, key):
        item = self.item(key)
        data = item["data"]
        if data.get("deleted"):
            fail("目标已在回收站中。")
        if data["itemType"] != "attachment":
            pdfs = [
                i
                for i in self.children(key)
                if i["data"].get("contentType") == "application/pdf"
                and not i["data"].get("deleted")
            ]
            if len(pdfs) != 1:
                fail(
                    "该论文有零个或多个 PDF，请明确指定附件键："
                    + ", ".join(i["key"] for i in pdfs)
                )
            item, data = pdfs[0], pdfs[0]["data"]
        if data.get("contentType") != "application/pdf":
            fail("目标不是 PDF 附件。")
        uri, _ = self.request(self.prefix + "/items/" + item["key"] + "/file/view/url")
        u = urllib.parse.urlsplit(uri.strip())
        if u.scheme != "file" or u.netloc not in ("", "localhost"):
            fail("附件尚未下载，或未返回本地文件路径。请先在 Zotero 打开 PDF。")
        path = Path(urllib.request.url2pathname(u.path)).resolve()
        if not path.is_file():
            fail("PDF 不在本机，请先在 Zotero 下载。")
        parent = self.item(data["parentItem"]) if data.get("parentItem") else item
        return {
            "library": self.library,
            "attachmentKey": item["key"],
            "parentKey": data.get("parentItem"),
            "title": parent["data"].get("title", data.get("title")),
            "pdfPath": str(path),
            "pdfSha256": sha256(path),
            "serverID": self.server_id,
        }

    def annotation_request(self, action, **payload):
        discovery_file = self.state_dir / "bridge.json"
        if not discovery_file.exists():
            fail(
                "批注后台未就绪。请启用或更新 Codex for Zotero 插件；不要打开执行 JavaScript 窗口作为替代。"
            )
        connection = json.loads(discovery_file.read_text())
        url = urllib.parse.urlsplit(connection.get("url", ""))
        base = urllib.parse.urlsplit(self.base)
        if (
            url.scheme != "http"
            or url.hostname not in ("127.0.0.1", "localhost", "::1")
            or url.port != base.port
            or url.path != "/codex-for-zotero/annotations"
            or url.query
            or url.fragment
            or url.username
            or url.password
        ):
            fail("批注后台地址无效。")
        if not self.server_id:
            self.request("/api/")
        if connection.get("serverID") != self.server_id:
            fail("批注后台与当前 Zotero 实例不一致，请重新打开插件。")
        token = connection.get("token", "")
        if not isinstance(token, str) or len(token) < 32:
            fail("批注后台凭据无效，请重新打开插件。")
        response, _ = self.request(
            url.path,
            "POST",
            {
                "action": action,
                "library": self.library,
                "serverID": self.server_id,
                **payload,
            },
            {"Authorization": "Bearer " + token},
            timeout=90,
        )
        return response

    def annotations(self, key):
        return self.annotation_request("list", attachmentKey=key)["annotations"]

    def append(self, source, items):
        return self.annotation_request(
            "append",
            attachmentKey=source["attachmentKey"],
            pdfSha256=source["pdfSha256"],
            items=items,
        )


def normalize_with_map(chars):
    """Whitespace/ligature normalization, preserving the original glyph indices."""
    output, mapping = [], []
    for i, ch in enumerate(chars):
        text = ch["c"]
        # Remove an end-of-line hyphen only where it joins two alphabetic words.
        if (
            text in ("-", "‐", "‑")
            and i
            and i + 1 < len(chars)
            and chars[i + 1]["c"] == "\n"
        ):
            j = i + 2
            while j < len(chars) and chars[j]["c"].isspace():
                j += 1
            if (
                j < len(chars)
                and chars[i - 1]["c"].isalpha()
                and chars[j]["c"].isalpha()
            ):
                continue
        if text == "\n" and i and chars[i - 1]["c"] in ("-", "‐", "‑"):
            j = i + 1
            while j < len(chars) and chars[j]["c"].isspace():
                j += 1
            if (
                i > 1
                and j < len(chars)
                and chars[i - 2]["c"].isalpha()
                and chars[j]["c"].isalpha()
            ):
                continue
        for c in unicodedata.normalize("NFKC", text).casefold():
            if c == "\u00ad":
                continue
            c = " " if c.isspace() else c
            if c == " " and (not output or output[-1] == " "):
                continue
            output.append(c)
            mapping.append(i)
    return "".join(output).strip(), mapping[: len(output)]


def normalized(text):
    return normalize_with_map([{"c": c} for c in str(text)])[0]


def page_chars(page, ocr=False):
    kwargs = {}
    if ocr:
        kwargs["textpage"] = page.get_textpage_ocr(language="eng", dpi=200, full=True)
    raw = page.get_text("rawdict", sort=False, **kwargs)
    chars, lines = [], []
    for block in raw.get("blocks", []):
        for line in block.get("lines", []):
            line_id = len(lines)
            text = "".join(
                c["c"].replace("\x00", "\ufffd")
                for span in line["spans"]
                for c in span["chars"]
            )
            lines.append({"id": line_id, "text": text, "bbox": line["bbox"]})
            for span in line["spans"]:
                for ch in span["chars"]:
                    chars.append(
                        {
                            "c": ch["c"].replace("\x00", "\ufffd"),
                            "bbox": ch["bbox"],
                            "line": line_id,
                        }
                    )
            chars.append({"c": "\n", "bbox": None, "line": line_id})
    return chars, lines


def extract(source, out, ocr=False):
    import pymupdf as fitz

    out = Path(out).resolve()
    pages, readable = [], []
    with fitz.open(source["pdfPath"]) as doc:
        if doc.needs_pass:
            fail("PDF 已加密，需要先解锁。")
        for i, page in enumerate(doc):
            chars, lines = page_chars(page, ocr=ocr and not page.get_text().strip())
            text = "\n".join(line["text"] for line in lines)
            pages.append(
                {
                    "pageIndex": i,
                    "pageLabel": page.get_label() or str(i + 1),
                    "width": page.rect.width,
                    "height": page.rect.height,
                    "rotation": page.rotation,
                    "lines": lines,
                    "needsOCR": len(text.strip()) < 30,
                }
            )
            readable.append(
                f'\n===== PDF PAGE {i+1} | pageIndex={i} | label={pages[-1]["pageLabel"]} =====\n'
                + "\n".join(f'[L{line["id"]}] {line["text"]}' for line in lines)
            )
    source = {**source, "pageCount": len(pages), "ocr": ocr}
    save_json(out / "source.json", source)
    save_json(out / "pages.json", pages)
    (out / "paper.txt").write_text("\n".join(readable), encoding="utf-8")
    return {
        "source": str(out / "source.json"),
        "text": str(out / "paper.txt"),
        "pages": str(out / "pages.json"),
        "pageCount": len(pages),
        "pagesNeedingOCR": [p["pageIndex"] for p in pages if p["needsOCR"]],
    }


def find_anchor(page, candidate, ocr=False):
    import pymupdf as fitz

    quote = candidate.get("quote", "").strip()
    if len(normalized(quote)) < 8:
        fail("原文引句过短，无法可靠定位。")
    chars, _ = page_chars(page, ocr=ocr and not page.get_text().strip())
    line_ids = candidate.get("line_ids")
    if line_ids is not None:
        if (
            not isinstance(line_ids, list)
            or not line_ids
            or not all(isinstance(i, int) and not isinstance(i, bool) for i in line_ids)
        ):
            fail("line_ids 须为提取结果中的行号数组。")
        allowed = set(line_ids)
        # Keep the original indices so restrictions don't join unrelated text silently.
        for ch in chars:
            if ch["line"] not in allowed:
                ch["c"] = "\x00"
    text, mapping = normalize_with_map(chars)
    needle = normalized(quote)
    starts, start = [], 0
    while (start := text.find(needle, start)) >= 0:
        starts.append(start)
        start += max(1, len(needle))
    if not starts:
        fail(
            "未找到逐字匹配的原文；请检查 pageIndex、断行和 quote，不能猜坐标："
            + quote[:100]
        )
    occurrence = candidate.get("occurrence")
    if len(starts) > 1 and occurrence is None:
        fail(
            "引句在本页出现多次；请提供 line_ids 或 occurrence（从 0 开始）："
            + quote[:80]
        )
    occurrence = 0 if occurrence is None else occurrence
    if (
        not isinstance(occurrence, int)
        or isinstance(occurrence, bool)
        or not 0 <= occurrence < len(starts)
    ):
        fail("occurrence 超出匹配范围。")
    pos = starts[occurrence]
    begin, end = mapping[pos], mapping[pos + len(needle) - 1]
    groups, previous = [], None
    for ch in chars[begin : end + 1]:
        if not ch["bbox"] or ch["c"].isspace():
            continue
        r = fitz.Rect(ch["bbox"])
        if (
            previous is None
            or previous["line"] != ch["line"]
            or r.x0 - previous["rect"].x1 > max(r.height * 1.6, 12)
        ):
            previous = {"line": ch["line"], "rect": r}
            groups.append(previous)
        else:
            previous["rect"] |= r
    if not groups:
        fail("匹配到了文字但没有可用字形坐标。")
    inverse = ~page.transformation_matrix
    rects = []
    for group in groups:
        r = group["rect"] * inverse
        rects.append([round(v, 3) for v in (r.x0, r.y0, r.x1, r.y1)])
    top = min(g["rect"].y0 for g in groups)
    return {
        "position": {"pageIndex": candidate["pageIndex"], "rects": rects},
        "pageLabel": page.get_label() or str(candidate["pageIndex"] + 1),
        "sortIndex": f'{candidate["pageIndex"]:05}|{min(begin,999999):06}|{min(max(0,int(top)),99999):05}',
        "matchCount": len(starts),
    }


def key_for(fingerprint):
    n = int(fingerprint[:16], 16)
    return "".join(ALPHABET[(n >> (i * 5)) & 31] for i in range(8))


def build_plan(source, candidates):
    import pymupdf as fitz

    if not isinstance(candidates, list) or not candidates or len(candidates) > 50:
        fail("每次计划须包含 1–50 条批注；不要为了数量填充高亮。")
    if source["pdfSha256"] != sha256(source["pdfPath"]):
        fail("PDF 已变化，请重新提取和定位。")
    items, matches, seen = [], [], set()
    with fitz.open(source["pdfPath"]) as doc:
        for index, c in enumerate(candidates):
            kind, comment, page_index = (
                c.get("kind"),
                c.get("comment", "").strip(),
                c.get("pageIndex"),
            )
            if kind not in COLORS:
                fail(
                    f"第 {index+1} 条 kind 应为 summary/core/method/result/limitation。"
                )
            if (
                not isinstance(page_index, int)
                or isinstance(page_index, bool)
                or not 0 <= page_index < len(doc)
            ):
                fail(f"第 {index+1} 条 pageIndex 无效；从 0 开始。")
            if (
                not comment
                or len(comment) > 8000
                or not re.search(r"[\u3400-\u9fff]", comment)
            ):
                fail(f"第 {index+1} 条需要不超过 8000 字符的中文批注。")
            anchor = find_anchor(doc[page_index], c, ocr=source.get("ocr", False))
            identity = [
                source["library"],
                source["attachmentKey"],
                page_index,
                anchor["position"]["rects"],
                kind,
                normalized(c["quote"]),
            ]
            fingerprint = hashlib.sha256(
                json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()
            ).hexdigest()
            if fingerprint in seen:
                fail("计划中有重复的高亮位置与类别。")
            seen.add(fingerprint)
            items.append(
                {
                    "key": key_for(fingerprint),
                    "version": 0,
                    "itemType": "annotation",
                    "parentItem": source["attachmentKey"],
                    "annotationType": "highlight",
                    "annotationAuthorName": "",
                    "annotationText": c["quote"].strip(),
                    "annotationComment": comment,
                    "annotationColor": COLORS[kind],
                    "annotationPageLabel": anchor["pageLabel"],
                    "annotationSortIndex": anchor["sortIndex"],
                    "annotationPosition": json.dumps(
                        anchor["position"], separators=(",", ":")
                    ),
                    "tags": [],
                    "codexAnchor": fingerprint[:24],
                }
            )
            matches.append(
                {
                    "index": index,
                    "matchCount": anchor["matchCount"],
                    "pageIndex": page_index,
                    "rectCount": len(anchor["position"]["rects"]),
                }
            )
    return {
        "schema": 1,
        "source": source,
        "candidates": candidates,
        "items": items,
        "matches": matches,
    }


def verify_source(client, source):
    current = client.resolve(source["attachmentKey"])
    for field in ("library", "attachmentKey", "pdfSha256", "serverID"):
        if source.get(field) != current.get(field):
            fail("目标文库、Zotero 实例或 PDF 已改变，请重新提取；不写入旧计划。")
    return {**current, "ocr": source.get("ocr", False)}


def preview(plan, out):
    import pymupdf as fitz
    from PIL import Image, ImageDraw

    out = Path(out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    images = []
    with fitz.open(plan["source"]["pdfPath"]) as doc:
        for page_index in sorted({c["pageIndex"] for c in plan["candidates"]}):
            page = doc[page_index]
            scale = 1.5
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples).convert(
                "RGBA"
            )
            overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
            draw = ImageDraw.Draw(overlay)
            for index, item in enumerate(plan["items"]):
                position = json.loads(item["annotationPosition"])
                if position["pageIndex"] != page_index:
                    continue
                color = tuple(
                    int(item["annotationColor"][i : i + 2], 16) for i in (1, 3, 5)
                )
                for r in position["rects"]:
                    v = (
                        fitz.Rect(r)
                        * page.transformation_matrix
                        * page.rotation_matrix
                        * fitz.Matrix(scale, scale)
                    )
                    draw.rectangle(
                        tuple(v), fill=(*color, 65), outline=(*color, 200), width=1
                    )
                v = (
                    fitz.Rect(position["rects"][0])
                    * page.transformation_matrix
                    * page.rotation_matrix
                    * fitz.Matrix(scale, scale)
                )
                draw.text(
                    (max(0, v.x0 - 16), max(0, v.y0 - 12)),
                    str(index + 1),
                    fill=(190, 30, 30, 255),
                )
            dest = out / f"page-{page_index+1:03}.png"
            Image.alpha_composite(img, overlay).convert("RGB").save(dest)
            images.append(str(dest))
    return {"previews": images, "sourcePDFModified": False}


def apply_plan(client, plan):
    source = verify_source(client, plan["source"])
    rebuilt = build_plan(source, plan["candidates"])
    if rebuilt["items"] != plan["items"]:
        fail("计划坐标或批注内容被改动，请从 draft 重新 prepare，再检查预览。")
    existing = client.annotations(source["attachmentKey"])
    existing_by_key = {i["key"]: i for i in existing}
    anchors = {
        i["codexAnchor"][:24]
        for i in existing
        if i.get("codexAnchor") and not i["data"].get("deleted")
    }
    anchors.update(
        t["tag"].split(":", 1)[1][:24]
        for i in existing
        for t in i["data"].get("tags", [])
        if t["tag"].startswith("codex-anchor:") and not i["data"].get("deleted")
    )
    pending, skipped = [], []
    for item in rebuilt["items"]:
        own_anchor = item["codexAnchor"]
        if own_anchor in anchors:
            skipped.append(
                {"key": item["key"], "reason": "已存在，保留现有批注及用户修改"}
            )
        elif item["key"] in existing_by_key:
            old = existing_by_key[item["key"]]["data"]
            if (
                old.get("parentItem") == item["parentItem"]
                and old.get("annotationType") == "highlight"
                and old.get("annotationText") == item["annotationText"]
                and json.loads(old.get("annotationPosition", "{}"))
                == json.loads(item["annotationPosition"])
            ):
                skipped.append({"key": item["key"], "reason": "已存在，保留用户修改"})
            else:
                fail("稳定键与现有批注冲突；停止，未覆盖现有批注。")
        else:
            pending.append(item)
    if not pending:
        return {"created": [], "skipped": skipped, "failed": {}, "verified": True}
    response = client.append(source, pending)
    if (
        not isinstance(response, dict)
        or "success" not in response
        or "failed" not in response
    ):
        fail("批注后台未返回有效写入回执；请读取批注后确认，不能盲目重发。")
    skipped.extend(
        {"key": key, "reason": "已存在，保留用户修改"}
        for key in response.get("unchanged", {}).values()
    )
    created = list(response.get("success", {}).values())
    current = {i["key"]: i["data"] for i in client.annotations(source["attachmentKey"])}
    expected = {i["key"]: i for i in pending}
    for annotation_key in created:
        actual, wanted = current.get(annotation_key), expected.get(annotation_key)
        if (
            not actual
            or not wanted
            or any(
                actual.get(field) != wanted[field]
                for field in (
                    "parentItem",
                    "annotationText",
                    "annotationComment",
                    "annotationType",
                )
            )
            or json.loads(actual["annotationPosition"])
            != json.loads(wanted["annotationPosition"])
        ):
            fail("写入后复读验证失败；不要盲目重发。检查 Zotero 中的批注和写入结果。")
    return {
        "created": created,
        "skipped": skipped,
        "failed": response.get("failed", {}),
        "verified": not bool(response.get("failed")),
        "attachmentKey": source["attachmentKey"],
        "sourcePDFModified": False,
    }


def context_key(pdf, library):
    path = Path(pdf).expanduser().resolve()
    metadata = path.parent / "paper.json"
    if metadata.exists():
        data = json.loads(metadata.read_text())
        if data.get("attachmentKey"):
            if data.get("libraryID") not in (None, 1) and library == "users/0":
                fail("上下文来自群组文库，请指定 --library groups/<组ID>。")
            return data["attachmentKey"]
    if path.parent.parent.name == "storage" and re.fullmatch(
        r"[A-Z0-9]{8}", path.parent.name
    ):
        return path.parent.name
    fail("无法从路径唯一确定 Zotero 附件，请 search 后提供 --key；不凭同名文件猜测。")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:23119")
    parser.add_argument("--library", default="users/0")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    search = sub.add_parser("search")
    search.add_argument("query")
    search.add_argument("--limit", type=int, default=20)
    resolve = sub.add_parser("resolve")
    resolve.add_argument("--key")
    resolve.add_argument("--pdf")
    extract_p = sub.add_parser("extract")
    extract_p.add_argument("--key")
    extract_p.add_argument("--pdf")
    extract_p.add_argument("--out", required=True)
    extract_p.add_argument("--ocr", action="store_true")
    prepare = sub.add_parser("prepare")
    prepare.add_argument("--source", required=True)
    prepare.add_argument("--draft", required=True)
    prepare.add_argument("--out", required=True)
    render = sub.add_parser("preview")
    render.add_argument("--plan", required=True)
    render.add_argument("--out", required=True)
    sub.add_parser("authorize")
    cleanup = sub.add_parser("cleanup")
    cleanup.add_argument("--key", required=True)
    apply = sub.add_parser("apply")
    apply.add_argument("--plan", required=True)
    apply.add_argument("--receipt", required=True)
    annotations = sub.add_parser("annotations")
    annotations.add_argument("--key", required=True)
    args = parser.parse_args(argv)
    client = Client(args.base_url, args.library)
    if args.command == "status":
        root, _ = client.request("/api/")
        dump(
            {
                "available": True,
                "serverID": client.server_id,
                "silentAnnotationBridge": client.annotation_request("status"),
            }
        )
    elif args.command == "search":
        query = urllib.parse.urlencode(
            {"q": args.query, "limit": min(max(args.limit, 1), 100), "sort": "title"}
        )
        data, _ = client.request(client.prefix + "/items?" + query)
        dump(
            [
                {
                    "key": i["key"],
                    "type": i["data"]["itemType"],
                    "title": i["data"].get("title"),
                    "parentItem": i["data"].get("parentItem"),
                    "contentType": i["data"].get("contentType"),
                }
                for i in data
                if i["data"]["itemType"] not in ("annotation", "note")
            ]
        )
    elif args.command in ("resolve", "extract"):
        key = args.key or (context_key(args.pdf, args.library) if args.pdf else None)
        if not key:
            fail("请给 --key 或来自当前 Codex/Zotero 上下文的 --pdf 路径。")
        source = client.resolve(key)
        dump(
            source if args.command == "resolve" else extract(source, args.out, args.ocr)
        )
    elif args.command == "prepare":
        source = json.loads(Path(args.source).read_text())
        if source["library"] != client.library:
            fail("--library 与提取来源不一致。")
        source = verify_source(client, source)
        draft = json.loads(Path(args.draft).read_text())
        plan = build_plan(
            source, draft["annotations"] if isinstance(draft, dict) else draft
        )
        save_json(args.out, plan)
        dump(
            {
                "plan": str(Path(args.out).resolve()),
                "annotationCount": len(plan["items"]),
                "matches": plan["matches"],
                "writesPerformed": False,
            }
        )
    elif args.command == "preview":
        dump(preview(json.loads(Path(args.plan).read_text()), args.out))
    elif args.command == "authorize":
        dump({"pluginReady": client.annotation_request("status")})
    elif args.command == "annotations":
        dump(client.annotations(args.key))
    elif args.command == "cleanup":
        dump(client.annotation_request("cleanup", attachmentKey=args.key))
    elif args.command == "apply":
        plan = json.loads(Path(args.plan).read_text())
        if plan["source"]["library"] != client.library:
            fail("--library 与计划不一致。")
        result = apply_plan(client, plan)
        save_json(args.receipt, result)
        dump(result)
        return 2 if result["failed"] else 0
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(
            json.dumps(
                {
                    "error": str(e),
                    "note": "使用 Codex for Zotero 后台接口；不要回退到执行 JavaScript 窗口。写入超时须先读取批注确认，不能盲目重发。",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        sys.exit(1)
