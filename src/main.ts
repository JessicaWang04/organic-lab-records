import { App, FileSystemAdapter, ItemView, Modal, Notice, Plugin, PluginSettingTab, requestUrl, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PythonChemistry } from "./chemistry";
import { AgentRunner, SessionState } from "./runner";
import { ResponsesTransport, Http, modelCatalog } from "./provider";
import { ObsidianStore } from "./obsidian-store";
import { finitePositive, PhysicalState, safePath, slug, SourceAsset, StoichInput } from "./domain";
import { indexSource } from "./sources";
import { calculateStoichiometry, formatNumber } from "./stoichiometry";
import { buildStepNote, DEFAULT_GALLERY, GalleryOptions, galleryViews, parseFrontmatter, parseStoichInput, replaceStoichBlock, stepFile, updateBaseGallery } from "./records";
import { markUserProperty, PropertyResolver, stateLabels } from "./reagent-properties";
import { appendBudget, BudgetLimits, budgetText, canContinue, DEFAULT_BUDGET, parseBudget, SessionGate, validateBudget } from "./budget";
import SKILL from "../skills/experiment-records/SKILL.md";

interface Settings { baseUrl: string; model: string; models: string[]; pythonPath: string; folder: string; maxTurns: number; maxCalls: number; lastSession: string; gallery: GalleryOptions }
const defaults: Settings = { baseUrl: "https://api.openai.com/v1", model: "", models: [], pythonPath: "python", folder: "Organic Lab", ...DEFAULT_BUDGET, lastSession: "", gallery: DEFAULT_GALLERY };
const VIEW = "organic-lab-agent";
const STATUS_LABELS: Record<string, string> = { completed: "草稿已生成", needsInput: "等待回答", needsReview: "需要核对", stopped: "已停止", failed: "运行失败", budgetExhausted: "已达到预算", running: "执行中" };
const secretId = (base: string) => `organic-lab-${createHash("sha256").update(base.trim().replace(/\/+$/, "")).digest("hex").slice(0, 16)}`;
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);
const hasPendingTools = (state: SessionState): boolean => {
  const answered = new Set(state.context.filter(item => item.type === "function_call_output").map(item => item.call_id));
  return state.context.some(item => item.type === "function_call" && !answered.has(item.call_id));
};
const http: Http = async (method, url, headers, body) => {
  const response = await requestUrl({ url, method, headers, body, throw: false });
  return { status: response.status, text: response.text };
};
export default class OrganicLabPlugin extends Plugin {
  settings: Settings = { ...defaults };
  runner: AgentRunner | null = null;
  private sessionGate = new SessionGate();
  private savingBudget = false;
  get sessionBusy(): boolean { return this.sessionGate.busy || this.runner?.isRunning === true; }
  acquireSessionOperation(): (() => void) | null {
    if (this.runner?.isRunning) return null;
    const release = this.sessionGate.acquire();
    if (!release) return null;
    this.refreshBudgetDisplays();
    return () => { release(); this.refreshBudgetDisplays(); };
  }
  refreshBudgetDisplays(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) if (leaf.view instanceof Workbench) leaf.view.refreshBudget();
  }
  refreshStates(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) if (leaf.view instanceof Workbench) leaf.view.showState();
  }
  async saveBudget(limits: BudgetLimits): Promise<void> {
    const next = validateBudget(limits);
    if (this.savingBudget) throw new Error("预算正在保存，请等待后再修改");
    const previous = { maxTurns: this.settings.maxTurns, maxCalls: this.settings.maxCalls };
    this.savingBudget = true;
    try {
      Object.assign(this.settings, next);
      await this.persist();
      this.runner?.setBudget(next);
      this.refreshBudgetDisplays();
    } catch (error) { Object.assign(this.settings, previous); this.refreshBudgetDisplays(); throw error; }
    finally { this.savingBudget = false; }
  }
  async onload(): Promise<void> {
    this.settings = { ...defaults, ...await this.loadData() };
    try { Object.assign(this.settings, validateBudget(this.settings)); }
    catch { Object.assign(this.settings, DEFAULT_BUDGET); }
    this.settings.gallery = { ...DEFAULT_GALLERY, ...this.settings.gallery };
    this.registerView(VIEW, leaf => new Workbench(leaf, this));
    this.addRibbonIcon("flask-conical", "Organic Lab：路线工作台", () => void this.open());
    this.addCommand({ id: "open-workbench", name: "打开路线工作台", callback: () => void this.open() });
    this.addCommand({ id: "record-result", name: "记录本次实验结果", callback: () => this.resultModal() });
    this.addCommand({ id: "repeat-experiment", name: "为当前步骤新建重复实验", callback: () => void this.repeat() });
    this.addCommand({ id: "configure-route-gallery", name: "调整当前路线图库", callback: () => void this.configureGallery() });
    this.addSettingTab(new LabSettings(this.app, this));
    this.registerMarkdownCodeBlockProcessor("organic-stoich", (source, el, context) => {
      try { this.stoichEditor(JSON.parse(source), el, context.sourcePath); }
      catch (error) { el.createEl("p", { text: `计量输入无效：${String(error)}` }); }
    });
    this.registerMarkdownPostProcessor((el, context) => {
      const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
      if (!(file instanceof TFile)) return;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (fm?.type !== "reaction-experiment" || typeof fm.image !== "string") return;
      const path = fm.image.replace(/^\[\[|\]\]$/g, "").split("|")[0];
      for (const embed of Array.from(el.querySelectorAll<HTMLElement>(".image-embed"))) if (embed.getAttribute("src") === path) embed.addClass("olab-reaction-image");
    });
  }
  onunload(): void { if (this.runner) this.runner.stopped = true; }
  async persist(): Promise<void> { await this.saveData(this.settings); this.refreshBudgetDisplays(); }
  chemistry(): PythonChemistry {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("本地化学工具需要桌面文件库");
    return new PythonChemistry(this.settings.pythonPath, join(adapter.getBasePath(), this.app.vault.configDir, "plugins", this.manifest.id, "chemistry_worker.py"));
  }
  async open(): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(VIEW)[0] ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
  transport(): ResponsesTransport {
    const key = this.app.secretStorage?.getSecret(secretId(this.settings.baseUrl));
    if (!key || !this.settings.model) throw new Error("请在 Organic Lab 设置中保存API key，验证连接并选择模型");
    return new ResponsesTransport({ baseUrl: this.settings.baseUrl, model: this.settings.model, apiKey: key, instructions: SKILL, maxOutputTokens: 24000 }, http);
  }
  stoichEditor(input: StoichInput, el: HTMLElement, sourcePath: string): void {
    const box = el.createDiv({ cls: "olab-stoich" });
    const controls = box.createDiv({ cls: "olab-scale-controls" });
    const label = controls.createEl("label", { text: "本步投料规模" });
    const scale = label.createEl("input", { type: "number", attr: { step: "any", min: "0", placeholder: "mmol", "aria-label": "本步基准底物规模 mmol" } });
    scale.value = input.scaleMmol?.toString() ?? "";
    const basis = controls.createEl("select", { attr: { "aria-label": "本步基准底物" } });
    basis.createEl("option", { value: "", text: "选择本步基准底物" });
    const substrates = input.rows.filter(r => r.role === "substrate");
    for (const row of substrates) basis.createEl("option", { value: row.id, text: row.name });
    if (!input.basisId && substrates.length === 1) input.basisId = substrates[0].id;
    basis.value = input.basisId ?? "";
    basis.onchange = () => { input.basisId = basis.value || null; redraw(); };
    const area = box.createDiv({ cls: "olab-table-scroll" });
    const preview = box.createDiv({ cls: "olab-table-scroll olab-result-preview" });
    const details = box.createEl("details", { cls: "olab-property-details" });
    details.createEl("summary", { text: "文献投料与物料性质来源" });
    const sourcesEl = details.createDiv();
    const numeric = (value: string) => value.trim() ? Number(value) : null;
    const redraw = () => {
      area.empty(); preview.empty(); sourcesEl.empty();
      const table = area.createEl("table");
      const header = table.createEl("thead").createEl("tr");
      ["组分", "常温形态", "MW", "eq", "纯度 %", "浓度 M", "密度 g/mL"].forEach(text => header.createEl("th", { text }));
      const body = table.createEl("tbody");
      const calculated = calculateStoichiometry(input);
      const resultTable = preview.createEl("table");
      const resultHeader = resultTable.createEl("thead").createEl("tr");
      ["即时计算", "mmol", "纯品 mg", "称量 mg", "理论体积 mL", "实配体积 mL"].forEach(text => resultHeader.createEl("th", { text }));
      const resultBody = resultTable.createEl("tbody");
      input.rows.forEach((row, index) => {
        const tr = body.createEl("tr");
        const name = tr.createEl("td", { text: row.name, cls: "olab-component" });
        name.createEl("small", { text: row.formula ?? "分子式待补" });
        const state = tr.createEl("td").createEl("select", { attr: { "aria-label": `${row.name} 常温形态` } });
        state.createEl("option", { value: "", text: "待补" });
        for (const [value, text] of Object.entries(stateLabels)) state.createEl("option", { value, text });
        state.value = row.physicalState ?? "";
        state.onchange = () => { row.physicalState = state.value as PhysicalState || null; markUserProperty(row, "physicalState"); redraw(); };
        for (const property of ["mw", "equivalents", "purityPercent", "concentrationM", "densityGml"] as const) {
          const cell = tr.createEl("td"); const control = cell.createEl("input", { type: "number", attr: { step: "any", min: "0", placeholder: "待补", "aria-label": `${row.name} ${property}` } });
          control.value = row[property]?.toString() ?? "";
          if (property === "purityPercent") control.max = "100";
          if (property === "densityGml" && row.physicalState === "solid") { control.disabled = true; control.placeholder = "—"; }
          if (property === "densityGml" && row.densityGml !== null) {
            const origin = row.propertySources?.find(s => s.property === property);
            cell.createEl("small", { text: origin?.temperatureC != null ? `${origin.temperatureC} °C` : "温度待核对" });
          }
          control.onchange = () => {
            const value = numeric(control.value);
            if (value !== null && (!finitePositive(value) || (property === "purityPercent" && value > 100))) { new Notice("请输入有效的正数；未知值留空"); return; }
            row[property] = value; markUserProperty(row, property); redraw();
          };
        }
        const result = resultBody.createEl("tr"); result.createEl("td", { text: row.name });
        for (const property of ["amountMmol", "pureMassMg", "weighingMassMg", "pureVolumeMl", "volumeMl"] as const) result.createEl("td", { text: formatNumber(calculated[index][property]) });
        const info = sourcesEl.createDiv({ cls: "olab-property-source" });
        info.createEl("strong", { text: row.name });
        const original = [[row.referenceAmountMmol, "mmol"], [row.referenceMassMg, "mg"], [row.referenceVolumeMl, "mL"]].filter(([value]) => value !== null).map(([value, unit]) => `${formatNumber(value as number)} ${unit}`).join("；");
        info.createEl("p", { text: `文献投料：${original || "待核对"}` });
        for (const origin of row.propertySources ?? []) {
          const line = info.createEl("p", { text: `${origin.property}：${origin.reference}` });
          if (origin.citation) line.createEl("span", { text: ` [${origin.citation.sourceId}:p${origin.citation.page}]` });
          if (origin.url && /^https:\/\//.test(origin.url)) line.createEl("a", { text: " 打开性质来源", href: origin.url, attr: { target: "_blank", rel: "noopener" } });
        }
      });
    };
    scale.onchange = () => { const value = numeric(scale.value); if (value !== null && !finitePositive(value)) { new Notice("规模必须为正数"); return; } input.scaleMmol = value; redraw(); };
    box.createEl("p", { text: "理论体积按100%纯品计算。实配体积需有效浓度，或批次纯度及密度；下方 Stoichiometry 为上次保存结果。", cls: "olab-calculation-hint" });
    const actions = box.createDiv({ cls: "olab-actions" });
    const fill = actions.createEl("button", { text: "补全物料性质" });
    fill.onclick = async () => {
      fill.disabled = true;
      try {
        const file = this.app.vault.getAbstractFileByPath(sourcePath);
        const store = new ObsidianStore(this.app);
        const statePath = file instanceof TFile && file.parent ? `${file.parent.path}/会话状态.json` : "";
        const sources: SourceAsset[] = statePath && await store.exists(statePath) ? (JSON.parse(await store.read(statePath)) as SessionState).sources : [];
        const result = await new PropertyResolver(this.chemistry()).prefill(input.rows, sources);
        redraw(); new Notice(result.filled ? `补全了${result.filled}项物料性质，来源已附上` : "暂无可核对的新增性质");
      } catch (error) { new Notice(String(error)); }
      finally { fill.disabled = false; }
    };
    const save = actions.createEl("button", { text: "保存输入并更新结果", cls: "mod-cta" });
    save.onclick = async () => {
      try {
        if (input.scaleMmol !== null && !substrates.some(r => r.id === input.basisId)) throw new Error("请明确本步规模的基准底物");
        const file = this.app.vault.getAbstractFileByPath(sourcePath);
        if (!(file instanceof TFile)) throw new Error("找不到当前实验文件");
        const note = await this.app.vault.read(file);
        await this.app.vault.modify(file, replaceStoichBlock(note, input));
        await this.app.fileManager.processFrontMatter(file, fm => { fm.scale_mmol = input.scaleMmol; fm.scale_basis = input.basisId ?? null; });
        new Notice("计量表已更新，实际操作和观察记录保留");
      } catch (error) { new Notice(String(error)); }
    };
    redraw();
  }
  resultModal(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice("先打开一份实验记录"); return; }
    const modal = new Modal(this.app); modal.titleEl.setText("记录本次实验结果");
    let status = "completed", worked: boolean | null = null, yieldValue = "";
    new Setting(modal.contentEl).setName("状态").addDropdown(d => d.addOptions({ planned: "计划中", running: "进行中", completed: "完成", failed: "失败" }).setValue(status).onChange(v => status = v));
    new Setting(modal.contentEl).setName("是否跑通").addDropdown(d => d.addOptions({ unknown: "尚未判断", yes: "是", no: "否" }).onChange(v => worked = v === "yes" ? true : v === "no" ? false : null));
    new Setting(modal.contentEl).setName("本次实测产率 %").addText(t => t.onChange(v => yieldValue = v));
    new Setting(modal.contentEl).addButton(b => b.setButtonText("保存结果").setCta().onClick(async () => {
      const value = yieldValue.trim() ? Number(yieldValue) : null;
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) { new Notice("产率应为0–100或留空"); return; }
      await this.app.fileManager.processFrontMatter(file, fm => {
        if (fm.type !== "reaction-experiment") throw new Error("当前文件不是实验记录");
        fm.status = status; fm.worked = worked; fm.measured_yield_percent = value; fm.attempts_count = 1;
      });
      modal.close(); new Notice("本次实验结果已保存");
    })); modal.open();
  }
  async repeat(): Promise<void> {
    try {
      const file = this.app.workspace.getActiveFile(); if (!file) throw new Error("先打开实验记录");
      const currentNote = await this.app.vault.read(file);
      const fm = parseFrontmatter(currentNote);
      if (fm.type !== "reaction-experiment") throw new Error("当前文件不是实验记录");
      const dir = file.parent!.path; const store = new ObsidianStore(this.app);
      const state: SessionState = JSON.parse(await store.read(`${dir}/会话状态.json`));
      const sourceStep = state.plan?.steps.find(s => s.order === fm.step_number); if (!sourceStep) throw new Error("找不到该步骤的生成来源");
      const step = structuredClone(sourceStep);
      const input = parseStoichInput(currentNote);
      step.reagents = input.rows; step.scaleMmol = input.scaleMmol; step.scaleBasisId = input.basisId ?? null;
      let attempt = 2; let path = stepFile(dir, state.id, step, attempt);
      while (await store.exists(path)) path = stepFile(dir, state.id, step, ++attempt);
      let content = buildStepNote(state.id, step, state.rendered[step.order], state.sources, null, null);
      content = content.replace(/^attempt: 1$/m, `attempt: ${attempt}`);
      await store.write(path, content); await this.app.workspace.openLinkText(path, "", true);
    } catch (error) { new Notice(String(error)); }
  }
  async configureGallery(): Promise<void> {
    try {
      const active = this.app.workspace.getActiveFile();
      if (!active) throw new Error("先打开路线图库或该路线的笔记");
      const fm = active.extension === "md" ? parseFrontmatter(await this.app.vault.read(active)) : {};
      const file = active.extension === "base" ? active : ["reaction-route", "reaction-experiment"].includes(String(fm.type)) && active.parent ? this.app.vault.getAbstractFileByPath(`${active.parent.path}/路线.base`) : null;
      if (!(file instanceof TFile)) throw new Error("找不到当前路线的Bases图库");
      const views = galleryViews(await this.app.vault.read(file));
      if (!views.length) throw new Error("当前Bases没有卡片图库视图");
      const modal = new Modal(this.app); modal.titleEl.setText("调整路线图库");
      let selected = views[0].name;
      let options: GalleryOptions = { ...views[0], imageAspectRatio: views[0].imageAspectRatio >= .2 && views[0].imageAspectRatio <= 1 ? views[0].imageAspectRatio : .4 };
      const draw = () => {
        modal.contentEl.empty();
        new Setting(modal.contentEl).setName("图库视图").addDropdown(d => { for (const view of views) d.addOption(view.name, view.name); d.setValue(selected).onChange(name => { selected = name; const view = views.find(v => v.name === name)!; options = { imageAspectRatio: Math.max(.2, Math.min(1, view.imageAspectRatio)), imageFit: view.imageFit, cardSize: view.cardSize }; draw(); }); });
        new Setting(modal.contentEl).setName("图片比例").setDesc("0.2–1，可按反应式的实际形状调整。").addSlider(s => s.setLimits(.2, 1, .01).setValue(options.imageAspectRatio).setDynamicTooltip().onChange(v => options.imageAspectRatio = Number(v.toFixed(2))));
        new Setting(modal.contentEl).setName("图像适配").addDropdown(d => d.addOptions({ contain: "完整显示（Contain）", cover: "填满并裁剪（Cover）" }).setValue(options.imageFit).onChange(v => options.imageFit = v as GalleryOptions["imageFit"]));
        new Setting(modal.contentEl).setName("卡片宽度").addSlider(s => s.setLimits(150, 800, 25).setValue(options.cardSize).setDynamicTooltip().onChange(v => options.cardSize = v));
        new Setting(modal.contentEl).addButton(b => b.setButtonText("应用到此图库").setCta().onClick(async () => {
          try { const current = await this.app.vault.read(file); await this.app.vault.modify(file, updateBaseGallery(current, selected, { imageAspectRatio: options.imageAspectRatio, imageFit: options.imageFit, cardSize: options.cardSize })); modal.close(); new Notice("图库配置已更新"); }
          catch (error) { new Notice(String(error)); }
        }));
      };
      draw(); modal.open();
    } catch (error) { new Notice(String(error)); }
  }
}

