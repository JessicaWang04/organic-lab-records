import { stringify as yamlStringify, parse, parseDocument, isMap, isSeq } from "yaml";
import { ExperimentStep, RoutePlan, SourceAsset, StepArtifacts, StoichInput, slug, safePath } from "./domain";
import { stoichMarkdown } from "./stoichiometry";
const stringify = (value: unknown) => yamlStringify(value, { lineWidth: 0 });

export const pad = (value: number) => value.toString().padStart(2, "0");
export function stepFile(routeDir: string, routeId: string, step: ExperimentStep, attempt = 1): string {
  return safePath(`${routeDir}/${routeId}-${pad(step.order)}-R${pad(attempt)}-${slug(step.title)}.md`);
}
export interface GalleryOptions { imageAspectRatio: number; imageFit: "contain" | "cover"; cardSize: number }
export const DEFAULT_GALLERY: GalleryOptions = { imageAspectRatio: .4, imageFit: "contain", cardSize: 350 };
export function validateGallery(options: GalleryOptions): void {
  if (!Number.isFinite(options.imageAspectRatio) || options.imageAspectRatio < .2 || options.imageAspectRatio > 1) throw new Error("图库图片比例应为0.2–1");
  if (!["contain", "cover"].includes(options.imageFit) || !Number.isFinite(options.cardSize) || options.cardSize < 150 || options.cardSize > 800) throw new Error("图库适配或卡片宽度无效");
}
export function buildBase(routeId: string, options: GalleryOptions = DEFAULT_GALLERY): string {
  validateGallery(options);
  return stringify({
    filters: { and: ['file.ext == "md"', 'note.type == "reaction-experiment"', `note.route_id == ${JSON.stringify(routeId)}`] },
    properties: { "note.step_number": { displayName: "步骤" }, "note.paper_step": { displayName: "文献步骤" }, "note.attempt": { displayName: "尝试" }, "note.status": { displayName: "状态" }, "note.worked": { displayName: "是否跑通" } },
    views: [
      { type: "cards", name: "路线图库", image: "note.image", ...options, order: ["file.name", "note.step_number", "note.attempt", "note.status", "note.worked"], sort: [{ property: "note.step_number", direction: "ASC" }, { property: "note.attempt", direction: "ASC" }] },
      { type: "table", name: "实验管理", order: ["file.name", "note.step_number", "note.paper_step", "note.attempt", "note.status", "note.worked", "note.measured_yield_percent"], sort: [{ property: "note.step_number", direction: "ASC" }, { property: "note.attempt", direction: "ASC" }] }
    ]
  });
}
export function galleryViews(content: string): ({ name: string } & GalleryOptions)[] {
  const base = parse(content);
  return (base?.views ?? []).filter((view: Record<string, unknown>) => view.type === "cards").map((view: Record<string, unknown>) => ({ name: String(view.name),
    imageAspectRatio: Number(view.imageAspectRatio ?? DEFAULT_GALLERY.imageAspectRatio), imageFit: view.imageFit === "cover" ? "cover" : "contain", cardSize: Number(view.cardSize ?? DEFAULT_GALLERY.cardSize) }));
}
export function updateBaseGallery(content: string, name: string, options: GalleryOptions): string {
  validateGallery(options);
  const document = parseDocument(content);
  if (document.errors.length) throw new Error("Bases YAML无效");
  const views = document.get("views");
  if (!isSeq(views)) throw new Error("找不到Bases视图");
  const view = views.items.find(item => isMap(item) && item.get("type") === "cards" && item.get("name") === name);
  if (!isMap(view)) throw new Error("找不到指定图库视图");
  for (const [key, value] of Object.entries(options)) view.set(key, value);
  return document.toString({ lineWidth: 0 });
}
export function parseStoichInput(note: string): StoichInput {
  const block = note.match(/^```organic-stoich\s*\n([\s\S]*?)^```\s*$/m);
  if (!block) throw new Error("找不到本记录的可编辑计量输入");
  const input = JSON.parse(block[1]) as StoichInput;
  if (!Array.isArray(input.rows)) throw new Error("计量输入缺少物料行");
  return input;
}
export function moveStoichEditorBeforeResults(note: string): string {
  const block = /^```organic-stoich[^\n]*\n[\s\S]*?^```[^\n]*\n?/m.exec(note);
  const heading = /^## Stoichiometry[^\n]*\n/m.exec(note);
  if (!block || !heading || block.index < heading.index) return note;
  const removed = note.slice(0, block.index) + note.slice(block.index + block[0].length);
  return `${removed.slice(0, heading.index)}## 计量输入\n\n${block[0].trim()}\n\n${removed.slice(heading.index)}`;
}
function stoichSection(input: StoichInput): string {
  const json = JSON.stringify(input, null, 2).replace(/```/g, "\\u0060\\u0060\\u0060");
  return `## 计量输入\n\n\`\`\`organic-stoich\n${json}\n\`\`\`\n\n## Stoichiometry\n\n<!-- organic-lab:stoich-start -->\n${stoichMarkdown(input)}\n<!-- organic-lab:stoich-end -->`;
}
const list = (values: string[], numbered = false) => values.length ? values.map((v, i) => `${numbered ? `${i + 1}.` : "-"} ${v}`).join("\n") : "原文未给出，待补充。";
export function buildStepNote(routeId: string, step: ExperimentStep, artifacts: StepArtifacts, sources: SourceAsset[], previous: string | null, next: string | null): string {
  const link = (path: string | null) => path ? `[[${safePath(path)}]]` : null;
  const sourceLinks = [...new Set(step.citations.map(c => {
    const source = sources.find(s => s.id === c.sourceId);
    return source ? `[[${source.path}${source.mime === "application/pdf" ? `#page=${c.page}` : ""}]]` : `${c.sourceId}:p${c.page}`;
  }))];
  const frontmatter = {
    type: "reaction-experiment", route_id: routeId, step_number: step.order, paper_step: step.paperStep,
    attempt: 1, attempts_count: 0, status: "draft", worked: null,
    image: link(artifacts.image), cdxml: link(artifacts.cdxml), structure_status: artifacts.cdxml ? "graph-validated-needs-image-review" : "source-image-only",
    quality: link(artifacts.quality), scale_mmol: step.scaleMmol, scale_basis: step.scaleBasisId,
    previous_step: link(previous), next_step: link(next), sources: sourceLinks,
    reference_yield: step.referenceYield, reference_yield_scope: step.yieldScope,
    measured_yield_percent: null, spectra: [], skill_version: "experiment-records/1.0.0", harness_version: "organic-lab/0.1.0"
  };
  const referenceSpectra = artifacts.referenceSpectra ?? [];
  Object.assign(frontmatter, { reference_spectra: referenceSpectra.map(path => link(path)) });
  const stoich = { scaleMmol: step.scaleMmol, basisId: step.scaleBasisId, rows: step.reagents };
  return `---\n${stringify(frontmatter)}---\n\n# ${step.title}\n\n## 实验目的\n\n${step.purpose}\n\n## 反应式\n\n![[${artifacts.image}]]\n\n可编辑结构：${link(artifacts.cdxml) ?? "结构尚待确认；当前显示原文图像。"}\n\n参考条件：${[...step.aboveArrow, ...step.belowArrow].join("；")}\n\n${stoichSection(stoich)}\n\n## 文献参考步骤\n\n${list(step.procedure, true)}\n\n## 实际操作与现象记录\n\n| 时间 | 操作／观察 | TLC／取样 | 附件 |\n|---|---|---|---|\n| | | | |\n\n## 后处理\n\n### 文献参考\n${list(step.workup, true)}\n\n### 实际记录\n\n\n## 纯化\n\n### 文献参考\n${list(step.purification)}\n\n### 实际记录\n\n\n## 表征与图谱\n\n### 文献参考\n${list(step.characterization)}\n\n### 本次实验\n\n将本次 NMR、LCMS、HRMS、IR 或原始数据拖入此处，并在 YAML 的 spectra 中登记。\n\n## 结果\n\n- 本次产物质量：\n- 本次实测产率：\n- 本次是否跑通：\n- 备注：\n\n文献产率：${step.referenceYield ?? "未知"}；口径：${step.yieldScope ?? "未知"}。本次实验结果单独记录。\n\n## 来源与核对\n\n${step.citations.map(c => {
    const s = sources.find(source => source.id === c.sourceId);
    return `- ${s ? `[[${s.path}#page=${c.page}|${s.name} · p${c.page}]]` : `${c.sourceId}:p${c.page}`}\n  > ${c.quote.replace(/\n/g, "\n  > ")}`;
  }).join("\n\n")}\n\n${list(step.conflicts)}\n\n质量报告：[[${artifacts.quality}]]\n\n## 文献参考图谱附件\n\n${referenceSpectra.map(path => `![[${path}]]`).join("\n\n")}\n`;
}
export function routeNote(routeId: string, routeDir: string, plan: RoutePlan): string {
  return `---\ntype: reaction-route\nroute_id: ${JSON.stringify(routeId)}\n---\n\n# ${plan.title}\n\n${plan.intent}\n\n![[${routeDir}/路线.base]]\n\n## 按步骤打开\n\n${plan.steps.map(s => `- [[${stepFile(routeDir, routeId, s)}|${pad(s.order)} · ${s.title}]]`).join("\n")}\n\n## 用户要求的结构变化\n\n${list(plan.requestedChanges)}\n\n运行与工具回执：[[${routeDir}/运行日志.json]]\n`;
}
export function replaceStoichBlock(note: string, input: StoichInput): string {
  const start = "<!-- organic-lab:stoich-start -->", end = "<!-- organic-lab:stoich-end -->";
  if (note.indexOf(start) < 0 || note.indexOf(end) < 0) throw new Error("找不到插件管理的计量表区域");
  const table = stoichMarkdown(input as Parameters<typeof stoichMarkdown>[0]);
  const updated = note.replace(new RegExp(`${start}[\\s\\S]*?${end}`), () => `${start}\n${table}\n${end}`);
  return moveStoichEditorBeforeResults(updated.replace(/^```organic-stoich\s*[\s\S]*?^```/m, () => `\`\`\`organic-stoich\n${JSON.stringify(input, null, 2).replace(/```/g, "\\u0060\\u0060\\u0060")}\n\`\`\``));
}
export function parseFrontmatter(note: string): Record<string, unknown> {
  const match = note.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? parse(match[1]) as Record<string, unknown> : {};
}
