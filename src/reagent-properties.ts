import { Chemistry } from "./chemistry";
import { Citation, PhysicalState, PropertyKey, PropertySource, Reagent, SourceAsset } from "./domain";

export const stateLabels: Record<PhysicalState, string> = { solid: "固体", liquid: "液体", solution: "溶液", gas: "气体" };
const normalized = (s: string) => s.normalize("NFKC").replace(/[−–]/g, "-").replace(/\s+/g, "").toLowerCase();
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
interface CatalogEntry {
  names: string[]; formula: string; state: PhysicalState | null; url: string; reference: string;
  density?: number; temperature?: number;
  smiles?: string;
}
const wiki = (name: string) => `https://en.wikipedia.org/wiki/${name}`;
const chemicalbook = (cas: string) => `https://www.chemicalbook.com/CASEN_${cas}.htm`;
const catalog: CatalogEntry[] = [
  { names: ["DIPEA", "DIEA", "DIPEA（原文DIEPA）", "N,N-diisopropylethylamine"], smiles: "CCN(C(C)C)C(C)C", formula: "C8H19N", state: "liquid", density: .742, temperature: 25, url: wiki("Diisopropylethylamine"), reference: "DIPEA 游离碱：C8H19N；无色液体；密度0.742 g/mL（条目标准条件25 °C）。" },
  { names: ["Et3N", "triethylamine", "三乙胺"], smiles: "CCN(CC)CC", formula: "C6H15N", state: "liquid", density: .7255, temperature: 25, url: wiki("Triethylamine"), reference: "Et3N 游离碱：C6H15N；无色液体；密度0.7255 g/mL（条目标准条件25 °C）。" },
  { names: ["Ac2O", "Ac2O（原文当量矛盾）", "acetic anhydride", "乙酸酐"], smiles: "CC(=O)OC(C)=O", formula: "C4H6O3", state: "liquid", density: 1.082, temperature: 25, url: wiki("Acetic_anhydride"), reference: "乙酸酐：C4H6O3；无色液体；密度1.082 g/mL（条目标准条件25 °C）。" },
  { names: ["DMAP", "4-dimethylaminopyridine"], smiles: "CN(C)c1ccncc1", formula: "C7H10N2", state: "solid", url: wiki("4-Dimethylaminopyridine"), reference: "DMAP 游离碱：C7H10N2，白色固体。" },
  { names: ["IBX", "2-iodoxybenzoic acid"], formula: "C7H5IO4", state: "solid", url: wiki("2-Iodoxybenzoic_acid"), reference: "IBX 活性组分：C7H5IO4，白色晶体；稳定化配方及批次纯度另填。" },
  { names: ["Cp2TiCl2", "titanocene dichloride"], formula: "C10H10Cl2Ti", state: "solid", url: wiki("Titanocene_dichloride"), reference: "二氯二茂钛：C10H10Cl2Ti，红色固体。" },
  { names: ["Me3SnOH", "trimethyltin hydroxide"], smiles: "O[Sn](C)(C)C", formula: "C3H10OSn", state: "solid", url: wiki("Trimethyltin_hydroxide"), reference: "三甲基氢氧化锡：(CH3)3SnOH，白色晶体。" },
  { names: ["TsCl", "tosyl chloride", "p-toluenesulfonyl chloride"], formula: "C7H7ClO2S", state: "solid", url: wiki("4-Toluenesulfonyl_chloride"), reference: "对甲苯磺酰氯：C7H7ClO2S，白色固体。" },
  { names: ["Grubbs II", "Grubbs catalyst 2nd generation"], formula: "C46H65Cl2N2PRu", state: "solid", url: `${wiki("Grubbs_catalyst")}#Second-generation_Grubbs_catalyst`, reference: "Grubbs第二代催化剂（非Hoveyda型）：C46H65Cl2N2PRu，粉棕色固体。" },
  { names: ["3-bromo-2-methylpropene", "methallyl bromide"], smiles: "C=C(C)CBr", formula: "C4H7Br", state: "liquid", density: 1.339, temperature: 25, url: chemicalbook("1458-98-6"), reference: "CAS1458-98-6：C4H7Br；液体；密度1.339 g/mL at25 °C（lit.）。" },
  { names: ["cis-1,4-diacetoxy-2-butene", "cis-2-butene-1,4-diol diacetate"], smiles: "CC(=O)OC/C=C\\COC(C)=O", formula: "C8H12O4", state: "liquid", density: 1.09, url: chemicalbook("25260-60-0"), reference: "CAS25260-60-0，cis异构体：C8H12O4；液体；密度1.09 g/mL，来源未注明测量温度。" },
  { names: ["trifluoroacetyl imidazole", "1-(trifluoroacetyl)imidazole", "TFAI"], smiles: "FC(F)(F)C(=O)n1ccnc1", formula: "C5H3F3N2O", state: "liquid", density: 1.442, temperature: 25, url: chemicalbook("1546-79-8"), reference: "CAS1546-79-8：C5H3F3N2O；液体；密度1.442 g/mL at25 °C（lit.）。" },
  { names: ["Mn", "manganese powder"], formula: "Mn", state: "solid", url: wiki("Manganese"), reference: "元素锰；常温固体，粉末投料。" },
  { names: ["Zn", "zinc powder"], formula: "Zn", state: "solid", url: wiki("Zinc"), reference: "元素锌；常温固体，粉末投料。" },
  { names: ["NaHCO3", "sodium bicarbonate"], formula: "NaHCO3", state: "solid", url: wiki("Sodium_bicarbonate"), reference: "碳酸氢钠：NaHCO3，固体；不用于饱和水溶液的配方计算。" }
];

