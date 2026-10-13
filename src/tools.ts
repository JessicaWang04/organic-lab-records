import Ajv from "ajv";
const string = { type: "string" };
const nullableNumber = { type: ["number", "null"] };
const nullableString = { type: ["string", "null"] };
const array = (items: unknown) => ({ type: "array", items });
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const citation = object({ sourceId: string, page: { type: "integer" }, quote: string });
const propertySource = object({ property: { type: "string", enum: ["formula", "mw", "physicalState", "densityGml", "concentrationM", "purityPercent", "equivalents"] },
  kind: { type: "string", enum: ["structure", "literature", "catalog", "user"] }, reference: string,
  citation: { anyOf: [citation, { type: "null" }] }, url: nullableString, temperatureC: nullableNumber });
const reagent = object({
  id: string, name: string, role: { type: "string", enum: ["substrate", "reagent", "catalyst", "solvent", "product"] },
  smiles: nullableString, mw: nullableNumber, equivalents: nullableNumber,
  referenceAmountMmol: nullableNumber, referenceMassMg: nullableNumber, referenceVolumeMl: nullableNumber,
  concentrationM: nullableNumber, densityGml: nullableNumber, purityPercent: nullableNumber, citations: array(citation),
  formula: nullableString, physicalState: { type: ["string", "null"], enum: ["solid", "liquid", "solution", "gas", null] }, propertySources: array(propertySource)
});
const sourceImage = { anyOf: [object({ sourceId: string, page: { type: "integer" }, bbox: { anyOf: [array({ type: "number" }), { type: "null" }] } }), { type: "null" }] };
const compoundObservation = object({ id: string, label: string, origin: { type: "string", enum: ["starting", "intermediate", "target"] },
  sourceImage: object({ sourceId: string, page: { type: "integer" }, bbox: { anyOf: [array({ type: "number" }), { type: "null" }] } }), citations: array(citation),
  formula: { anyOf: [object({ formula: string, adduct: nullableString, mz: nullableNumber }), { type: "null" }] },
  stereo: object({ scope: { type: "string", enum: ["achiral", "specified", "relative", "unspecified"] }, centers: { type: ["integer", "null"] }, doubleBonds: { type: ["integer", "null"] } }),
  components: { type: ["integer", "null"] }, isomerOf: nullableString, relationship: { type: ["string", "null"], enum: ["epimer", "enantiomer", null] } });
