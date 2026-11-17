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


if __name__ == "__main__":
    unittest.main()
