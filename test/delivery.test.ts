import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { PythonChemistry, Chemistry } from "../src/chemistry";
import { ExperimentStep, FileStore } from "../src/domain";
import { AgentRunner, SessionState } from "../src/runner";
import { auditDelivery } from "../src/delivery";
import { fixtureDeliveryVerification, installFixtureInventory } from "./delivery-fixture";

class MemoryStore implements FileStore {
  files = new Map<string, string>(); bytes = new Map<string, Uint8Array>();
  async exists(path: string) { return this.files.has(path) || this.bytes.has(path); }
  async read(path: string) { const value = this.files.get(path); if (value === undefined) throw new Error(`missing: ${path}`); return value; }
  async readBinary(path: string) { const value = this.bytes.get(path); if (!value) throw new Error(`missing: ${path}`); return value; }
  async write(path: string, content: string) { this.files.set(path, content); }
  async binary(path: string, content: Uint8Array) { this.bytes.set(path, content); }
}
const step = (): ExperimentStep => ({ order: 1, paperStep: "1", title: "stereochemical fixture", purpose: "verification fixture",
  reactants: ["N[C@@H](C)C(=O)O"], products: ["N[C@@H](C)C(=O)OC"], reagents: [], aboveArrow: ["MeOH"], belowArrow: ["rt"],
  procedure: [], workup: [], purification: [], characterization: [], citations: [], referenceBasisMmol: null,
  referenceYield: null, yieldScope: null, conflicts: [], sourceImage: null, scaleMmol: null, scaleBasisId: null });
function fixture(chemistry: Chemistry) {
  const state: SessionState = { id: "delivery", dir: "Route", prompt: "fixture", status: "localReady", turns: 0, calls: 0,
    sources: [], context: [], plan: { title: "fixture", intent: "fixture", requestedChanges: [], steps: [step()] },
    rendered: {}, written: {}, receipts: {}, events: [], question: null };
  const store = new MemoryStore();
  const runner = new AgentRunner(state, store, chemistry, { turn: async () => { throw new Error("unexpected model request"); } }, () => undefined);
  return { state, store, runner };
}
const native = new PythonChemistry(process.env.ORGANIC_LAB_PYTHON || "python", resolve("python/chemistry_worker.py"));
const unitChemistry: Chemistry = { call: async <T>(request: Record<string, unknown>) => {
  if (request.op === "verify_delivery") return fixtureDeliveryVerification(request) as T;
  if (request.op === "inspect") { if (request.smiles === "INVALID") throw new Error("invalid_smiles"); return { smiles: request.smiles } as T; }
  if (request.op === "render_step") return { png: Buffer.from("unit PNG").toString("base64"), cdxml: "unit CDXML", properties: [], quality: {} } as T;
  throw new Error(`unexpected operation: ${request.op}`);
} };

test("unknown structures cannot fall back to a source page or save a record", async () => {
  for (const side of ["reactants", "products"] as const) {
    const f = fixture(unitChemistry); f.state.plan!.steps[0][side] = [];
    f.state.plan!.steps[0].sourceImage = { sourceId: "paper", page: 1, bbox: null };
    await assert.rejects(f.runner.execute("render_step", { step: 1 }), /structure_missing/);
    await assert.rejects(f.runner.execute("write_step", { step: 1 }), /structure_missing/);
    assert.equal(f.store.files.size + f.store.bytes.size, 0);
  }
});
test("partial structure repair is atomic and invalidates old renderings", async () => {
  const f = fixture(unitChemistry); f.state.plan!.steps.push({ ...step(), order: 2 }); f.state.written[2] = "existing.md";
  await f.runner.execute("render_step", { step: 1 }); const before = f.state.plan!.steps[0].products;
  await assert.rejects(f.runner.execute("set_step_structures", { step: 1, reactants: ["CCO"], products: ["INVALID"] }), /invalid_smiles/);
  assert.deepEqual(f.state.plan!.steps[0].products, before);
  await f.runner.execute("set_step_structures", { step: 1, reactants: ["CCO"], products: ["CC=O"] });
  assert.equal(f.state.rendered[1], undefined); assert.equal(f.state.written[2], "existing.md");
  await assert.rejects(f.runner.execute("set_step_structures", { step: 2, reactants: ["CCO"], products: ["CC=O"] }), /records_exist/);
});
test("null CDXML and missing note links cannot complete even with cached artifacts", async () => {
  const f = fixture(unitChemistry);
  await f.runner.execute("render_step", { step: 1 }); await f.runner.execute("write_step", { step: 1 });
  const artifacts = f.state.rendered[1], path = f.state.written[1]; const cdxml = artifacts.cdxml!;
  artifacts.cdxml = null;
  await assert.rejects(f.runner.execute("finish_route", {}), /editable_artifacts_missing/);
  await assert.rejects(f.runner.execute("render_step", { step: 1 }), /editable_artifacts_missing/);
  artifacts.cdxml = cdxml;
  const note = await f.store.read(path); f.store.files.set(path, note.replace(`可编辑结构：[[${cdxml}]]`, "结构尚待确认"));
  await assert.rejects(f.runner.execute("finish_route", {}), /record_artifact_mismatch/);
  assert.equal(await f.store.exists("Route/路线.base"), false);
});
test("quality flags and incomplete verifier responses never grant acceptance", async () => {
  const f = fixture({ call: async <T>() => ({ results: [{ order: 1, ok: true, verification: { editableGraph: "passed" } }] }) as T });
  f.state.rendered[1] = { image: "a.png", cdxml: "a.cdxml", svg: null, quality: "quality.json" };
  f.store.bytes.set("a.png", Buffer.from("fake")); f.store.files.set("a.cdxml", "fake");
  f.store.files.set("quality.json", '{"everything":"passed"}');
  const report = await auditDelivery(f.state, f.store, { call: async <T>() => ({ results: [] }) as T }, undefined, false);
  assert.equal(report.complete, false); assert.match(report.issues[0].message, /delivery_verifier_invalid/);
  await assert.rejects(f.runner.execute("write_step", { step: 1 }), /delivery_verifier_invalid/);
});
test("real PNG and editable CDXML pass, while changed bytes and stale success receipts fail", async () => {
  const f = fixture(native);
  installFixtureInventory(f.state); f.state.compounds = {};
  await f.runner.execute("register_compounds", { structures: [{ compoundId: "c1", smiles: f.state.plan!.steps[0].reactants[0] }, { compoundId: "c2", smiles: f.state.plan!.steps[0].products[0] }] });
  await f.runner.execute("bind_steps", { bindings: Object.values(f.state.bindings!) });
  await f.runner.execute("render_step", { step: 1 }); await f.runner.execute("write_step", { step: 1 });
  const finished = await f.runner.execute("finish_route", {});
  assert.equal(f.state.status, "completed");
  assert.equal((finished.delivery as { verifiedEditableCdxml: number }).verifiedEditableCdxml, 1);
  const artifacts = f.state.rendered[1], originalImage = await f.store.readBinary(artifacts.image);
  f.store.bytes.set(artifacts.image, Buffer.from("full-page substitute"));
  f.store.files.set(artifacts.quality, '{"graphRoundtrip":"passed","imageFidelity":"passed"}');
  await assert.rejects(f.runner.validateCachedDelivery("finish_route", {}), /delivery_incomplete/);
  assert.equal(f.state.status, "deliveryIncomplete");
  f.store.bytes.set(artifacts.image, originalImage);
  f.state.plan!.steps[0].products = ["N[C@H](C)C(=O)OC"];
  await assert.rejects(f.runner.execute("write_step", { step: 1 }), /bound_structure_mismatch/);
});
