import base64
import copy
import hashlib
import io
import json
import math
import os
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from collections import Counter
from contextlib import ExitStack
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont
from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem, Descriptors, Draw, rdMolDescriptors, rdFMCS

RDLogger.DisableLog("rdApp.warning")


def molecule(smiles):
    if not isinstance(smiles, str) or not smiles.strip() or len(smiles) > 4000:
        raise ValueError("invalid_smiles: 需要具体分子结构")
    mol = Chem.MolFromSmiles(smiles)
    if mol is None or mol.GetNumAtoms() > 500:
        raise ValueError("invalid_smiles: 无法解析结构或原子数超限")
    return mol


def identity(mol):
    copy = Chem.Mol(mol)
    for atom in copy.GetAtoms():
        atom.SetAtomMapNum(0)
    return Chem.MolToSmiles(copy, isomericSmiles=True)


def stereo_summary(mol):
    Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    centers = [{"atom": i, "cip": label} for i, label in Chem.FindMolChiralCenters(mol, includeUnassigned=True) if label != "?"]
    double_bonds = [{"bond": b.GetIdx(), "stereo": str(b.GetStereo())} for b in mol.GetBonds() if b.GetStereo() in (Chem.BondStereo.STEREOE, Chem.BondStereo.STEREOZ, Chem.BondStereo.STEREOCIS, Chem.BondStereo.STEREOTRANS)]
    return {"centers": centers, "doubleBonds": double_bonds}


def component_identities(molecules):
    return Counter(identity(part) for mol in molecules for part in Chem.GetMolFrags(mol, asMols=True))


def isomer_relationship(first, second, relationship):
    a, b = molecule(first), molecule(second)
    plain_a, plain_b = Chem.Mol(a), Chem.Mol(b)
    Chem.RemoveStereochemistry(plain_a)
    Chem.RemoveStereochemistry(plain_b)
    if identity(plain_a) != identity(plain_b):
        raise ValueError("isomer_graph_mismatch: 差向异构体/对映体必须保持连接、同位素和盐型")
    Chem.AssignStereochemistry(a, cleanIt=True, force=True)
    Chem.AssignStereochemistry(b, cleanIt=True, force=True)
    possibilities = set()
    matches = b.GetSubstructMatches(a, useChirality=False, uniquify=False, maxMatches=257)
    if len(matches) > 256:
        raise ValueError("isomer_mapping_ambiguous: 对称性导致映射过多，需要核对具体位点")
    for match in matches:
        differences, assigned, lost = 0, 0, False
        for atom in a.GetAtoms():
            counterpart = b.GetAtomWithIdx(match[atom.GetIdx()])
            left = atom.GetProp("_CIPCode") if atom.HasProp("_CIPCode") else None
            right = counterpart.GetProp("_CIPCode") if counterpart.HasProp("_CIPCode") else None
            if (left is None) != (right is None):
                lost = True
            if left is not None and right is not None:
                assigned += 1
                differences += left != right
        for bond in a.GetBonds():
            other = b.GetBondBetweenAtoms(match[bond.GetBeginAtomIdx()], match[bond.GetEndAtomIdx()])
            if bond.GetStereo() != other.GetStereo():
                lost = True
        if not lost:
            possibilities.add((differences, assigned))
    if len(possibilities) != 1:
        raise ValueError("isomer_mapping_ambiguous: 立体映射不唯一或立体信息丢失")
    differences, assigned = possibilities.pop()
    valid = assigned > 1 and differences == 1 if relationship == "epimer" else assigned > 0 and differences == assigned
    if not valid:
        raise ValueError(f"isomer_relationship_mismatch: {relationship} 实际翻转{differences}/{assigned}个中心")
    return {"relationship": relationship, "invertedCenters": differences, "specifiedCenters": assigned}


def verify_compounds(request):
    observations = {c["id"]: c for c in request["observations"]}
    structures = {c["id"]: c["smiles"] for c in request["structures"]}
    if not observations or len(observations) != len(request["observations"]) or set(observations) != set(structures) or len(structures) != len(request["structures"]) or len(structures) > 160:
        raise ValueError("compound_batch_invalid")
    output = []
    for cid, smiles in structures.items():
        observation = observations[cid]
        mol = molecule(smiles)
        formula = rdMolDescriptors.CalcMolFormula(mol)
        if observation.get("components") is not None and observation["components"] != len(Chem.GetMolFrags(mol)):
            raise ValueError(f"compound_component_mismatch: {cid} 盐型/组分数量与来源观察不一致")
        source_formula = observation.get("formula")
        if source_formula:
            calculated = formula_properties(source_formula)
            if calculated["formula"] != formula:
                raise ValueError(f"compound_formula_mismatch: {cid} 来源式{calculated['formula']}，候选结构式{formula}")
        stereo = stereo_summary(mol)
        expected = observation["stereo"]
        if expected["scope"] in ("specified", "relative") and (expected["centers"] is None or expected["doubleBonds"] is None):
            raise ValueError(f"stereo_observation_missing: {cid}")
        for field, actual in (("centers", len(stereo["centers"])), ("doubleBonds", len(stereo["doubleBonds"]))):
            count = 0 if expected["scope"] in ("achiral", "unspecified") else expected[field]
            if count is not None and count != actual:
                raise ValueError(f"compound_stereo_mismatch: {cid} 来源明确{count}个{field}，候选{actual}个；不能补造或丢失构型")
        if observation.get("isomerOf"):
            parent = structures.get(observation["isomerOf"])
            if parent is None:
                raise ValueError(f"isomer_parent_missing: {cid} 需先登记或同时提交{observation['isomerOf']}")
            isomer_relationship(parent, smiles, observation["relationship"])
        output.append({"id": cid, "smiles": identity(mol), "formula": formula, "mw": Descriptors.MolWt(mol),
                       "stereoCenters": len(stereo["centers"]), "stereoDoubleBonds": len(stereo["doubleBonds"])})
    return {"compounds": output}


