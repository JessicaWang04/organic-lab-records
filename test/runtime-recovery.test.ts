import assert from "node:assert/strict";
import { fixtureDeliveryVerification, fixtureInventory } from "./delivery-fixture";
import { test } from "node:test";
import { ExperimentStep, FileStore, Reagent, RoutePlan } from "../src/domain";
import { AgentRunner, ProtocolItem, SessionState, Transport, withoutImages } from "../src/runner";

class MemoryStore implements FileStore {
  files = new Map<string, string>();
  bytes = new Map<string, Uint8Array>();
  textWrites = new Map<string, number>();
  binaryWrites = new Map<string, number>();
  failNextCdxml = false;
  async exists(path: string): Promise<boolean> { return this.files.has(path) || this.bytes.has(path); }
  async read(path: string): Promise<string> {
    if (!this.files.has(path)) throw new Error(`missing: ${path}`);
    return this.files.get(path)!;
  }
  async readBinary(path: string): Promise<Uint8Array> {
    if (!this.bytes.has(path)) throw new Error(`missing: ${path}`);
    return this.bytes.get(path)!.slice();
  }
  async write(path: string, value: string, overwrite = false): Promise<void> {
    if (path.endsWith(".cdxml") && this.failNextCdxml) {
      this.failNextCdxml = false;
      throw new Error("transient_cdxml_write_failure");
    }
    if (await this.exists(path) && !overwrite) throw new Error(`exists: ${path}`);
    this.files.set(path, value);
    this.textWrites.set(path, (this.textWrites.get(path) ?? 0) + 1);
  }
  async binary(path: string, value: Uint8Array, overwrite = false): Promise<void> {
    if (await this.exists(path) && !overwrite) throw new Error(`exists: ${path}`);
    this.bytes.set(path, value.slice());
    this.binaryWrites.set(path, (this.binaryWrites.get(path) ?? 0) + 1);
  }
}

const initial = (): SessionState => ({
  id: "recovery-test", dir: "MemoryRoute", prompt: "fixture", status: "running", turns: 0, calls: 0,
  sources: [{ id: "fixture-source", name: "synthetic fixture", mime: "image/png", path: "fixture.png", pages: [] }], context: [], plan: null, rendered: {}, written: {}, receipts: {}, events: [], question: null
});
const reagent = (): Reagent => ({
  id: "SM", name: "substrate", role: "substrate", smiles: "CCO", mw: null, equivalents: 1,
  referenceAmountMmol: null, referenceMassMg: null, referenceVolumeMl: null,
  concentrationM: null, densityGml: null, purityPercent: null, citations: [],
  formula: null, physicalState: null, propertySources: []
});
const step = (title = "A"): ExperimentStep => ({
  order: 1, paperStep: "1", title, purpose: "fixture", reactants: ["CCO"], products: ["CCOC(C)=O"],
  reagents: [], aboveArrow: [], belowArrow: [], procedure: [], workup: [], purification: [], characterization: [],
  citations: [], referenceBasisMmol: null, referenceYield: null, yieldScope: null, conflicts: [],
  sourceImage: null, scaleMmol: null, scaleBasisId: null
});
const plan = (title = "A"): RoutePlan => ({ title, intent: "fixture", requestedChanges: [], steps: [step(title)] });
const call = (name: string, args: unknown, callId: string): ProtocolItem => ({
  type: "function_call", name, arguments: JSON.stringify(args), call_id: callId
});
const output = (callId: string, result: unknown): ProtocolItem => ({
  type: "function_call_output", call_id: callId, output: JSON.stringify(result)
});
function outputs(state: SessionState, callId: string): ProtocolItem[] {
  return state.context.filter(item => item.type === "function_call_output" && item.call_id === callId);
}
function result(state: SessionState, callId: string): Record<string, unknown> {
  const values = outputs(state, callId);
  assert.equal(values.length, 1, `${callId} must have exactly one durable output`);
  return JSON.parse(String(values[0].output)) as Record<string, unknown>;
}
function assertAllCallsPaired(state: SessionState): void {
  for (const item of state.context.filter(item => item.type === "function_call")) {
    assert.equal(outputs(state, String(item.call_id)).length, 1, `${item.call_id} has no unique output`);
  }
}
const noModelRequests: Transport = { turn: async () => { throw new Error("unexpected model request during recovery"); } };
const noChemistry = { call: async <T>(request: Record<string, unknown>): Promise<T> => fixtureDeliveryVerification(request) as T };
const renderingChemistry = { call: async <T>(request: Record<string, unknown>): Promise<T> => {
  if (["verify_delivery", "verify_compounds", "check_binding"].includes(String(request.op))) return fixtureDeliveryVerification(request) as T;
  assert.equal(request.op, "render_step");
  return { png: Buffer.from("fixture png").toString("base64"), cdxml: "fixture cdxml", properties: [], quality: { fixture: true } } as T;
} };

