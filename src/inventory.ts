import { Chemistry } from "./chemistry";
import { Citation, ExperimentStep, SourceAsset } from "./domain";
import { checkEvidence } from "./quality";

export interface CompoundObservation {
  id: string; label: string; origin: "starting" | "intermediate" | "target";
  sourceImage: { sourceId: string; page: number; bbox: number[] | null };
  citations: Citation[];
  formula: { formula: string; adduct: string | null; mz: number | null } | null;
  stereo: { scope: "achiral" | "specified" | "relative" | "unspecified"; centers: number | null; doubleBonds: number | null };
  components: number | null;
  isomerOf: string | null; relationship: "epimer" | "enantiomer" | null;
}
export interface SourceInventory {
  compounds: CompoundObservation[];
  experiments: { id: string; paperStep: string; reactants: string[]; products: string[]; handling: "isolated" | "one-pot" | "crude-transfer"; citations: Citation[] }[];
  targets: string[];
}
export interface RegisteredCompound { id: string; smiles: string; formula: string; mw: number; stereoCenters: number; stereoDoubleBonds: number }
export interface StepBinding { step: number; experimentId: string; reagents: { reagentId: string; compoundId: string }[] }
export interface InventoryState { inventory?: SourceInventory; compounds?: Record<string, RegisteredCompound>; bindings?: Record<number, StepBinding> }

function evidence(citations: Citation[], sources: SourceAsset[]): void {
  if (!citations.length || citations.some(c => !c.quote.trim())) throw new Error("inventory_evidence_missing: 每项观察必须有真实来源短引");
  const fake = { citations, reagents: [], conflicts: [], referenceYield: null } as unknown as ExperimentStep;
  const errors = checkEvidence(fake, sources).filter(issue => issue.severity === "error");
  if (errors.length) throw new Error(`inventory_evidence_invalid: ${JSON.stringify(errors)}`);
  const normalized = (text: string) => text.normalize("NFKC").replace(/\s/g, "");
  for (const citation of citations) {
    const source = sources.find(s => s.id === citation.sourceId), text = source?.pages.find(p => p.page === citation.page)?.text ?? "";
    if (source && source.mime !== "application/pdf" && citation.page !== 1) throw new Error("inventory_evidence_invalid: 图片来源只有第1页");
    if (source?.mime === "application/pdf" && text.trim() && !normalized(text).includes(normalized(citation.quote))) throw new Error("inventory_quote_mismatch: 文本PDF观察短引必须匹配真实页文字；不能编造公式或来源");
  }
}
export function validateInventory(inventory: SourceInventory, sources: SourceAsset[]): void {
  if (!inventory || !Array.isArray(inventory.compounds) || !inventory.compounds.length || inventory.compounds.length > 160 || !Array.isArray(inventory.experiments) || !inventory.experiments.length || inventory.experiments.length > 60 || !Array.isArray(inventory.targets) || !inventory.targets.length) throw new Error("inventory_invalid: 需要化合物、范围内实验和目标清单");
  const ids = new Set<string>();
  for (const compound of inventory.compounds) {
    if (!["starting", "intermediate", "target"].includes(compound.origin) || !["achiral", "specified", "relative", "unspecified"].includes(compound.stereo.scope) || ![null, "epimer", "enantiomer"].includes(compound.relationship)) throw new Error("inventory_invalid: 观察枚举不合法");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(compound.id) || ids.has(compound.id)) throw new Error("compound_id_invalid: 化合物ID必须唯一");
    ids.add(compound.id); evidence(compound.citations, sources);
    const image = compound.sourceImage, source = sources.find(s => s.id === image?.sourceId);
    if (!source || !Number.isInteger(image.page) || image.page < 1 || (source.mime !== "application/pdf" && image.page !== 1) || source.mime === "application/pdf" && !source.pages.some(p => p.page === image.page)) throw new Error("compound_source_invalid: 来源图必须来自本次材料的真实页");
    const box = image.bbox;
    if (source.mime === "application/pdf" && box === null) throw new Error("compound_crop_required: PDF结构观察必须指定局部bbox");
    if (box !== null && (box.length !== 4 || box.some(v => !Number.isFinite(v) || v < 0 || v > 1) || box[0] >= box[2] || box[1] >= box[3])) throw new Error("invalid_bbox: 使用0至1的局部矩形");
    for (const count of [compound.stereo.centers, compound.stereo.doubleBonds]) if (count !== null && (!Number.isInteger(count) || count < 0 || count > 500)) throw new Error("stereo_count_invalid");
    if (["specified", "relative"].includes(compound.stereo.scope) && (compound.stereo.centers === null || compound.stereo.doubleBonds === null)) throw new Error("stereo_observation_missing: 已指定构型必须记录明确中心和双键构型数量");
    if (compound.components !== null && (!Number.isInteger(compound.components) || compound.components < 1 || compound.components > 12)) throw new Error("component_count_invalid");
    if (compound.formula && !compound.citations.some(c => c.quote.normalize("NFKC").replace(/\s/g, "").includes(compound.formula!.formula.normalize("NFKC").replace(/\s/g, "")))) throw new Error("formula_evidence_missing: 分子式必须出现在该化合物的来源短引中");
    if ((compound.isomerOf === null) !== (compound.relationship === null)) throw new Error("isomer_relationship_invalid");
  }
  for (const compound of inventory.compounds) if (compound.isomerOf && (!ids.has(compound.isomerOf) || compound.isomerOf === compound.id)) throw new Error("isomer_reference_invalid");
  const experiments = new Set<string>();
  for (const experiment of inventory.experiments) {
    if (!["isolated", "one-pot", "crude-transfer"].includes(experiment.handling)) throw new Error("experiment_inventory_invalid: 实验单元类型不合法");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(experiment.id) || experiments.has(experiment.id) || !experiment.paperStep.trim() || !experiment.reactants.length || !experiment.products.length || [...experiment.reactants, ...experiment.products].some(id => !ids.has(id))) throw new Error("experiment_inventory_invalid");
    experiments.add(experiment.id); evidence(experiment.citations, sources);
  }
  if (new Set(inventory.targets).size !== inventory.targets.length || inventory.targets.some(id => !ids.has(id) || !inventory.experiments.some(e => e.products.includes(id)))) throw new Error("target_inventory_invalid: 每个目标必须在范围内实验中产生");
}

