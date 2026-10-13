"""Replay synthetic end-to-end fixtures. Never a laboratory protocol or an OCR benchmark."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

import pymupdf
from rdkit import Chem
from rdkit.Chem import Draw, rdMolDescriptors
from chemistry_worker import render_step

ROOT = Path(__file__).resolve().parent.parent


def json_file(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def pdf_text(page, text, top=40):
    page.insert_textbox(pymupdf.Rect(35, top, 560, 790), text, fontsize=10)


def sources(case, output):
    directory = output / "sources"
    directory.mkdir()
    main = pymupdf.open()
    pdf_text(main.new_page(), f"SYNTHETIC TEST FIXTURE — NOT A PUBLISHED PAPER\n{case['title']}\nTargets: {', '.join(case['targets'])}\nThis fixture tests file generation and acceptance, not experimental feasibility or image recognition.")
    main.save(directory / "main.pdf", deflate=True)
    main.close()
    si = pymupdf.open()
    observations, experiments, steps = [], [], []
    lookup = {c["id"]: c for c in case["compounds"]}
    for index, compound in enumerate(case["compounds"], 1):
        mol = Chem.MolFromSmiles(compound["smiles"])
        formula = rdMolDescriptors.CalcMolFormula(mol)
        image = Draw.MolToImage(mol, size=(900, 420))
        stream = io.BytesIO()
        image.save(stream, format="PNG")
        page = si.new_page()
        page.insert_image(pymupdf.Rect(40, 65, 550, 303), stream=stream.getvalue())
        quote = f"Synthetic compound {compound['id']}: formula {formula}; specified centers {compound['centers']}; specified double bonds 0; components 1."
        if compound.get("relationship"):
            quote += f" {compound['id']} is an {compound['relationship']} of {compound['isomerOf']}; exactly one of two centers is inverted."
        pdf_text(page, "SYNTHETIC SI — NOT A LAB PROTOCOL\n" + compound["label"], 25)
        pdf_text(page, quote, 325)
        citation = {"sourceId": "si", "page": index, "quote": quote}
        observations.append({"id": compound["id"], "label": compound["label"], "origin": compound["origin"],
                             "sourceImage": {"sourceId": "si", "page": index, "bbox": [.05, .065, .95, .375]}, "citations": [citation],
                             "formula": {"formula": formula, "adduct": None, "mz": None},
                             "stereo": {"scope": "specified" if compound["centers"] else "achiral", "centers": compound["centers"], "doubleBonds": 0},
                             "components": 1, "isomerOf": compound.get("isomerOf"), "relationship": compound.get("relationship")})
    for order, experiment in enumerate(case["experiments"], 1):
        reactants = [lookup[c]["smiles"] for c in experiment["reactants"]]
        products = [lookup[c]["smiles"] for c in experiment["products"]]
        conditions = ["SYNTHETIC FIXTURE"]
        below = [experiment["handling"]]
        reaction = render_step({"reactants": reactants, "products": products, "aboveArrow": conditions, "belowArrow": below})
        page = si.new_page()
        page.insert_image(pymupdf.Rect(35, 70, 560, 270), stream=base64.b64decode(reaction["png"]), keep_proportion=True)
        quote = f"Synthetic experiment {experiment['id']}: {','.join(experiment['reactants'])} to {','.join(experiment['products'])}; handling {experiment['handling']}; {experiment['stages']} simulated stage(s). Reference basis 1.00 mmol is synthetic. No experimental conditions or measured yields are supplied."
        pdf_text(page, "SYNTHETIC SI — NOT A LAB PROTOCOL\n" + experiment["id"], 25)
        pdf_text(page, quote, 300)
        citation = {"sourceId": "si", "page": len(case["compounds"]) + order, "quote": quote}
        experiments.append({"id": experiment["id"], "paperStep": experiment["id"], "reactants": experiment["reactants"], "products": experiment["products"], "handling": experiment["handling"], "citations": [citation]})
        steps.append({"order": order, "paperStep": experiment["id"], "title": experiment["id"] + " synthetic fixture", "purpose": "仅用于工具与文件验收，非实验指导",
                      "reactants": reactants, "products": products, "reagents": [], "aboveArrow": conditions, "belowArrow": below,
                      "procedure": [f"合成测试阶段 {i+1}：未提供可执行实验操作。" for i in range(experiment["stages"])],
                      "workup": [], "purification": [], "characterization": ["测试固定结构，不是实测表征。"], "citations": [citation],
                      "referenceBasisMmol": 1, "referenceYield": None, "yieldScope": "combined (synthetic fixture)" if experiment["handling"] == "one-pot" else None,
                      "conflicts": ["本记录为合成测试材料，不能用于真实实验。"], "sourceImage": {"sourceId": "si", "page": citation["page"], "bbox": [.04, .07, .96, .33]}, "scaleMmol": None, "scaleBasisId": None})
    si.save(directory / "si.pdf", deflate=True)
    si.close()
    return {"compounds": observations, "experiments": experiments, "targets": case["targets"]}, {"title": case["title"], "intent": "完整重放合成测试材料", "requestedChanges": [], "steps": steps}


def run_case(case, output, node):
    output.mkdir()
    inventory, plan = sources(case, output)
    requests = output / "requests"
    requests.mkdir()
    vault = output / "vault"
    sequence = 0
    env = dict(os.environ, ORGANIC_LAB_PYTHON=sys.executable, PYTHONUTF8="1")

    def invoke(command, request, expected_error=None):
        nonlocal sequence
        sequence += 1
        path = requests / f"{sequence:03d}-{command}.json"
        json_file(path, request)
        result = subprocess.run([node, str(ROOT / "scripts" / "organic-lab.cjs"), command, "--request", str(path)], capture_output=True, encoding="utf-8", env=env, timeout=120)
        if expected_error:
            if result.returncode == 0 or expected_error not in result.stderr:
                raise RuntimeError(f"Expected {expected_error}, got {result.returncode}: {result.stdout} {result.stderr}")
            response = json.loads(result.stderr.strip())
        else:
            if result.returncode:
                raise RuntimeError(result.stderr)
            response = json.loads(result.stdout)
        json_file(path.with_suffix(".receipt.json"), response)
        return response

    location = {"vault": str(vault), "routeId": case["id"]}

    def call(tool, args, label=None, expected_error=None):
        return invoke("call", {**location, "tool": tool, "args": args, "callId": label or f"call-{sequence+1:03d}"}, expected_error)

    start = time.perf_counter()
    invoke("init", {**location, "prompt": case["title"], "sources": [{"id": "main", "path": str(output / "sources" / "main.pdf")}, {"id": "si", "path": str(output / "sources" / "si.pdf")}]})
    call("record_inventory", {"inventory": inventory})
    structures = [{"compoundId": c["id"], "smiles": c["smiles"]} for c in case["compounds"]]
    wrong = [dict(c) for c in structures]
    wrong[0]["smiles"] = "C"
    call("register_compounds", {"structures": wrong}, expected_error="compound_formula_mismatch")
    negative = ["compound_formula_mismatch"]
    if case["compounds"][0]["centers"]:
        wrong = [dict(c) for c in structures]
        wrong[0]["smiles"] = wrong[0]["smiles"].replace("@", "")
        call("register_compounds", {"structures": wrong}, expected_error="compound_stereo_mismatch")
        wrong = [dict(c) for c in structures]
        wrong[-1]["smiles"] = wrong[-2]["smiles"]
        call("register_compounds", {"structures": wrong}, expected_error="isomer_relationship_mismatch")
        negative += ["compound_stereo_mismatch", "isomer_relationship_mismatch"]
    call("register_compounds", {"structures": structures})
    incomplete = {**plan, "steps": plan["steps"][:-1]}
    call("record_route", {"plan": incomplete})
    call("bind_steps", {"bindings": [{"step": s["order"], "experimentId": s["paperStep"], "reagents": []} for s in incomplete["steps"]]})
    preflight = call("validate_plan", {})["result"]
    assert preflight["ready"] is False and any(i["code"] == "missing_experiment" for i in preflight["issues"])
    negative.append("missing_experiment")
    call("record_route", {"plan": plan})
    call("bind_steps", {"bindings": [{"step": s["order"], "experimentId": s["paperStep"], "reagents": []} for s in plan["steps"]]})
    assert call("validate_plan", {})["result"]["ready"] is True
    materialized = call("materialize_steps", {"steps": [s["order"] for s in plan["steps"]]})["result"]
    assert materialized["status"] == "saved", materialized
    delivery = call("validate_route", {})["result"]
    assert delivery["complete"] is True and delivery["verifiedEditableCdxml"] == len(plan["steps"]), delivery
    call("finish_route", {}, "finish")
    status = invoke("status", location)
    files = []
    for step in status["steps"]:
        artifact = step["artifacts"]
        for name in [artifact["image"], artifact["cdxml"], step["written"]]:
            path = vault / name
            files.append({"path": name, "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    image = vault / status["steps"][0]["artifacts"]["image"]
    original = image.read_bytes()
    image.write_bytes(b"full-page replacement pretending to be a reaction")
    call("finish_route", {}, "finish", expected_error="delivery_incomplete")
    negative.append("cached_finish_rejected_changed_png")
    image.write_bytes(original)
    assert call("validate_route", {})["result"]["complete"] is True
    call("finish_route", {}, "finish-restored")
    journal = json.loads((Path(status["directory"]) / "会话状态.json").read_text(encoding="utf-8"))
    assert all(s["scaleMmol"] is None and s["scaleBasisId"] is None for s in journal["plan"]["steps"])
    report = {"case": case["id"], "synthetic": True, "notAnOcrBenchmark": True, "modelRequests": status["modelRequests"], "delivery": delivery,
              "targets": inventory["targets"], "expectedSteps": len(plan["steps"]), "expectedCompounds": len(inventory["compounds"]),
              "files": files, "negativeChecks": negative, "concurrency": materialized["concurrency"], "seconds": round(time.perf_counter() - start, 3)}
    json_file(output / "report.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    if not output.is_absolute() or output.exists():
        parser.error("output must be an absolute, new directory; existing records are never overwritten")
    node = ROOT / "scripts" / "runtime" / "node.exe"
    node = str(node) if node.exists() else shutil.which("node")
    if not node:
        parser.error("Node runtime missing; run setup or install Node")
    output.mkdir(parents=True)
    reports = [run_case(json.loads(path.read_text(encoding="utf-8")), output / path.stem, node) for path in sorted((ROOT / "assets" / "examples").glob("*.json"))]
    json_file(output / "report.json", {"synthetic": True, "cases": reports})
    print(json.dumps({"output": str(output), "cases": [{"case": r["case"], "complete": r["delivery"]["complete"], "seconds": r["seconds"]} for r in reports]}))


if __name__ == "__main__":
    main()