test("legacy durable edit event recovers its output without applying the edit again", async () => {
  const state = initial();
  const editArgs = { step: 1, reagentId: "SM", operation: "replace_atom", anchorElement: null, atomIndex: 2, group: null, element: "N" };
  const editResult = { before: "CCO", after: "CCN", properties: { mw: 45.085, formula: "C2H7N" }, site: 2 };
  state.plan = plan();
  state.plan.steps[0].reactants = [editResult.after];
  state.plan.steps[0].reagents = [{ ...reagent(), smiles: editResult.after, mw: editResult.properties.mw, formula: editResult.properties.formula }];
  state.plan.steps[0].edits = [editResult];
  state.context = [call("edit_structure", editArgs, "legacy-edit")];
  state.events = [{ time: "2026-01-01T00:00:00Z", kind: "tool_completed", tool: "edit_structure", callId: "legacy-edit", result: editResult }];
  state.turns = 1; state.calls = 1;
  const runner = new AgentRunner(state, new MemoryStore(), noChemistry, noModelRequests, () => undefined, 1, 1);
  await runner.run();
  assert.deepEqual(result(state, "legacy-edit"), editResult);
  assert.equal(state.plan.steps[0].reagents[0].smiles, "CCN");
  assert.equal(state.plan.steps[0].edits!.length, 1);
  assert.equal(state.calls, 1); assert.equal(state.turns, 1);
  assertAllCallsPaired(state);
});

test("legacy failed tool event recovers its error without retrying or charging the call", async () => {
  const state = initial();
  state.context = [call("inspect_structure", { smiles: "bad" }, "legacy-failed")];
  state.events = [{ time: "2026-01-01T00:00:00Z", kind: "tool_failed", tool: "inspect_structure", callId: "legacy-failed", status: "error", message: "invalid_smiles" }];
  state.turns = 1; state.calls = 1;
  await new AgentRunner(state, new MemoryStore(), noChemistry, noModelRequests, () => undefined, 1, 1).run();
  assert.equal(result(state, "legacy-failed").status, "error");
  assert.match(String(result(state, "legacy-failed").message), /invalid_smiles/);
  assert.equal(state.calls, 1); assertAllCallsPaired(state);
});

test("completed execution appends the saved native output exactly once without execution", async () => {
  const state = initial(); const invocation = call("inspect_structure", { smiles: "CCO" }, "saved-inspect");
  const savedOutput = output("saved-inspect", { smiles: "CCO", mw: 46.069 });
  state.context = [invocation]; state.turns = 1; state.calls = 1;
  state.executions = { "saved-inspect": { name: "inspect_structure", arguments: String(invocation.arguments), phase: "completed", output: savedOutput } };
  const runner = new AgentRunner(state, new MemoryStore(), noChemistry, noModelRequests, () => undefined, 1, 1);
  await runner.run(); await runner.run();
  assert.deepEqual(outputs(state, "saved-inspect"), [savedOutput]);
  assert.equal(state.calls, 1); assert.equal(state.turns, 1);
});

test("started call completes at the turn and call limits without charging it twice", async () => {
  const state = initial(); const invocation = call("inspect_structure", { smiles: "CCO" }, "started-inspect");
  state.context = [invocation]; state.turns = 1; state.calls = 1;
  state.executions = { "started-inspect": { name: "inspect_structure", arguments: String(invocation.arguments), phase: "started" } };
  let executions = 0;
  const chemistry = { call: async <T>(): Promise<T> => { executions++; return { smiles: "CCO", mw: 46.069 } as T; } };
  await new AgentRunner(state, new MemoryStore(), chemistry, noModelRequests, () => undefined, 1, 1).run();
  assert.equal(result(state, "started-inspect").mw, 46.069);
  assert.equal(executions, 1); assert.equal(state.calls, 1); assert.equal(state.turns, 1);
  assertAllCallsPaired(state);
});

