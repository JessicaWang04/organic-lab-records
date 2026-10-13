import assert from "node:assert/strict";
import { fixtureDeliveryVerification, installFixtureInventory } from "./delivery-fixture";
import { test } from "node:test";
import { Chemistry } from "../src/chemistry";
import { ExperimentStep, FileStore, Reagent, StepArtifacts } from "../src/domain";
import { buildStepNote } from "../src/records";
import { AgentRunner, SessionState } from "../src/runner";

class MemoryStore implements FileStore {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  async exists(path: string) { return this.files.has(path) || this.bytes.has(path); }
  async read(path: string) {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`missing: ${path}`);
    return value;
  }
  async readBinary(path: string) {
    const value = this.bytes.get(path);
    if (!value) throw new Error(`missing: ${path}`);
    return value;
  }
  async write(path: string, content: string, overwrite = false) {
    if (!overwrite && await this.exists(path)) throw new Error(`exists: ${path}`);
    this.files.set(path, content);
  }
  async binary(path: string, data: Uint8Array, overwrite = false) {
    if (!overwrite && await this.exists(path)) throw new Error(`exists: ${path}`);
    this.bytes.set(path, data);
  }
}

function fixture(requestedChanges: string[]) {
  const row: Reagent = { id: "SM", name: "source substrate", role: "substrate", smiles: "CCO", mw: 46,
    equivalents: null, referenceAmountMmol: null, referenceMassMg: null, referenceVolumeMl: null,
    concentrationM: null, densityGml: null, purityPercent: null, citations: [] };
  const step: ExperimentStep = { order: 1, paperStep: "1", title: "source reaction", purpose: "fixture",
    reactants: ["CCO"], products: ["CC=O"], reagents: [row], aboveArrow: [], belowArrow: [],
    procedure: [], workup: [], purification: [], characterization: [], citations: [],
    referenceBasisMmol: null, referenceYield: null, yieldScope: null, conflicts: [], sourceImage: null,
    scaleMmol: null, scaleBasisId: null };
  const store = new MemoryStore();
  const state: SessionState = { id: "intent-test", dir: "Route", prompt: "fixture", status: "running",
    turns: 0, calls: 0, sources: [], context: [], rendered: {}, written: {}, receipts: {}, events: [], question: null,
    plan: { title: "source route", intent: "fixture", requestedChanges, steps: [step] } };
  installFixtureInventory(state);
  let editCalls = 0;
  const chemistry: Chemistry = { call: async <T>(request: Record<string, unknown>) => {
    if (["verify_delivery", "verify_compounds", "check_binding"].includes(String(request.op))) return fixtureDeliveryVerification(request) as T;
    if (request.op === "inspect") return { smiles: request.smiles } as T;
    if (request.op === "edit") {
      editCalls++;
      return { before: "CCO", after: "CCCO", properties: { mw: 60, formula: "C3H8O" }, site: 0 } as T;
    }
    throw new Error(`unexpected chemistry: ${request.op}`);
  } };
  const runner = new AgentRunner(state, store, chemistry, { turn: async () => { throw new Error("unexpected model request"); } }, () => undefined, 1);
  const installWrittenArtifacts = () => {
    const artifacts: StepArtifacts = { image: "Route/assets/S01.png", cdxml: "Route/assets/S01.cdxml", svg: null, quality: "Route/assets/S01-quality.json" };
    const path = "Route/S01.md";
    store.files.set(path, buildStepNote(state.id, step, artifacts, [], null, null));
    store.bytes.set(artifacts.image, Buffer.from("fixture PNG"));
    store.files.set(artifacts.cdxml!, "fixture CDXML");
    store.files.set(artifacts.quality, "{}");
    state.rendered[1] = artifacts; state.written[1] = path;
  };
  return { state, store, runner, step, installWrittenArtifacts, editCalls: () => editCalls };
}

test("finish accepts the reported screenshot-original instruction without an edit", async () => {
  const f = fixture(["使用截图原始底物，不修改结构。"]); f.installWrittenArtifacts();
  const result = await f.runner.execute("finish_route", {});
  assert.equal(result.status, "drafts_created"); assert.equal(f.state.status, "completed");
  assert.equal(f.editCalls(), 0); assert.equal(f.step.edits, undefined);
  assert.ok(await f.store.exists("Route/路线.md")); assert.ok(await f.store.exists("Route/路线.base"));
});

test("explicit no-edit and preservation clauses can finish with no receipts", async () => {
  for (const requestedChanges of [["不修改结构"], ["不要改变底物的结构。"], ["保留原图底物", "保持原始结构不变"], ["沿用文献原始产物结构"]]) {
    const f = fixture(requestedChanges); f.installWrittenArtifacts();
    await f.runner.execute("finish_route", {}); assert.equal(f.editCalls(), 0);
  }
});

test("empty requested changes retain ordinary finish behavior", async () => {
  const f = fixture([]); f.installWrittenArtifacts();
  await f.runner.execute("finish_route", {}); assert.equal(f.state.status, "completed");
});

