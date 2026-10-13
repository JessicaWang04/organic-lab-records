import { createHash } from "node:crypto";
import { Chemistry } from "./chemistry";
import { Citation, ExperimentStep, FileStore, finitePositive, RoutePlan, SourceAsset, StepArtifacts, validatePlan } from "./domain";
import { buildBase, buildStepNote, GalleryOptions, pad, routeNote, stepFile } from "./records";
import { checkEvidence, requiresStructureEdit } from "./quality";
import { searchSources, sourcePage, sourcePages } from "./sources";
import { validateToolCall } from "./tools";
import { PropertyResolver } from "./reagent-properties";
import { BudgetLimits, DEFAULT_BUDGET, validateBudget } from "./budget";
import { auditDelivery, assertDelivery, requireStructures } from "./delivery";
import { SourceInventory, RegisteredCompound, StepBinding, validateInventory, verifyCompounds, expectedStep, inventoryIssues } from "./inventory";
export type ProtocolItem = Record<string, unknown>;
export interface Turn { output: ProtocolItem[]; usage?: unknown }
export interface Transport { turn(input: ProtocolItem[]): Promise<Turn> }
export type ToolExecution = { name: string; arguments: string } & (
  { phase: "started" | "waiting"; output?: never } | { phase: "completed"; output: ProtocolItem }
);
export interface SessionState {
  id: string; dir: string; prompt: string; status: string; turns: number; calls: number;
  sources: SourceAsset[]; context: ProtocolItem[]; plan: RoutePlan | null;
  rendered: Record<number, StepArtifacts>; written: Record<number, string>; receipts: Record<string, ProtocolItem>;
  events: ProtocolItem[]; question: { callId: string; text: string } | null;
  failures?: Record<string, number>; emptyTurns?: number;
  provider?: { baseUrl: string; model: string; keyFingerprint: string };
  gallery?: GalleryOptions;
  executions?: Record<string, ToolExecution>;
  inventory?: SourceInventory; compounds?: Record<string, RegisteredCompound>; bindings?: Record<number, StepBinding>;
}
const canonicalJson = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalJson) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalJson(item)])) : value;
const stableQuality = (value: unknown): unknown => {
  if (value && typeof value === "object" && !Array.isArray(value) && "properties" in value) {
    const properties = value.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) return { ...value, properties: Object.fromEntries(Object.entries(properties).filter(([key]) => key !== "filled")) };
  }
  return value;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex").slice(0, 14);
