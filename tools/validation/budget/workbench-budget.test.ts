import assert from "node:assert/strict";
import { test } from "node:test";
import type { App, PluginManifest } from "obsidian";
import OrganicLabPlugin from "../../../src/main";
import { AgentRunner, SessionState } from "../../../src/runner";
import { PythonChemistry } from "../../../src/chemistry";
import { ResponsesTransport } from "../../../src/provider";
import { Element, notices, Plugin as StubPlugin, WorkspaceLeaf } from "./obsidian-stub";

interface View { budgetEl: Element; stateEl: Element; continueButton: Element; promptEl: Element; onOpen(): Promise<void>; start(): Promise<void>; restore(): Promise<void> }
const state = (): SessionState => ({
  id: "ui-budget", dir: "Memory", prompt: "fixture", status: "budgetExhausted", turns: 32, calls: 128,
  sources: [], context: [], plan: null, rendered: {}, written: {}, receipts: {}, events: [], question: null
});
const store = {
  exists: async () => false, read: async () => "", readBinary: async () => new Uint8Array(),
  write: async () => undefined, binary: async () => undefined
};
async function setup() {
  const leaves: WorkspaceLeaf[] = [];
  const app = { workspace: { getLeavesOfType: () => leaves }, vault: { adapter: { read: async () => JSON.stringify(state()) } }, secretStorage: { getSecret: () => "" } };
  const plugin = new OrganicLabPlugin(app as unknown as App, { id: "organic-lab-agent" } as PluginManifest);
  await plugin.onload();
  const backing = plugin as unknown as StubPlugin;
  const factory = backing.viewFactories.get("organic-lab-agent")!;
  const views: View[] = [];
  for (let index = 0; index < 2; index++) {
    const leaf = new WorkspaceLeaf(app); const view = factory(leaf) as View; leaf.view = view; leaves.push(leaf);
    await view.onOpen(); views.push(view);
  }
  return { app, plugin, backing, views };
}

test("saved settings update both workbench displays and the already exhausted runner", async () => {
  const { plugin, backing, views } = await setup(); const current = state();
  plugin.runner = new AgentRunner(current, store, { call: async () => { throw new Error("unused chemistry"); } }, { turn: async () => { throw new Error("unused transport"); } }, () => undefined);
  plugin.refreshStates();
  await plugin.saveBudget({ maxTurns: 40, maxCalls: 160 });
  assert.deepEqual(plugin.runner.budget, { maxTurns: 40, maxCalls: 160 });
  assert.equal(current.turns, 32); assert.equal(current.calls, 128);
  assert.equal(backing.saves.length, 1);
  for (const view of views) {
    assert.match(view.budgetEl.textContent, /已用32／上限40/);
    assert.match(view.budgetEl.textContent, /已用128／上限160/);
    assert.match(view.stateEl.textContent, /额度已更新，可继续/);
    assert.equal(view.continueButton.disabled, false);
  }
});

test("failed settings save restores the prior limits in settings, runner and display", async () => {
  const { plugin, backing, views } = await setup();
  plugin.runner = new AgentRunner(state(), store, { call: async () => { throw new Error("unused chemistry"); } }, { turn: async () => { throw new Error("unused transport"); } }, () => undefined);
  backing.saveError = new Error("fixture_settings_save_failed");
  await assert.rejects(plugin.saveBudget({ maxTurns: 40, maxCalls: 160 }), /fixture_settings_save_failed/);
  assert.equal(plugin.settings.maxTurns, 32); assert.equal(plugin.settings.maxCalls, 128);
  assert.deepEqual(plugin.runner.budget, { maxTurns: 32, maxCalls: 128 });
  for (const view of views) assert.match(view.budgetEl.textContent, /已用32／上限32/);
});

test("another budget save cannot overwrite limits while the first save is awaiting storage", async () => {
  const { plugin, backing } = await setup(); let finishSave!: () => void;
  const paused = new Promise<void>(resolve => finishSave = resolve);
  backing.saveData = async () => { await paused; };
  const saved = plugin.saveBudget({ maxTurns: 40, maxCalls: 160 });
  await assert.rejects(plugin.saveBudget({ maxTurns: 48, maxCalls: 192 }), /预算正在保存/);
  finishSave(); await saved;
  assert.equal(plugin.settings.maxTurns, 40); assert.equal(plugin.settings.maxCalls, 160);
});

test("an exhausted turn budget still permits repairing already received native tool calls", async () => {
  const { plugin, views } = await setup(); const current = state();
  current.context = [{ type: "function_call", call_id: "received", name: "inspect_structure", arguments: '{"smiles":"CCO"}' }];
  plugin.runner = new AgentRunner(current, store, { call: async () => { throw new Error("unused chemistry"); } }, { turn: async () => { throw new Error("unused transport"); } }, () => undefined);
  plugin.refreshStates();
  for (const view of views) {
    assert.equal(view.continueButton.disabled, false);
    assert.match(view.continueButton.textContent, /补齐已收到的工具调用/);
  }
});

test("restore acquires the shared lock before reading, blocking other views from replacing the runner", async () => {
  const { app, plugin, views } = await setup(); let finishRead!: () => void; let reads = 0;
  const paused = new Promise<void>(resolve => finishRead = resolve);
  app.vault.adapter.read = async () => { reads++; await paused; return JSON.stringify(state()); };
  plugin.settings.lastSession = "Memory/会话状态.json";
  plugin.chemistry = () => ({ call: async () => { throw new Error("unused chemistry"); } }) as unknown as PythonChemistry;
  plugin.transport = () => ({ turn: async () => { throw new Error("unused transport"); } }) as unknown as ResponsesTransport;
  const restored = views[0].restore();
  assert.equal(plugin.sessionBusy, true);
  views[1].promptEl.value = "fixture new route";
  await views[1].restore(); await views[1].start();
  assert.equal(reads, 1); assert.equal(plugin.runner, null);
  assert.ok(notices.some(text => /会话正在执行|另一个工作台正在/.test(text)));
  finishRead(); await restored;
  assert.equal(plugin.runner!.state.id, "ui-budget"); assert.equal(plugin.sessionBusy, false);
});
