import { CalculatedRow, finitePositive, StoichInput } from "./domain";
import { stateLabels } from "./reagent-properties";

export function calculateStoichiometry(input: StoichInput): CalculatedRow[] {
  if (input.scaleMmol !== null && !finitePositive(input.scaleMmol)) throw new Error("规模必须为正数");
  const basis = input.basisId ? input.rows.find(row => row.id === input.basisId && row.role === "substrate") : null;
  if (input.basisId && (!basis || !finitePositive(basis.equivalents))) throw new Error("基准底物或其参考当量未知，请核对后再计算");
  const basisEq = basis?.equivalents ?? 1;
  return input.rows.map(row => {
    const amountMmol = input.scaleMmol !== null && finitePositive(row.equivalents) ? input.scaleMmol * row.equivalents / basisEq : null;
    const pureMassMg = amountMmol !== null && finitePositive(row.mw) ? amountMmol * row.mw : null;
    const weighingMassMg = pureMassMg !== null && finitePositive(row.purityPercent) ? pureMassMg * 100 / row.purityPercent : null;
    const pureVolumeMl = pureMassMg !== null && row.physicalState === "liquid" && finitePositive(row.densityGml) ? pureMassMg / (row.densityGml * 1000) : null;
    const volumeMl = amountMmol !== null && finitePositive(row.concentrationM) ? amountMmol / row.concentrationM :
      weighingMassMg !== null && row.physicalState !== "solid" && finitePositive(row.densityGml) ? weighingMassMg / (row.densityGml * 1000) : null;
    return { ...row, amountMmol, pureMassMg, weighingMassMg, pureVolumeMl, volumeMl };
  });
}
export function amountFromMass(massMg: number, mw: number, purityPercent: number): number {
  if (![massMg, mw, purityPercent].every(finitePositive) || purityPercent > 100) throw new Error("质量、摩尔质量和纯度无效");
  return massMg / mw * purityPercent / 100;
}
export function formatNumber(value: number | null, digits = 4): string { return value === null ? "—" : Number(value.toFixed(digits)).toString(); }
export function stoichMarkdown(input: StoichInput): string {
  const headers = "| 组分 | 常温形态 | MW (g/mol) | eq | mmol | 纯品 mg | 称量 mg | 理论体积 mL | 实配体积 mL |\n|---|---|---:|---:|---:|---:|---:|---:|---:|";
  const escape = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const rows = calculateStoichiometry(input).map(r => `| ${escape(r.name)} | ${r.physicalState ? stateLabels[r.physicalState] : "待补"} | ${formatNumber(r.mw)} | ${formatNumber(r.equivalents)} | ${formatNumber(r.amountMmol)} | ${formatNumber(r.pureMassMg)} | ${formatNumber(r.weighingMassMg)} | ${formatNumber(r.pureVolumeMl)} | ${formatNumber(r.volumeMl)} |`);
  const propertyNames: Record<string, string> = { mw: "MW", formula: "分子式", physicalState: "形态", densityGml: "密度", concentrationM: "浓度", purityPercent: "纯度", equivalents: "当量" };
  const details = input.rows.map(r => {
    const temperature = r.propertySources?.find(s => s.property === "densityGml")?.temperatureC;
    const density = r.densityGml !== null ? `${formatNumber(r.densityGml)} g/mL${temperature != null ? ` @ ${temperature} °C` : "（温度待核对）"}` : r.physicalState === "solid" ? "固体不换算体积" : "密度待补";
    const origins = (r.propertySources ?? []).map(s => `${propertyNames[s.property]}：${s.kind === "user" ? "用户" : s.citation ? `${s.citation.sourceId}:p${s.citation.page}` : s.url && /^https:\/\//.test(s.url) ? `[目录](${s.url})` : "RDKit"}`);
    const quantity = r.valueSource === "user" ? "用户编辑；文献原值见来源" : r.citations.map(c => `${c.sourceId}:p${c.page}`).join(", ") || "待补";
    return `| ${escape(r.name)} | ${escape(r.formula ?? "待补")}；${escape(density)} | ${[...new Set(origins), `投料：${quantity}`].map(escape).join("；")} |`;
  });
  return [headers, ...rows, "", "计算：mmol = 已选基准底物规模 × 参考eq / 基准参考eq。纯品 mg = mmol × 平均MW；称量 mg = 纯品 mg / 纯度。液体理论体积按100%纯品计算；实配体积采用已知有效浓度，或已确认的纯度及密度。固体不按密度换算体积。", "", "### 物料性质与来源", "", "| 组分 | 分子式／密度 | 性质与投料来源 |", "|---|---|---|", ...details].join("\n");
}
