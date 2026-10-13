import base64
import io
import json
import math
import os
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from collections import Counter
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
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


def render_step(request):
    reactants = [molecule(s) for s in request["reactants"]]
    products = [molecule(s) for s in request["products"]]
    if not reactants or not products or len(reactants) + len(products) > 12:
        raise ValueError("structure_missing: 需要明确的反应物与产物，不能从名称猜结构")
    above = request.get("aboveArrow", [])
    below = request.get("belowArrow", [])
    width = max(1200, (len(reactants) + len(products)) * 330 + 350)
    root = ET.Element("CDXML", BondLength="18", LabelFont="3", LabelSize="10", LabelFace="96", CaptionFont="3", CaptionSize="10",
                      CaptionFace="0", LineWidth="0.6", BondSpacing="18", InterpretChemically="no", PrintMargins="36 36 36 36")
    table = ET.SubElement(root, "fonttable")
    ET.SubElement(table, "font", id="3", name="Arial", charset="utf-8")
    page = ET.SubElement(root, "page", id="1", BoundingBox=f"0 0 {width} 460")
    ids, uid, xs = [], 10, []
    for i, mol in enumerate(reactants + products):
        x = 165 + i * 330 + (350 if i >= len(reactants) else 0)
        fid, uid = fragment(page, mol, uid, x, 220)
        ids.append(fid)
        xs.append(x)
    tail = len(reactants) * 330
    head = tail + 350
    arrow = uid
    ET.SubElement(page, "arrow", id=str(uid), Head3D=f"{head} 220 0", Tail3D=f"{tail} 220 0", ArrowheadHead="Full", ArrowheadType="Solid", HeadSize="1000", FillType="None")
    uid += 1
    tops, bottoms = [], []
    for i, value in enumerate(above):
        tops.append(text(page, uid, (tail + head) / 2, 190 - (len(above) - 1 - i) * 20, value))
        uid += 1
    for i, value in enumerate(below):
        bottoms.append(text(page, uid, (tail + head) / 2, 253 + i * 20, value))
        uid += 1
    scheme = ET.SubElement(page, "scheme", id=str(uid))
    ET.SubElement(scheme, "step", id=str(uid + 1), ReactionStepReactants=" ".join(map(str, ids[:len(reactants)])), ReactionStepProducts=" ".join(map(str, ids[len(reactants):])), ReactionStepArrows=str(arrow), ReactionStepObjectsAboveArrow=" ".join(map(str, tops)), ReactionStepObjectsBelowArrow=" ".join(map(str, bottoms)))
    layout = fit_cdxml_canvas(root)
    ET.indent(root)
    cdxml = ET.tostring(root, encoding="utf-8", xml_declaration=True).decode("utf-8")
    parsed = Chem.MolsFromCDXML(cdxml)
    if Counter(map(identity, parsed)) != Counter(map(identity, reactants + products)):
        raise ValueError("cdxml_roundtrip_failed: 导出改变了结构或立体化学")
    image = Image.new("RGB", (width, 460), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=20)
    for candidate in (Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/msyh.ttc", Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")):
        if candidate.is_file():
            font = ImageFont.truetype(str(candidate), 20)
            break
    for mol, x in zip(reactants + products, xs):
        tile = Draw.MolToImage(mol, size=(310, 280))
        image.paste(tile.convert("RGB"), (int(x - 155), 80))
    draw.line((tail, 220, head, 220), fill="black", width=3)
    draw.polygon(((head, 220), (head - 12, 214), (head - 12, 226)), fill="black")
    for i, value in enumerate(above):
        draw.text(((tail + head) / 2, 185 - (len(above) - 1 - i) * 27), value, font=font, anchor="mm", fill="black")
    for i, value in enumerate(below):
        draw.text(((tail + head) / 2, 253 + i * 27), value, font=font, anchor="mm", fill="black")
    png = io.BytesIO()
    image.save(png, "PNG")
    return {"cdxml": cdxml, "png": base64.b64encode(png.getvalue()).decode(), "properties": [inspect(identity(m)) for m in reactants + products],
            "quality": {"graphRoundtrip": "passed", "imageFidelity": "needsReview", "stereoRoundtrip": "passed", "cdxmlLayout": layout}}


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
    if operation == "inspect":
        return inspect(request["smiles"])
    if operation == "formula_properties":
        return formula_properties(request)
    if operation == "edit":
        return edit(request)
    if operation == "render_step":
        return render_step(request)
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