def check_bound_structures(request):
    if "expectedReactants" not in request:
        return
    def changed(smiles):
        current = identity(molecule(smiles))
        for edit in request.get("edits", []):
            if current == identity(molecule(edit["before"])):
                current = identity(molecule(edit["after"]))
        return current
    for field, expected in (("reactants", "expectedReactants"), ("products", "expectedProducts")):
        if Counter(identity(molecule(s)) for s in request[field]) != Counter(changed(s) for s in request[expected]):
            raise ValueError("bound_structure_mismatch: 本步结构与登记化合物/原生编辑回执不一致")
    for row in request.get("reagentStructures", []):
        if not row.get("actual") or not row.get("expected") or identity(molecule(row["actual"])) != changed(row["expected"]):
            raise ValueError(f"reagent_structure_mismatch: {row['id']} 与化合物绑定不一致")
        mol = molecule(row["actual"])
        if row.get("mw") is not None and (not isinstance(row["mw"], (int, float)) or not math.isfinite(row["mw"]) or abs(row["mw"] - Descriptors.MolWt(mol)) > .02):
            raise ValueError(f"reagent_mw_mismatch: {row['id']} 的平均MW与实际结构不一致")
        if row.get("formula") is not None and row["formula"] != rdMolDescriptors.CalcMolFormula(mol):
            raise ValueError(f"reagent_formula_mismatch: {row['id']} 的分子式与实际结构不一致")


def inspect(smiles):
    mol = molecule(smiles)
    Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    return {
        "smiles": identity(mol), "formula": rdMolDescriptors.CalcMolFormula(mol),
        "mw": Descriptors.MolWt(mol), "exactMass": rdMolDescriptors.CalcExactMolWt(mol),
        "atoms": [{"index": a.GetIdx(), "element": a.GetSymbol(), "aromatic": a.GetIsAromatic(),
                   "hydrogens": a.GetTotalNumHs(), "neighbors": [n.GetIdx() for n in a.GetNeighbors()],
                   "cip": a.GetProp("_CIPCode") if a.HasProp("_CIPCode") else None} for a in mol.GetAtoms()],
        "bonds": [{"from": b.GetBeginAtomIdx(), "to": b.GetEndAtomIdx(), "order": b.GetBondTypeAsDouble()} for b in mol.GetBonds()],
    }


def formula_properties(request):
    formula = unicodedata.normalize("NFKC", request["formula"]).replace(" ", "")
    if len(formula) > 200 or not re.fullmatch(r"(?:[A-Z][a-z]?\d*)+", formula):
        raise ValueError("invalid_formula: 需要明确的实际投料物分子式，不支持电荷、同位素或配方简写")
    table = Chem.GetPeriodicTable()
    elements = {table.GetElementSymbol(i) for i in range(1, 119)}
    counts = Counter()
    for element, count in re.findall(r"([A-Z][a-z]?)(\d*)", formula):
        amount = int(count or 1)
        if element not in elements or amount < 1 or amount > 1000:
            raise ValueError("invalid_formula")
        counts[element] += amount
    exact = sum(table.GetMostCommonIsotopeMass(e) * n for e, n in counts.items())
    conversion = "actual-material-formula"
    adduct = request.get("adduct")
    if adduct is not None:
        adduct = unicodedata.normalize("NFKC", adduct).replace(" ", "").replace("–", "-").replace("−", "-")
        rules = {"[M+H]+": ("H", 1), "[M-H]-": ("H", -1), "[M+Na]+": ("Na", 1)}
        if adduct not in rules or not isinstance(request.get("mz"), (int, float)) or not math.isfinite(request["mz"]):
            raise ValueError("unsupported_adduct: 需要可核对的单电荷HRMS加合物及calcd m/z")
        element, direction = rules[adduct]
        electron = .000548579909
        if abs(exact - direction * electron - request["mz"]) < .003:
            counts[element] -= direction
            if counts[element] < 0:
                raise ValueError("adduct_formula_conflict")
            conversion = f"ion-formula-to-neutral:{adduct}"
        elif abs(exact + direction * (table.GetMostCommonIsotopeMass(element) - electron) - request["mz"]) < .003:
            conversion = f"neutral-formula-confirmed:{adduct}"
        else:
            raise ValueError("adduct_formula_conflict: 分子式与calcd m/z不匹配，不能自动认作中性分子式")
    ordered = (["C", "H"] + sorted(e for e in counts if e not in ("C", "H"))) if counts["C"] else sorted(counts)
    neutral = "".join(e + (str(counts[e]) if counts[e] != 1 else "") for e in ordered if counts[e] > 0)
    return {"formula": neutral, "mw": round(sum(table.GetAtomicWeight(e) * n for e, n in counts.items()), 6),
            "conversion": conversion, "method": "RDKit average atomic weights"}


