"""Exercise the PDF pipeline with synthetic vector pages and no model calls."""
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import pymupdf as fitz

SPEC = importlib.util.spec_from_file_location("translator", Path(__file__).parents[1] / "bridge/translation/pdf.py")
PDF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PDF)


class TranslationPDF(unittest.TestCase):
    def test_typesetting_preserves_source_formula_art_and_all_translations(self):
        with TemporaryDirectory() as folder, fitz.open() as source:
            folder = Path(folder)
            original, plan, translations, target, mapping = [folder / name for name in
                ("source.pdf", "plan.json", "translations.json", "target.pdf", "map.json")]
            page = source.new_page(width=520, height=720)
            page.insert_text((30, 50), "Analysis of predictive control", fontsize=18)
            page.insert_text((30, 100), "The delay reduces the performance of the same", fontsize=11)
            page.insert_text((30, 116), "policy in the contact experiment [1].", fontsize=11)
            page.insert_text((45, 210), "E = m c^2 (1)", fontsize=14)
            page.draw_rect(fitz.Rect(40, 250, 340, 310), color=(0.1, 0.4, 0.7), fill=(0.8, 0.9, 1))
            page.insert_text((30, 338), "Results", fontsize=9)
            source.save(original)
            before = original.read_bytes()
            PDF.extract(original, plan)
            units = PDF.read_json(plan)["pages"][0]["units"]
            self.assertEqual(len(units), 3)
            self.assertIn("same policy", units[1]["text"])
            long = "这是必须完整保留的补译段落。" * 46
            PDF.write_json(translations, dict(zip((u["id"] for u in units), ["预测控制分析", "在接触实验中，时延降低了同一策略的性能 [1]。", long])))
            PDF.render(original, plan, translations, target, mapping)
            self.assertEqual(original.read_bytes(), before)
            result = json.loads(mapping.read_text())
            with fitz.open(target) as doc:
                main = doc[0]
                text = main.get_text()
                self.assertEqual(main.rect, page.rect)
                self.assertIn("预测控制分析", text)
                self.assertIn("E = m c^2", text)
                self.assertNotIn("The delay reduces", text)
                self.assertEqual(len(main.get_drawings()), 1)
                self.assertEqual(main.get_links()[0]["page"], 1)
                self.assertEqual(result["sourcePages"], 1)
                self.assertEqual(result["pages"][1]["source"], 0)
                self.assertIn("必须完整保留", doc[1].get_text())

    def test_wrapped_paragraph_stays_out_of_figure_and_exports_reusable_mapping(self):
        with TemporaryDirectory() as folder, fitz.open() as doc:
            folder = Path(folder)
            original, plan, translations, target, mapping = [folder / name for name in
                ("source.pdf", "plan.json", "translations.json", "source_cn.pdf", "map.json")]
            page = doc.new_page(width=480, height=620)
            figure = fitz.Rect(248, 56, 430, 153)
            page.draw_rect(figure, fill=(0.70, 0.78, 0.91), color=(0.2, 0.3, 0.4))
            page.insert_text((275, 90), "Figure artwork label", fontsize=10)
            for i, text in enumerate(("The demonstration is recorded", "next to the figure and continues", "with the same controller in a much wider paragraph below.")):
                page.insert_text((35, 130 + i * 17.5), text, fontsize=11)
            background = fitz.Rect(30, 250, 440, 321)
            page.draw_rect(background, fill=(0.96, 0.97, 0.98), color=None)
            page.insert_text((44, 278), "This abstract has a pale background.", fontsize=11)
            doc.save(original)
            PDF.extract(original, plan)
            units = PDF.read_json(plan)["pages"][0]["units"]
            self.assertEqual(len(units), 3)
            self.assertTrue(all(not PDF.intersects(fitz.Rect(unit["box"]), figure) for unit in units))
            chinese = ["演示数据记录在插图旁。", "正文随后在更宽的区域继续。", "摘要采用浅色背景。"]
            PDF.write_json(translations, dict(zip((unit["id"] for unit in units), chinese)))
            PDF.render(original, plan, translations, target, mapping)
            result = PDF.read_json(mapping)
            PDF.read_mapping(target, folder / "reopened.json")
            self.assertEqual(PDF.read_json(folder / "reopened.json"), result)
            self.assertEqual(result["sourceDigest"], PDF.source_digest(original))
            with fitz.open(target) as translated:
                self.assertEqual(len(translated), 1)
                self.assertEqual(translated[0].rect, page.rect)
                self.assertIn("Figure artwork label", translated[0].get_text())
                spans = [span for block in translated[0].get_text("dict")["blocks"] if block["type"] == 0
                         for line in block["lines"] for span in line["spans"]]
                for text in chinese:
                    matches = [span for span in spans if text in span["text"]]
                    self.assertEqual(len(matches), 1)
                    self.assertGreater(matches[0]["size"], 11)
                    self.assertFalse(PDF.intersects(fitz.Rect(matches[0]["bbox"]), figure))


if __name__ == "__main__":
    unittest.main()
