import type { ExperimentStep } from "../src/domain";
import type { SessionState } from "../src/runner";
import type { SourceInventory } from "../src/inventory";
// Journal/intent unit tests use a fake verifier; real files have separate integration tests.
export function fixtureDeliveryVerification(request: Record<string, unknown>): unknown {
  if (request.op === "verify_compounds") return { compounds: (request.structures as { id: string; smiles: string }[]).map(c => ({ ...c, mw: 1, formula: "unit-fixture", stereoCenters: 0, stereoDoubleBonds: 0 })) };
  if (request.op === "check_binding") return { passed: true };
  if (request.op !== "verify_delivery") throw new Error(`unexpected fixture operation: ${request.op}`);
  return { results: (request.steps as { order: number }[]).map(step => ({ order: step.order, ok: true,
    verification: { editableGraph: "passed", stereoRoundtrip: "passed", reactionImage: { kind: "single-reaction" } } })) };
}
export function fixtureInventory(steps: ExperimentStep[], sourceId = "fixture-source"): SourceInventory {
  const identities = [...new Set(steps.flatMap(s => [...s.reactants, ...s.products]))];
  const id = (smiles: string) => `c${identities.indexOf(smiles) + 1}`;
  const citation = { sourceId, page: 1, quote: "Synthetic test fixture; not a published experimental protocol." };
  return { compounds: identities.map(smiles => ({ id: id(smiles), label: id(smiles), origin: steps.some(s => s.products.includes(smiles)) ? "target" : "starting",
    sourceImage: { sourceId, page: 1, bbox: null }, citations: [citation], formula: null,
    stereo: { scope: smiles.includes("@") ? "specified" : "achiral", centers: (smiles.match(/@{1,2}/g) ?? []).length, doubleBonds: 0 }, components: smiles.split(".").length, isomerOf: null, relationship: null })),
    experiments: steps.map(s => ({ id: `e${s.order}`, paperStep: s.paperStep, reactants: s.reactants.map(id), products: s.products.map(id), handling: "isolated", citations: [citation] })),
    targets: [...new Set(steps.flatMap(s => s.products.map(id)))] };
}
export function installFixtureInventory(state: SessionState) {
  const steps = state.plan!.steps;
  state.sources.push({ id: "fixture-source", name: "synthetic fixture", mime: "image/png", path: "fixture.png", pages: [] });
  state.inventory = fixtureInventory(steps);
  state.compounds = Object.fromEntries(state.inventory.compounds.map(c => [c.id, { id: c.id, smiles: [...new Set(steps.flatMap(s => [...s.reactants, ...s.products]))][Number(c.id.slice(1)) - 1], mw: 1, formula: "unit-fixture", stereoCenters: 0, stereoDoubleBonds: 0 }]));
  state.bindings = {};
  for (const step of steps) {
    const experiment = state.inventory.experiments.find(e => e.id === `e${step.order}`)!;
    const links: { reagentId: string; compoundId: string }[] = [];
    for (const [role, ids] of [["substrate", experiment.reactants], ["product", experiment.products]] as const) {
      let rows = step.reagents.filter(row => row.role === role);
      if (!rows.length) {
        rows = ids.map(cid => ({ id: `${role}-${cid}`, name: cid, role, smiles: state.compounds![cid].smiles, mw: null, equivalents: null, referenceAmountMmol: null, referenceMassMg: null, referenceVolumeMl: null, concentrationM: null, densityGml: null, purityPercent: null, citations: [] }));
        step.reagents.push(...rows);
      }
      rows.forEach((row, index) => links.push({ reagentId: row.id, compoundId: ids[index] }));
    }
    state.bindings[step.order] = { step: step.order, experimentId: experiment.id, reagents: links };
  }
}