def edit(request):
    before = molecule(request["smiles"])
    operation = request["operation"]
    mol = Chem.RWMol(before)
    index = request.get("atomIndex")
    if operation == "add_para_methoxy":
        anchor = request.get("anchorElement") or "Br"
        anchors = [a for a in before.GetAtoms() if a.GetSymbol() == anchor]
        if len(anchors) != 1 or len(anchors[0].GetNeighbors()) != 1:
            raise ValueError("ambiguous_anchor: 参照原子不唯一，请定位具体分子")
        carbon = anchors[0].GetNeighbors()[0].GetIdx()
        rings = [r for r in before.GetRingInfo().AtomRings() if len(r) == 6 and carbon in r
                 and all(before.GetAtomWithIdx(i).GetIsAromatic() and before.GetAtomWithIdx(i).GetAtomicNum() == 6 for i in r)]
        if len(rings) != 1:
            raise ValueError("ambiguous_ring: 需要唯一的全碳六元芳香环")
        ring = rings[0]
        index = ring[(ring.index(carbon) + 3) % 6]
        group = "OC"
    elif operation == "add_group":
        group = {"methoxy": "OC", "methyl": "C", "hydroxy": "O", "fluoro": "F", "chloro": "Cl", "bromo": "Br"}.get(request.get("group"))
        if not group:
            raise ValueError("unsupported_group: 支持 methoxy/methyl/hydroxy/fluoro/chloro/bromo")
    elif operation == "replace_atom":
        element = request.get("element")
        if element not in ("C", "N", "O", "S", "F", "Cl", "Br", "I", "P", "Si"):
            raise ValueError("unsupported_element")
        if not isinstance(index, int) or index < 0 or index >= before.GetNumAtoms():
            raise ValueError("invalid_atom_index")
        mol.GetAtomWithIdx(index).SetAtomicNum(Chem.GetPeriodicTable().GetAtomicNumber(element))
        group = None
    else:
        raise ValueError("unsupported_edit")
    if group:
        if not isinstance(index, int) or index < 0 or index >= before.GetNumAtoms():
            raise ValueError("invalid_atom_index")
        site = before.GetAtomWithIdx(index)
        if site.GetTotalNumHs() < 1:
            raise ValueError("occupied_site: 位点没有可替换的 H")
        mol.GetAtomWithIdx(index).SetNumExplicitHs(max(0, site.GetNumExplicitHs() - 1))
        fragment = molecule(group)
        offset = mol.GetNumAtoms()
        for atom in fragment.GetAtoms():
            mol.AddAtom(Chem.Atom(atom))
        for bond in fragment.GetBonds():
            mol.AddBond(offset + bond.GetBeginAtomIdx(), offset + bond.GetEndAtomIdx(), bond.GetBondType())
        mol.AddBond(index, offset, Chem.BondType.SINGLE)
    after = mol.GetMol()
    Chem.SanitizeMol(after)
    return {"before": identity(before), "after": identity(after), "site": index,
            "addedHeavyAtoms": after.GetNumHeavyAtoms() - before.GetNumHeavyAtoms(),
            "beforeFormula": rdMolDescriptors.CalcMolFormula(before), "afterFormula": rdMolDescriptors.CalcMolFormula(after),
            "properties": inspect(identity(after)), "imageFidelity": "needsReview"}


def text(page, uid, x, y, value, center=True):
    node = ET.SubElement(page, "t", id=str(uid), p=f"{x:.3f} {y:.3f}",
                         CaptionJustification="Center" if center else "Left", Justification="Center" if center else "Left",
                         InterpretChemically="no")
    ET.SubElement(node, "s", font="3", size="10").text = value
    return uid


