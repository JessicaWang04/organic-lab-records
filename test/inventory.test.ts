import assert from "node:assert/strict";
import test from "node:test";
import { fixtureInventory, installFixtureInventory, fixtureDeliveryVerification } from "./delivery-fixture";
import { inventoryIssues, validateInventory, verifyCompounds } from "../src/inventory";
import type { SessionState } from "../src/runner";
import { AgentRunner } from "../src/runner";
import type { ExperimentStep, FileStore } from "../src/domain";
const step = (order = 1): ExperimentStep => ({ order, paperStep: String(order), title: "fixture", purpose: "fixture", reactants: order === 1 ? ["CCO"] : ["CC=O"], products: order === 1 ? ["CC=O"] : ["CC(=O)O"], reagents: [], aboveArrow: [], belowArrow: [], procedure: [], workup: [], purification: [], characterization: [], citations: [], referenceBasisMmol: null, referenceYield: null, yieldScope: null, conflicts: [], sourceImage: null, scaleMmol: null, scaleBasisId: null });
function state(): SessionState { const s: SessionState = { id: "inventory", dir: "Route", prompt: "fixture", status: "localReady", sources: [], context: [], turns: 0, calls: 0, plan: { title: "fixture", intent: "fixture", requestedChanges: [], steps: [step(), step(2)] }, rendered: {}, written: {}, receipts: {}, events: [], question: null }; installFixtureInventory(s); s.inventory!.compounds[1].origin = "intermediate"; return s; }
test("source inventory detects omitted and duplicate experiments independently of the plan", () => {
  const s = state(); assert.deepEqual(inventoryIssues(s, s.plan!.steps, s.sources), []);
  assert.ok(inventoryIssues(s, [s.plan!.steps[0]], s.sources).some(i => i.code === "missing_experiment"));
  s.bindings![2].experimentId = "e1";
  assert.ok(inventoryIssues(s, s.plan!.steps, s.sources).some(i => i.code === "duplicate_experiment"));
});
test("order and one-pot yield scope cannot be discarded", () => {
  const s = state(); s.bindings![1] = { ...s.bindings![2], step: 1 }; s.bindings![2] = { ...s.bindings![1], step: 2, experimentId: "e1" };
  assert.ok(inventoryIssues(s, s.plan!.steps, s.sources).some(i => i.code === "route_order_conflict"));
  const p = state(); p.inventory!.experiments[0].handling = "one-pot"; p.plan!.steps[0].referenceYield = "70%";
  assert.ok(inventoryIssues(p, p.plan!.steps, p.sources).some(i => i.code === "one_pot_yield_scope"));
});
test("observations require source evidence, crop and explicit stereo counts", () => {
  const s = state(), inventory = fixtureInventory([step()]);
  inventory.compounds[0].stereo = { scope: "specified", centers: null, doubleBonds: 0 };
  assert.throws(() => validateInventory(inventory, s.sources), /stereo_observation_missing/);
  inventory.compounds[0].stereo = { scope: "achiral", centers: 0, doubleBonds: 0 };
  inventory.compounds[0].formula = { formula: "C2H6O", adduct: null, mz: null };
  assert.throws(() => validateInventory(inventory, s.sources), /formula_evidence_missing/);
  inventory.compounds[0].formula = null; inventory.compounds[0].citations = [];
  assert.throws(() => validateInventory(inventory, s.sources), /inventory_evidence_missing/);
  inventory.compounds[0].citations = inventory.compounds[1].citations;
  inventory.compounds[0].sourceImage.page = 2;
  assert.throws(() => validateInventory(inventory, s.sources), /compound_source_invalid/);
});
test("registration is atomic and same ID cannot drift", async () => {
  const s = state(), before = structuredClone(s.compounds);
  await assert.rejects(verifyCompounds(s, { call: async <T>(r: Record<string, unknown>) => fixtureDeliveryVerification(r) as T }, [{ compoundId: "c1", smiles: "CCN" }]), /compound_identity_conflict/);
  assert.deepEqual(s.compounds, before);
  await assert.rejects(verifyCompounds(s, { call: async () => { throw new Error("native failure"); } }, [{ compoundId: "c1", smiles: "CCO" }]), /native failure/);
  assert.deepEqual(s.compounds, before);
});
test("text-PDF observations cannot cite invented text or use full-page compound crops", () => {
  const s = state(), inventory = fixtureInventory([step()]);
  const source = { ...s.sources[0], mime: "application/pdf", pages: [{ page: 1, text: "Real source observation: ethanol C2H6O." }] };
  for (const compound of inventory.compounds) { compound.sourceImage.bbox = [.1, .1, .7, .4]; compound.citations = [{ sourceId: source.id, page: 1, quote: "Real source observation: ethanol C2H6O." }]; }
  for (const experiment of inventory.experiments) experiment.citations = inventory.compounds[0].citations;
  validateInventory(inventory, [source]);
  inventory.compounds[0].citations[0].quote = "Invented compound C99H99.";
  assert.throws(() => validateInventory(inventory, [source]), /quote_not_found|inventory_quote_mismatch/);
  inventory.compounds[0].citations = inventory.compounds[1].citations;
  inventory.compounds[0].sourceImage.bbox = null;
  assert.throws(() => validateInventory(inventory, [source]), /compound_crop_required/);
});
test("materialization bounds concurrency, saves independent successes, and retries only failure", async () => {
  const s = state(); s.plan!.steps.push({ ...step(3), paperStep: "3" }); s.bindings![3] = { step: 3, experimentId: "e3", reagents: [] };
  const store: FileStore = { exists: async () => false, read: async () => "", readBinary: async () => new Uint8Array(), write: async () => {}, binary: async () => {} };
  const runner = new AgentRunner(s, store, { call: async <T>() => ({} as T) }, { turn: async () => ({ output: [] }) }, () => {});
  const execute = runner.execute.bind(runner); let active = 0, maximum = 0, fail = true; const rendered: number[] = [], written: number[] = [];
  runner.execute = async (name, args) => {
    if (name === "render_step") { const order = Number(args.step); rendered.push(order); active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; if (order === 2 && fail) throw new Error("fixture step 2 failure"); return {}; }
    if (name === "write_step") { written.push(Number(args.step)); return { path: `S${args.step}.md` }; }
    return execute(name, args);
  };
  const first = await runner.execute("materialize_steps", { steps: [1, 2, 3] });
  assert.equal(first.status, "partial"); assert.equal(maximum, 2); assert.deepEqual(written.sort(), [1, 3]);
  assert.deepEqual((first.results as { step: number }[]).map(r => r.step), [1, 2, 3]);
  fail = false; await runner.execute("materialize_steps", { steps: [2] });
  assert.deepEqual(rendered.filter(order => order === 1), [1]); assert.deepEqual(written.sort(), [1, 2, 3]);
});
