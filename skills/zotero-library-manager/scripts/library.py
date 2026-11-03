#!/usr/bin/env python3
"""Add/deduplicate papers and create/resolve Zotero collections via the local plugin."""
import argparse
import json
import re
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request


class Client:
    def __init__(self, library="users/0", base="http://127.0.0.1:23119"):
        u = urllib.parse.urlsplit(base)
        if (
            u.scheme != "http"
            or u.hostname not in ("127.0.0.1", "localhost", "::1")
            or u.username
            or u.password
            or u.query
            or u.fragment
            or u.path not in ("", "/")
        ):
            raise ValueError("只允许本机 Zotero 服务地址")
        if not re.fullmatch(r"(users|groups)/\d+", library):
            raise ValueError("文库须为 users/0 或 groups/<ID>")
        self.library, self.base, self.server_id = library, base.rstrip("/"), None

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args):
                return None

        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect()
        )

    def request(self, route, data=None, token=None):
        headers = {"Accept": "application/json"}
        if self.server_id:
            headers["Zotero-Server-ID"] = self.server_id
        if data is not None:
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(
            self.base + route,
            headers=headers,
            method="GET" if data is None else "POST",
            data=(
                None if data is None else json.dumps(data, ensure_ascii=False).encode()
            ),
        )
        try:
            with self.opener.open(request, timeout=180) as response:
                sid = response.headers.get("Zotero-Server-ID")
                if self.server_id and sid and sid != self.server_id:
                    raise ValueError("Zotero 实例改变，请重新检查目标文库")
                if sid:
                    self.server_id = sid
                text = response.read().decode("utf-8")
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return text
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", errors="replace")[:1500]
            if token:
                text = text.replace(token, "[redacted]")
            raise RuntimeError("Zotero HTTP " + str(e.code) + ": " + text) from None

    def call(self, action, **payload):
        connection_file = (
            Path.home() / ".local/state/codex/zotero-paper-annotator/bridge.json"
        )
        if not connection_file.exists():
            raise ValueError(
                "请启用 Codex for Zotero 0.5.0+ 的后台接口，不要打开执行 JavaScript 窗口"
            )
        connection = json.loads(connection_file.read_text())
        u = urllib.parse.urlsplit(connection.get("libraryURL", ""))
        if (
            u.scheme != "http"
            or u.hostname not in ("127.0.0.1", "localhost", "::1")
            or u.port != urllib.parse.urlsplit(self.base).port
            or u.path != "/codex-for-zotero/library"
            or u.query
            or u.fragment
            or u.username
            or u.password
        ):
            raise ValueError("论文入库后台未就绪，请更新 Codex for Zotero 插件")
        if not self.server_id:
            self.request("/api/")
        if self.server_id != connection.get("serverID"):
            raise ValueError("后台与当前 Zotero 文库实例不一致")
        token = connection.get("token", "")
        if not isinstance(token, str) or len(token) < 32:
            raise ValueError("后台凭据无效，请重新启用插件")
        return self.request(
            u.path,
            {
                "action": action,
                "library": self.library,
                "serverID": self.server_id,
                **payload,
            },
            token,
        )


def emit(value, path=None):
    text = json.dumps(value, ensure_ascii=False, indent=2)
    if path:
        out = Path(path).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        print(json.dumps({"saved": str(out)}, ensure_ascii=False))
    else:
        print(text)


def resolve(client, args):
    if args.doi:
        return client.call("resolve", DOI=args.doi)
    if args.arxiv:
        return client.call("resolve", arXiv=args.arxiv)
    if args.import_file:
        path = Path(args.import_file).expanduser().resolve()
        if path.suffix.lower() not in (".bib", ".bibtex", ".ris", ".txt"):
            raise ValueError("请提供 RIS/BibTeX 文本文件")
        return client.call("parse", text=path.read_text(encoding="utf-8-sig"))
    raise ValueError("请提供 --doi、--arxiv 或 --import-file")


