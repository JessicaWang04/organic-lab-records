export interface Citation { sourceId: string; page: number; quote: string }
export interface SourcePage { page: number; text: string }
export interface SourceAsset { id: string; name: string; path: string; mime: string; pages: SourcePage[] }
export type PhysicalState = "solid" | "liquid" | "solution" | "gas";
export type PropertyKey = "formula" | "mw" | "physicalState" | "densityGml" | "concentrationM" | "purityPercent" | "equivalents";
export interface PropertySource {
  property: PropertyKey; kind: "structure" | "literature" | "catalog" | "user";
  reference: string; citation: Citation | null; url: string | null; temperatureC: number | null;
}
export interface Reagent {
  id: string; name: string; role: "substrate" | "reagent" | "catalyst" | "solvent" | "product";
  smiles: string | null; mw: number | null; equivalents: number | null;
  referenceAmountMmol: number | null; referenceMassMg: number | null; referenceVolumeMl: number | null;
  concentrationM: number | null; densityGml: number | null; purityPercent: number | null;
  citations: Citation[];
  valueSource?: "user";
  formula?: string | null; physicalState?: PhysicalState | null;
  propertySources?: PropertySource[]; userProperties?: PropertyKey[];
  identityModified?: boolean;
}
export interface ExperimentStep {
  order: number; paperStep: string; title: string; purpose: string;
  reactants: string[]; products: string[]; reagents: Reagent[];
  aboveArrow: string[]; belowArrow: string[]; procedure: string[]; workup: string[]; purification: string[];
  characterization: string[]; citations: Citation[]; referenceBasisMmol: number | null;
  referenceYield: string | null; yieldScope: string | null; conflicts: string[];
  sourceImage: { sourceId: string; page: number; bbox: number[] | null } | null;
  scaleMmol: number | null; scaleBasisId: string | null;
  edits?: Record<string, unknown>[];
}
export interface RoutePlan { title: string; intent: string; requestedChanges: string[]; steps: ExperimentStep[] }
export interface StoichInput { scaleMmol: number | null; basisId?: string | null; rows: Reagent[] }
export interface CalculatedRow extends Reagent { amountMmol: number | null; pureMassMg: number | null; weighingMassMg: number | null; pureVolumeMl: number | null; volumeMl: number | null }
export interface StepArtifacts { image: string; cdxml: string | null; svg: string | null; quality: string; referenceSpectra?: string[] }
export interface QualityIssue { code: string; message: string; severity: "error" | "review"; field: string }
export interface FileStore {
  exists(path: string): Promise<boolean>; read(path: string): Promise<string>;
  write(path: string, content: string, overwrite?: boolean): Promise<void>;
  binary(path: string, data: Uint8Array, overwrite?: boolean): Promise<void>;
  readBinary(path: string): Promise<Uint8Array>;
}
export const finitePositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
export function safePath(path: string): string {
  const value = path.replace(/\\/g, "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").some(p => !p || p === "." || p === "..") || /[\x00-\x1f]/.test(value)) throw new Error("路径必须是库内相对路径");
  return value;
}
export function slug(value: string): string {
  return value.replace(/[\\/:*?"<>|\[\]#^\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 70) || "实验";
}
export function validatePlan(plan: RoutePlan): void {
  if (!plan || typeof plan.title !== "string" || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 60) throw new Error("路线需要 1–60 个有序步骤");
  const orders = new Set<number>();
  for (const step of plan.steps) {
    if (!Number.isInteger(step.order) || step.order < 1 || orders.has(step.order)) throw new Error("步骤编号必须唯一且为正整数");
    orders.add(step.order);
    if (/^TS[-–]?\d/i.test(step.paperStep.trim())) throw new Error("过渡态示意不能作为独立实验步骤");
    for (const field of ["reactants", "products", "reagents", "aboveArrow", "belowArrow", "procedure", "workup", "purification", "characterization", "citations", "conflicts"] as const) {
      if (!Array.isArray(step[field])) throw new Error(`步骤 ${step.order} 缺少 ${field}`);
    }
    if (step.reagents.length > 40 || step.reactants.length > 12 || step.products.length > 12) throw new Error("单步结构或试剂数量超出限制");
    if (step.scaleMmol !== null && !finitePositive(step.scaleMmol)) throw new Error("规模必须为正数或未知");
    if (step.scaleMmol !== null && !step.reagents.some(r => r.id === step.scaleBasisId && r.role === "substrate")) throw new Error("规模必须绑定本步具体底物");
    const ids = new Set<string>();
    for (const row of step.reagents) {
      if (!row.id || ids.has(row.id)) throw new Error("试剂 ID 必须唯一");
      ids.add(row.id);
      for (const key of ["mw", "equivalents", "referenceAmountMmol", "referenceMassMg", "referenceVolumeMl", "concentrationM", "densityGml", "purityPercent"] as const) {
        if (row[key] !== null && !finitePositive(row[key])) throw new Error(`${row.name}.${key} 必须为正数或未知`);
      }
      if (row.purityPercent !== null && row.purityPercent > 100) throw new Error("纯度不能超过100%");
      if (row.physicalState != null && !["solid", "liquid", "solution", "gas"].includes(row.physicalState)) throw new Error("常温形态无效");
    }
  }
  plan.steps.sort((a, b) => a.order - b.order);
}
