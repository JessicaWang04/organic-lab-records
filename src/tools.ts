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
const step = object({
  order: { type: "integer" }, paperStep: string, title: string, purpose: string,
  reactants: array(string), products: array(string), reagents: array(reagent), aboveArrow: array(string), belowArrow: array(string),
  procedure: array(string), workup: array(string), purification: array(string), characterization: array(string), citations: array(citation),
  referenceBasisMmol: nullableNumber, referenceYield: nullableString, yieldScope: nullableString, conflicts: array(string), sourceImage,
  scaleMmol: nullableNumber, scaleBasisId: nullableString
});
const tool = (name: string, description: string, properties: Record<string, unknown>) => ({ type: "function", name, description, strict: true, parameters: object(properties) });
export const TOOLS = [
  tool("search_sources", "检索本次全部正文和SI的文本索引。返回来源ID、页码和原文；先按化合物编号或试剂检索，再阅读具体页面，不上传整个SI的全部图谱。", { query: string, limit: { type: "integer" } }),
  tool("read_source_page", "读取已上传来源的具体页面，返回页面文字和真实图像供视觉核对；bbox可指定0到1的[x0,y0,x1,y1]裁剪，null为整页。", { sourceId: string, page: { type: "integer" }, bbox: { anyOf: [array({ type: "number" }), { type: "null" }] } }),
  tool("record_route", "记录原图/文献观察、用户目的和有序实验步骤。所有未知值用null/空数组。结构先记录原始观察，用户修改走edit_structure。缺少可核对SMILES可留空结构数组，并指定sourceImage。任何文献当量必须有引用；已有实验已写入后不能覆盖计划。", { plan: object({ title: string, intent: string, requestedChanges: array(string), steps: array(step) }) }),
  tool("inspect_structure", "RDKit解析本次候选结构，返回平均摩尔质量、分子式、原子索引、邻接和CIP。此调用只验证分子图，不证明原图识别正确。", { smiles: string }),
  tool("lookup_reagent", "补全某一步物料的可核对性质：SMILES平均MW、本次PDF同编号化合物的HRMS分子式核对、常温形态、已核对常用试剂目录密度。只填空缺并附来源；不猜复杂底物密度、配方或EDCI盐型。", { step: { type: "integer" }, reagentId: string }),
  tool("edit_structure", "在已记录路线的某一步指定试剂/底物上执行本地编辑，返回权威before/after。add_para_methoxy按唯一卤素及芳环定位；add_group需要inspect返回的atomIndex；replace_atom指定element。其余字段填null。后续不同结构需要分别核对调用，不自动预测反应。", {
    step: { type: "integer" }, reagentId: string, operation: { type: "string", enum: ["add_para_methoxy", "add_group", "replace_atom"] },
    anchorElement: nullableString, atomIndex: { type: ["integer", "null"] }, group: nullableString, element: nullableString
  }),
  tool("set_scale", "将用户明确的mmol绑定本步具体底物。仅操作指定步，不使用文献产率推算后续投料；修改后图会重新计算MW。", { step: { type: "integer" }, reagentId: string, amountMmol: { type: "number" } }),
  tool("render_step", "真实生成某步反应图片和可编辑CDXML，校验图结构与立体读回。结构未知时仅裁剪sourceImage并标待核对，CDXML为null。返回真实文件引用、MW和质量报告。", { step: { type: "integer" } }),
  tool("write_step", "保存已经绘图的单步实验草稿Markdown，包含正文/YAML图片、CDXML链接、计量、参考procedure、留空实际现象与表征区。引用硬错误不能保存。同一已创建步骤返回已有路径，不重复创建。", { step: { type: "integer" } }),
  tool("ask_user", "缺少会改变结构或计量的用户选择时提出具体问题，用户回答作为本次原生工具回执继续；图片一般核对项与未知procedure可留在草稿。不要与其他调用并行请求。", { question: string }),
  tool("finish_route", "检查各步骤已生成、图片与图谱链接、文件顺序和质量产物，保存路线主页、Bases图库和真实Log；全部检查成功才结束。", {})
];
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
const validators = new Map(TOOLS.map(tool => [tool.name, ajv.compile(tool.parameters)]));
export function validateToolCall(name: string, argumentsValue: unknown): void {
  const validate = validators.get(name);
  if (!validate) throw new Error(`unknown_tool: ${name}`);
  if (!validate(argumentsValue)) throw new Error(`tool_arguments_invalid: ${JSON.stringify(validate.errors?.map(e => ({ path: e.instancePath, message: e.message, details: e.params })))}`);
}