test("unexecuted calls in the final received turn complete before reporting the turn budget", async () => {
  const state = initial(); state.turns = 1;
  state.context = [call("inspect_structure", { smiles: "CCO" }, "final-a"), call("inspect_structure", { smiles: "CCN" }, "final-b")];
  const executed: string[] = [];
  const chemistry = { call: async <T>(request: Record<string, unknown>): Promise<T> => {
    executed.push(String(request.smiles)); return { smiles: request.smiles, mw: 46 } as T;
  } };
  await new AgentRunner(state, new MemoryStore(), chemistry, noModelRequests, () => undefined, 1, 2).run();
  assert.deepEqual(executed, ["CCO", "CCN"]);
  assert.equal(state.calls, 2); assert.equal(state.turns, 1); assert.equal(state.status, "budgetExhausted");
  assertAllCallsPaired(state);
});

test("stop during the first tool pairs remaining calls without executing or charging them", async () => {
  const state = initial(); let executed = 0; let runner: AgentRunner;
  const chemistry = { call: async <T>(): Promise<T> => { executed++; runner.stopped = true; return { smiles: "CCO", mw: 46.069 } as T; } };
  const transport: Transport = { turn: async () => ({ output: [
    call("inspect_structure", { smiles: "CCO" }, "stop-a"), call("inspect_structure", { smiles: "CCN" }, "stop-b")
  ] }) };
  runner = new AgentRunner(state, new MemoryStore(), chemistry, transport, () => undefined, 1, 2);
  await runner.run();
  assert.equal(result(state, "stop-a").mw, 46.069);
  assert.equal(result(state, "stop-b").status, "not_executed");
  assert.equal(executed, 1); assert.equal(state.calls, 1); assert.equal(state.status, "stopped");
  assertAllCallsPaired(state);
});

test("new record_route calls apply A to B to A instead of reusing a stale argument receipt", async () => {
  const state = initial(); const titles = ["A", "B", "A"]; let index = 0;
  const transport: Transport = { turn: async () => {
    const turn = index++; return { output: [call("record_route", { plan: plan(titles[turn]) }, `plan-${turn}`)] };
  } };
  await new AgentRunner(state, new MemoryStore(), noChemistry, transport, () => undefined, 3, 3).run();
  assert.equal(index, 3); assert.equal(state.plan!.title, "A");
  assert.equal(state.plan!.steps[0].title, "A");
  assert.equal(state.calls, 3); assert.equal(state.turns, 3);
  assertAllCallsPaired(state);
});

test("render retry after a CDXML write failure reuses the identical PNG and completes", async () => {
  const state = initial(); state.plan = plan(); const store = new MemoryStore(); store.failNextCdxml = true;
  const runner = new AgentRunner(state, store, renderingChemistry, noModelRequests, () => undefined);
  await assert.rejects(runner.execute("render_step", { step: 1 }), /transient_cdxml_write_failure/);
  assert.equal(Object.keys(state.rendered).length, 0); assert.equal(store.bytes.size, 1);
  const pngPath = [...store.bytes.keys()][0]; const originalPng = await store.readBinary(pngPath);
  await runner.execute("render_step", { step: 1 });
  assert.equal(state.rendered[1].image, pngPath);
  assert.equal(store.binaryWrites.get(pngPath), 1);
  assert.deepEqual(await store.readBinary(pngPath), originalPng);
  assert.equal(await store.read(state.rendered[1].cdxml!), "fixture cdxml");
  assert.ok(await store.exists(state.rendered[1].quality));
});

test("render recovery refuses conflicting binary or text artifacts and preserves them", async () => {
  for (const kind of ["binary", "text"] as const) {
    const state = initial(); state.plan = plan(); const store = new MemoryStore();
    const runner = new AgentRunner(state, store, renderingChemistry, noModelRequests, () => undefined);
    await runner.execute("render_step", { step: 1 });
    const artifacts = state.rendered[1]; delete state.rendered[1];
    if (kind === "binary") store.bytes.set(artifacts.image, Buffer.from("user changed png"));
    else store.files.set(artifacts.cdxml!, "user changed cdxml");
    await assert.rejects(runner.execute("render_step", { step: 1 }), /artifact_conflict/);
    if (kind === "binary") assert.equal(Buffer.from(await store.readBinary(artifacts.image)).toString(), "user changed png");
    else assert.equal(await store.read(artifacts.cdxml!), "user changed cdxml");
    assert.equal(Object.keys(state.rendered).length, 0);
  }
});