export function markUserProperty(row: Reagent, property: PropertyKey): void {
  row.valueSource = "user";
  row.userProperties = [...new Set([...(row.userProperties ?? []), property])];
  row.propertySources = [...(row.propertySources ?? []).filter(s => s.property !== property),
    { property, kind: "user", reference: "用户填写的当前物料／批次值", citation: null, url: null, temperatureC: null }];
}

interface Section { text: string; citationAt: (offset: number, quote: string) => Citation }
function sectionsFor(row: Reagent, sources: SourceAsset[]): Section[] {
  if (row.identityModified) return [];
  const label = row.name.trim().match(/^(?:compound\s+)?(\d+[a-z]?)$/i)?.[1];
  if (!label || !row.citations.length) return [];
  const ids = new Set(row.citations.map(c => c.sourceId));
  const sections: Section[] = [];
  for (const source of sources.filter(s => ids.has(s.id))) {
    const starts: { offset: number; page: number }[] = [];
    let text = "";
    for (const page of source.pages) { starts.push({ offset: text.length, page: page.page }); text += `${page.text}\n`; }
    const headings = [...text.matchAll(/^[ \t]*Compounds?[ \t]+([^\n:]+):[ \t]*$/gmi)];
    for (const [index, heading] of headings.entries()) {
      if (heading[1].trim().toLowerCase() !== label.toLowerCase()) continue;
      const start = heading.index!;
      const end = headings[index + 1]?.index ?? Math.min(text.length, start + 12000);
      sections.push({ text: text.slice(start, end), citationAt: (offset, quote) => ({ sourceId: source.id,
        page: starts.filter(p => p.offset <= start + offset).at(-1)!.page, quote }) });
    }
  }
  return sections;
}

