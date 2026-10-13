import assert from "node:assert/strict";
import { fixtureDeliveryVerification } from "./delivery-fixture";
import { test } from "node:test";
import { parse } from "yaml";
import { ExperimentStep, FileStore, Reagent, safePath, SourceAsset } from "../src/domain";
import { amountFromMass, calculateStoichiometry } from "../src/stoichiometry";
import { buildBase, buildStepNote, moveStoichEditorBeforeResults, parseFrontmatter, parseStoichInput, replaceStoichBlock, updateBaseGallery } from "../src/records";
import { markUserProperty, PropertyResolver } from "../src/reagent-properties";
import { checkEvidence } from "../src/quality";
import { ResponsesTransport, parseResponse } from "../src/provider";
import { AgentRunner, SessionState, Turn } from "../src/runner";
import { Chemistry } from "../src/chemistry";
import { PythonChemistry } from "../src/chemistry";
import { resolve } from "node:path";
import { validateToolCall } from "../src/tools";
const chemistryPython = process.env.ORGANIC_LAB_PYTHON || "python";

const citation = { sourceId: "si", page: 20, quote: "Ac2O (0.82 mL, 8.70 mmol, 2.00 equiv)" };
const row = (id = "reagent"): Reagent => ({ id, name: "Ac2O", role: "reagent", smiles: "CC(=O)OC(C)=O", mw: 102.09, equivalents: 2,
  referenceAmountMmol: 8.70, referenceMassMg: null, referenceVolumeMl: 0.82, concentrationM: null, densityGml: null, purityPercent: null, citations: [citation] });
const source: SourceAsset = { id: "si", name: "SI.pdf", path: "sources/SI.pdf", mime: "application/pdf", pages: [{ page: 20, text: citation.quote }] };
function step(): ExperimentStep { return { order: 1, paperStep: "8", title: "乙酰化", purpose: "建立一份独立实验草稿", reactants: ["CCO"], products: ["CCOC(C)=O"],
  reagents: [row()], aboveArrow: ["Ac2O"], belowArrow: ["CH2Cl2, rt"], procedure: [], workup: [], purification: [], characterization: [], citations: [citation],
  referenceBasisMmol: 4.35, referenceYield: "95%", yieldScope: "原文单步", conflicts: [], sourceImage: null, scaleMmol: null, scaleBasisId: null }; }