def fragment(page, mol, uid, center_x, center_y):
    copy = Chem.Mol(mol)
    if any(a.GetNumRadicalElectrons() for a in copy.GetAtoms()) or copy.GetStereoGroups():
        raise ValueError("unsupported_depiction: 自由基或增强立体组暂不能可靠导出")
    Chem.Kekulize(copy, clearAromaticFlags=True)
    AllChem.Compute2DCoords(copy)
    Chem.WedgeMolBonds(copy, copy.GetConformer())
    conf = copy.GetConformer()
    xs = [conf.GetAtomPosition(i).x for i in range(copy.GetNumAtoms())]
    ys = [conf.GetAtomPosition(i).y for i in range(copy.GetNumAtoms())]
    scale = min(18.0, 250 / max(max(xs) - min(xs), max(ys) - min(ys), 1))
    fragment_id = uid
    uid += 1
    frag = ET.SubElement(page, "fragment", id=str(fragment_id))
    ids = {}
    for atom in copy.GetAtoms():
        ids[atom.GetIdx()] = uid
        pos = conf.GetAtomPosition(atom.GetIdx())
        x = center_x + (pos.x - (max(xs) + min(xs)) / 2) * scale
        y = center_y - (pos.y - (max(ys) + min(ys)) / 2) * scale
        attributes = {"id": str(uid), "p": f"{x:.5f} {y:.5f}", "Element": str(atom.GetAtomicNum())}
        if atom.GetFormalCharge():
            attributes["Charge"] = str(atom.GetFormalCharge())
        if atom.GetIsotope():
            attributes["Isotope"] = str(atom.GetIsotope())
        if atom.GetAtomicNum() != 6:
            attributes["NumHydrogens"] = str(atom.GetTotalNumHs())
        node = ET.SubElement(frag, "n", **attributes)
        uid += 1
        if atom.GetAtomicNum() != 6:
            label = atom.GetSymbol() + ("H" if atom.GetTotalNumHs() == 1 else f"H{atom.GetTotalNumHs()}" if atom.GetTotalNumHs() else "")
            t = ET.SubElement(node, "t", id=str(uid), p=f"{x - 3:.5f} {y + 3:.5f}")
            ET.SubElement(t, "s", font="3", size="10", face="96").text = label
            uid += 1
    for bond in copy.GetBonds():
        attributes = {"id": str(uid), "B": str(ids[bond.GetBeginAtomIdx()]), "E": str(ids[bond.GetEndAtomIdx()]), "Order": str(int(bond.GetBondTypeAsDouble()))}
        if bond.GetBondDir() == Chem.BondDir.BEGINWEDGE:
            attributes["Display"] = "WedgeBegin"
        elif bond.GetBondDir() == Chem.BondDir.BEGINDASH:
            attributes["Display"] = "WedgedHashBegin"
        ET.SubElement(frag, "b", **attributes)
        uid += 1
    return fragment_id, uid


@lru_cache(maxsize=32)
def caption_font(size):
    for candidate in (Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/arial.ttf",
                      Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")):
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default(size=size)


def cdxml_drawing_bounds(root):
    boxes = []
    for atom in root.findall(".//n"):
        if "p" in atom.attrib:
            x, y = map(float, atom.attrib["p"].split())
            label = "".join(run.text or "" for run in atom.findall("t/s"))
            extra = 4 if atom.get("Charge") or atom.get("Isotope") else 0
            padding = max(10, len(label) * 4) + extra
            boxes.append((x - padding, y - 12, x + padding, y + 12))
    for caption in root.findall("page/t"):
        x, y = map(float, caption.attrib["p"].split())
        size = max(float(run.get("size", "10")) for run in caption.findall("s"))
        font = caption_font(round(size * 4))
        lines = "".join(run.text or "" for run in caption.findall("s")).splitlines() or [""]
        width = max(font.getlength(line) for line in lines) / 4
        left = x - width / 2 if caption.get("Justification") == "Center" else x
        boxes.append((left - 3, y - size - 3, left + width + 3, y + (len(lines) - 1) * size * 1.25 + 4))
    for arrow in root.findall("page/arrow"):
        points = [list(map(float, arrow.attrib[key].split()))[:2] for key in ("Head3D", "Tail3D")]
        boxes.append((min(p[0] for p in points) - 4, min(p[1] for p in points) - 4,
                      max(p[0] for p in points) + 4, max(p[1] for p in points) + 4))
    if not boxes:
        raise ValueError("cdxml_empty_drawing")
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def fit_cdxml_canvas(root):
    page_width, page_height, margin = 540, 720, 24
    positions = [(node, key, list(map(float, node.attrib[key].split())))
                 for node in root.iter() for key in ("p", "Head3D", "Tail3D") if key in node.attrib]

    def transform(scale, dx=0, dy=0):
        for node, key, point in positions:
            node.set(key, f"{point[0] * scale + dx:.5f} {point[1] * scale + dy:.5f}" + (" 0" if len(point) == 3 else ""))

    def fits(scale):
        transform(scale)
        bounds = cdxml_drawing_bounds(root)
        return bounds[2] - bounds[0] <= page_width - 2 * margin - 1 and bounds[3] - bounds[1] <= page_height - 2 * margin - 1

    scale = .5
    if fits(1):
        scale = 1
    elif fits(scale):
        low, high = scale, 1
        for _ in range(24):
            mid = (low + high) / 2
            if fits(mid):
                low = mid
            else:
                high = mid
        scale = low
    transform(scale)
    bounds = cdxml_drawing_bounds(root)
    transform(scale, margin - bounds[0], margin - bounds[1])
    bounds = cdxml_drawing_bounds(root)
    columns = max(1, math.ceil((bounds[2] + margin) / page_width))
    rows = max(1, math.ceil((bounds[3] + margin) / page_height))
    page = root.find("page")
    page.set("BoundingBox", f"0 0 {columns * page_width} {rows * page_height}")
    page.set("WidthPages", str(columns)); page.set("HeightPages", str(rows))
    root.set("BoundingBox", " ".join(f"{value:.5f}" for value in bounds))
    root.set("BondLength", f"{27 * scale:.5f}")
    for arrow in page.findall("arrow"):
        points = [list(map(float, arrow.attrib[key].split()))[:2] for key in ("Head3D", "Tail3D")]
        arrow.set("BoundingBox", " ".join(f"{v:.5f}" for v in (min(p[0] for p in points) - 4, min(p[1] for p in points) - 4,
                                                                    max(p[0] for p in points) + 4, max(p[1] for p in points) + 4)))
    if not all(math.isfinite(v) for v in bounds) or bounds[0] < 0 or bounds[1] < 0 or bounds[2] > columns * page_width or bounds[3] > rows * page_height:
        raise ValueError("cdxml_canvas_overflow: 图形或条件文字超出声明的页面")
    return {"canvasFit": "passed", "drawingBounds": bounds, "pageBounds": [0, 0, columns * page_width, rows * page_height],
            "widthPages": columns, "heightPages": rows, "coordinateScale": scale, "captionInterpretation": "disabled"}


def reaction_layout(request):
    font = ImageFont.load_default(size=20)
    for candidate in (Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/msyh.ttc", Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")):
        if candidate.is_file():
            font = ImageFont.truetype(str(candidate), 20)
            break

    def lines(values):
        output = []
        for value in values:
            if not isinstance(value, str) or len(value) > 2000:
                raise ValueError("conditions_invalid: 条件文字必须为不超过2000字的字符串")
            for line in value.splitlines() or [""]:
                current = ""
                for character in line:
                    if current and font.getlength(current + character) > 560:
                        output.append(current.strip())
                        current = ""
                    current += character
                output.append(current.strip())
        if len(output) > 24:
            raise ValueError("conditions_too_long: 请将实验操作放入procedure，仅在箭头处保留反应条件")
        return output

    above, below = lines(request.get("aboveArrow", [])), lines(request.get("belowArrow", []))
    gap = max(350, math.ceil(max((font.getlength(line) for line in above + below), default=0)) + 40)
    center = max(170, 70 + len(above) * 27)
    height = center + max(170, 70 + len(below) * 27)
    return font, above, below, gap, center, height