def target(args):
    if getattr(args, "collection_key", None):
        return {"collectionKey": args.collection_key}
    if getattr(args, "path_json", None):
        return {"path": json.loads(args.path_json)}
    if getattr(args, "collection", None):
        return {"path": args.collection}
    raise ValueError("请给出 --collection 路径或 --collection-key 分类键")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", default="users/0")
    parser.add_argument("--base-url", default="http://127.0.0.1:23119")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    collections = sub.add_parser("collections")
    collections.add_argument("--contains")
    collections.add_argument("--limit", type=int, default=100)
    search = sub.add_parser("search")
    search.add_argument("query")
    search.add_argument("--limit", type=int, default=30)
    create = sub.add_parser("create")
    ct = create.add_mutually_exclusive_group(required=True)
    ct.add_argument("--collection")
    ct.add_argument("--path-json")
    create.add_argument("--receipt")
    resolver = sub.add_parser("resolve")
    group = resolver.add_mutually_exclusive_group(required=True)
    group.add_argument("--doi")
    group.add_argument("--arxiv")
    group.add_argument("--import-file")
    resolver.add_argument("--out")
    add = sub.add_parser("add")
    source = add.add_mutually_exclusive_group(required=True)
    source.add_argument("--metadata")
    source.add_argument("--item-key")
    source.add_argument("--doi")
    source.add_argument("--arxiv")
    source.add_argument("--import-file")
    destination = add.add_mutually_exclusive_group(required=True)
    destination.add_argument("--collection")
    destination.add_argument("--collection-key")
    destination.add_argument("--path-json")
    add.add_argument("--create-collection", action="store_true")
    add.add_argument("--index", type=int)
    pdf = add.add_mutually_exclusive_group()
    pdf.add_argument("--pdf")
    pdf.add_argument("--pdf-url")
    add.add_argument("--receipt", required=True)
    args = parser.parse_args()
    client = Client(args.library, args.base_url)
    if args.command == "status":
        emit(client.call("status"))
    elif args.command == "collections":
        rows = client.call("collections")["collections"]
        if args.contains:
            rows = [
                r
                for r in rows
                if args.contains.casefold() in "/".join(r["path"]).casefold()
            ]
        limit = min(max(args.limit, 1), 1000)
        emit(
            {
                "collections": rows[:limit],
                "totalMatching": len(rows),
                "truncated": len(rows) > limit,
            }
        )
    elif args.command == "search":
        q = urllib.parse.urlencode(
            {"q": args.query, "limit": min(max(args.limit, 1), 100), "sort": "title"}
        )
        rows = client.request("/api/" + args.library + "/items?" + q)
        emit(
            [
                {
                    "key": i["key"],
                    "title": i["data"].get("title"),
                    "DOI": i["data"].get("DOI"),
                    "url": i["data"].get("url"),
                    "collections": i["data"].get("collections", []),
                }
                for i in rows
                if i["data"].get("itemType") not in ("attachment", "annotation", "note")
            ]
        )
    elif args.command == "create":
        emit(client.call("ensure-collection", **target(args)), args.receipt)
    elif args.command == "resolve":
        emit(resolve(client, args), args.out)
    elif args.command == "add":
        payload = {**target(args), "createCollection": args.create_collection}
        if args.item_key:
            payload["itemKey"] = args.item_key
        else:
            if args.metadata:
                raw = json.loads(Path(args.metadata).expanduser().read_text())
                if "records" in raw:
                    records = raw["records"]
                    index = args.index if args.index is not None else 0
                    if len(records) > 1 and args.index is None:
                        raise ValueError("有多条候选，请显式指定 --index（从 0 开始）")
                    record = records[index] if 0 <= index < len(records) else None
                    if not record:
                        raise ValueError("--index 超出解析结果范围")
                    raw = record["metadata"]
                payload["metadata"] = raw
            else:
                records = resolve(client, args)["records"]
                if len(records) > 1 and args.index is None:
                    raise ValueError(
                        "解析出多条记录，请先 resolve，再逐条指定 --index 导入"
                    )
                index = args.index if args.index is not None else 0
                if not 0 <= index < len(records):
                    raise ValueError("--index 超出解析结果范围")
                payload["metadata"] = records[index]["metadata"]
        if args.pdf:
            payload["pdfPath"] = str(Path(args.pdf).expanduser().resolve())
        if args.pdf_url:
            payload["pdfURL"] = args.pdf_url
        result = client.call("add", **payload)
        emit(result, args.receipt)
        print(
            json.dumps(
                {
                    "itemKey": result["itemKey"],
                    "created": result["created"],
                    "membershipAdded": result["membershipAdded"],
                    "pdf": result["pdf"]["status"],
                    "verified": result["verified"],
                },
                ensure_ascii=False,
            )
        )
        if result["pdf"]["status"] == "failed":
            return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(
            json.dumps(
                {
                    "error": str(e),
                    "note": "写入结果不确定时先查重和检查回执；不盲目重试，不改用 JavaScript 窗口。",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        sys.exit(1)