test("real edits and abbreviated edit targets still require local receipts", async () => {
  for (const change of ["在芳环对位添加甲氧基", "将底物的Br替换为Cl", "para methoxy"]) {
    const f = fixture([change]); f.installWrittenArtifacts();
    await assert.rejects(f.runner.execute("finish_route", {}), /requested_edit_not_executed/);
    assert.equal(f.state.status, "running"); assert.ok(!await f.store.exists("Route/路线.md"));
  }
});

test("a real local edit produces the receipt needed for finish", async () => {
  const f = fixture(["修改底物结构"]);
  await f.runner.execute("edit_structure", { step: 1, reagentId: "SM", operation: "replace_group", atomIndex: 0, group: "C", element: null, anchorElement: null });
  assert.equal(f.editCalls(), 1); assert.equal(f.step.edits?.length, 1);
  assert.equal(f.step.reactants[0], "CCCO");
  f.installWrittenArtifacts(); await f.runner.execute("finish_route", {});
  assert.equal(f.state.status, "completed"); assert.equal(f.editCalls(), 1);
});

test("negative and affirmative items retain the receipt requirement in either order", async () => {
  for (const changes of [["不修改底物", "在产物对位添加甲氧基"], ["替换产物的Br为Cl", "不修改底物"]]) {
    const f = fixture(changes); f.installWrittenArtifacts();
    await assert.rejects(f.runner.execute("finish_route", {}), /requested_edit_not_executed/);
  }
});

test("negative and affirmative clauses in one item cannot bypass receipt checks", async () => {
  for (const change of ["不修改底物，但在产物添加甲氧基。", "使用截图原始底物；替换产物的Br为Cl。", "不修改结构仅添加一个甲氧基", "不修改结构，但不是不添加甲氧基"]) {
    const f = fixture([change]); f.installWrittenArtifacts();
    await assert.rejects(f.runner.execute("finish_route", {}), /requested_edit_not_executed/);
  }
});

test("unrecognized instructions stay conservative even when they contain a no-edit phrase", async () => {
  const f = fixture(["不是不修改结构"]); f.installWrittenArtifacts();
  await assert.rejects(f.runner.execute("finish_route", {}), /requested_edit_not_executed/);
});

test("an already-started finish call keeps its call ID and completes without another model turn", async () => {
  const f = fixture(["使用截图原始底物，不修改结构。"]); f.installWrittenArtifacts();
  const call = { type: "function_call", call_id: "existing-finish", name: "finish_route", arguments: "{}" };
  f.state.context.push(call); f.state.turns = 1; f.state.calls = 1;
  f.state.executions = { "existing-finish": { name: "finish_route", arguments: "{}", phase: "started" } };
  await f.runner.run();
  assert.equal(f.state.status, "completed"); assert.equal(f.state.turns, 1); assert.equal(f.state.calls, 1);
  const outputs = f.state.context.filter(item => item.type === "function_call_output" && item.call_id === call.call_id);
  assert.equal(outputs.length, 1); assert.match(String(outputs[0].output), /drafts_created/);
  assert.equal(f.state.executions[call.call_id].phase, "completed");
});

test("no-edit intent does not weaken artifact verification", async () => {
  const f = fixture(["不修改结构"]); f.installWrittenArtifacts();
  f.store.files.delete(f.state.rendered[1].quality);
  await assert.rejects(f.runner.execute("finish_route", {}), /artifact_missing/);
  assert.ok(!await f.store.exists("Route/路线.md"));
});

test("finish accepts the complete reported requestedChanges array without changing it", async () => {
  const changes = ["使用截图原始底物，不修改结构。", "仅第一步设置底物0.1 mmol；第二步实际规模待输入。"];
  const original = [...changes]; const f = fixture(changes); f.installWrittenArtifacts();
  await f.runner.execute("finish_route", {});
  assert.equal(f.state.status, "completed"); assert.equal(f.editCalls(), 0);
  assert.deepEqual(f.state.plan!.requestedChanges, original);
});

test("explicit numeric scale and pending-scale clauses do not require structure edits", async () => {
  for (const change of ["设置底物0.1 mmol", "第一步底物规模设为0.25 mmol。", "本步反应规模设置为1.0 mmol.", "第二步实际规模待输入。", "第二步规模待用户输入"] ) {
    const f = fixture([change]); f.installWrittenArtifacts();
    await f.runner.execute("finish_route", {});
    assert.equal(f.state.status, "completed"); assert.equal(f.editCalls(), 0);
  }
});

test("scale and affirmative structure changes in one item still need an edit receipt", async () => {
  for (const change of ["仅第一步设置底物0.1 mmol；将产物的Br替换为Cl。", "第二步实际规模待输入，添加对位甲氧基。", "设置底物0.1 mmol并替换底物的Br", "设置底物0.1 mmol.替换底物的Br"] ) {
    const f = fixture([change]); f.installWrittenArtifacts();
    await assert.rejects(f.runner.execute("finish_route", {}), /requested_edit_not_executed/);
  }
});

test("scale and structure changes in different items still need an edit receipt", async () => {
  for (const changes of [["仅第一步设置底物0.1 mmol", "修改底物结构"], ["para methoxy", "第二步实际规模待输入。"]]) {
    const f = fixture(changes); f.installWrittenArtifacts();
    await assert.rejects(f.runner.execute("finish_route", {}), /requested_edit_not_executed/);
  }
});