def reaction_png(request, reactants, products):
    font, above, below, gap, center, height = reaction_layout(request)
    width = (len(reactants) + len(products)) * 330 + gap
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    for i, mol in enumerate(reactants + products):
        x = 165 + i * 330 + (gap if i >= len(reactants) else 0)
        tile = Draw.MolToImage(mol, size=(310, 280))
        image.paste(tile.convert("RGB"), (int(x - 155), center - 140))
    tail, head = len(reactants) * 330, len(reactants) * 330 + gap
    draw.line((tail, center, head, center), fill="black", width=3)
    draw.polygon(((head, center), (head - 12, center - 6), (head - 12, center + 6)), fill="black")
    for i, value in enumerate(above):
        draw.text(((tail + head) / 2, center - 35 - (len(above) - 1 - i) * 27), value, font=font, anchor="mm", fill="black")
    for i, value in enumerate(below):
        draw.text(((tail + head) / 2, center + 33 + i * 27), value, font=font, anchor="mm", fill="black")
    ink = ImageChops.difference(image, Image.new("RGB", image.size, "white")).getbbox()
    if not ink:
        raise ValueError("reaction_image_empty")
    # Crop to the actual reaction, keeping 20 px of padding on each edge.
    image = image.crop(ink)
    padded = Image.new("RGB", (image.width + 40, image.height + 40), "white")
    padded.paste(image, (20, 20))
    png = io.BytesIO()
    padded.save(png, "PNG")
    return png.getvalue(), {"kind": "single-reaction", "width": padded.width, "height": padded.height,
                            "paddingPx": 20, "inkBounds": [20, 20, padded.width - 20, padded.height - 20]}


def render_step(request):
    check_bound_structures(request)
    reactants = [molecule(s) for s in request["reactants"]]
    products = [molecule(s) for s in request["products"]]
    if not reactants or not products or len(reactants) + len(products) > 12:
        raise ValueError("structure_missing: 需要明确的反应物与产物，不能从名称猜结构")
    _, above, below, gap, center, height = reaction_layout(request)
    width = (len(reactants) + len(products)) * 330 + gap
    root = ET.Element("CDXML", BondLength="18", LabelFont="3", LabelSize="10", LabelFace="96", CaptionFont="3", CaptionSize="10",
                      CaptionFace="0", LineWidth="0.6", BondSpacing="18", InterpretChemically="no", PrintMargins="36 36 36 36")
    table = ET.SubElement(root, "fonttable")
    ET.SubElement(table, "font", id="3", name="Arial", charset="utf-8")
    page = ET.SubElement(root, "page", id="1", BoundingBox=f"0 0 {width} {height}")
    ids, uid, xs = [], 10, []
    for i, mol in enumerate(reactants + products):
        x = 165 + i * 330 + (gap if i >= len(reactants) else 0)
        fid, uid = fragment(page, mol, uid, x, center)
        ids.append(fid)
        xs.append(x)
    tail = len(reactants) * 330
    head = tail + gap
    arrow = uid
    ET.SubElement(page, "arrow", id=str(uid), Head3D=f"{head} {center} 0", Tail3D=f"{tail} {center} 0", ArrowheadHead="Full", ArrowheadType="Solid", HeadSize="1000", FillType="None")
    uid += 1
    tops, bottoms = [], []
    for i, value in enumerate(above):
        tops.append(text(page, uid, (tail + head) / 2, center - 35 - (len(above) - 1 - i) * 27, value))
        uid += 1
    for i, value in enumerate(below):
        bottoms.append(text(page, uid, (tail + head) / 2, center + 33 + i * 27, value))
        uid += 1
    scheme = ET.SubElement(page, "scheme", id=str(uid))
    ET.SubElement(scheme, "step", id=str(uid + 1), ReactionStepReactants=" ".join(map(str, ids[:len(reactants)])), ReactionStepProducts=" ".join(map(str, ids[len(reactants):])), ReactionStepArrows=str(arrow), ReactionStepObjectsAboveArrow=" ".join(map(str, tops)), ReactionStepObjectsBelowArrow=" ".join(map(str, bottoms)))
    layout = fit_cdxml_canvas(root)
    ET.indent(root)
    cdxml = ET.tostring(root, encoding="utf-8", xml_declaration=True).decode("utf-8")
    parsed = Chem.MolsFromCDXML(cdxml)
    if component_identities(parsed) != component_identities(reactants + products):
        raise ValueError("cdxml_roundtrip_failed: 导出改变了结构或立体化学")
    png, image_layout = reaction_png(request, reactants, products)
    return {"cdxml": cdxml, "png": base64.b64encode(png).decode(), "properties": [inspect(identity(m)) for m in reactants + products],
            "quality": {"graphRoundtrip": "passed", "sourceImageFidelity": "not-machine-verified", "stereoRoundtrip": "passed", "cdxmlLayout": layout,
                        "reactionImage": image_layout}}