test("restored ask_user pauses then pairs the answer without requesting beyond the final turn", async () => {
  const state = initial(); state.turns = 1;
  state.context = [call("ask_user", { question: "本步规模是多少？" }, "restored-question")];
  const runner = new AgentRunner(state, new MemoryStore(), noChemistry, noModelRequests, () => undefined, 1, 1);
  await runner.run();
  assert.equal(state.status, "needsInput"); assert.equal(state.question!.callId, "restored-question");
  assert.equal(outputs(state, "restored-question").length, 0); assert.equal(state.calls, 1);
  await runner.run("0.1 mmol");
  assert.equal(result(state, "restored-question").answer, "0.1 mmol");
  assert.equal(state.question, null); assert.equal(state.calls, 1); assert.equal(state.turns, 1);
  assert.equal(state.status, "budgetExhausted"); assertAllCallsPaired(state);
});

test("waiting execution restores a saved question and accepts its answer without double charge", async () => {
  const state = initial(); const invocation = call("ask_user", { question: "确认底物？" }, "waiting-question");
  state.turns = 1; state.calls = 1; state.context = [invocation];
  state.question = { callId: "waiting-question", text: "确认底物？" };
  state.executions = { "waiting-question": { name: "ask_user", arguments: String(invocation.arguments), phase: "waiting" } };
  await new AgentRunner(state, new MemoryStore(), noChemistry, noModelRequests, () => undefined, 1, 1).run("使用A");
  assert.equal(result(state, "waiting-question").answer, "使用A");
  assert.equal(state.question, null); assert.equal(state.calls, 1); assertAllCallsPaired(state);
});

test("model request failure without an output leaves no pending calls and can be retried", async () => {
  const state = initial(); let requests = 0;
  const transport: Transport = { turn: async () => {
    if (requests++ === 0) throw new Error("fixture_transport_failure");
    return { output: [call("ask_user", { question: "确认？" }, "after-network-error")] };
  } };
  const runner = new AgentRunner(state, new MemoryStore(), noChemistry, transport, () => undefined, 2, 1);
  await assert.rejects(runner.run(), /fixture_transport_failure/);
  assert.equal(state.status, "failed"); assert.equal(state.calls, 0);
  assert.equal(state.context.filter(item => item.type === "function_call").length, 0);
  await runner.run();
  assert.equal(state.status, "needsInput"); assert.equal(requests, 2);
  assert.equal(state.turns, 2); assert.equal(state.calls, 1);
});

class AuditedStore extends MemoryStore {
  failCompletionLogOnce = false;
  snapshots = 0;
  async write(path: string, value: string, overwrite = false): Promise<void> {
    if (path.endsWith("会话状态.json")) {
      const state: SessionState = JSON.parse(value);
      for (const event of state.events.filter(item => item.kind === "tool_completed")) {
        assert.equal(outputs(state, String(event.callId)).length, 1, "completed event must persist its native output in the same snapshot");
      }
      this.snapshots++;
    }
    if (path.endsWith("运行日志.json") && this.failCompletionLogOnce) {
      const log: { events: ProtocolItem[] } = JSON.parse(value);
      const last = log.events.at(-1);
      if (last?.kind === "tool_completed" && last.tool === "finish_route") {
        this.failCompletionLogOnce = false;
        throw new Error("fixture_completion_log_failure");
      }
    }
    await super.write(path, value, overwrite);
  }
}

const routeTurn = (): ProtocolItem[] => [
  call("record_inventory", { inventory: fixtureInventory([step()]) }, "inventory"),
  call("register_compounds", { structures: [{ compoundId: "c1", smiles: "CCO" }, { compoundId: "c2", smiles: "CCOC(C)=O" }] }, "compounds"),
  call("record_route", { plan: plan() }, "route-plan"),
  call("bind_steps", { bindings: [{ step: 1, experimentId: "e1", reagents: [] }] }, "bind"),
  call("render_step", { step: 1 }, "route-render"),
  call("write_step", { step: 1 }, "route-write"),
  call("finish_route", {}, "route-finish")
];
test("source payload filtering retains artifact paths and native write receipts stay text", async () => {
  const payload = { image: "Route/assets/S01.png", pages: [{ image: "iVBORw0KGgoFAKE", mime: "image/png" }], artifacts: { image: "a.png" } };
  assert.deepEqual(withoutImages(payload), { image: "Route/assets/S01.png", pages: [{ mime: "image/png" }], artifacts: { image: "a.png" } });
  const state = initial();
  await new AgentRunner(state, new MemoryStore(), renderingChemistry, { turn: async () => ({ output: routeTurn() }) }, () => {}, 1, 7).run();
  const writeReceipt = outputs(state, "route-write")[0];
  assert.equal(typeof writeReceipt.output, "string");
  assert.equal(JSON.parse(String(writeReceipt.output)).image, state.rendered[1].image);
});