export class PropertyResolver {
  private cache = new Map<string, Promise<{ formula: string; mw: number; conversion?: string }>>();
  constructor(private chemistry: Chemistry) {}
  private compute(request: Record<string, unknown>) {
    const key = JSON.stringify(request);
    if (!this.cache.has(key)) this.cache.set(key, this.chemistry.call<{ formula: string; mw: number; conversion?: string }>(request));
    return this.cache.get(key)!;
  }
  async prefill(rows: Reagent[], sources: SourceAsset[], authoritative = false): Promise<{ filled: number; reviews: string[] }> {
    let filled = 0;
    const reviews: string[] = [];
    for (const row of rows) {
      const set = (property: PropertyKey, value: string | number | null, source: Omit<PropertySource, "property">, replace = false) => {
        if (value == null || row[property] != null && !replace || row.userProperties?.includes(property)) return;
        const changed = row[property] !== value;
        (row as unknown as Record<string, unknown>)[property] = value;
        row.propertySources = [...(row.propertySources ?? []).filter(s => s.property !== property), { ...source, property }];
        if (changed) filled++;
      };
      const structural = { kind: "structure" as const, reference: "RDKit：当前SMILES的分子式与平均摩尔质量；不推算密度或形态。", citation: null, url: null, temperatureC: null };
      try {
        if (row.smiles && (authoritative || !row.formula || row.mw === null)) {
          const property = await this.compute({ op: "inspect", smiles: row.smiles });
          set("formula", property.formula, structural, authoritative); set("mw", property.mw, structural, authoritative);
        } else if (row.formula && row.mw === null && row.propertySources?.some(s => s.property === "formula")) {
          const property = await this.compute({ op: "formula_properties", formula: row.formula });
          const origin = row.propertySources.find(s => s.property === "formula")!;
          set("mw", property.mw, { ...origin, reference: `${origin.reference}；RDKit平均原子量求和。` });
        }
        const properties: { formula: string; mw: number; source: Omit<PropertySource, "property"> }[] = [];
        const states: { value: PhysicalState; source: Omit<PropertySource, "property"> }[] = [];
        for (const section of sectionsFor(row, sources)) {
          for (const match of section.text.matchAll(/calcd\s+for\s+((?:[A-Z][a-z]?\d*)+)\s*(\[M\s*[+−–-]\s*(?:H|Na)\]\s*[+−–-])\s*:\s*(\d+\.\d+)/g)) {
            try {
              const property = await this.compute({ op: "formula_properties", formula: match[1], adduct: match[2], mz: Number(match[3]) });
              properties.push({ ...property, source: { kind: "literature", reference: `化合物${row.name}的HRMS分子式经calcd m/z核对（${property.conversion}）；取实际中性分子式${property.formula}，用平均原子量求MW。`, citation: section.citationAt(match.index!, match[0]), url: null, temperatureC: null } });
            } catch (error) { reviews.push(`${row.name}：${String(error)}`); }
          }
          const state = section.text.match(/\bas\s+(?:an?\s+)?(?:(?:white|colorless|colourless|yellow|amorphous|crystalline)\s+)*(solid|powder|oil|liquid)\b/i);
          if (state) states.push({ value: /solid|powder/i.test(state[1]) ? "solid" : "liquid", source: { kind: "literature", reference: `SI报告化合物${row.name}的分离形态；液体密度仍需独立资料。`, citation: section.citationAt(state.index!, state[0]), url: null, temperatureC: null } });
        }
        if (new Set(properties.map(p => p.formula)).size === 1) {
          if (!row.smiles) { set("formula", properties[0].formula, properties[0].source, authoritative); set("mw", properties[0].mw, properties[0].source, authoritative); }
        } else if (properties.length) reviews.push(`${row.name}：不同原文段落的分子式冲突，未自动补入。`);
        const literatureAgrees = !row.smiles || properties.length > 0 && properties.every(p => p.formula === row.formula);
        if (!literatureAgrees && properties.length) reviews.push(`${row.name}：当前结构分子式与文献编号不一致，未沿用原物料形态。`);
        if (literatureAgrees && new Set(states.map(s => s.value)).size === 1) set("physicalState", states[0].value, states[0].source);
        const label = row.name.trim().match(/^(?:compound\s+)?(\d+[a-z]?)$/i)?.[1];
        if (label && literatureAgrees && !row.identityModified && row.physicalState == null) {
          const pattern = new RegExp(`compound\\s+(?:[^\\d\\n]{0,70}\\(\\s*)?${escapeRegex(label)}(?!\\d)(?:\\s*\\([^)]*\\)|\\s*,[^)]*\\))?\\s+as\\s+(?:an?\\s+)?(?:(?:white|colorless|colourless|amorphous|crystalline)\\s+)*(solid|powder|oil|liquid)\\b`, "i");
          for (const source of sources.filter(s => row.citations.some(c => c.sourceId === s.id))) for (const page of source.pages) {
            const match = page.text.match(pattern);
            if (match) set("physicalState", /solid|powder/i.test(match[1]) ? "solid" : "liquid", { kind: "literature", reference: `原文明确绑定化合物${label}的分离形态。`, citation: { sourceId: source.id, page: page.page, quote: match[0] }, url: null, temperatureC: null });
          }
        }
        const entry = catalog.find(e => e.names.some(name => normalized(name) === normalized(row.name)));
        if (entry) {
          const property = await this.compute({ op: "formula_properties", formula: entry.formula });
          const current = row.formula ? await this.compute({ op: "formula_properties", formula: row.formula }) : null;
          const agrees = (!row.identityModified || !!row.smiles && !!entry.smiles) && (!current || current.formula === property.formula);
          if (agrees) {
            const origin = { kind: "catalog" as const, reference: entry.reference, citation: null, url: entry.url, temperatureC: entry.temperature ?? null };
            set("formula", property.formula, origin); set("mw", property.mw, { ...origin, reference: `${entry.reference} MW按RDKit平均原子量求和。` }, authoritative && !row.smiles);
            const graphAgrees = !row.smiles || !!entry.smiles &&
              (await this.chemistry.call<{ smiles: string }>({ op: "inspect", smiles: row.smiles })).smiles ===
              (await this.chemistry.call<{ smiles: string }>({ op: "inspect", smiles: entry.smiles })).smiles;
            if (graphAgrees) {
              set("physicalState", entry.state, origin);
              if (entry.state === "liquid" && row.physicalState === "liquid" && row.concentrationM === null) set("densityGml", entry.density ?? null, origin);
            }
          } else reviews.push(`${row.name}：当前分子式与目录条目不同，未采用目录密度／形态。`);
        }
        if (normalized(row.name) === "thx-bh2") {
          for (const source of sources.filter(s => row.citations.some(c => c.sourceId === s.id))) for (const page of source.pages) {
            const match = page.text.match(/Solution of Thx-BH2 in THF\s*\((\d+(?:\.\d+)?)\s*M\)/i);
            if (match) {
              const origin = { kind: "literature" as const, reference: "原文明确配制的Thx-BH2/THF溶液；只采用标出的有效浓度。", citation: { sourceId: source.id, page: page.page, quote: match[0] }, url: null, temperatureC: null };
              set("physicalState", "solution", origin); set("concentrationM", Number(match[1]), origin);
            }
          }
        }
        if (/\baq\.?\b|水溶液/i.test(row.name)) {
          const c = row.citations.find(c => /\baq\b|水溶液/i.test(c.quote));
          if (c) set("physicalState", "solution", { kind: "literature", reference: "原文水溶液；百分比口径、批次密度和有效浓度待核对。", citation: c, url: null, temperatureC: null });
          const component = row.name.match(/\b(H2O2|NaOH)\b/);
          if (c && component) {
            const property = await this.compute({ op: "formula_properties", formula: component[1] });
            const origin = { kind: "literature" as const, reference: `仅为原文有效组分${component[1]}的分子式和平均MW；不是整瓶水溶液的MW。`, citation: c, url: null, temperatureC: null };
            set("formula", property.formula, origin); set("mw", property.mw, origin);
          }
        }
        if (/^2-\(trifluoroacetoxy\)acetic acid$/i.test(row.name)) {
          const c = row.citations.find(c => /2-\(2,2,2-trifluoroacetoxy\)-acetic acid/.test(c.quote));
          if (c) {
            const property = await this.compute({ op: "inspect", smiles: "O=C(O)COC(=O)C(F)(F)F" });
            const origin = { kind: "literature" as const, reference: "原文系统名称2-(2,2,2-trifluoroacetoxy)-acetic acid对应HOOC-CH2-OCO-CF3；RDKit计算平均MW，不据此推断形态或密度。", citation: c, url: null, temperatureC: null };
            set("formula", property.formula, origin); set("mw", property.mw, origin);
          }
        }
        if (/^(?:EDC|EDCI)$/i.test(row.name) && !row.smiles && !row.formula) reviews.push(`${row.name}：请明确游离碱或盐酸盐；未凭质量/mmol选盐型。`);
        if (row.mw == null) reviews.push(`${row.name}：平均摩尔质量待补。`);
        if (row.physicalState == null) reviews.push(`${row.name}：常温形态待补。`);
        if (row.physicalState === "liquid" && row.densityGml === null) reviews.push(`${row.name}：液体密度待补。`);
      } catch (error) { reviews.push(`${row.name}：${String(error)}`); }
    }
    return { filled, reviews: [...new Set(reviews)] };
  }
}