def verify_step_artifacts(request):
    check_bound_structures(request)
    expected = [molecule(s) for s in request["reactants"] + request["products"]]
    if not request["reactants"] or not request["products"] or len(expected) > 12:
        raise ValueError("structure_missing: 每一步必须有反应物和产物结构")
    cdxml = request["cdxml"]
    if not isinstance(cdxml, str) or len(cdxml) > 5_000_000 or "<!" in cdxml:
        raise ValueError("cdxml_invalid: 不接受DTD、实体或超大文档")
    root = ET.fromstring(cdxml)
    if root.tag != "CDXML" or len(root.findall("page")) != 1:
        raise ValueError("cdxml_not_editable: 需要原生单反应CDXML")
    allowed = {"CDXML", "fonttable", "font", "colortable", "color", "page", "fragment", "n", "b", "t", "s", "arrow", "scheme", "step"}
    if any(element.tag not in allowed for element in root.iter()):
        raise ValueError("cdxml_not_editable: 不接受嵌入图片、对象或未知节点")
    page = root.find("page")
    fragments = page.findall("fragment")
    steps = page.findall("scheme/step")
    if len(fragments) != len(expected) or not root.findall(".//n") or len(steps) != 1 or len(page.findall("arrow")) != 1:
        raise ValueError("cdxml_not_editable: 缺少原生分子图或唯一反应步骤")
    ids = [node.get("id") for node in root.iter() if node.get("id") is not None and node.tag not in ("font", "color")]
    if len(ids) != len(set(ids)):
        raise ValueError("cdxml_invalid: 节点ID重复")
    for fragment_element in fragments:
        coordinates = {node.get("id"): list(map(float, node.get("p", "").split())) for node in fragment_element.findall("n")}
        if any(len(point) != 2 or not all(math.isfinite(v) for v in point) for point in coordinates.values()):
            raise ValueError("cdxml_geometry_invalid: 原子坐标无效")
        for bond in fragment_element.findall("b"):
            begin, end = coordinates.get(bond.get("B")), coordinates.get(bond.get("E"))
            if begin is None or end is None or math.dist(begin, end) < 0.01:
                raise ValueError("cdxml_geometry_invalid: 键引用错误或原子坐标重叠")
    scheme = steps[0]
    for field, smiles in (("ReactionStepReactants", request["reactants"]), ("ReactionStepProducts", request["products"])):
        references = scheme.get(field, "").split()
        selected = [fragment for reference in references for fragment in fragments if fragment.get("id") == reference]
        if len(selected) != len(smiles) or len(set(references)) != len(references):
            raise ValueError("cdxml_reaction_mismatch: 反应物或产物链接缺失")
        subset = ET.Element("CDXML", root.attrib)
        subset_page = ET.SubElement(subset, "page", page.attrib)
        for fragment_element in selected:
            subset_page.append(copy.deepcopy(fragment_element))
        actual = Chem.MolsFromCDXML(ET.tostring(subset, encoding="unicode"))
        if component_identities(actual) != component_identities([molecule(s) for s in smiles]):
            raise ValueError("cdxml_graph_mismatch: 原子、键、反应方向或立体化学与本步结构不一致")
    if set(scheme.get("ReactionStepReactants", "").split() + scheme.get("ReactionStepProducts", "").split()) != {f.get("id") for f in fragments}:
        raise ValueError("cdxml_reaction_mismatch: 存在未关联或复用的分子图")
    arrow_ids = scheme.get("ReactionStepArrows", "").split()
    if arrow_ids != [page.find("arrow").get("id")]:
        raise ValueError("cdxml_reaction_mismatch: 反应箭头未关联")
    _, above, below, _, _, _ = reaction_layout(request)
    for field, lines in (("ReactionStepObjectsAboveArrow", above), ("ReactionStepObjectsBelowArrow", below)):
        values = []
        for reference in scheme.get(field, "").split():
            matches = [t for t in page.findall("t") if t.get("id") == reference]
            if len(matches) != 1:
                raise ValueError("cdxml_conditions_mismatch")
            values.append("".join(run.text or "" for run in matches[0].findall("s")))
        if values != lines:
            raise ValueError("cdxml_conditions_mismatch: 条件文字与本步记录不一致")
    bounds = cdxml_drawing_bounds(root)
    canvas = list(map(float, page.get("BoundingBox", "").split()))
    if len(canvas) != 4 or not all(math.isfinite(v) for v in bounds + canvas) or bounds[0] < canvas[0] or bounds[1] < canvas[1] or bounds[2] > canvas[2] or bounds[3] > canvas[3]:
        raise ValueError("cdxml_canvas_overflow")
    data = base64.b64decode(request["png"], validate=True)
    if len(data) > 10_000_000:
        raise ValueError("reaction_image_too_large")
    expected_png, image_layout = reaction_png(request, expected[:len(request["reactants"])], expected[len(request["reactants"]):])
    with Image.open(io.BytesIO(data)) as actual_image, Image.open(io.BytesIO(expected_png)) as reference_image:
        if actual_image.format != "PNG" or actual_image.size != reference_image.size or actual_image.convert("RGB").tobytes() != reference_image.tobytes():
            raise ValueError("reaction_image_mismatch: 图库必须使用本步本地生成并紧裁剪的反应PNG，不能用PDF整页或替换图片")
    return {"editableGraph": "passed", "stereoRoundtrip": "passed", "reactionImage": image_layout,
            "pngSha256": hashlib.sha256(data).hexdigest(), "cdxmlSha256": hashlib.sha256(cdxml.encode()).hexdigest(),
            "sourceImageFidelity": "not-machine-verified"}


