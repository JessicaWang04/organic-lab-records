import { ExperimentStep, QualityIssue, SourceAsset } from "./domain";
const normalized = (text: string) => text.normalize("NFKC").replace(/[−–—]/g, "-").replace(/\s+/g, "").toLowerCase();

const referencePrefix = "(?:(?:截图|原图|原文|文献)(?:中|上)?的?)?";
const structureTarget = "(?:结构|(?:底物|反应物|产物)(?:的?结构)?|分子结构|化合物结构|立体化学|构型)";
const target = `${referencePrefix}(?:原始|原有|原)?${structureTarget}`;
const unchangedClauses = [
  new RegExp(`^(?:请)?(?:不|不要|无需|不用|不需要)(?:进行)?(?:任何)?(?:修改|改变|更改|改动|调整|编辑|替换)${target}$`),
  new RegExp(`^(?:请)?(?:不|不要|无需|不用|不需要)对${target}(?:进行)?(?:任何)?(?:修改|改变|更改|改动|调整|编辑|替换)$`),
  new RegExp(`^(?:请)?(?:保留|保持)${target}(?:不变|原样)?$`),
  new RegExp(`^(?:请)?(?:使用|沿用|采用)${referencePrefix}(?:原始|原有|原)${structureTarget}$`)
];
const stepScope = "(?:(?:第[一二三四五六七八九十百\\d]+步|本步)的?)?";
const scaleTarget = "(?:底物(?:用量|规模)?|(?:实际|反应|实验)?规模)";
const scalePrefix = `^(?:请)?(?:仅|只)?${stepScope}`;
const scaleAmount = "\\d+(?:\\.\\d+)?mmol";
const scaleClauses = [
  new RegExp(`${scalePrefix}(?:设置|设定|调整)${scaleTarget}(?:为|至|到)?${scaleAmount}$`),
  new RegExp(`${scalePrefix}${scaleTarget}(?:设为|设置为|设定为|调整为|调整到|为)${scaleAmount}$`),
  new RegExp(`${scalePrefix}${scaleTarget}(?:待输入|待确认|待提供|待用户输入|未知|未指定)$`)
];

export function requiresStructureEdit(requestedChanges: string[]): boolean {
  // Only whole preservation/scale clauses are exempt. Unknown or mixed edit
  // instructions still require a local receipt; decimal points stay in amounts.
  return requestedChanges.some(change => change.split(/[，,。;；\n!?！？]+|(?<!\d)\.|\.(?!\d)/).some(part => {
    const clause = normalized(part);
    return clause.length > 0 && ![...unchangedClauses, ...scaleClauses].some(pattern => pattern.test(clause));
  }));
}

export function checkEvidence(step: ExperimentStep, sources: SourceAsset[]): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const cite = [...step.citations, ...step.reagents.flatMap(row => [...row.citations, ...(row.propertySources ?? []).flatMap(s => s.citation ? [s.citation] : [])])];
  for (const c of cite) {
    const source = sources.find(s => s.id === c.sourceId);
    const page = source?.pages.find(p => p.page === c.page);
    if (!source || !Number.isInteger(c.page) || c.page < 1 || (source.mime === "application/pdf" && !page)) {
      issues.push({ code: "invalid_source_reference", field: "citations", severity: "error", message: `不存在的来源 ${c.sourceId}:p${c.page}` });
    } else if (page && page.text.trim() && c.quote && !normalized(page.text).includes(normalized(c.quote))) {
      issues.push({ code: "quote_not_found", field: "citations", severity: "error", message: `引文不在 ${c.sourceId}:p${c.page} 中` });
    } else if (source.mime === "application/pdf" && page && !page.text.trim()) {
      issues.push({ code: "visual_citation_review", field: "citations", severity: "review", message: `${c.sourceId}:p${c.page} 无可提取文字，目视转录需要对照原页核对` });
    }
  }
  if (!step.citations.length) issues.push({ code: "missing_step_evidence", field: "citations", severity: "review", message: "本步没有具体原文引用" });
  for (const row of step.reagents) {
    if (row.equivalents !== null && !row.citations.length) issues.push({ code: "unsupported_equivalents", field: row.id, severity: "error", message: `${row.name} 的 eq 缺少来源` });
    const evidence = row.citations.map(c => c.quote.normalize("NFKC")).join(" ");
    const quantities = [...evidence.matchAll(/(\d+(?:\.\d+)?)\s*(mmol|equiv|eq\b|mg|g\b|mL|ml)/g)].map(m => ({ value: Number(m[1]), unit: m[2] }));
    const recorded = [[row.equivalents, "equiv"], [row.referenceAmountMmol, "mmol"], [row.referenceMassMg, "mg"], [row.referenceVolumeMl, "ml"]] as const;
    for (const [value, unit] of recorded) if (value !== null && !quantities.some(q => {
      const actualUnit = q.unit === "eq" ? "equiv" : q.unit === "mL" ? "ml" : q.unit === "g" ? "mg" : q.unit;
      const actual = q.unit === "g" ? q.value * 1000 : q.value;
      return actualUnit === unit && Math.abs(actual - value) < 0.00001;
    })) issues.push({ code: "quantity_not_in_quote", field: row.id, severity: "error", message: `${row.name} 的 ${value} ${unit} 不在对应引文中；未知值应留空` });
    if (row.equivalents !== null && row.referenceAmountMmol !== null && step.referenceBasisMmol !== null) {
      const ratio = row.referenceAmountMmol / step.referenceBasisMmol;
      if (Math.abs(ratio - row.equivalents) > Math.max(0.03, Math.abs(row.equivalents) * 0.025)) issues.push({ code: "equivalent_conflict", field: row.id, severity: "review", message: `${row.name}: 原文量比 ${ratio.toFixed(3)} eq 与 ${row.equivalents} eq 不一致` });
    }
    if (row.referenceMassMg !== null && row.referenceAmountMmol !== null && row.mw !== null) {
      const implied = row.referenceMassMg / row.referenceAmountMmol;
      if (Math.abs(implied - row.mw) / row.mw > 0.03) issues.push({ code: "mass_amount_conflict", field: row.id, severity: "review", message: `${row.name}: 原文质量/mmol 与结构摩尔质量不一致` });
    }
  }
  for (const conflict of step.conflicts) issues.push({ code: "reported_source_conflict", field: "conflicts", severity: "review", message: conflict });
  if (step.referenceYield && !step.yieldScope) issues.push({ code: "missing_yield_scope", field: "referenceYield", severity: "error", message: "文献产率必须注明单步、合并步骤、混合物或回收计算口径" });
  issues.push({ code: "image_fidelity_review", field: "structures", severity: "review", message: "人工核对结构、立体化学、图文对应和原图条件" });
  return issues;
}