const step = object({
  order: { type: "integer" }, paperStep: string, title: string, purpose: string,
  reactants: array(string), products: array(string), reagents: array(reagent), aboveArrow: array(string), belowArrow: array(string),
  procedure: array(string), workup: array(string), purification: array(string), characterization: array(string), citations: array(citation),
  referenceBasisMmol: nullableNumber, referenceYield: nullableString, yieldScope: nullableString, conflicts: array(string), sourceImage,
  scaleMmol: nullableNumber, scaleBasisId: nullableString
});
const tool = (name: string, description: string, properties: Record<string, unknown>) => ({ type: "function", name, description, strict: true, parameters: object(properties) });
export const TOOLS = [
  tool("validate_plan", "写入前检查来源实验覆盖、目标、化合物绑定、顺序、one-pot口径和物料结构；缺项先修正record_route/bind_steps，再生成文件。此预检不代表完整文件交付。", {}),
  tool("record_inventory", "先保存从本次来源观察到的范围内实验、目标和化合物清单，独立于生成计划；one-pot对应一个实验。含来源局部图、可读引文、原文分子式/HRMS、明确立体中心数量和盐组分；未知事实保留null，不删困难步骤。清单登记后保留原观察。", { inventory: object({ compounds: array(compoundObservation), experiments: array(object({ id: string, paperStep: string, reactants: array(string), products: array(string), handling: { type: "string", enum: ["isolated", "one-pot", "crude-transfer"] }, citations: array(citation) })), targets: array(string) }) }),
  tool("register_compounds", "批量核对候选与来源观察的分子式、明确立体数量、盐组分和差向异构体关系，登记规范化SMILES及平均MW；同一ID不能漂移为另一结构。可一次提交父结构及其异构体。失败时修复候选，不能降低来源约束。", { structures: array(object({ compoundId: string, smiles: string })) }),
  tool("bind_steps", "将计划步骤绑定来源实验和已登记化合物，自动复用登记结构及底物/产物MW，防止编号漂移。每条物料映射含reagentId和compoundId；底物/产物行均须绑定。已写笔记只接受一致结构，不覆盖。", { bindings: array(object({ step: { type: "integer" }, experimentId: string, reagents: array(object({ reagentId: string, compoundId: string })) })) }),
  tool("search_sources", "检索本次全部正文和SI的文本索引。返回来源ID、页码和原文；先按化合物编号或试剂检索，再阅读具体页面，不上传整个SI的全部图谱。", { query: string, limit: { type: "integer" } }),
  tool("read_source_page", "读取已上传来源的具体页面，返回页面文字和真实图像供视觉核对；bbox可指定0到1的[x0,y0,x1,y1]裁剪，null为整页。", { sourceId: string, page: { type: "integer" }, bbox: { anyOf: [array({ type: "number" }), { type: "null" }] } }),
  tool("read_source_pages", "一次读取1至8个独立页面/局部裁剪，复用PDF解码和同一Python进程；返回真实图像，逐图查看。只取本批需要的页，不读取整个SI图谱。", { pages: array(object({ sourceId: string, page: { type: "integer" }, bbox: { anyOf: [array({ type: "number" }), { type: "null" }] } })) }),
  tool("locate_reaction", "按PDF实验小节标题定位紧邻的反应式区域，支持跨页，返回真实页码和bbox。用read_source_page读取该区域并查看图像；定位失败时自行选择局部bbox。此区域仅用于来源核对，不能代替图库反应PNG或CDXML。", { sourceId: string, page: { type: "integer" }, heading: string }),
  tool("record_route", "记录原图/文献观察、用户目的和有序实验步骤。未知数值用null，未知内容用空数组。空结构仅允许暂存计划，不能render/write/finish；必须逐步补齐结构。用户修改走edit_structure。文献当量必须有引用；已写入记录不能覆盖计划。", { plan: object({ title: string, intent: string, requestedChanges: array(string), steps: array(step) }) }),
  tool("inspect_structure", "RDKit解析本次候选结构，返回平均摩尔质量、分子式、原子索引、邻接和CIP。此调用只验证分子图，不证明原图识别正确。", { smiles: string }),
  tool("inspect_structures", "同一Python进程批量解析1至64个候选，返回规范结构、分子式、平均MW和明确CIP/双键构型摘要。登记时register_compounds已包含这些检查，无需重复调用；具体位点编辑仍用inspect_structure查看原子索引。", { smiles: array(string) }),
  tool("set_step_structures", "为尚未写入记录的一步补齐从来源局部图核对的反应物与产物SMILES，解析成功后更新计划并使旧绘图失效。保留其他步骤；物料表SMILES必须已与对应结构一致，物料修订可在写入前record_route。不可用占位结构绕过来源核对。", { step: { type: "integer" }, reactants: array(string), products: array(string) }),
  tool("lookup_reagent", "补全某一步物料的可核对性质：SMILES平均MW、本次PDF同编号化合物的HRMS分子式核对、常温形态、已核对常用试剂目录密度。只填空缺并附来源；不猜复杂底物密度、配方或EDCI盐型。", { step: { type: "integer" }, reagentId: string }),
  tool("edit_structure", "在已记录路线的某一步指定试剂/底物上执行本地编辑，返回权威before/after。add_para_methoxy按唯一卤素及芳环定位；add_group需要inspect返回的atomIndex；replace_atom指定element。其余字段填null。后续不同结构需要分别核对调用，不自动预测反应。", {
    step: { type: "integer" }, reagentId: string, operation: { type: "string", enum: ["add_para_methoxy", "add_group", "replace_atom"] },
    anchorElement: nullableString, atomIndex: { type: ["integer", "null"] }, group: nullableString, element: nullableString
  }),
  tool("set_scale", "将用户明确的mmol绑定本步具体底物。仅操作指定步，不使用文献产率推算后续投料；修改后图会重新计算MW。", { step: { type: "integer" }, reagentId: string, amountMmol: { type: "number" } }),
  tool("render_step", "生成某一步紧裁剪的单反应PNG和含原生原子/键的可编辑CDXML，校验结构和立体读回。反应物或产物结构缺失时失败，来源图片不作降级交付。缓存复用仍验证真实文件。", { step: { type: "integer" } }),
  tool("write_step", "保存已经绘图的单步实验草稿Markdown，包含正文/YAML图片、CDXML链接、计量、参考procedure、留空实际现象与表征区。引用硬错误不能保存。同一已创建步骤返回已有路径，不重复创建。", { step: { type: "integer" } }),
  tool("materialize_steps", "为1至8个不同步骤生成PNG/CDXML并写入笔记。结构登记与绑定完成后使用；每步内部先render再write，不同步修改计划。最多2个独立步骤并发；返回逐步成功/失败，失败步骤不会算完成。重试只选择失败步骤；不能在执行时编辑结构或规模。", { steps: array({ type: "integer" }) }),
  tool("ask_user", "缺少会改变结构或计量的用户选择时提出具体问题，用户回答作为本次原生工具回执继续；图片一般核对项与未知procedure可留在草稿。不要与其他调用并行请求。", { question: string }),
  tool("validate_route", "重新读取实际文件，逐步验收紧裁剪反应PNG、原生可编辑CDXML、结构/立体读回及笔记链接；返回真实数量和缺项。在已完成路线也可调用；没有放宽验收的参数。", {}),
  tool("finish_route", "所有步骤必须通过真实反应PNG、非空可编辑CDXML及笔记链接验收，才保存路线主页和图库并标完成。待确认结构、整页PDF、位图CDXML、伪造质量标记均不能通过。", {})
];
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
const validators = new Map(TOOLS.map(tool => [tool.name, ajv.compile(tool.parameters)]));
export function validateToolCall(name: string, argumentsValue: unknown): void {
  const validate = validators.get(name);
  if (!validate) throw new Error(`unknown_tool: ${name}`);
  if (!validate(argumentsValue)) throw new Error(`tool_arguments_invalid: ${JSON.stringify(validate.errors?.map(e => ({ path: e.instancePath, message: e.message, details: e.params })))}`);
}