def heading_crop(document, number, heading_text):
    page = document[number - 1]
    matches = page.search_for(heading_text)
    if not matches:
        raise ValueError("heading_not_found")
    heading = matches[0]

    def last_graphic_band(target, top, bottom):
        boxes = [d["rect"] for d in target.get_drawings()]
        boxes += [target.rect.__class__(item["bbox"]) for item in target.get_image_info()]
        boxes = sorted((box for box in boxes if box.y0 >= top and box.y1 <= bottom
                        and box.width + box.height > 1), key=lambda box: box.y0)
        bands = []
        for box in boxes:
            if bands and box.y0 <= bands[-1][3] + 22:
                band = bands[-1]
                band[:] = [min(band[0], box.x0), min(band[1], box.y0),
                           max(band[2], box.x1), max(band[3], box.y1)]
            else:
                bands.append(list(box))
        return next((band for band in reversed(bands)
                     if band[2] - band[0] >= 60 and band[3] - band[1] >= 20), None)

    band = last_graphic_band(page, max(0, heading.y0 - 200), heading.y0 - 3)
    crop_page = number
    if band is None and heading.y0 < page.rect.height * .2 and number > 1:
        page = document[number - 2]
        band = last_graphic_band(page, page.rect.height * .6, page.rect.height * .94)
        crop_page = number - 1
    if band is None:
        raise ValueError("reaction_graphic_not_found: 标题前未找到图形，请目视指定反应式页码与区域")
    padding = 7
    return {"page": crop_page, "headingPage": number,
            "bbox": [max(0, (band[0] - padding) / page.rect.width),
                     max(0, (band[1] - padding) / page.rect.height),
                     min(1, (band[2] + padding) / page.rect.width),
                     min(1, (band[3] + padding) / page.rect.height)]}


def pdf_operation(request):
    import pymupdf
    data = base64.b64decode(request["data"], validate=True)
    if len(data) > 80 * 1024 * 1024:
        raise ValueError("pdf_too_large: 最大80MB")
    with pymupdf.open(stream=data, filetype="pdf") as document:
        if document.needs_pass:
            raise ValueError("encrypted_pdf")
        if request["op"] == "pdf_index":
            if len(document) > 2000:
                raise ValueError("pdf_page_limit")
            return {"pageCount": len(document), "pages": [{"page": i + 1, "text": page.get_text(sort=True)} for i, page in enumerate(document)]}
        number = request["page"]
        if not isinstance(number, int) or number < 1 or number > len(document):
            raise ValueError("invalid_pdf_page")
        page = document[number - 1]
        if request["op"] == "pdf_heading_bbox":
            return heading_crop(document, number, request["heading"])
        bbox = request.get("bbox")
        clip = page.rect
        if bbox is not None:
            if len(bbox) != 4 or not all(isinstance(v, (int, float)) and 0 <= v <= 1 for v in bbox) or bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
                raise ValueError("invalid_bbox: 使用0至1的归一化矩形")
            clip = pymupdf.Rect(bbox[0] * page.rect.width, bbox[1] * page.rect.height, bbox[2] * page.rect.width, bbox[3] * page.rect.height)
        image = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), clip=clip, alpha=False)
        return {"page": number, "text": page.get_text(sort=True), "png": base64.b64encode(image.tobytes("png")).decode()}


