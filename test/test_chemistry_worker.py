import base64
import importlib.util
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "python/chemistry_worker.py"
spec = importlib.util.spec_from_file_location("worker", path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ChemistryTests(unittest.TestCase):
    def test_para_edit(self):
        result = worker.edit({"smiles": "Brc1ccccc1", "operation": "add_para_methoxy", "anchorElement": "Br"})
        self.assertEqual(result["after"], "COc1ccc(Br)cc1")
        self.assertEqual(result["addedHeavyAtoms"], 2)
        with self.assertRaisesRegex(ValueError, "ambiguous_anchor"):
            worker.edit({"smiles": "Brc1ccc(Br)cc1", "operation": "add_para_methoxy"})

    def test_average_mass(self):
        result = worker.inspect("CCO")
        self.assertAlmostEqual(result["mw"], 46.069, places=3)
        self.assertAlmostEqual(result["exactMass"], 46.041864812)

    def test_hrms_ion_formula_is_converted_to_average_neutral_mass(self):
        result = worker.formula_properties({"formula": "C21H35O4", "adduct": "[M + H]+", "mz": 351.2530})
        self.assertEqual(result["formula"], "C21H34O4")
        self.assertAlmostEqual(result["mw"], 350.499, places=3)
        negative = worker.formula_properties({"formula": "C22H30O4F3", "adduct": "[M – H]-", "mz": 415.2091})
        self.assertEqual(negative["formula"], "C22H31F3O4")
        neutral = worker.formula_properties({"formula": "C21H34O4", "adduct": "[M+H]+", "mz": 351.2530})
        self.assertEqual(neutral["formula"], result["formula"])
        sodium = worker.formula_properties({"formula": "C2H6ONa", "adduct": "[M+Na]+", "mz": 69.0311})
        self.assertEqual(sodium["formula"], "C2H6O")
        with self.assertRaisesRegex(ValueError, "adduct_formula_conflict"):
            worker.formula_properties({"formula": "C21H35O4", "adduct": "[M+H]+", "mz": 300.1234})
        with self.assertRaisesRegex(ValueError, "unsupported_adduct"):
            worker.formula_properties({"formula": "C21H35O4", "adduct": "[2M+H]+", "mz": 700.0})
        with self.assertRaisesRegex(ValueError, "invalid_formula"):
            worker.formula_properties({"formula": "HF.Py"})

    def test_cdxml_and_real_image(self):
        result = worker.render_step({"reactants": ["COc1ccc(Br)c(NC(=O)CCCO)c1"], "products": ["COc1ccc(Br)c(NC(=O)CCCOC(C)=O)c1"], "aboveArrow": ["Ac2O, DMAP"], "belowArrow": ["CH2Cl2, rt, 12 h"]})
        self.assertIn("CH2Cl2, rt, 12 h", result["cdxml"])
        self.assertTrue(base64.b64decode(result["png"]).startswith(b"\x89PNG"))
        self.assertEqual(result["quality"]["graphRoundtrip"], "passed")

    def test_stereochemistry_is_read_back(self):
        result = worker.render_step({"reactants": ["N[C@@H](C)C(=O)O"], "products": ["N[C@@H](C)C(=O)OC"], "aboveArrow": [], "belowArrow": []})
        self.assertEqual(result["quality"]["stereoRoundtrip"], "passed")

    def test_reaction_and_conditions_fit_one_chemdraw_page(self):
        for reactant, product, above, below, atoms, bonds in (
            ("COc1ccc(Br)c(NC(=O)CCCO)c1", "COc1ccc(Br)c(NC(=O)CCCOC(C)=O)c1", ["Ac2O, Et3N, DMAP"], ["CH2Cl2", "0 °C to rt, 12 h"], 35, 35),
            ("COc1ccc(Br)c(NC(=O)CCCOC(C)=O)c1", "COc1ccc2oc(CCCOC(C)=O)nc2c1", ["CuI", "1,10-phenanthroline"], ["Cs2CO3, DME", "110 °C, 24 h"], 37, 38)
        ):
            result = worker.render_step({"reactants": [reactant], "products": [product], "aboveArrow": above, "belowArrow": below})
            root = ET.fromstring(result["cdxml"])
            page = root.find("page")
            self.assertEqual(page.get("WidthPages"), "1")
            self.assertEqual(page.get("HeightPages"), "1")
            self.assertEqual(page.get("BoundingBox"), "0 0 540 720")
            self.assertEqual(len(root.findall(".//n")), atoms)
            self.assertEqual(len(root.findall(".//b")), bonds)
            self.assertEqual(len(page.findall("arrow")), 1)
            self.assertEqual(["".join(run.text or "" for run in t.findall("s")) for t in page.findall("t")], above + below)
            self.assertEqual(root.get("InterpretChemically"), "no")
            self.assertTrue(all(t.get("InterpretChemically") == "no" for t in page.findall("t")))
            bounds = worker.cdxml_drawing_bounds(root)
            self.assertGreaterEqual(bounds[0], 23.99)
            self.assertGreaterEqual(bounds[1], 23.99)
            self.assertLessEqual(bounds[2], 516.01)
            self.assertLessEqual(bounds[3], 696.01)
            self.assertEqual(result["quality"]["cdxmlLayout"]["canvasFit"], "passed")

    def test_large_reaction_declares_all_needed_pages_without_tiny_labels(self):
        result = worker.render_step({"reactants": ["CCO"] * 5, "products": ["CCOC(C)=O"] * 5, "aboveArrow": ["Ac2O, DMAP"], "belowArrow": ["CH2Cl2, rt"]})
        root = ET.fromstring(result["cdxml"])
        page = root.find("page")
        self.assertGreater(int(page.get("WidthPages")), 1)
        self.assertEqual(len(root.findall(".//fragment")), 10)
        self.assertTrue(all(float(run.get("size")) >= 10 for run in root.findall(".//s")))
        bounds = worker.cdxml_drawing_bounds(root)
        canvas = list(map(float, page.get("BoundingBox").split()))
        self.assertLessEqual(bounds[2], canvas[2])
        self.assertLessEqual(bounds[3], canvas[3])

    def test_pdf_page_and_index(self):
        import pymupdf
        pdf = pymupdf.open()
        pdf.new_page().insert_text((40, 40), "Compound 16: Ac2O, 2.00 equiv")
        data = base64.b64encode(pdf.tobytes()).decode()
        index = worker.execute({"op": "pdf_index", "data": data})
        self.assertIn("2.00 equiv", index["pages"][0]["text"])
        page = worker.execute({"op": "pdf_page", "data": data, "page": 1})
        self.assertTrue(base64.b64decode(page["png"]).startswith(b"\x89PNG"))
        with self.assertRaisesRegex(ValueError, "invalid_pdf_page"):
            worker.execute({"op": "pdf_page", "data": data, "page": 2})

    def test_heading_crop_follows_a_scheme_across_a_page_break(self):
        import pymupdf
        with pymupdf.open() as pdf:
            previous = pdf.new_page()
            previous.draw_rect(pymupdf.Rect(100, 670, 440, 745))
            title_page = pdf.new_page()
            title_page.insert_text((90, 85), "Compound 19:")
            title_page.draw_rect(pymupdf.Rect(100, 590, 460, 690))
            result = worker.heading_crop(pdf, 2, "Compound 19")
            self.assertEqual(result["page"], 1)
            self.assertEqual(result["headingPage"], 2)
            self.assertGreater(result["bbox"][1], .7)
            self.assertLess(result["bbox"][3] - result["bbox"][1], .15)

    def test_heading_crop_is_tight_and_never_returns_blank_title_padding(self):
        import pymupdf
        with pymupdf.open() as pdf:
            page = pdf.new_page()
            page.draw_rect(pymupdf.Rect(100, 390, 450, 465))
            page.insert_text((90, 500), "Compound 20:")
            result = worker.heading_crop(pdf, 1, "Compound 20")
            self.assertEqual(result["page"], 1)
            self.assertLess(result["bbox"][3] - result["bbox"][1], .15)
        with pymupdf.open() as pdf:
            pdf.new_page().insert_text((90, 85), "Compound 19:")
            with self.assertRaisesRegex(ValueError, "reaction_graphic_not_found"):
                worker.heading_crop(pdf, 1, "Compound 19")


if __name__ == "__main__":
    unittest.main()