export const withoutImages = (value: unknown): unknown => Array.isArray(value) ? value.map(withoutImages) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key, item]) => !["png", "data"].includes(key) && !(key === "image" && typeof item === "string" && item.startsWith("iVBORw0KGgo"))).map(([key, item]) => [key, withoutImages(item)])) : value;
export class AgentRunner {
  stopped = false;
  private running = false;
  private properties: PropertyResolver;
  constructor(public state: SessionState, private store: FileStore, private chemistry: Chemistry, private transport: Transport,
    private notify: (message: string) => void, private maxTurns = DEFAULT_BUDGET.maxTurns, private maxCalls = DEFAULT_BUDGET.maxCalls) {
    validateBudget({ maxTurns, maxCalls }); this.properties = new PropertyResolver(chemistry);
  }
  get isRunning(): boolean { return this.running; }
  get budget(): BudgetLimits { return { maxTurns: this.maxTurns, maxCalls: this.maxCalls }; }
  setBudget(limits: BudgetLimits): void {
    const next = validateBudget(limits);
    this.maxTurns = next.maxTurns; this.maxCalls = next.maxCalls;
  }
  async save(): Promise<void> {
    await this.store.write(`${this.state.dir}/会话状态.json`, JSON.stringify(this.state, null, 2), true);
    await this.store.write(`${this.state.dir}/运行日志.json`, JSON.stringify({ harness: "organic-lab/0.2.0", events: this.state.events }, null, 2), true);
  }
  async event(kind: string, details: ProtocolItem = {}): Promise<void> {
    this.state.events.push({ time: new Date().toISOString(), kind, ...details });
    await this.save();
  }
  step(number: number): ExperimentStep {
    const value = this.state.plan?.steps.find(s => s.order === number);
    if (!value) throw new Error("step_not_found: 请先record_route并使用其步骤order");
    return value;
  }
  source(id: string): SourceAsset {
    const value = this.state.sources.find(s => s.id === id);
    if (!value) throw new Error("source_not_found: 不在本次上传来源中");
    return value;
  }
  private async writeArtifact(path: string, content: string): Promise<void> {
    if (!await this.store.exists(path)) { await this.store.write(path, content); return; }
    if (await this.store.read(path) !== content) throw new Error(`artifact_conflict: 已有文件内容不同，保留原文件 ${path}`);
  }
  private async writeBinaryArtifact(path: string, content: Uint8Array): Promise<void> {
    if (!await this.store.exists(path)) { await this.store.binary(path, content); return; }
    if (!Buffer.from(await this.store.readBinary(path)).equals(Buffer.from(content))) throw new Error(`artifact_conflict: 已有文件内容不同，保留原文件 ${path}`);
  }
  private async writeQualityArtifact(path: string, report: ProtocolItem): Promise<void> {
    if (!await this.store.exists(path)) { await this.store.write(path, JSON.stringify(report, null, 2)); return; }
    const content = await this.store.read(path); let existing: unknown;
    try { existing = JSON.parse(content); } catch { throw new Error(`artifact_conflict: 已有质量报告无法读取，保留原文件 ${path}`); }
    if (JSON.stringify(canonicalJson(stableQuality(existing))) !== JSON.stringify(canonicalJson(stableQuality(report)))) throw new Error(`artifact_conflict: 已有质量报告内容不同，保留原文件 ${path}`);
  }
  async execute(name: string, args: Record<string, unknown>): Promise<ProtocolItem> {
    if (name === "record_inventory") {
      const inventory = args.inventory as SourceInventory;
      validateInventory(inventory, this.state.sources);
      if (this.state.inventory && digest(this.state.inventory) !== digest(inventory)) throw new Error("inventory_conflict: 保留原始观察；来源事实修正需新路线，不能删约束掩盖失败");
      await this.writeArtifact(`${this.state.dir}/来源清单.json`, JSON.stringify(inventory, null, 2));
      this.state.inventory = inventory; this.state.compounds ??= {}; this.state.bindings ??= {};
      return { experiments: inventory.experiments.length, compounds: inventory.compounds.length, targets: inventory.targets, next: "register_compounds" };
    }
    if (name === "register_compounds") {
      const compounds = await verifyCompounds(this.state, this.chemistry, args.structures as { compoundId: string; smiles: string }[]);
      this.state.compounds = Object.fromEntries(compounds.map(c => [c.id, c]));
      return { compounds, next: "bind_steps" };
    }
    if (name === "bind_steps") {
      if (!this.state.inventory) throw new Error("inventory_missing");
      const bindings = args.bindings as StepBinding[];
      if (!bindings.length || bindings.length > 60 || new Set(bindings.map(b => b.step)).size !== bindings.length) throw new Error("binding_batch_invalid");
      const prepared: { step: ExperimentStep; binding: StepBinding }[] = [];
      for (const requested of bindings) {
        const current = this.step(requested.step), step = structuredClone(current), binding = structuredClone(requested);
        const experiment = this.state.inventory.experiments.find(e => e.id === binding.experimentId);
        if (!experiment || step.paperStep !== experiment.paperStep) throw new Error("paper_step_mismatch: 计划与来源实验编号必须一致");
        const get = (id: string) => { const value = this.state.compounds?.[id]; if (!value) throw new Error(`compound_unregistered: ${id}`); return value; };
        const reactants = experiment.reactants.map(id => get(id).smiles), products = experiment.products.map(id => get(id).smiles);
        if (this.state.written[step.order]) {
          await this.chemistry.call({ op: "check_binding", ...step, expectedReactants: reactants, expectedProducts: products, edits: step.edits ?? [] });
        } else {
          step.reactants = reactants; step.products = products;
          if ([...experiment.reactants, ...experiment.products].some(id => this.state.inventory!.compounds.find(c => c.id === id)?.stereo.scope === "relative") && !step.belowArrow.some(text => /relative|相对构型/i.test(text))) step.belowArrow.push("relative configuration; absolute configuration not assigned");
        }
        for (const [role, ids] of [["substrate", experiment.reactants], ["product", experiment.products]] as const) {
          let rows = step.reagents.filter(r => r.role === role);
          if (!rows.length && !this.state.written[step.order]) {
            rows = ids.map(id => {
              const observation = this.state.inventory!.compounds.find(c => c.id === id)!;
              const row = { id: `${role}-${id}`, name: observation.label, role, smiles: get(id).smiles, mw: get(id).mw, formula: get(id).formula,
                equivalents: null, referenceAmountMmol: null, referenceMassMg: null, referenceVolumeMl: null, concentrationM: null,
                densityGml: null, purityPercent: null, physicalState: null, citations: observation.citations, propertySources: [] };
              step.reagents.push(row); binding.reagents.push({ reagentId: row.id, compoundId: id }); return row;
            });
          }
          if (rows.length === 1 && ids.length === 1 && !binding.reagents.some(link => link.reagentId === rows[0].id)) binding.reagents.push({ reagentId: rows[0].id, compoundId: ids[0] });
          for (const row of rows) {
            const links = binding.reagents.filter(link => link.reagentId === row.id);
            if (links.length !== 1 || !ids.includes(links[0].compoundId)) throw new Error(`reagent_binding_missing: ${row.id}`);
            if (!this.state.written[step.order]) {
              const compound = get(links[0].compoundId);
              if (row.smiles && row.smiles !== compound.smiles) {
                row.physicalState = null; row.densityGml = null; row.concentrationM = null; row.purityPercent = null;
                row.propertySources = (row.propertySources ?? []).filter(p => !["physicalState", "densityGml", "concentrationM", "purityPercent"].includes(p.property));
                row.userProperties = (row.userProperties ?? []).filter(p => !["physicalState", "densityGml", "concentrationM", "purityPercent"].includes(p));
              }
              row.smiles = compound.smiles; row.mw = compound.mw; row.formula = compound.formula;
              row.propertySources = (row.propertySources ?? []).filter(p => p.property !== "mw" && p.property !== "formula");
              for (const property of ["mw", "formula"] as const) row.propertySources.push({ property, kind: "structure", reference: `来源化合物登记 ${compound.id}；RDKit平均摩尔质量和实际分子式`, citation: null, url: null, temperatureC: null });
            }
          }
        }
        if (new Set(binding.reagents.map(link => link.reagentId)).size !== binding.reagents.length || binding.reagents.some(link => !step.reagents.some(row => row.id === link.reagentId) || !this.state.compounds?.[link.compoundId])) throw new Error("reagent_binding_invalid");
        prepared.push({ step, binding });
      }
      for (const item of prepared) {
        Object.assign(this.step(item.step.order), item.step);
        (this.state.bindings ??= {})[item.step.order] = item.binding;
        if (!this.state.written[item.step.order]) delete this.state.rendered[item.step.order];
      }
      return { steps: prepared.map(item => item.step.order), next: "materialize_steps" };
    }
    if (name === "inspect_structures") return this.chemistry.call({ op: "inspect_structures", smiles: args.smiles });
    if (name === "search_sources") return { hits: searchSources(this.state.sources, String(args.query), Number(args.limit)) };
    if (name === "read_source_pages") return sourcePages(this.store, this.chemistry, this.state.sources, args.pages as { sourceId: string; page: number; bbox: number[] | null }[]);
    if (name === "read_source_page") {
      const source = this.source(String(args.sourceId));
      const page = await sourcePage(this.store, this.chemistry, source, Number(args.page), args.bbox as number[] | null);
      return { sourceId: source.id, page: args.page, text: page.text, image: page.png, mime: "image/png" };
    }
    if (name === "record_route") {
      if (Object.keys(this.state.written).length) throw new Error("records_exist: 实验记录已保存，修改请建立新路线或由用户编辑");
      const plan = args.plan as unknown as RoutePlan;
      validatePlan(plan);
      this.state.plan = plan; this.state.rendered = {}; this.state.bindings = {};
      return { stepCount: plan.steps.length, steps: plan.steps.map(s => ({ order: s.order, title: s.title, review: checkEvidence(s, this.state.sources) })) };
    }
    if (name === "inspect_structure") return this.chemistry.call({ op: "inspect", smiles: args.smiles });
    if (name === "locate_reaction") {
      const source = this.source(String(args.sourceId));
      if (source.mime !== "application/pdf") throw new Error("pdf_required: 截图可直接用read_source_page的bbox裁剪");
      const data = Buffer.from(await this.store.readBinary(source.path)).toString("base64");
      return this.chemistry.call({ op: "pdf_heading_bbox", data, page: args.page, heading: args.heading });
    }
    if (name === "set_step_structures") {
      const step = this.step(Number(args.step));
      if (this.state.written[step.order]) throw new Error("records_exist: 已写记录保留原件；结构变更请建立新路线");
      const reactants = args.reactants as string[], products = args.products as string[];
      requireStructures({ ...step, reactants, products });
      if (reactants.length + products.length > 12) throw new Error("structure_limit: 单步最多12个结构");
      const inspected = await Promise.all([...reactants, ...products].map(smiles => this.chemistry.call({ op: "inspect", smiles })));
      step.reactants = reactants; step.products = products;
      delete this.state.rendered[step.order];
      return { step: step.order, structures: inspected, next: "render_step" };
    }
    if (name === "validate_plan") {
      const steps = this.state.plan?.steps ?? [], issues = inventoryIssues(this.state, steps, this.state.sources);
      if (!steps.length) issues.push({ step: 0, code: "plan_missing", message: "先record_route" });
      if (this.state.inventory && Object.keys(this.state.compounds ?? {}).length) {
        try { await verifyCompounds(this.state, this.chemistry); }
        catch (error) { issues.push({ step: 0, code: "compound_validation_failed", message: String(error) }); }
      }
      for (const step of steps) if (this.state.bindings?.[step.order]) {
        try { await this.chemistry.call({ op: "check_binding", ...step, ...expectedStep(this.state, step) }); }
        catch (error) { issues.push({ step: step.order, code: "binding_validation_failed", message: String(error) }); }
      }
      return { ready: steps.length > 0 && !issues.length, issues, next: issues.length ? "repair_plan" : "materialize_steps", artifactAcceptance: false };
    }
    if (name === "validate_route") {
      const report = await auditDelivery(this.state, this.store, this.chemistry);
      if (!report.complete && this.state.status === "completed") this.state.status = "deliveryIncomplete";
      return { ...report };
    }
    if (name === "lookup_reagent") {
      const step = this.step(Number(args.step));
      if (this.state.written[step.order]) throw new Error("record_already_written: 已保存的物料性质请在笔记计量表中补全");
      const row = step.reagents.find(r => r.id === args.reagentId);
      if (!row) throw new Error("reagent_not_found");
      const result = await this.properties.prefill([row], this.state.sources);
      delete this.state.rendered[step.order];
      return { ...result, row };
    }
    if (name === "set_scale" || name === "edit_structure") {
      const step = this.step(Number(args.step));
      if (this.state.written[step.order]) throw new Error("record_already_written: 请在写入前完成修改，已有实际记录不覆盖");
      const row = step.reagents.find(r => r.id === args.reagentId);
      if (!row) throw new Error("reagent_not_found");
      if (name === "set_scale") {
        if (row.role !== "substrate" || !finitePositive(args.amountMmol)) throw new Error("scale_basis_invalid: 需要具体底物和正数mmol");
        step.scaleMmol = args.amountMmol; step.scaleBasisId = row.id;
        delete this.state.rendered[step.order];
        return { basis: row.id, amountMmol: step.scaleMmol, scope: "this step only" };
      }
      if (!row.smiles) throw new Error("missing_structure");
      const result = await this.chemistry.call<{ before: string; after: string; properties: { mw: number; formula: string }; site: number } & ProtocolItem>({ op: "edit", smiles: row.smiles, ...args });
      const canonical = new Map<string, string>();
      const matches = async (smiles: string) => {
        if (!canonical.has(smiles)) canonical.set(smiles, (await this.chemistry.call<{ smiles: string }>({ op: "inspect", smiles })).smiles);
        return canonical.get(smiles) === result.before;
      };
      const nextReactants = await Promise.all(step.reactants.map(async s => await matches(s) ? result.after : s));
      const nextProducts = await Promise.all(step.products.map(async s => await matches(s) ? result.after : s));
      if (!nextReactants.includes(result.after) && !nextProducts.includes(result.after)) throw new Error("target_not_in_scheme: 该试剂结构不属于本步反应物/产物，不能把修改假记到反应式");
      row.smiles = result.after; row.mw = result.properties.mw;
      row.formula = result.properties.formula; row.physicalState = null; row.densityGml = null;
      row.concentrationM = null; row.purityPercent = null;
      row.identityModified = true;
      row.userProperties = (row.userProperties ?? []).filter(p => !["formula", "mw", "physicalState", "densityGml", "concentrationM", "purityPercent"].includes(p));
      row.propertySources = (row.propertySources ?? []).filter(s => !["formula", "mw", "physicalState", "densityGml", "concentrationM", "purityPercent"].includes(s.property));
      for (const property of ["formula", "mw"] as const) row.propertySources.push({ property, kind: "structure", reference: "RDKit：本次edit_structure返回的当前结构；原物料密度／形态不沿用。", citation: null, url: null, temperatureC: null });
      step.reactants = nextReactants;
      step.products = nextProducts;
      step.edits = [...(step.edits ?? []), result];
      delete this.state.rendered[step.order];
      return result;
    }
    if (name === "render_step") {
      const step = this.step(Number(args.step));
      requireStructures(step);
      if (this.state.rendered[step.order]) {
        assertDelivery(await auditDelivery(this.state, this.store, this.chemistry, [step], false));
        return { artifacts: this.state.rendered[step.order], reused: true };
      }
      const propertyResult = await this.properties.prefill(step.reagents, this.state.sources, true);
      const key = digest({ renderer: "0.2.0", step }); const prefix = `${this.state.dir}/assets/S${pad(step.order)}-${key}`;
      const result = await this.chemistry.call<{ png: string; cdxml: string; properties: { smiles: string; mw: number }[]; quality: unknown }>({ op: "render_step", ...step, ...expectedStep(this.state, step) });
      const quality = checkEvidence(step, this.state.sources);
      await this.writeBinaryArtifact(`${prefix}.png`, Buffer.from(result.png, "base64"));
      await this.writeArtifact(`${prefix}.cdxml`, result.cdxml);
      const artifacts: StepArtifacts = { image: `${prefix}.png`, cdxml: `${prefix}.cdxml`, svg: null, quality: `${prefix}-quality.json` };
      await this.writeQualityArtifact(artifacts.quality, { chemistry: result.quality, issues: quality, properties: { reviews: propertyResult.reviews }, step: step.order });
      this.state.rendered[step.order] = artifacts;
      return { artifacts, issues: quality, scaleMmol: step.scaleMmol, propertyUpdates: propertyResult.filled, rows: step.reagents.map(r => ({ id: r.id, mw: r.mw })) };
    }
    if (name === "write_step") {
      const step = this.step(Number(args.step));
      assertDelivery(await auditDelivery(this.state, this.store, this.chemistry, [step], false));
      if (this.state.written[step.order]) {
        assertDelivery(await auditDelivery(this.state, this.store, this.chemistry, [step]));
        return { path: this.state.written[step.order], reused: true };
      }
      const artifacts = this.state.rendered[step.order];
      if (!artifacts) throw new Error("render_first: 请先render_step");
      const errors = checkEvidence(step, this.state.sources).filter(i => i.severity === "error");
      if (errors.length) throw new Error(`evidence_invalid: ${JSON.stringify(errors)}`);
      const plan = this.state.plan!; const index = plan.steps.indexOf(step);
      const previous = index ? stepFile(this.state.dir, this.state.id, plan.steps[index - 1]) : null;
      const next = index < plan.steps.length - 1 ? stepFile(this.state.dir, this.state.id, plan.steps[index + 1]) : null;
      const path = stepFile(this.state.dir, this.state.id, step);
      const content = buildStepNote(this.state.id, step, artifacts, this.state.sources, previous, next);
      if (await this.store.exists(path)) {
        if (await this.store.read(path) !== content) throw new Error("existing_record_conflict: 已有记录内容不同，不能覆盖");
      } else await this.store.write(path, content);
      this.state.written[step.order] = path;
      return { path, status: "draft", image: artifacts.image, cdxml: artifacts.cdxml };
    }
    if (name === "finish_route") {
      const plan = this.state.plan;
      if (!plan || plan.steps.some(s => !this.state.written[s.order])) throw new Error("missing_step_records: 需要完成所有步骤记录");
      if (requiresStructureEdit(plan.requestedChanges) && !plan.steps.some(s => s.edits?.length)) throw new Error("requested_edit_not_executed: 有结构修改意图但没有本地编辑回执");
      const delivery = await auditDelivery(this.state, this.store, this.chemistry);
      if (!delivery.complete && this.state.status === "completed") this.state.status = "deliveryIncomplete";
      assertDelivery(delivery);
      if (!await this.store.exists(`${this.state.dir}/路线.base`)) await this.store.write(`${this.state.dir}/路线.base`, buildBase(this.state.id, this.state.gallery));
      if (!await this.store.exists(`${this.state.dir}/路线.md`)) await this.store.write(`${this.state.dir}/路线.md`, routeNote(this.state.id, this.state.dir, plan));
      this.state.status = "completed";
      return { route: `${this.state.dir}/路线.md`, gallery: `${this.state.dir}/路线.base`, stepFiles: this.state.written, status: "drafts_created", delivery };
    }
    if (name === "materialize_steps") {
      const orders = args.steps as number[];
      if (!orders.length || orders.length > 8 || new Set(orders).size !== orders.length) throw new Error("materialize_batch_invalid: 选择1至8个不同步骤");
      for (const order of orders) {
        this.step(order);
        if (!this.state.bindings?.[order]) throw new Error(`step_unbound: ${order}，先登记并绑定结构`);
      }
      const results: ProtocolItem[] = new Array(orders.length);
      let index = 0;
      const worker = async () => {
        while (index < orders.length) {
          const slot = index++, step = orders[slot];
          try {
            await this.execute("render_step", { step });
            results[slot] = { step, status: "saved", ...await this.execute("write_step", { step }) };
            results[slot].status = "saved";
          } catch (error) { results[slot] = { step, status: "error", message: error instanceof Error ? error.message : String(error) }; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, orders.length) }, worker));
      return { status: results.every(result => result.status === "saved") ? "saved" : "partial", results, concurrency: Math.min(2, orders.length) };
    }
    throw new Error(`unknown_tool: ${name}`);
  }
  async validateCachedDelivery(name: string, args: Record<string, unknown>): Promise<void> {
    if (!["render_step", "write_step", "finish_route", "materialize_steps"].includes(name)) return;
    const steps = name === "finish_route" ? this.state.plan?.steps : name === "materialize_steps" ? (args.steps as number[]).map(order => this.step(order)) : [this.step(Number(args.step))];
    const report = await auditDelivery(this.state, this.store, this.chemistry, steps, name !== "render_step");
    if (!report.complete && this.state.status === "completed") this.state.status = "deliveryIncomplete";
    assertDelivery(report);
    if (name === "finish_route") for (const file of ["路线.md", "路线.base"]) {
      if (!await this.store.exists(`${this.state.dir}/${file}`)) {
        if (this.state.status === "completed") this.state.status = "deliveryIncomplete";
        throw new Error(`route_assets_missing: ${file}，重新finish_route修复`);
      }
    }
    if (name === "finish_route" && this.state.plan && requiresStructureEdit(this.state.plan.requestedChanges) && !this.state.plan.steps.some(s => s.edits?.length)) {
      throw new Error("requested_edit_not_executed: 没有本地结构编辑回执");
    }
  }
  private pendingCalls(): ProtocolItem[] {
    const answered = new Set(this.state.context.filter(item => item.type === "function_call_output").map(item => item.call_id));
    const calls = this.state.context.filter(item => item.type === "function_call");
    const seen = new Set<string>();
    for (const call of calls) {
      if (typeof call.call_id !== "string" || !call.call_id || typeof call.name !== "string" || typeof call.arguments !== "string") throw new Error("tool_envelope_invalid: 会话中的工具调用缺少有效call_id/name/arguments");
      if (seen.has(call.call_id)) throw new Error("duplicate_call_id: 会话中有重复工具调用ID，需要核对会话");
      seen.add(call.call_id);
    }
    return calls.filter(item => !answered.has(item.call_id));
  }
  private toolOutput(callId: string, result: ProtocolItem): ProtocolItem {
    if (typeof result.image === "string" && result.mime === "image/png") return { type: "function_call_output", call_id: callId, output: [
      { type: "input_text", text: JSON.stringify(withoutImages(result)) },
      { type: "input_image", image_url: `data:${result.mime || "image/png"};base64,${result.image}` }
    ] };
    const pages = Array.isArray(result.pages) ? result.pages.filter((p): p is ProtocolItem => !!p && typeof p === "object" && typeof p.image === "string") : [];
    const images = pages;
    const output = images.length ? [
      { type: "input_text", text: JSON.stringify(withoutImages(result)) },
      ...images.flatMap(page => [{ type: "input_text", text: JSON.stringify({ sourceId: page.sourceId, page: page.page }) },
        { type: "input_image", image_url: `data:${page.mime || "image/png"};base64,${page.image}` }])
    ] : JSON.stringify(result);
    return { type: "function_call_output", call_id: callId, output };
  }
  private async legacyOutput(call: ProtocolItem): Promise<ProtocolItem | null> {
    const event = [...this.state.events].reverse().find(item => item.callId === call.call_id && item.tool === call.name && ["tool_completed", "tool_failed"].includes(String(item.kind)));
    if (!event) return null;
    if (event.kind === "tool_failed") return this.toolOutput(String(call.call_id), { status: "error", message: event.message });
    if (["read_source_page", "read_source_pages"].includes(String(call.name))) {
      const args: unknown = JSON.parse(String(call.arguments)); validateToolCall(String(call.name), args);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("tool_arguments_invalid: 参数需要对象");
      return this.toolOutput(String(call.call_id), await this.execute(String(call.name), Object.fromEntries(Object.entries(args))));
    }
    if (!event.result || typeof event.result !== "object" || Array.isArray(event.result)) throw new Error("tool_recovery_failed: 旧回执缺少结果，需要核对运行日志");
    return this.toolOutput(String(call.call_id), Object.fromEntries(Object.entries(event.result)));
  }
  private completeCall(call: ProtocolItem, output: ProtocolItem): void {
    const callId = String(call.call_id);
    this.state.executions ??= {};
    this.state.executions[callId] = { name: String(call.name), arguments: String(call.arguments), phase: "completed", output };
    this.state.context.push(output);
  }
  private async processCall(call: ProtocolItem, batchSize: number): Promise<boolean> {
    const name = String(call.name), callId = String(call.call_id), argumentsText = String(call.arguments);
    let execution = this.state.executions?.[callId];
    if (execution && (execution.name !== name || execution.arguments !== argumentsText)) throw new Error("tool_call_conflict: 同一工具调用ID对应不同参数，停止恢复");
    if (execution?.phase === "completed" && !execution.output) throw new Error("tool_recovery_failed: 已完成的工具调用缺少保存的输出，需要核对会话");
    const recovered = execution?.output ?? await this.legacyOutput(call);
    if (recovered) {
      let output = recovered;
      if (["render_step", "write_step", "finish_route", "materialize_steps"].includes(name)) {
        try { await this.validateCachedDelivery(name, JSON.parse(argumentsText)); }
        catch (error) { output = this.toolOutput(callId, { status: "error", message: error instanceof Error ? error.message : String(error) }); }
      }
      this.completeCall(call, output);
      await this.event("tool_recovered", { tool: name, callId });
      return false;
    }
    if (this.stopped || this.state.status === "completed" || (!execution && this.state.calls >= this.maxCalls)) {
      const reason = this.stopped ? "user_stop_or_repeated_failure" : this.state.status === "completed" ? "route_completed" : "tool_budget_exhausted";
      this.completeCall(call, this.toolOutput(callId, { status: "not_executed", reason }));
      await this.save();
      return false;
    }
    if (!execution) {
      this.state.calls++;
      execution = { name, arguments: argumentsText, phase: "started" };
      this.state.executions ??= {}; this.state.executions[callId] = execution;
      await this.event("tool_started", { tool: name, callId });
    }
    if (this.stopped) {
      this.completeCall(call, this.toolOutput(callId, { status: "not_executed", reason: "user_stop_or_repeated_failure" }));
      await this.save(); return false;
    }
    this.notify(`执行 ${name}`);
    let result: ProtocolItem, failed = false, waiting = false;
    try {
      const args: unknown = JSON.parse(argumentsText); validateToolCall(name, args);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("tool_arguments_invalid: 参数需要对象");
      const parameters = Object.fromEntries(Object.entries(args));
      if (name === "ask_user") {
        if (batchSize !== 1) throw new Error("question_must_be_alone: ask_user需要单独调用");
        this.state.question = { callId, text: String(parameters.question) }; this.state.status = "needsInput";
        this.state.executions ??= {}; this.state.executions[callId] = { name, arguments: argumentsText, phase: "waiting" };
        waiting = true; result = { status: "needsInput" };
      } else result = await this.execute(name, parameters);
    } catch (error: unknown) {
      failed = true;
      result = { status: "error", message: error instanceof Error ? error.message : String(error) };
      const signature = digest({ name, arguments: argumentsText, message: result.message });
      this.state.failures ??= {}; this.state.failures[signature] = (this.state.failures[signature] ?? 0) + 1;
      if (this.state.failures[signature] >= 2) { this.stopped = true; this.state.status = "needsReview"; result.stopReason = "repeated_identical_failure"; }
    }
    if (waiting) { await this.event("question", { callId, question: this.state.question?.text }); return true; }
    this.completeCall(call, this.toolOutput(callId, result));
    const details = failed ? { tool: name, callId, ...result } : { tool: name, callId, result: withoutImages(result) };
    await this.event(failed ? "tool_failed" : "tool_completed", details);
    return false;
  }
  async run(answer?: string): Promise<void> {
    if (this.running) throw new Error("session_busy: 当前会话仍在执行，请等待或停止后继续");
    if (this.state.question && !answer?.trim()) throw new Error("请回答当前问题");
    this.running = true;
    this.stopped = false;
    try {
      if (this.state.status === "completed") {
        const delivery = await auditDelivery(this.state, this.store, this.chemistry);
        if (!delivery.complete) {
          this.state.status = "deliveryIncomplete";
          await this.event("delivery_reopened", { delivery });
        }
      }
      if (this.state.question) {
        if (!answer?.trim()) throw new Error("请回答当前问题");
        const question = this.state.question;
        const call = this.state.context.find(item => item.type === "function_call" && item.call_id === question.callId);
        if (!call) throw new Error("question_call_missing: 当前问题没有对应的工具调用，需要核对会话");
        this.completeCall(call, this.toolOutput(question.callId, { answer }));
        this.state.question = null;
        await this.event("user_answer", { answer });
      }
      if (this.state.status !== "completed") this.state.status = "running";
      while (true) {
        const pending = this.pendingCalls();
        if (pending.length) {
          for (const call of pending) if (await this.processCall(call, pending.length)) return;
          continue;
        }
        if (this.state.status === "completed") return;
        if (this.stopped || this.state.turns >= this.maxTurns || this.state.calls >= this.maxCalls) break;
        this.state.turns++;
        await this.event("model_request", { turn: this.state.turns });
        this.notify(`AI 请求 ${this.state.turns}/${this.maxTurns}`);
        const turn = await this.transport.turn(this.state.context);
        this.state.context.push(...turn.output);
        await this.event("model_response", { turn: this.state.turns, usage: turn.usage ?? null });
        if (!turn.output.some(item => item.type === "function_call")) {
          this.state.emptyTurns = (this.state.emptyTurns ?? 0) + 1;
          if (this.state.emptyTurns >= 2) { this.state.status = "needsReview"; await this.event("no_native_calls", { message: "连续两轮没有工具调用，停止自动请求" }); return; }
          this.state.context.push({ role: "user", content: "请依据真实工具结果继续，使用finish_route完成或ask_user提出需要回答的问题。" });
        } else this.state.emptyTurns = 0;
      }
      if (this.state.status !== "needsReview") this.state.status = this.stopped ? "stopped" : "budgetExhausted";
      await this.event("stopped", { reason: this.state.status });
    } catch (error: unknown) {
      if (this.state.status !== "completed") this.state.status = "failed";
      await this.event("run_failed", { message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { this.running = false; }
  }
}