def execute(request):
    operation = request.get("op")
    if operation == "source_pages":
        import pymupdf
        pages = request["pages"]
        if not isinstance(pages, list) or not 1 <= len(pages) <= 8:
            raise ValueError("page_batch_invalid")
        sources = request["sources"]
        if not isinstance(sources, list) or not 1 <= len(sources) <= 8 or len({s["id"] for s in sources}) != len(sources):
            raise ValueError("source_batch_invalid")
        decoded = {s["id"]: {"mime": s["mime"], "data": base64.b64decode(s["data"], validate=True)} for s in sources}
        if sum(len(s["data"]) for s in decoded.values()) > 80 * 1024 * 1024:
            raise ValueError("source_batch_too_large")
        output, documents = [], {}
        with ExitStack() as stack:
            for selected in pages:
                source = decoded.get(selected["sourceId"])
                if source is None:
                    raise ValueError("source_not_found")
                number, bbox = selected["page"], selected.get("bbox")
                if bbox is not None and (len(bbox) != 4 or not all(isinstance(v, (int, float)) and 0 <= v <= 1 for v in bbox) or bbox[0] >= bbox[2] or bbox[1] >= bbox[3]):
                    raise ValueError("invalid_bbox")
                if source["mime"] == "application/pdf":
                    if selected["sourceId"] not in documents:
                        documents[selected["sourceId"]] = stack.enter_context(pymupdf.open(stream=source["data"], filetype="pdf"))
                    document = documents[selected["sourceId"]]
                    if not isinstance(number, int) or not 1 <= number <= len(document):
                        raise ValueError("invalid_pdf_page")
                    page = document[number - 1]
                    clip = page.rect if bbox is None else pymupdf.Rect(bbox[0] * page.rect.width, bbox[1] * page.rect.height, bbox[2] * page.rect.width, bbox[3] * page.rect.height)
                    png = base64.b64encode(page.get_pixmap(matrix=pymupdf.Matrix(2, 2), clip=clip, alpha=False).tobytes("png")).decode()
                    text_value = page.get_text(sort=True)
                else:
                    if number != 1:
                        raise ValueError("invalid_image_page")
                    cropped = execute({"op": "image_crop", "data": base64.b64encode(source["data"]).decode(), "bbox": bbox})
                    png, text_value = cropped["png"], cropped["text"]
                output.append({"sourceId": selected["sourceId"], "page": number, "text": text_value, "image": png, "mime": "image/png"})
        return {"pages": output}
    if operation == "inspect":
        return inspect(request["smiles"])
    if operation == "inspect_structures":
        smiles_list = request["smiles"]
        if not isinstance(smiles_list, list) or not 1 <= len(smiles_list) <= 64:
            raise ValueError("structure_batch_invalid")
        return {"structures": [{"smiles": identity(molecule(s)), "formula": rdMolDescriptors.CalcMolFormula(molecule(s)),
                                 "mw": Descriptors.MolWt(molecule(s)), "stereo": stereo_summary(molecule(s))} for s in smiles_list]}
    if operation == "verify_compounds":
        return verify_compounds(request)
    if operation == "check_binding":
        check_bound_structures(request)
        return {"binding": "passed"}
    if operation == "formula_properties":
        return formula_properties(request)
    if operation == "edit":
        return edit(request)
    if operation == "render_step":
        return render_step(request)
    if operation == "verify_delivery":
        steps = request["steps"]
        if not isinstance(steps, list) or not 1 <= len(steps) <= 60:
            raise ValueError("delivery_steps_invalid")
        results = []
        for step_request in steps:
            try:
                results.append({"order": step_request["order"], "ok": True, "verification": verify_step_artifacts(step_request)})
            except Exception as error:
                results.append({"order": step_request["order"], "ok": False, "error": str(error)[:1000]})
        return {"results": results}
    if operation in ("pdf_index", "pdf_page", "pdf_heading_bbox"):
        return pdf_operation(request)
    if operation == "image_crop":
        data = base64.b64decode(request["data"], validate=True)
        with Image.open(io.BytesIO(data)) as original:
            if original.width * original.height > 40_000_000:
                raise ValueError("image_too_large")
            image = original.convert("RGB")
            bbox = request.get("bbox")
            if bbox is not None:
                if len(bbox) != 4 or not all(isinstance(v, (float, int)) and 0 <= v <= 1 for v in bbox) or bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
                    raise ValueError("invalid_bbox")
                image = image.crop((bbox[0] * image.width, bbox[1] * image.height, bbox[2] * image.width, bbox[3] * image.height))
            output = io.BytesIO()
            image.save(output, "PNG")
            return {"text": "用户上传的原始图像区域", "png": base64.b64encode(output.getvalue()).decode()}
    raise ValueError("unknown_tool")


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.buffer.read(120 * 1024 * 1024))
        output = {"ok": True, "result": execute(request)}
    except Exception as error:
        output = {"ok": False, "error": {"code": str(error).split(":", 1)[0][:80], "message": str(error)[:1000]}}
    sys.stdout.buffer.write(json.dumps(output, ensure_ascii=False, allow_nan=False).encode("utf-8"))