test("native route flow persists paired outputs and creates note gallery and linked artifacts", async () => {
  const state = initial(); const store = new AuditedStore(); let modelRequests = 0;
  const transport: Transport = { turn: async () => { modelRequests++; return { output: routeTurn() }; } };
  const runner = new AgentRunner(state, store, renderingChemistry, transport, () => undefined, 1, 7);
  await runner.run();
  assert.equal(state.status, "completed"); assert.equal(modelRequests, 1);
  assert.equal(state.calls, 7); assert.equal(state.turns, 1); assertAllCallsPaired(state);
  const note = await store.read(state.written[1]);
  assert.ok(note.includes(`![[${state.rendered[1].image}]]`));
  assert.ok(note.includes(state.rendered[1].cdxml!));
  assert.ok(await store.exists(`${state.dir}/路线.base`));
  assert.ok(await store.exists(`${state.dir}/路线.md`));
  assert.ok(store.snapshots >= 8);
  const saved: SessionState = JSON.parse(await store.read(`${state.dir}/会话状态.json`));
  assert.equal(saved.status, "completed"); assertAllCallsPaired(saved);
});

test("log persistence failure after finish_route preserves completion when the session is restored", async () => {
  const state = initial(); const store = new AuditedStore(); store.failCompletionLogOnce = true;
  const transport: Transport = { turn: async () => ({ output: routeTurn() }) };
  await assert.rejects(new AgentRunner(state, store, renderingChemistry, transport, () => undefined, 1, 7).run(), /fixture_completion_log_failure/);
  assert.equal(state.status, "completed"); assertAllCallsPaired(state);
  const restored: SessionState = JSON.parse(await store.read(`${state.dir}/会话状态.json`));
  await new AgentRunner(restored, store, noChemistry, noModelRequests, () => undefined, 32, 128).run();
  assert.equal(restored.status, "completed"); assert.equal(restored.calls, 7); assertAllCallsPaired(restored);
});

test("legacy recovered output is paired before the next model request", async () => {
  const state = initial(); state.turns = 1; state.calls = 1;
  state.context = [call("inspect_structure", { smiles: "CCO" }, "old-inspect")];
  state.events = [{ kind: "tool_completed", tool: "inspect_structure", callId: "old-inspect", result: { smiles: "CCO" } }];
  const transport: Transport = { turn: async () => {
    assertAllCallsPaired(state);
    return { output: [call("ask_user", { question: "确认？" }, "next-question")] };
  } };
  await new AgentRunner(state, new MemoryStore(), noChemistry, transport, () => undefined, 2, 2).run();
  assert.equal(result(state, "old-inspect").smiles, "CCO");
  assert.equal(state.status, "needsInput"); assert.equal(state.calls, 2);
});

test("empty answer preserves a waiting question and its budget", async () => {
  const state = initial(); state.status = "needsInput"; state.calls = 1;
  state.context = [call("ask_user", { question: "确认？" }, "empty-answer")];
  state.question = { callId: "empty-answer", text: "确认？" };
  const store = new MemoryStore();
  await assert.rejects(new AgentRunner(state, store, noChemistry, noModelRequests, () => undefined).run("  "), /请回答当前问题/);
  assert.equal(state.status, "needsInput"); assert.equal(state.question.callId, "empty-answer");
  assert.equal(state.calls, 1); assert.equal(store.files.size, 0);
});

test("malformed or duplicate pending calls fail before execution or a model request", async () => {
  for (const context of [
    [{ type: "function_call", name: "inspect_structure", arguments: "{}" }],
    [call("inspect_structure", { smiles: "CCO" }, "duplicate"), call("inspect_structure", { smiles: "CCO" }, "duplicate")]
  ]) {
    const state = initial(); state.context = context;
    await assert.rejects(new AgentRunner(state, new MemoryStore(), noChemistry, noModelRequests, () => undefined).run(), /tool_envelope_invalid|duplicate_call_id/);
    assert.equal(state.calls, 0); assert.equal(state.turns, 0);
  }
});

