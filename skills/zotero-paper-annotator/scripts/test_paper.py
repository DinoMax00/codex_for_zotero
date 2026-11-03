"""Offline behavior checks using a generated PDF; no Zotero or model calls."""

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import pymupdf as fitz

spec = importlib.util.spec_from_file_location(
    "paper", Path(__file__).with_name("paper.py")
)
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
TITLE = (
    "Example Research: Learning a Compact World Model\nwith Reproducible Experiments"
)


class AnnotationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        pdf = Path(self.directory.name) / "fixture.pdf"
        with fitz.open() as doc:
            page = doc.new_page(width=612, height=792)
            page.insert_text((50, 70), TITLE, fontsize=14)
            page.insert_text(
                (50, 160),
                "The model predicts future states from observed actions.",
                fontsize=11,
            )
            doc.save(pdf)
        self.source = {
            "pdfPath": str(pdf),
            "pdfSha256": p.sha256(pdf),
            "attachmentKey": "TESTPDF1",
            "library": "users/0",
            "serverID": "test-instance",
        }
        self.candidate = {
            "pageIndex": 0,
            "quote": TITLE,
            "kind": "summary",
            "comment": "验证：标题全文总结。",
        }

    def test_normalization_preserves_ligature_and_dehyphenation_anchors(self):
        chars = [{"c": c} for c in "  efﬁcient world-\nmodel  "]
        text, mapping = p.normalize_with_map(chars)
        self.assertEqual(text, "efficient worldmodel")
        self.assertEqual(chars[mapping[text.index("ffi") + 1]]["c"], "ﬁ")
        self.assertEqual(chars[mapping[text.index("model")]]["c"], "m")

    def test_cross_line_title_has_separate_correct_native_rectangles(self):
        with fitz.open(self.source["pdfPath"]) as doc:
            anchor = p.find_anchor(doc[0], self.candidate)
            self.assertEqual(len(anchor["position"]["rects"]), 2)
            for rect in anchor["position"]["rects"]:
                r = fitz.Rect(rect) * doc[0].transformation_matrix
                self.assertGreater(r.width, 150)
                self.assertLess(r.height, 40)
                self.assertLess(r.y1, 180)

    def test_crop_and_rotation_round_trip(self):
        with fitz.open(self.source["pdfPath"]) as doc:
            page = doc[0]
            page.set_cropbox(
                fitz.Rect(10, 10, page.rect.width - 10, page.rect.height - 10)
            )
            page.set_rotation(90)
            anchor = p.find_anchor(page, self.candidate)
            for rect in anchor["position"]["rects"]:
                view = (
                    fitz.Rect(rect) * page.transformation_matrix * page.rotation_matrix
                )
                self.assertGreater(view.width, 0)
                self.assertGreater(view.height, 0)
                self.assertGreaterEqual(view.x0, -1)
                self.assertGreaterEqual(view.y0, -1)
                self.assertLessEqual(view.x1, page.rect.width + 1)
                self.assertLessEqual(view.y1, page.rect.height + 1)

    def test_unknown_or_ambiguous_original_is_not_guessed(self):
        with fitz.open(self.source["pdfPath"]) as doc:
            with self.assertRaisesRegex(ValueError, "未找到"):
                p.find_anchor(
                    doc[0],
                    {**self.candidate, "quote": "A nonexistent generated passage"},
                )
            # Repeated long text within the same in-memory page must be disambiguated.
            raw = doc[0].get_text("rawdict")
            block = next(b for b in raw["blocks"] if "lines" in b)
            first = copy.deepcopy(block["lines"][0])
            block["lines"].append(first)

            class RawPage:
                transformation_matrix = doc[0].transformation_matrix

                def get_text(self, *a, **k):
                    return raw

                def get_label(self):
                    return "1"

            quote = "".join(c["c"] for s in first["spans"] for c in s["chars"])
            with self.assertRaisesRegex(ValueError, "出现多次"):
                p.find_anchor(RawPage(), {**self.candidate, "quote": quote})

    def test_plan_is_native_append_only_and_rejects_changed_pdf(self):
        plan = p.build_plan(self.source, [self.candidate])
        item = plan["items"][0]
        self.assertEqual(item["version"], 0)
        self.assertEqual(item["parentItem"], self.source["attachmentKey"])
        self.assertEqual(item["itemType"], "annotation")
        self.assertEqual(item["tags"], [])
        self.assertEqual(item["annotationAuthorName"], "")
        self.assertEqual(len(item["codexAnchor"]), 24)
        self.assertRegex(item["key"], r"^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$")
        self.assertEqual(
            plan["items"], p.build_plan(self.source, [self.candidate])["items"]
        )
        with self.assertRaisesRegex(ValueError, "PDF 已变化"):
            p.build_plan({**self.source, "pdfSha256": "changed"}, [self.candidate])
        with self.assertRaisesRegex(ValueError, "重复"):
            p.build_plan(self.source, [self.candidate, self.candidate])

    def test_native_readback_and_user_edits_survive_rerun(self):
        plan = p.build_plan(self.source, [self.candidate])

        class FakeClient:
            server_id = self.source["serverID"]
            library = self.source["library"]
            prefix = "/api/users/0"

            def __init__(c):
                c.records = []
                c.writes = 0

            def resolve(c, key):
                return self.source

            def annotations(c, key):
                return copy.deepcopy(c.records)

            def append(c, source, data):
                c.writes += 1
                c.records = [
                    {
                        "key": i["key"],
                        "data": copy.deepcopy(i),
                        "codexAnchor": i["codexAnchor"],
                    }
                    for i in data
                ]
                return {
                    "success": {str(n): i["key"] for n, i in enumerate(data)},
                    "failed": {},
                }

        client = FakeClient()
        result = p.apply_plan(client, plan)
        self.assertEqual(len(result["created"]), 1)
        self.assertTrue(result["verified"])
        client.records[0]["data"]["annotationComment"] = "用户修改，必须保留"
        repeated = p.apply_plan(client, plan)
        self.assertEqual(repeated["created"], [])
        self.assertEqual(len(repeated["skipped"]), 1)
        self.assertEqual(client.writes, 1)
        self.assertEqual(
            client.records[0]["data"]["annotationComment"], "用户修改，必须保留"
        )
        tampered = copy.deepcopy(plan)
        tampered["items"][0]["parentItem"] = "WRONGKEY"
        with self.assertRaisesRegex(ValueError, "计划坐标或批注内容被改动"):
            p.apply_plan(client, tampered)

    def test_library_and_instance_mismatch_stops_before_write(self):
        class Client:
            def resolve(c, key):
                return {**self.source, "serverID": "different"}

        with self.assertRaisesRegex(ValueError, "实例或 PDF 已改变"):
            p.verify_source(Client(), self.source)

    def test_client_rejects_nonlocal_or_credential_forwarding_urls(self):
        for base in [
            "https://api.zotero.org",
            "http://evil.test:23119",
            "http://user:pass@127.0.0.1:23119",
            "http://127.0.0.1:23119/?token=x",
        ]:
            with self.assertRaises(ValueError):
                p.Client(base)


if __name__ == "__main__":
    unittest.main()