class Workbench extends ItemView {
  files: File[] = []; prompt = ""; busy = false; log!: HTMLElement; output!: HTMLElement; promptEl!: HTMLTextAreaElement;
  budgetEl?: HTMLElement; runButton?: HTMLButtonElement; restoreButton?: HTMLButtonElement;
  continueButton?: HTMLButtonElement; appendButton?: HTMLButtonElement;
  stateEl?: HTMLElement;
  constructor(leaf: WorkspaceLeaf, private plugin: OrganicLabPlugin) { super(leaf); }
  getViewType(): string { return VIEW; }
  getDisplayText(): string { return "Organic Lab · 路线工作台"; }
  getIcon(): string { return "flask-conical"; }
  async onOpen(): Promise<void> {
    this.contentEl.empty(); this.contentEl.addClass("olab-workbench");
    this.contentEl.createEl("h2", { text: "Organic Lab" });
    this.contentEl.createEl("p", { text: "截图确定路线，正文与 SI 提供用量。每一步保存为可编辑的实验记录。", cls: "olab-muted" });
    const input = this.contentEl.createDiv({ cls: "olab-input" });
    const file = input.createEl("input", { type: "file", attr: { multiple: "", accept: "image/png,image/jpeg,application/pdf" } });
    const attachments = input.createDiv({ cls: "olab-attachments" });
    const show = () => attachments.setText(this.files.map(f => `${f.name} · ${(f.size / 1024 / 1024).toFixed(1)}MB`).join("\n"));
    file.onchange = () => { this.files.push(...Array.from(file.files ?? [])); show(); };
    input.createEl("button", { text: "清空附件" }).onclick = () => { this.files = []; file.value = ""; show(); };
    this.promptEl = input.createEl("textarea", { attr: { rows: "6", placeholder: "例如：根据这张图和SI开路线记录。说明要修改的底物/位点和投料规模；未给规模时保留文献数据。" } });
    this.registerDomEvent(this.contentEl, "paste", event => {
      const images = Array.from(event.clipboardData?.files ?? []).filter(f => f.type.startsWith("image/"));
      if (images.length) { event.preventDefault(); this.files.push(...images.map((f, i) => new File([f], `截图-${Date.now()}-${i}.${f.type === "image/jpeg" ? "jpg" : "png"}`, { type: f.type }))); show(); }
    });
    const actions = input.createDiv({ cls: "olab-actions" });
    this.runButton = actions.createEl("button", { text: "运行真实 AI", cls: "mod-cta" }); this.runButton.onclick = () => void this.start();
    actions.createEl("button", { text: "停止" }).onclick = () => { if (this.plugin.runner) { this.plugin.runner.stopped = true; this.message("停止已请求，将保留收到的工具结果。"); } };
    this.restoreButton = actions.createEl("button", { text: "恢复上次会话" }); this.restoreButton.onclick = () => void this.restore();
    this.budgetEl = input.createEl("p", { cls: "olab-muted" });
    this.output = this.contentEl.createDiv({ cls: "olab-output" });
    this.log = this.contentEl.createDiv({ cls: "olab-log" });
    this.refreshBudget(); this.showState();
  }
  refreshBudget(): void {
    const runner = this.plugin.runner, busy = this.plugin.sessionBusy;
    this.budgetEl?.setText(`API：${this.plugin.settings.baseUrl}；模型：${this.plugin.settings.model || "尚未选择"}。${budgetText(this.plugin.settings, runner?.state)}`);
    if (this.runButton) this.runButton.disabled = busy;
    if (this.restoreButton) this.restoreButton.disabled = busy;
    const available = !!runner && canContinue(runner.budget, runner.state);
    if (this.stateEl && runner) this.stateEl.setText(`运行状态：${runner.state.status === "budgetExhausted" && available ? "额度已更新，可继续" : STATUS_LABELS[runner.state.status] ?? runner.state.status}`);
    if (this.continueButton) this.continueButton.disabled = busy || (!runner?.state.question && !available && (!runner || !hasPendingTools(runner.state)));
    if (this.appendButton) { this.appendButton.disabled = busy; this.appendButton.hidden = available || runner?.state.status === "completed"; }
  }
  message(message: string): void { this.log.createEl("div", { text: `${new Date().toLocaleTimeString()}  ${message}` }); }
  async start(): Promise<void> {
    if (this.busy) return;
    if (!this.promptEl.value.trim()) { new Notice("请填写指令"); return; }
    const release = this.plugin.acquireSessionOperation();
    if (!release) { new Notice("另一个工作台正在运行或恢复会话，请等待结束或停止后再操作"); return; }
    this.busy = true; this.output.empty();
    try {
      const submittedPrompt = this.promptEl.value;
      const submittedFiles = [...this.files];
      const selectedBase = this.plugin.settings.baseUrl;
      const selectedModel = this.plugin.settings.model;
      const selectedKey = this.app.secretStorage.getSecret(secretId(selectedBase)) ?? "";
      const transport = this.plugin.transport(); const chemistry = this.plugin.chemistry(); const store = new ObsidianStore(this.app);
      const id = `OL-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 6)}`;
      const dir = safePath(`${this.plugin.settings.folder}/${id}`); const sources: SourceAsset[] = [];
      for (const [index, file] of submittedFiles.entries()) {
        if (file.size > 80 * 1024 * 1024) throw new Error("单个附件最大80MB");
        const path = `${dir}/sources/${index + 1}-${slug(file.name)}`;
        await store.binary(path, new Uint8Array(await file.arrayBuffer()));
        this.message(`归档并索引 ${file.name}`);
        sources.push(await indexSource(store, chemistry, { id: `source-${index + 1}`, name: file.name, path, mime: file.type || (file.name.endsWith(".pdf") ? "application/pdf" : "image/png"), pages: [] }));
      }
      const content: Record<string, unknown>[] = [{ type: "input_text", text: `${submittedPrompt}\n\n本次附件：${JSON.stringify(sources.map(s => ({ sourceId: s.id, name: s.name, mime: s.mime, pageCount: s.pages.length || 1 })))}\nPDF已完整建立文本索引，调用search_sources和read_source_page查证。` }];
      for (const source of sources.filter(s => s.mime.startsWith("image/"))) content.push({ type: "input_image", image_url: `data:${source.mime};base64,${Buffer.from(await store.readBinary(source.path)).toString("base64")}` });
      const state: SessionState = { id, dir, prompt: submittedPrompt, status: "archived", sources, context: [{ role: "user", content }], turns: 0, calls: 0, plan: null, rendered: {}, written: {}, receipts: {}, events: [], question: null,
        provider: { baseUrl: selectedBase, model: selectedModel, keyFingerprint: fingerprint(selectedKey) }, gallery: { ...this.plugin.settings.gallery } };
      this.plugin.settings.lastSession = `${dir}/会话状态.json`; await this.plugin.persist();
      this.plugin.runner = new AgentRunner(state, store, chemistry, transport, m => { this.message(m); this.plugin.refreshBudgetDisplays(); }, this.plugin.settings.maxTurns, this.plugin.settings.maxCalls);
      await this.plugin.runner.event("input_archived", { sourceIds: sources.map(s => s.id), prompt: state.prompt });
      await this.plugin.runner.run(); this.showState();
    } catch (error) { this.message(String(error)); new Notice(String(error)); }
    finally { this.busy = false; release(); this.plugin.refreshStates(); }
  }
  async restore(): Promise<void> {
    if (this.busy) return;
    const release = this.plugin.acquireSessionOperation();
    if (!release) { new Notice("会话正在执行，请等待结束或停止后恢复"); return; }
    this.busy = true;
    try {
      if (!this.plugin.settings.lastSession) throw new Error("尚无可恢复的会话");
      const store = new ObsidianStore(this.app);
      const state: SessionState = JSON.parse(await store.read(this.plugin.settings.lastSession));
      const key = this.app.secretStorage.getSecret(secretId(this.plugin.settings.baseUrl)) ?? "";
      if (state.provider && (state.provider.baseUrl !== this.plugin.settings.baseUrl || state.provider.model !== this.plugin.settings.model || state.provider.keyFingerprint !== fingerprint(key))) throw new Error("请恢复此会话原来的 API、模型和 key 后继续，或明确新建会话");
      this.plugin.runner = new AgentRunner(state, store, this.plugin.chemistry(), this.plugin.transport(), m => { this.message(m); this.plugin.refreshBudgetDisplays(); }, this.plugin.settings.maxTurns, this.plugin.settings.maxCalls);
      this.showState();
    } catch (error) { new Notice(String(error)); }
    finally { this.busy = false; release(); this.plugin.refreshStates(); }
  }
  async resume(runner: AgentRunner, answer: string, budget?: BudgetLimits): Promise<void> {
    if (this.plugin.runner !== runner) { new Notice("会话已切换，请在当前会话中继续"); this.showState(); return; }
    if (runner.state.question && !answer.trim()) { new Notice("请先填写当前问题的回答"); return; }
    const release = this.plugin.acquireSessionOperation();
    if (!release) { new Notice("会话正在执行，请等待结束或停止后继续"); return; }
    this.busy = true;
    try {
      if (budget) {
        const previous = runner.budget;
        await this.plugin.saveBudget(budget);
        await runner.event("budget_updated", { previous, limits: runner.budget, used: { turns: runner.state.turns, calls: runner.state.calls } });
        new Notice("追加额度已保存，累计次数保留，继续当前会话");
      }
      if (!runner.state.question && !hasPendingTools(runner.state) && !canContinue(runner.budget, runner.state)) throw new Error("预算已耗尽，请先明确追加额度");
      if (!runner.state.question && answer.trim()) runner.state.context.push({ role: "user", content: answer });
      await runner.run(answer);
    } catch (error) { this.message(String(error)); new Notice(String(error)); }
    finally { this.busy = false; release(); this.plugin.refreshStates(); }
  }
  appendBudgetModal(runner: AgentRunner, answer: string): void {
    const modal = new Modal(this.app); modal.titleEl.setText("追加额度并继续当前会话");
    const current = runner.budget, used = { turns: runner.state.turns, calls: runner.state.calls };
    modal.contentEl.createEl("p", { text: budgetText(current, used) });
    modal.contentEl.createEl("p", { text: "只增加你填写的额度，累计次数和已有实验记录保留。追加后的上限也会用于新会话。" });
    let turns = "0", calls = "0";
    const preview = modal.contentEl.createEl("p", { cls: "olab-muted" });
    const update = () => { try { preview.setText(`追加后：${budgetText(appendBudget(current, used, turns, calls), used)}`); } catch (error) { preview.setText(error instanceof Error ? error.message : String(error)); } };
    new Setting(modal.contentEl).setName("追加模型请求次数").addText(t => t.setValue(turns).onChange(v => { turns = v; update(); }));
    new Setting(modal.contentEl).setName("追加工具调用次数").addText(t => t.setValue(calls).onChange(v => { calls = v; update(); }));
    new Setting(modal.contentEl).addButton(b => b.setButtonText("保存额度并继续").setCta().onClick(async () => {
      try {
        if (this.plugin.runner !== runner) throw new Error("会话已切换，请关闭后在当前会话追加额度");
        if (this.plugin.sessionBusy) throw new Error("会话正在执行，请等待结束后再追加");
        if (runner.budget.maxTurns !== current.maxTurns || runner.budget.maxCalls !== current.maxCalls || runner.state.turns !== used.turns || runner.state.calls !== used.calls) throw new Error("预算或使用次数已变化，请关闭后重新查看追加额度");
        const next = appendBudget(current, used, turns, calls);
        modal.close(); await this.resume(runner, answer, next);
      } catch (error) { new Notice(String(error)); }
    }));
    update(); modal.open();
  }
  showState(): void {
    const runner = this.plugin.runner; if (!runner || !this.output) return;
    this.continueButton = undefined; this.appendButton = undefined;
    this.output.empty(); this.stateEl = this.output.createEl("h3", { text: `运行状态：${STATUS_LABELS[runner.state.status] ?? runner.state.status}` });
    for (const [order, path] of Object.entries(runner.state.written)) this.output.createEl("button", { text: `打开步骤 ${order}` }).onclick = () => void this.app.workspace.openLinkText(path, "", true);
    if (runner.state.status === "completed") {
      this.output.createEl("button", { text: "打开路线图库" }).onclick = () => void this.app.workspace.openLinkText(`${runner.state.dir}/路线.base`, "", true);
      this.output.createEl("button", { text: "打开路线主页" }).onclick = () => void this.app.workspace.openLinkText(`${runner.state.dir}/路线.md`, "", true);
    } else {
      this.output.createEl("p", { text: runner.state.question?.text ?? "可补充说明后继续；预算仍按本会话累计。" });
      const answer = this.output.createEl("textarea", { attr: { rows: "3", placeholder: "回答或补充说明" } });
      this.continueButton = this.output.createEl("button", { text: runner.state.question ? "保存回答并继续" : hasPendingTools(runner.state) && !canContinue(runner.budget, runner.state) ? "补齐已收到的工具调用" : "继续当前会话" });
      this.continueButton.onclick = () => void this.resume(runner, answer.value);
      this.appendButton = this.output.createEl("button", { text: "追加额度并继续" });
      this.appendButton.onclick = () => this.appendBudgetModal(runner, answer.value);
    }
    this.refreshBudget();
  }
}

