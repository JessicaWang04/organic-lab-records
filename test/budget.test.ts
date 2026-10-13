import assert from "node:assert/strict";
import { test } from "node:test";
import { appendBudget, budgetText, canContinue, DEFAULT_BUDGET, parseBudget, remainingBudget, SessionGate } from "../src/budget";
import { FileStore } from "../src/domain";
import { AgentRunner, SessionState, Transport } from "../src/runner";

class MemoryStore implements FileStore {
  files = new Map<string, string>();
  async exists(path: string): Promise<boolean> { return this.files.has(path); }
  async read(path: string): Promise<string> { return this.files.get(path)!; }
  async readBinary(): Promise<Uint8Array> { throw new Error("unexpected binary read"); }
  async binary(): Promise<void> { throw new Error("unexpected binary write"); }
  async write(path: string, content: string): Promise<void> { this.files.set(path, content); }
}
const initial = (): SessionState => ({
  id: "budget-test", dir: "MemoryRoute", prompt: "fixture", status: "archived", turns: 0, calls: 0,
  sources: [], context: [], plan: null, rendered: {}, written: {}, receipts: {}, events: [], question: null
});
const call = (name: string, args: unknown, callId: string) => ({ type: "function_call", name, arguments: JSON.stringify(args), call_id: callId });
const chemistry = { call: async <T>(): Promise<T> => ({ smiles: "CCO", mw: 46.069 }) as T };

test("budget input keeps defaults and rejects empty, fractional or out-of-range limits", () => {
  assert.deepEqual(DEFAULT_BUDGET, { maxTurns: 32, maxCalls: 128 });
  assert.deepEqual(parseBudget(" 32 ", "128"), DEFAULT_BUDGET);
  for (const [turns, calls] of [["", "128"], ["32", ""], ["0", "128"], ["32.5", "128"], ["129", "128"], ["32", "513"], ["NaN", "128"]]) {
    assert.throws(() => parseBudget(turns, calls));
  }
});

test("remaining budget reports both exhausted axes without changing cumulative usage", () => {
  const used = { turns: 35, calls: 128 };
  assert.deepEqual(remainingBudget(DEFAULT_BUDGET, used), { turns: 0, calls: 0 });
  assert.equal(canContinue(DEFAULT_BUDGET, used), false);
  assert.deepEqual(used, { turns: 35, calls: 128 });
  assert.match(budgetText(DEFAULT_BUDGET, used), /已用35／上限32/);
  assert.match(budgetText(DEFAULT_BUDGET, used), /累计次数不清零/);
});

test("explicit additions preserve usage and require enough room on both exhausted axes", () => {
  const limits = { maxTurns: 32, maxCalls: 128 }, used = { turns: 32, calls: 128 };
  assert.throws(() => appendBudget(limits, used, "0", "0"), /明确填写/);
  assert.throws(() => appendBudget(limits, used, "8", "0"), /仍有一项/);
  assert.throws(() => appendBudget(limits, used, "-1", "32"), /0或正整数/);
  assert.throws(() => appendBudget(limits, used, "0.5", "32"), /0或正整数/);
  assert.deepEqual(appendBudget(limits, used, "8", "32"), { maxTurns: 40, maxCalls: 160 });
  assert.deepEqual(limits, DEFAULT_BUDGET); assert.deepEqual(used, { turns: 32, calls: 128 });
});

test("adding only the exhausted axis works and never silently raises a lowered limit", () => {
  assert.deepEqual(appendBudget(DEFAULT_BUDGET, { turns: 32, calls: 50 }, "8", "0"), { maxTurns: 40, maxCalls: 128 });
  assert.throws(() => appendBudget({ maxTurns: 20, maxCalls: 128 }, { turns: 32, calls: 50 }, "8", "0"), /仍有一项/);
  assert.throws(() => appendBudget({ maxTurns: 128, maxCalls: 512 }, { turns: 128, calls: 512 }, "1", "1"), /1–128/);
});

test("updating an exhausted existing runner resumes with the new limits and keeps counts", async () => {
  const state = initial(); let requests = 0;
  const transport: Transport = { turn: async () => ({ output: requests++ === 0
    ? [call("inspect_structure", { smiles: "CCO" }, "first")]
    : [call("ask_user", { question: "确认下一步？" }, "question")] }) };
  const runner = new AgentRunner(state, new MemoryStore(), chemistry, transport, () => undefined, 1, 1);
  await runner.run(); assert.equal(state.status, "budgetExhausted");
  runner.setBudget({ maxTurns: 2, maxCalls: 2 });
  assert.equal(state.turns, 1); assert.equal(state.calls, 1);
  await runner.run();
  assert.equal(requests, 2); assert.equal(state.status, "needsInput");
  assert.equal(state.turns, 2); assert.equal(state.calls, 2);
  assert.equal(state.context.filter(item => item.type === "function_call_output" && item.call_id === "first").length, 1);
});

test("saving a budget during a running request applies at the next boundary", async () => {
  const state = initial(); let requests = 0; let runner: AgentRunner;
  const transport: Transport = { turn: async () => {
    assert.equal(runner.isRunning, true);
    if (requests++ === 0) {
      runner.setBudget({ maxTurns: 2, maxCalls: 2 });
      return { output: [call("inspect_structure", { smiles: "CCO" }, "first")] };
    }
    return { output: [call("ask_user", { question: "确认？" }, "question")] };
  } };
  runner = new AgentRunner(state, new MemoryStore(), chemistry, transport, () => undefined, 1, 1);
  await runner.run();
  assert.equal(requests, 2); assert.equal(state.turns, 2); assert.equal(state.calls, 2);
  assert.equal(runner.isRunning, false); assert.equal(state.status, "needsInput");
});

test("invalid budget update does not partly change a runner or reset its counts", () => {
  const state = initial(); state.turns = 8; state.calls = 20;
  const runner = new AgentRunner(state, new MemoryStore(), chemistry, { turn: async () => { throw new Error("not used"); } }, () => undefined);
  assert.throws(() => runner.setBudget({ maxTurns: 40, maxCalls: 0 }));
  assert.deepEqual(runner.budget, DEFAULT_BUDGET);
  assert.equal(state.turns, 8); assert.equal(state.calls, 20);
  const detached = runner.budget; detached.maxTurns = 1;
  assert.deepEqual(runner.budget, DEFAULT_BUDGET);
});

test("one shared gate blocks another view while restore is awaiting its snapshot", async () => {
  const gate = new SessionGate(); let finishRead!: () => void; let replacements = 0;
  const read = new Promise<void>(resolve => finishRead = resolve);
  const restoreRelease = gate.acquire(); assert.ok(restoreRelease);
  const restore = (async () => { try { await read; replacements++; } finally { restoreRelease(); } })();
  assert.equal(gate.busy, true); assert.equal(gate.acquire(), null);
  finishRead(); await restore;
  assert.equal(replacements, 1); assert.equal(gate.busy, false);
  const nextRelease = gate.acquire(); assert.ok(nextRelease); nextRelease();
});

test("a repeated release from an old operation cannot unlock a newer operation", () => {
  const gate = new SessionGate(); const oldRelease = gate.acquire(); assert.ok(oldRelease); oldRelease();
  const currentRelease = gate.acquire(); assert.ok(currentRelease);
  oldRelease(); assert.equal(gate.busy, true); assert.equal(gate.acquire(), null);
  currentRelease(); assert.equal(gate.busy, false);
});