export function inventoryIssues(state: InventoryState, steps: ExperimentStep[], sources: SourceAsset[]): { step: number; code: string; message: string }[] {
  const issues: { step: number; code: string; message: string }[] = [];
  const add = (step: number, code: string, message: string) => issues.push({ step, code, message });
  if (!state.inventory) { add(0, "inventory_missing", "请先record_inventory保存来源步骤、目标和化合物观察；不能只用生成计划证明没有漏步。"); return issues; }
  try { validateInventory(state.inventory, sources); } catch (error) { add(0, "inventory_invalid", String(error)); return issues; }
  const { inventory } = state;
  for (const compound of inventory.compounds) if (!state.compounds?.[compound.id]) add(0, "compound_unregistered", `请register_compounds核对 ${compound.id} (${compound.label})`);
  const counts = new Map<string, number[]>();
  for (const step of steps) {
    const binding = state.bindings?.[step.order];
    if (!binding || !inventory.experiments.some(e => e.id === binding.experimentId)) { add(step.order, "step_unbound", "请bind_steps将本步绑定来源实验与已核对化合物"); continue; }
    counts.set(binding.experimentId, [...(counts.get(binding.experimentId) ?? []), step.order]);
    const experiment = inventory.experiments.find(e => e.id === binding.experimentId)!;
    if (!step.reagents.some(r => r.role === "substrate") || !step.reagents.some(r => r.role === "product")) add(step.order, "material_table_incomplete", "必须有绑定来源结构的底物和产物行，未知投料可留null");
    if (step.paperStep !== experiment.paperStep) add(step.order, "paper_step_mismatch", `本步paperStep必须保持来源编号 ${experiment.paperStep}`);
    if (experiment.handling === "one-pot" && step.yieldScope !== null && !/合并|one.?pot|combined|总|overall/i.test(step.yieldScope)) add(step.order, "one_pot_yield_scope", "one-pot产率必须保留合并口径");
    if (step.referenceYield !== null && experiment.handling === "one-pot" && step.yieldScope === null) add(step.order, "one_pot_yield_scope", "one-pot有产率时必须明确合并口径");
    if ([...experiment.reactants, ...experiment.products].some(id => inventory.compounds.find(c => c.id === id)?.stereo.scope === "relative") && !step.belowArrow.some(text => /relative|相对构型/i.test(text))) add(step.order, "relative_stereo_annotation_missing", "相对构型必须在反应图中明确注明，不宣称绝对构型");
    for (const row of step.reagents.filter(r => r.role === "substrate" || r.role === "product")) {
      const links = binding.reagents.filter(r => r.reagentId === row.id);
      const allowed = row.role === "substrate" ? experiment.reactants : experiment.products;
      if (links.length !== 1 || !allowed.includes(links[0].compoundId)) add(step.order, "reagent_binding_missing", `物料 ${row.id} 必须绑定对应来源化合物`);
    }
  }
  for (const experiment of inventory.experiments) {
    const mapped = counts.get(experiment.id) ?? [];
    if (mapped.length !== 1) add(0, mapped.length ? "duplicate_experiment" : "missing_experiment", `来源实验 ${experiment.id} (${experiment.paperStep}) 必须对应一个记录，当前 ${mapped.length} 个`);
    for (const id of experiment.reactants) {
      if (inventory.compounds.find(c => c.id === id)?.origin === "starting") continue;
      const producers = inventory.experiments.filter(e => e.products.includes(id) && e.id !== experiment.id);
      if (!producers.length) add(0, "intermediate_producer_missing", `中间体 ${id} 的来源步骤不在范围清单中`);
      if (mapped.length === 1 && producers.length && !producers.some(e => (counts.get(e.id)?.[0] ?? Infinity) < mapped[0])) add(mapped[0], "route_order_conflict", `中间体 ${id} 必须先产生再续用`);
    }
  }
  return issues;
}