class LabSettings extends PluginSettingTab {
  constructor(app: App, private plugin: OrganicLabPlugin) { super(app, plugin); }
  display(): void {
    this.containerEl.empty(); this.containerEl.createEl("h2", { text: "Organic Lab 设置" });
    const settings = this.plugin.settings;
    new Setting(this.containerEl).setName("API预设").setDesc("选择你自己的服务；运行失败不会更换服务。模型需要图片输入与Responses工具调用。").addDropdown(d => d.addOptions({ openai: "OpenAI Responses", deepseek: "DeepSeek Responses", custom: "自定义 Responses" }).setValue(settings.baseUrl.includes("deepseek") ? "deepseek" : settings.baseUrl.includes("openai") ? "openai" : "custom").onChange(async v => { if (v !== "custom") settings.baseUrl = v === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com/v1"; settings.model = ""; settings.models = []; await this.plugin.persist(); this.display(); }));
    new Setting(this.containerEl).setName("API base URL").addText(t => t.setValue(settings.baseUrl).onChange(async v => { settings.baseUrl = v; settings.models = []; await this.plugin.persist(); }));
    new Setting(this.containerEl).setName("API key").setDesc("每个API地址独立存入 Obsidian SecretStorage；留空保留该地址的已有key。").addText(t => { t.inputEl.type = "password"; t.setPlaceholder("输入自己的 API key"); t.onChange(v => { if (v.trim()) this.app.secretStorage.setSecret(secretId(settings.baseUrl), v.trim()); }); });
    new Setting(this.containerEl).setName("验证连接／获取模型").setDesc("只调用模型目录，不进行推理。").addButton(b => b.setButtonText("验证并获取模型").onClick(async () => {
      try { const key = this.app.secretStorage.getSecret(secretId(settings.baseUrl)); if (!key) throw new Error("请先填写该API地址的 key"); settings.models = await modelCatalog(settings.baseUrl, key, http); await this.plugin.persist(); new Notice(`连接成功，${settings.models.length} 个模型`); this.display(); }
      catch (error) { new Notice(String(error)); }
    }));
    new Setting(this.containerEl).setName("当前模型").addDropdown(d => { d.addOption("", "选择模型"); for (const model of settings.models) d.addOption(model, model); if (settings.model && !settings.models.includes(settings.model)) d.addOption(settings.model, settings.model); d.setValue(settings.model).onChange(async v => { settings.model = v; await this.plugin.persist(); }); });
    new Setting(this.containerEl).setName("手动模型ID").setDesc("目录受限时可直接填写，图片和工具能力在实际运行时检验。").addText(t => t.setValue(settings.model).onChange(async v => { settings.model = v.trim(); await this.plugin.persist(); }));
    new Setting(this.containerEl).setName("Python 可执行文件").setDesc("安装 requirements.txt 的 Python；可填写 .venv\\Scripts\\python.exe 的完整路径。").addText(t => t.setValue(settings.pythonPath).onChange(async v => { settings.pythonPath = v.trim(); await this.plugin.persist(); }));
    new Setting(this.containerEl).setName("本地工具检查").addButton(b => b.setButtonText("检查 RDKit").onClick(async () => { try { const r = await this.plugin.chemistry().call<{ formula: string; mw: number }>({ op: "inspect", smiles: "CCO" }); new Notice(`RDKit 正常：${r.formula}，MW ${r.mw}`); } catch (error) { new Notice(String(error)); } }));
    new Setting(this.containerEl).setName("实验保存文件夹").addText(t => t.setValue(settings.folder).onChange(async v => { settings.folder = v.trim(); await this.plugin.persist(); }));
    new Setting(this.containerEl).setName("新路线图库默认比例").setDesc("0.2–1；当前路线用命令“调整当前路线图库”设置。").addSlider(s => s.setLimits(.2, 1, .01).setValue(settings.gallery.imageAspectRatio).setDynamicTooltip().onChange(async v => { settings.gallery.imageAspectRatio = Number(v.toFixed(2)); await this.plugin.persist(); }));
    new Setting(this.containerEl).setName("新路线图库图像适配").addDropdown(d => d.addOptions({ contain: "完整显示", cover: "填满并裁剪" }).setValue(settings.gallery.imageFit).onChange(async v => { settings.gallery.imageFit = v as GalleryOptions["imageFit"]; await this.plugin.persist(); }));
    this.containerEl.createEl("h3", { text: "运行预算" });
    this.containerEl.createEl("p", { text: "填写累计上限后点击保存；默认32次模型请求、128次工具调用。保存会应用到当前会话和新会话，已用次数保留，不会自动开始运行。" });
    let turns = String(settings.maxTurns), calls = String(settings.maxCalls);
    new Setting(this.containerEl).setName("模型请求累计上限").setDesc("1–128次").addText(t => t.setValue(turns).onChange(v => turns = v));
    new Setting(this.containerEl).setName("工具调用累计上限").setDesc("1–512次").addText(t => t.setValue(calls).onChange(v => calls = v));
    const budgetStatus = this.containerEl.createEl("p", { text: budgetText(settings, this.plugin.runner?.state), cls: "olab-muted" });
    new Setting(this.containerEl).addButton(b => b.setButtonText("保存预算").setCta().onClick(async () => {
      b.setDisabled(true);
      try {
        const next = parseBudget(turns, calls);
        await this.plugin.saveBudget(next);
        budgetStatus.setText(`已保存。${budgetText(next, this.plugin.runner?.state)}`);
        new Notice("预算已保存，当前会话和新会话采用此上限；累计次数保留");
      } catch (error) { budgetStatus.setText(error instanceof Error ? error.message : String(error)); new Notice(String(error)); }
      finally { b.setDisabled(false); }
    }));
  }
}