test("unchanged scale after automatic property filling reuses stable quality artifacts", async () => {
  const state = initial(); state.plan = plan(); const s = state.plan.steps[0];
  s.reagents = [reagent()]; s.scaleMmol = .1; s.scaleBasisId = "SM";
  const chemistry = { call: async <T>(request: Record<string, unknown>): Promise<T> => {
    if (request.op === "inspect") return { smiles: "CCO", mw: 46.069, formula: "C2H6O" } as T;
    return renderingChemistry.call<T>(request);
  } };
  const store = new MemoryStore(); const runner = new AgentRunner(state, store, chemistry, noModelRequests, () => undefined);
  const first = await runner.execute("render_step", { step: 1 });
  assert.equal(first.propertyUpdates, 2); const artifacts = state.rendered[1];
  const quality = await store.read(artifacts.quality);
  await runner.execute("set_scale", { step: 1, reagentId: "SM", amountMmol: .1 });
  const second = await runner.execute("render_step", { step: 1 });
  assert.equal(second.propertyUpdates, 0); assert.deepEqual(state.rendered[1], artifacts);
  assert.equal(await store.read(artifacts.quality), quality);
  assert.equal(store.binaryWrites.get(artifacts.image), 1);
  assert.equal(store.textWrites.get(artifacts.cdxml!), 1); assert.equal(store.textWrites.get(artifacts.quality), 1);
});

test("legacy filled counter is compatible while changed quality evidence remains protected", async () => {
  const state = initial(); state.plan = plan(); const store = new MemoryStore();
  const runner = new AgentRunner(state, store, renderingChemistry, noModelRequests, () => undefined);
  await runner.execute("render_step", { step: 1 }); const artifacts = state.rendered[1];
  const report = JSON.parse(await store.read(artifacts.quality));
  report.properties.filled = 2;
  const legacyReport = JSON.stringify(report, null, 2); store.files.set(artifacts.quality, legacyReport);
  delete state.rendered[1];
  await runner.execute("render_step", { step: 1 });
  assert.equal(await store.read(artifacts.quality), legacyReport);
  report.chemistry.fixture = false;
  const userReport = JSON.stringify(report, null, 2); store.files.set(artifacts.quality, userReport);
  delete state.rendered[1];
  await assert.rejects(runner.execute("render_step", { step: 1 }), /artifact_conflict/);
  assert.equal(await store.read(artifacts.quality), userReport);
});

test("legacy source-page receipt rebuilds its image before the next native request", async () => {
  const state = initial(); const store = new MemoryStore();
  state.sources = [{ id: "source1", name: "paper.pdf", path: "sources/paper.pdf", mime: "application/pdf", pages: [{ page: 1, text: "fixture source" }] }];
  store.bytes.set("sources/paper.pdf", Buffer.from("fixture source bytes"));
  state.turns = 1; state.calls = 1;
  state.context = [call("read_source_page", { sourceId: "source1", page: 1, bbox: null }, "old-page")];
  state.events = [{ kind: "tool_completed", tool: "read_source_page", callId: "old-page", result: { sourceId: "source1", page: 1, text: "fixture source", mime: "image/png" } }];
  let pageReads = 0;
  const chemistry = { call: async <T>(request: Record<string, unknown>): Promise<T> => {
    assert.equal(request.op, "pdf_page"); pageReads++;
    return { text: "fixture source", png: Buffer.from("fixture page image").toString("base64") } as T;
  } };
  await new AgentRunner(state, store, chemistry, noModelRequests, () => undefined, 1, 1).run();
  const receipt = outputs(state, "old-page")[0];
  assert.ok(Array.isArray(receipt.output));
  assert.ok(receipt.output.some((item: ProtocolItem) => item.type === "input_image"));
  assert.equal(pageReads, 1); assert.equal(state.calls, 1); assertAllCallsPaired(state);
});

test("concurrent resume on one runner cannot issue a second model request", async () => {
  const state = initial(); let modelRequests = 0;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { entered = resolve; });
  const transport: Transport = { turn: async () => {
    modelRequests++; entered(); await gate;
    return { output: [call("ask_user", { question: "确认？" }, "concurrent-question")] };
  } };
  const runner = new AgentRunner(state, new MemoryStore(), noChemistry, transport, () => undefined);
  const firstRun = runner.run(); await requested;
  await assert.rejects(runner.run(), /session_busy/);
  release(); await firstRun;
  assert.equal(modelRequests, 1); assert.equal(state.turns, 1); assert.equal(state.calls, 1);
  assert.equal(state.status, "needsInput");
});