export async function verifyCompounds(state: InventoryState, chemistry: Chemistry, candidates?: { compoundId: string; smiles: string }[]): Promise<RegisteredCompound[]> {
  if (!state.inventory) throw new Error("inventory_missing: 先记录来源观察");
  const inputs = candidates ?? Object.values(state.compounds ?? {}).map(c => ({ compoundId: c.id, smiles: c.smiles }));
  if (!inputs.length || inputs.length > 160 || new Set(inputs.map(c => c.compoundId)).size !== inputs.length) throw new Error("compound_batch_invalid");
  const all = { ...state.compounds };
  for (const input of inputs) {
    if (!state.inventory.compounds.some(c => c.id === input.compoundId)) throw new Error(`compound_not_observed: ${input.compoundId}`);
    all[input.compoundId] = { id: input.compoundId, smiles: input.smiles } as RegisteredCompound;
  }
  const result = await chemistry.call<{ compounds: RegisteredCompound[] }>({ op: "verify_compounds", observations: state.inventory.compounds.filter(c => all[c.id]), structures: Object.values(all).map(c => ({ id: c.id, smiles: c.smiles })) });
  if (!Array.isArray(result.compounds) || result.compounds.length !== Object.keys(all).length || new Set(result.compounds.map(c => c.id)).size !== result.compounds.length || result.compounds.some(c => !all[c.id] || !c.smiles || !Number.isFinite(c.mw) || !c.formula)) throw new Error("compound_verifier_invalid");
  for (const compound of result.compounds) if (state.compounds?.[compound.id] && state.compounds[compound.id].smiles !== compound.smiles) throw new Error(`compound_identity_conflict: ${compound.id} 已登记为另一结构；差向异构体必须使用不同ID`);
  return result.compounds;
}

export function expectedStep(state: InventoryState, step: ExperimentStep): Record<string, unknown> {
  const binding = state.bindings?.[step.order], experiment = state.inventory?.experiments.find(e => e.id === binding?.experimentId);
  if (!binding || !experiment) return {};
  const structures = (ids: string[]) => ids.map(id => state.compounds?.[id]?.smiles).filter((s): s is string => !!s);
  return { expectedReactants: structures(experiment.reactants), expectedProducts: structures(experiment.products), edits: step.edits ?? [],
    reagentStructures: binding.reagents.map(link => { const row = step.reagents.find(r => r.id === link.reagentId); return { id: link.reagentId, expected: state.compounds?.[link.compoundId]?.smiles, actual: row?.smiles, mw: row?.mw, formula: row?.formula }; }) };
}