test("mmol/mass/concentration/purity conversion uses average MW and preserves unknowns", () => {
  const r = row(); const unknown = calculateStoichiometry({ scaleMmol: 0.1, rows: [r] })[0];
  assert.equal(unknown.amountMmol, 0.2); assert.ok(Math.abs(unknown.pureMassMg! - 20.418) < 1e-10); assert.equal(unknown.weighingMassMg, null); assert.equal(unknown.volumeMl, null);
  r.purityPercent = 80; r.concentrationM = 1;
  const known = calculateStoichiometry({ scaleMmol: 0.1, rows: [r] })[0];
  assert.ok(Math.abs(known.weighingMassMg! - 25.5225) < 1e-10); assert.equal(known.volumeMl, 0.2);
  assert.ok(Math.abs(amountFromMass(25.5225, 102.09, 80) - 0.2) < 1e-12);
  assert.equal(calculateStoichiometry({ scaleMmol: null, rows: [r] })[0].amountMmol, null);
});
test("gallery and note reference the same image and sort numeric step then attempt", () => {
  const s = step(); const art = { image: "Route/assets/S01.png", cdxml: "Route/assets/S01.cdxml", svg: null, quality: "Route/quality.json" };
  const note = buildStepNote("route1", s, art, [source], null, "Route/next.md");
  const fm = parseFrontmatter(note); assert.equal(fm.image, "[[Route/assets/S01.png]]"); assert.ok(note.includes("![[Route/assets/S01.png]]"));
  assert.equal(fm.worked, null); assert.equal(fm.measured_yield_percent, null);
  const base = parse(buildBase("route1")); assert.equal(base.views[0].image, "note.image"); assert.equal(base.views[0].sort[0].property, "note.step_number");
});
test("changing scale basis normalizes the source equivalents rather than doubling the basis amount", () => {
  const first = { ...row("A"), role: "substrate" as const, equivalents: 1 };
  const second = { ...row("B"), role: "substrate" as const, equivalents: 2 };
  const result = calculateStoichiometry({ scaleMmol: 0.1, basisId: "B", rows: [first, second] });
  assert.equal(result[0].amountMmol, 0.05); assert.equal(result[1].amountMmol, 0.1);
});
test("liquid pure volume is distinct from batch volume; solid density never becomes dispensing volume", () => {
  const liquid = { ...row(), physicalState: "liquid" as const, densityGml: 1.082 };
  const before = calculateStoichiometry({ scaleMmol: .1, rows: [liquid] })[0];
  assert.ok(Math.abs(before.pureVolumeMl! - 20.418 / 1082) < 1e-12);
  assert.equal(before.volumeMl, null); assert.equal(before.weighingMassMg, null);
  const batch = calculateStoichiometry({ scaleMmol: .1, rows: [{ ...liquid, purityPercent: 80 }] })[0];
  assert.ok(Math.abs(batch.volumeMl! - before.pureVolumeMl! / .8) < 1e-12);
  const solid = calculateStoichiometry({ scaleMmol: .1, rows: [{ ...liquid, physicalState: "solid", purityPercent: 100 }] })[0];
  assert.equal(solid.pureVolumeMl, null); assert.equal(solid.volumeMl, null);
  const stock = calculateStoichiometry({ scaleMmol: .1, rows: [{ ...liquid, physicalState: "solution", concentrationM: 1 }] })[0];
  assert.equal(stock.volumeMl, .2); assert.equal(stock.pureVolumeMl, null);
});
test("gallery edits preserve filters, unrelated views, user ordering and comments", () => {
  const original = `# 我的图库\n${buildBase("r")}custom: keep\n`;
  const before = parse(original);
  const updated = updateBaseGallery(original, "路线图库", { imageAspectRatio: .65, imageFit: "cover", cardSize: 425 });
  const after = parse(updated);
  assert.deepEqual(after.filters, before.filters); assert.deepEqual(after.views[1], before.views[1]);
  assert.deepEqual(after.views[0].order, before.views[0].order); assert.equal(after.custom, "keep");
  assert.ok(updated.includes("# 我的图库")); assert.equal(after.views[0].imageAspectRatio, .65);
  assert.throws(() => updateBaseGallery(original, "路线图库", { imageAspectRatio: 2.6, imageFit: "contain", cardSize: 350 }), /0.2–1/);
});
test("legacy editor is moved ahead of the saved calculation without losing handwritten material", () => {
  const s = step();
  const note = buildStepNote("r", s, { image: "a.png", cdxml: "a.cdxml", svg: null, quality: "q.json" }, [source], null, null);
  const editor = note.match(/## 计量输入\n\n```organic-stoich[\s\S]*?```\n\n/)![0];
  let legacy = note.replace(editor, "").replace("## 文献参考步骤", `${editor.replace("## 计量输入\n\n", "")}## 文献参考步骤`);
  legacy += "\n实测：黄色油，附件 ![[本次-NMR.png]]\n";
  const reordered = moveStoichEditorBeforeResults(legacy);
  assert.ok(reordered.indexOf("![[a.png]]") < reordered.indexOf("```organic-stoich"));
  assert.ok(reordered.indexOf("```organic-stoich") < reordered.indexOf("## Stoichiometry"));
  assert.deepEqual(parseStoichInput(reordered), parseStoichInput(legacy));
  assert.equal(reordered.slice(reordered.indexOf("## 文献参考步骤")), legacy.slice(legacy.indexOf("## 文献参考步骤")));
  assert.equal(moveStoichEditorBeforeResults(reordered), reordered);
});
test("property lookup binds substrate characterization across pages, not the following product", async () => {
  const chemistry = new PythonChemistry(chemistryPython, resolve("python/chemistry_worker.py"));
  const sources: SourceAsset[] = [{ ...source, pages: [
    { page: 1, text: "Compound 18:\nafford compound 18 (0.78 g, 90%) as a white solid.\nHRMS calcd for C21H35O4 [M + H]+: 351.2530, found: 351.2534." },
    { page: 2, text: "Compound 19:\nTo a solution of 18...\nHRMS calcd for C19H33O3 [M + H]+: 309.2424, found: 309.2421." }
  ] }];
  const substrate = { ...row("SM"), name: "18", role: "substrate" as const, smiles: null, mw: null, citations: [{ sourceId: "si", page: 2, quote: "To a solution of 18..." }] };
  const resolver = new PropertyResolver(chemistry);
  await resolver.prefill([substrate], sources);
  assert.equal(substrate.mw, 350.499); assert.equal(substrate.formula, "C21H34O4");
  assert.equal(substrate.physicalState, "solid"); assert.equal(substrate.densityGml, null);
  assert.equal(substrate.propertySources!.find(s => s.property === "mw")!.citation!.page, 1);
  const mistaken = { ...row("SM"), name: "18", smiles: null, mw: 351.2530, citations: substrate.citations };
  await resolver.prefill([mistaken], sources, true); assert.equal(mistaken.mw, 350.499);
  const edited = { ...row("SM"), name: "18", smiles: "CCO", mw: null, identityModified: true, citations: substrate.citations };
  await resolver.prefill([edited], sources);
  assert.ok(Math.abs(edited.mw! - 46.069) < 1e-9); assert.equal(edited.physicalState, undefined);
});
test("catalog properties preserve user values, exclude formulations and reject same-formula isomers", async () => {
  const resolver = new PropertyResolver(new PythonChemistry(chemistryPython, resolve("python/chemistry_worker.py")));
  const known = { ...row(), smiles: null, mw: null, densityGml: .9 };
  markUserProperty(known, "densityGml");
  await resolver.prefill([known], []);
  assert.equal(known.mw, 102.089); assert.equal(known.physicalState, "liquid"); assert.equal(known.densityGml, .9);
  assert.equal(known.purityPercent, null);
  const cleared = { ...row(), smiles: null, mw: null }; markUserProperty(cleared, "mw");
  await resolver.prefill([cleared], []); assert.equal(cleared.mw, null);
  const formulation = { ...row(), name: "HF·Py formulation", smiles: null, mw: null };
  await resolver.prefill([formulation], []); assert.equal(formulation.mw, null); assert.equal(formulation.densityGml, null);
  const isomer = { ...row(), name: "DIPEA", smiles: "CN(CC)CCCCC", mw: null };
  await resolver.prefill([isomer], []); assert.equal(isomer.formula, "C8H19N"); assert.equal(isomer.densityGml, null); assert.equal(isomer.physicalState, undefined);
});
test("stoichiometry update preserves user observations and characterization", () => {
  const s = step(); let note = buildStepNote("r", s, { image: "a.png", cdxml: "a.cdxml", svg: null, quality: "q.json" }, [source], null, null);
  note += "\n我的观察：溶液呈淡黄色。\n![[my-NMR.png]]";
  const result = replaceStoichBlock(note, { scaleMmol: 0.1, rows: s.reagents });
  assert.ok(result.includes("溶液呈淡黄色")); assert.ok(result.includes("my-NMR.png")); assert.ok(result.includes("20.418"));
});
test("source evidence rejects invented eq/page/quote, reports original quantity conflict", () => {
  const s = step(); assert.ok(!checkEvidence(s, [source]).some(i => i.severity === "error"));
  s.reagents[0].equivalents = 3;
  assert.ok(checkEvidence(s, [source]).some(i => i.code === "quantity_not_in_quote"));
  assert.ok(checkEvidence(s, [source]).some(i => i.code === "equivalent_conflict"));
  s.citations = [{ ...citation, page: 999 }]; assert.ok(checkEvidence(s, [source]).some(i => i.code === "invalid_source_reference"));
  s.citations = [{ ...citation, quote: "invented" }]; assert.ok(checkEvidence(s, [source]).some(i => i.code === "quote_not_found"));
});
test("paths cannot escape the vault and YAML-like text cannot inject properties", () => {
  assert.throws(() => safePath("../outside.md")); assert.throws(() => safePath("E:/outside.md"));
  const s = step(); s.referenceYield = "95%\nworked: true";
  const fm = parseFrontmatter(buildStepNote("r", s, { image: "a.png", cdxml: "a.cdxml", svg: null, quality: "q.json" }, [source], null, null));
  assert.equal(fm.worked, null);
});
test("Responses request carries native tools, selected model, original image and full instruction", async () => {
  let sent: Record<string, unknown> = {};
  const transport = new ResponsesTransport({ baseUrl: "https://api.openai.com/v1", model: "selected-model", apiKey: "test-only-key", instructions: "skill", maxOutputTokens: 24000 }, async (_method, url, _headers, body) => {
    assert.equal(url, "https://api.openai.com/v1/responses"); sent = JSON.parse(body!);
    return { status: 200, text: JSON.stringify({ output: [{ type: "function_call", call_id: "c1", name: "search_sources", arguments: "{}", status: "completed" }] }) };
  });
  const input = [{ role: "user", content: [{ type: "input_text", text: "原始完整修改指令" }, { type: "input_image", image_url: "data:image/png;base64,fixture" }] }];
  const turn = await transport.turn(input); assert.equal(sent.model, "selected-model"); assert.deepEqual(sent.input, input); assert.equal(sent.store, false);
  assert.equal(turn.output[0].call_id, "c1"); assert.equal(turn.output[0].status, undefined);
});
test("SSE only executes completed response; reasoning continuation state is retained", () => {
  assert.throws(() => parseResponse('data: {"type":"response.output_text.delta"}\n'));
  const turn = parseResponse(JSON.stringify({ output: [{ type: "reasoning", id: "reason1", summary: [], encrypted_content: "opaque" }] }));
  assert.equal(turn.output[0].encrypted_content, "opaque");
});
test("local tool contract blocks extra fields even if a provider ignores strict mode", () => {
  validateToolCall("set_scale", { step: 1, reagentId: "SM", amountMmol: 0.1 });
  assert.throws(() => validateToolCall("set_scale", { step: 1, reagentId: "SM", amountMmol: 0.1, arbitraryPath: "outside" }), /tool_arguments_invalid/);
  assert.throws(() => validateToolCall("unknown", {}), /unknown_tool/);
});
class MemoryStore implements FileStore {
  files = new Map<string, string>(); bytes = new Map<string, Uint8Array>();
  async exists(p: string) { return this.files.has(p) || this.bytes.has(p); }
  async read(p: string) { return this.files.get(p)!; }
  async readBinary(p: string) { return this.bytes.get(p)!; }
  async write(p: string, v: string, overwrite = false) { if (await this.exists(p) && !overwrite) throw new Error("exists"); this.files.set(p, v); }
  async binary(p: string, v: Uint8Array) { if (await this.exists(p)) throw new Error("exists"); this.bytes.set(p, v); }
}
const initial = (): SessionState => ({ id: "r", dir: "Route", prompt: "task", status: "archived", turns: 0, calls: 0, sources: [source], context: [], plan: null, rendered: {}, written: {}, receipts: {}, events: [], question: null });
const call = (name: string, args: unknown, id: string) => ({ type: "function_call", name, arguments: JSON.stringify(args), call_id: id });
test("native tool receipts feed next turn; question resumes without repeating successful source read", async () => {
  const state = initial(); const store = new MemoryStore(); let index = 0;
  const turns: Turn[] = [
    { output: [call("search_sources", { query: "Ac2O", limit: 2 }, "search")] },
    { output: [call("ask_user", { question: "规模是多少？" }, "question")] },
    { output: [call("ask_user", { question: "确认下一项" }, "question2")] }
  ];
  const runner = new AgentRunner(state, store, { call: async () => { throw new Error("unexpected chemistry"); } }, { turn: async input => {
    if (index === 1) assert.ok(input.some(item => item.call_id === "search" && item.type === "function_call_output"));
    if (index === 2) assert.ok(input.some(item => item.call_id === "question" && String(item.output).includes("0.1")));
    return turns[index++];
  } }, () => undefined);
  await runner.run(); assert.equal(state.status, "needsInput"); await runner.run("0.1 mmol"); assert.equal(state.turns, 3);
  assert.equal(state.events.filter(e => e.kind === "tool_completed").length, 1);
});
test("invalid evidence cannot create a note; duplicate call does not create another record", async () => {
  const state = initial(); const store = new MemoryStore(); const chemistry: Chemistry = { call: async <T>(req: Record<string, unknown>) => (req.op === "verify_delivery" ? fixtureDeliveryVerification(req) : req.op === "inspect" ? { mw: 102.09 } : { png: Buffer.from("test bytes").toString("base64"), cdxml: "transport fixture", properties: [], quality: {} }) as T };
  const runner = new AgentRunner(state, store, chemistry, { turn: async () => { throw new Error("not used"); } }, () => undefined);
  const s = step(); await runner.execute("record_route", { plan: { title: "route", intent: "task", requestedChanges: [], steps: [s] } });
  await runner.execute("render_step", { step: 1 }); s.reagents[0].equivalents = 3;
  await assert.rejects(runner.execute("write_step", { step: 1 }), /evidence_invalid/);
  assert.equal([...store.files.keys()].filter(p => p.endsWith(".md")).length, 0);
  s.reagents[0].equivalents = 2; await runner.execute("write_step", { step: 1 }); await runner.execute("write_step", { step: 1 });
  assert.equal([...store.files.keys()].filter(p => p.endsWith(".md")).length, 1);
});
test("real local edit updates a chemically identical alternate SMILES in the reaction scheme", async () => {
  const state = initial(); const store = new MemoryStore();
  const chemistry = new PythonChemistry(chemistryPython, resolve("python/chemistry_worker.py"));
  const runner = new AgentRunner(state, store, chemistry, { turn: async () => { throw new Error("not used"); } }, () => undefined);
  const s = step(); s.reactants = ["c1ccc(Br)cc1"]; s.products = ["CCO"];
  s.reagents = [{ ...row("SM"), name: "bromobenzene", role: "substrate", smiles: "Brc1ccccc1", equivalents: 1, physicalState: "liquid", densityGml: 1.49, concentrationM: 1, purityPercent: 99 }];
  await runner.execute("record_route", { plan: { title: "edit test", intent: "test", requestedChanges: ["para methoxy"], steps: [s] } });
  await runner.execute("edit_structure", { step: 1, reagentId: "SM", operation: "add_para_methoxy", anchorElement: "Br", atomIndex: null, group: null, element: null });
  assert.equal(s.reactants[0], "COc1ccc(Br)cc1"); assert.equal(s.reagents[0].smiles, "COc1ccc(Br)cc1");
  assert.equal(s.edits!.length, 1);
  assert.equal(s.reagents[0].densityGml, null); assert.equal(s.reagents[0].physicalState, null);
  assert.equal(s.reagents[0].concentrationM, null); assert.equal(s.reagents[0].purityPercent, null);
});
