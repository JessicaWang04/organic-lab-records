---
name: experiment-records
description: 图文来源、化合物登记及原生结构验收的逐步有机实验草稿
metadata:
  version: "2.0.0"
---

使用中文。你能调用本地工具，但不能要求用户填写工具JSON或为整理提供实际规模。完整主路线默认全做；用户明确全部目标则含所有分支。以下为Obsidian模型上下文的核心与专业规则。便携宿主另按manifest渐进加载，不需要装入所有专题。

# 核心流程（始终加载）

## 1. 建立可追溯的来源

保存正文与 SI 原文件，记录 DOI、标题、下载地址和实际页数。页码统一为文件中的 1-based PDF 页，不把印刷 S 页码当工具页码。检索编号与实验标题后阅读邻近段落和局部图；read_source_pages每批最多8个裁剪，返回的每张imageFile必须实际查看。整页可用于阅读布局，图库只使用本地渲染的单反应PNG。

目标已明确就直接做，不为了开始要求用户提供规模。完整主路线包括制备关键片段、汇聚偶联及最终转化；全部目标的共享步骤只建一次，分支各有独立实验。机理、过渡态、晶体展示不是实验步骤。排除某段必须说明范围依据，不能因为结构难而删步。

## 2. 来源清单先于生成计划

用record_inventory保存由正文/SI观察得到的compounds、experiments、targets。每个化合物用稳定唯一ID（如c17、c17_epi），保留原编号label、origin、局部sourceImage、短引、来源分子式/HRMS、明确立体中心及E/Z数量、盐组分。未知只在来源确实未报告时留null；不要抹去清楚的楔线或已给分子式。

实验ID独立于顺序，记录paperStep、反应物/产物化合物ID、isolated/one-pot/crude-transfer和来源。one-pot的操作阶段写在同一实验中；分离过的中间体对应独立实验。targets列出全部请求目标。清单不可用生成计划倒推，观察登记后不能偷偷缩小约束。

## 3. 结构立即开始

清单确定后，与实验文字提取独立处理候选结构，不等所有笔记写完。按连接、环并合、保护基、盐型、同位素、楔线/E/Z核对；同编号在其他图或表征中交叉查证。不同候选可用inspect_structures一次检查；直接register_compounds时无需重复inspect。按批提交候选，父结构和其差向异构体可同批提交。失败时修候选或找更清楚来源，不降低来源约束。

## 4. 计划、绑定、预检

record_route存有序步骤、全文献用量、操作、后处理、纯化、表征和引用。原文没有的用null/空数组，问题写conflicts。文献投料与实际投料分开，scaleMmol默认null；文献产率不得推出后续实际投料。

bind_steps将每步绑定原实验，底物/产物行绑定compoundId；工具复用登记结构、分子式、平均MW。单一底物/产物可自动绑定，缺行可补齐但未知数量仍空。多物料明确逐行映射。结构修改仅按用户意图走inspect_structure/edit_structure；不预测后续反应。

**写文件之前运行validate_plan。** ready=false时先修record_route或bind_steps，再预检；已写笔记不能被计划替换。预检检查覆盖、顺序、绑定、口径和化合物一致性，不代表文件验收。纠正已登记的来源转录错误时保留旧路线，新建校正路线并标明更正；不可借“纠正”减少步骤或抹掉来源事实。

## 5. 生成和闭环

预检通过后，按最多8步调用materialize_steps；内部最多2步并行，每步按render→write顺序。逐条检查results，partial时只修复并重试失败步。需要精细修改时按单步render_step/write_step。

最后validate_route检查实际文件、全部来源实验和结构，再finish_route创建主页及gallery。完整成功后给真实库、路线和实验路径。失败保存状态，加载recovery继续；不得改回执、伪造quality标记、写空CDXML或用PDF整页顶替反应图。实际操作、现象、实测产率、图谱待用户填写。


# 化学核对总则（始终加载）

RDKit能解析仅证明分子图合法。识别完成需要候选回绘图与局部源图并排核对：连接、异原子位置、键级、环大小及桥环、取代位置、官能团、保护基、立体及盐组分。保留来源页/bbox和短引。机器文件验收与原图识别准确性分开报告。

每个文献编号绑定稳定compoundId。同一中间体复用登记结构；差向异构体、不同保护基、游离碱与盐使用不同身份。同一ID改成另一canonical isomeric SMILES会被拒绝。同一图的不同SMILES写法规范化后可以相同，原子映射编号不作为身份。

不可用名称猜复杂骨架，不把Ph、Bn、Boc、Cbz、Ts、OTf、R、波浪键当元素。展开明确缩写并对照式；R未定义时查正文、图注、表格和SI。真实多组分结构点连接保留，不得删除反离子让图更干净。

逐一登记来源明确中心和E/Z数量，楔线/虚线核对连接、方向、隐氢。来源构型清楚不能声明unspecified绕检查。未给绝对构型不能补造R/S；仅相对构型注明relative，代表性楔线不宣称绝对归属。差向异构体分别登记并声明与父结构关系。详见stereo专题。

来源式逐字保留在短引中。HRMS离子式及calcd m/z先核对加合物，再比较中性结构；[M+H]+、[M-H]-、[M+Na]+以外不自动换算。不能把m/z填平均MW。相同分子式不能证明连接/立体相同。

MW按实际投料形态计算。盐、溶剂化物、溶液、配方先分清有效物与称量物组成。明确盐型不得省略；未知浓度、密度、纯度留空。结构变更后旧物性失效。底物/产物表的结构、式和平均MW必须一致。

保留原文温度、时间、次序、气氛、后处理、纯化、产率口径和表征。不能把usual workup扩成具体体积。粗品续用不造分离质量/产率，one-pot不造每阶段产率。冲突分别保存，不取平均。机理图不当制备。详见one-pot、quantities、conflicts专题。

harness检查来源清单覆盖、登记身份、明确立体数量、声明差向/对映关系、式/加合物、盐组分、物料绑定、PNG/CDXML内容和笔记链接。它不能据此证明模型抄对所有来源原子或完整盘点文章。局部源图仍须视觉核对。人工review项不能替代机器必需文件，自报核对不能说成机器证明。


# 立体化学逐项核对

1. 对每个明确四面体中心记录邻接、楔线/虚线指向、隐氢；双键是否明确E/Z。桥头、环并合、同位素中心不可漏。约束数量指明确指定中心，不是所有潜在中心。
2. 不比较SMILES的@/@@字符判同构型，邻接顺序变会改字符。用规范图和对应CIP/邻接比较。转化保留构型但优先序变化可使R变S，不据此说差向异构化。
3. specified时centers/doubleBonds不可null；achiral/unspecified候选不能补明确立体。仅真实未报告可用unspecified。相对构型scope=relative，步骤标relative configuration; absolute configuration not assigned。当前输出代表性楔线，不证明绝对归属；需要ChemDraw增强立体分组时另检该编码。
4. epimer需同连接、同位素、盐型，至少2个明确中心且映射后仅1个翻转。enantiomer需所有明确中心翻转。只有1个中心的两结构是对映体。E/Z变化、缺楔线、换盐/保护基不能算epimer。
5. 父结构先登记或同批。对称映射不唯一时逐位查证，不改关系绕错误。数量/关系检查不证明原文的具体位置仍须源图逐位比较。
6. 原生CDXML读回与isomeric结构比较。丢楔线、改键级、少组分或嵌入图片会拒绝。用户编辑结构保留本地回执，不能冒称文献原结构。


# 盐、保护基、组分与HRMS

游离胺/盐酸盐分开。明确水合物/溶剂化物保留；EDCI未注明盐型不默认EDCI·HCl。盐图见2组分则components=2，点连接数必须一致。配方试剂不造伪单分子，保存原名称及有依据的活性含量。

缩写展开核对连接端：OBn与Bn、OTs与Ts、OAc与C-acetyl不同。芳环位置按邻接，不凭印象。R未定义查图注/表格。来源式保留在短引中。

HRMS保存原公式、adduct和calcd m/z。支持[M+H]+、[M-H]-、[M+Na]+，精确质量核对式为离子还是中性再还原；found不替代calcd。超容差、其他加合物、同位素需独立分析，不静默删掉明确式。

平均MW用于计量，m/z和exactMass不可填MW。浓度mol/L，密度g/ml且有温度与来源；复杂底物无密度依据留空。结构变化后不复用旧物性。


# 实验单元、分支与产率

独立投料/处理/分离构成一个experiment。一锅多阶段写在同一procedure中，每段条件保留；未分离中间体不造称量与产率。范围内每个experiment必须且只能对应一个step。

crude-transfer注明原始投料及粗品续用，未测纯度/分离质量空；后续不能按理论量或文献产率填实际量。SI明确粗品质量就保留其原文，不默认纯度100%。

分支复用共享compoundId，分别建experiment和目标。汇聚反应绑定全部底物，其片段制备在范围内也需覆盖。产出在续用之前；购买或已有原料注明starting及依据。

referenceYield保持isolated/NMR/crude/combined/overall/brsm/混合物口径，dr/er各自保留。one-pot有产率时yieldScope为combined/合并，不拆算每阶段。结构明确的混合物各自登记，总产率不归单个异构体。


# 投料、当量与规模

原文分别保存mg、mmol、ml、M、eq与referenceBasisMmol。可复算：mg=mmol×平均MW；溶液ml=mmol/M；纯液体ml=mg/(1000×密度g/ml)。只有明确形态与含量才用于换算。

质量/mmol冲突保留两值写conflicts，查盐型、单位、纯度、笔误。催化mol%转换eq注明原始基准；多底物不默认都1eq。非空eq/投料附对应引文，物性附属性来源。

未给实际规模则scaleMmol和scaleBasisId均null，不追问才能开始。不用文献产率推下步实际投料。首步规模只绑定首步底物；理论计算不写作实测。修结构同时修式/MW，旧密度、浓度、形态等失效。


# 冲突处理

建立字段—出处—原文—差异列表，原文并存、不平均。确认版本、页码、Scheme编号复用、单位与离子式。图提供结构，实验段提供操作，HRMS提供式；具体矛盾不按无条件权威排序消除。

图/文字保护基不同、结构衔接不符：重读同编号其他页和表征，不按期望反应补造产物。投料/温度冲突明确两值待核对。关键结构无唯一判断时继续查证，不用占位SMILES完成。

观察清单登记后不可静默改。转录纠正确认后保留旧会话，在校正路线写旧/新证据，不能借更正缩范围。用户实际记录不覆盖。问题写具体编号、页、失败规则与下一动作，不泛写结构复杂。


# 失败修复手册

先读错误回执和status，保留已成功文件与用户笔记。恢复同一调用沿用callId和完全相同参数；改变任何参数必须新callId。失败回执不是成功，旧completed回执仍会重读实际文件验收。不要删状态重跑整篇、不改quality.json旗标、不手写空文件补数量。

| 错误/现象 | 排查与修复 | 不能采用 |
| --- | --- | --- |
| dependencies_missing | doctor定位缺RDKit/Pillow/PyMuPDF或Python路径，按setup修环境后重试原调用 | 跳过native验收 |
| PDF打不开/下载是HTML | 检查真实链接、签名、版本，重新下载可访问原文件 | 改后缀冒充PDF |
| locate未命中/裁图截断 | 看标题变体及前后页，手选完整局部bbox，再read_source_pages实际看图 | gallery放整页 |
| compound_formula_mismatch | 核对离子/中性式、calcd m/z、漏原子/保护基/盐，修候选新callId | 将明确formula置null |
| compound_stereo_mismatch | 数楔线/虚线/EZ，查隐氢和桥头，修候选 | scope改unspecified或计数改0 |
| compound_component_mismatch | 查反离子、水合物和实投形态，补真实点连接组分 | 删除盐组分约束 |
| isomer_parent_missing | 父结构先登记或与异构体同批 | 用同一ID覆盖 |
| isomer_relationship_mismatch/ambiguous | 同连接原子映射逐位核对，纠正候选并查具体构型位点 | 抹掉真实epimer关系 |
| compound_identity_conflict | 查是否复用了编号；不同异构体用独立源ID。登记事实有转录错误则保留旧路线并新建校正路线 | 修改既有登记身份 |
| missing_experiment/duplicate_experiment | 对源清单逐实验补漏或合并重复，写入前record_route重存并重新bind | 从inventory删难步骤 |
| step_unbound/reagent_binding_missing | bind_steps指定experimentId和每个底物/产物row ID映射 | 用无来源SMILES填表 |
| route_order_conflict | 先片段制备再汇聚/续用，保留所有来源实验 | 将中间体改starting绕顺序 |
| bound_structure/reagent_*_mismatch | 回到登记身份、物料式/MW和编辑回执，重新绑定未写步；检查用户修改范围 | 只改图片或旧质量标记 |
| editable_artifacts_missing/structure_missing | 完成局部识别→登记→绑定→render，不跳CDXML | 占位SMILES/空XML/嵌图 |
| cdxml_graph/stereo错误 | 先查候选及回绘，核对生成器/读回，保留错误文件供诊断 | 取消roundtrip |
| PNG不匹配/文件遭改 | status指出具体步，保留用户修改；新路线重建或恢复已核对原件，再验真实字节 | 复用旧finish成功 |
| existing_record_conflict/records_exist | 保留原记录与手写内容，新路线记录修改原因 | 覆盖或删实际记录 |
| session_busy | 另一个调用结束后重试；确认原PID已退出才清理该路线锁文件 | 同时多个写入者 |
| materialize_steps partial | 按results修失败步骤，新callId只重试这些步；validate_route复查全路线 | 因一个失败重生成全部 |
| call_id_conflict | 保留历史，新参数用新ID | 强改原回执 |

修复顺序：来源/环境→观察→候选结构→绑定/计划→文件→总验收。来源事实不可降低；如果规则确实揭示转录错误，校正路线附原/新证据。反复失败必须说明编号、页、已试动作、还缺什么，保存可恢复状态，不能写“整理完成，CDXML后补”。


# 分层、批量与并行

先索引再只读实验/路线页，不逐页上传SI。核心始终加载，专题按manifest，哈希未变复用。contracts按当前阶段筛选，避免反复加载全部合同。

| 工作 | 批量或并行 | 依赖 |
| --- | --- | --- |
| 正文/SI获取 | 宿主可并发独立来源 | 入库前验真实文件 |
| 读图/候选解析 | read_source_pages≤8；inspect_structures≤64，同一进程 | 每个局部实际查看 |
| 操作文字与结构候选 | 输入固定可独立提取 | 一个协调者合并清单/计划 |
| 化合物登记 | register_compounds批量，复用中间体 | 父先子后或同批 |
| 不同步骤文件 | materialize_steps≤8，内部并发≤2 | 计划冻结，每步render先write |
| plan/scale/edit/finish | 一个写入者顺序执行 | 锁与真实回执 |

不要启动多个CLI同时改同一路线。partial逐项检查，成功项保留，仅新callId重跑失败steps。旧批次回执保持历史，用status/validate_route看实时状态。

Jev类有界判断器可做来源类型、页优先级、专题、修复分流；输出只选有限枚举，不更改范围、不生成SMILES、不宣布验收。确定规则用代码，confidence仅排序。候选识别见recognition。

计时分下载、索引/定位、模型读图、核对、文件和验收。微基准仅证明进程/调用开销，不能当整篇天然产物路线速度或Qwen/DeepSeek准确率。


# 交付验收与修复

默认任务必须覆盖文章主路线，以及用户明确指定的全部目标和分支。先用record_inventory保存独立的化合物编号—来源实验—目标清单，再register_compounds核对身份、bind_steps绑定每步，保留 one-pot、粗品续用与合并产率口径；不能删除困难步骤来提高完成率。

每一步必须同时满足以下规则；模型没有 `allowIncomplete` 或降低验收的开关。

| 交付物 | 原生工具验收 |
|---|---|
| 图库 PNG | 本步结构和条件渲染的单反应图，按实际内容紧裁剪，四边保留 20 px；不得使用整页 PDF、来源截图或无关图片 |
| 可编辑 CDXML | 非空，含原生分子片段、原子、键、反应箭头和条件；分别读回反应物/产物，核对连接与立体；不能嵌入位图代替分子图 |
| 实验笔记 | YAML 与正文同时链接同一本步 PNG 和 CDXML，路线与步骤编号匹配，引用无硬错误 |
| 完成状态 | `finish_route` 重读实际文件全部验收通过后才标记 completed；质量 JSON 的通过标记与旧回执不作为验收证据 |

`read_source_page` 可读取整页用于找实验信息。结构核对时用 `locate_reaction` 的标题定位或手选 bbox，读取并查看局部图；定位器失败不代表可放弃，转用局部 bbox 或其他出现页。图库图片只由 `render_step` 输出。

修复顺序：

1. `validate_route` 列出具体步骤、错误和真实通过数量。
2. 缺结构：按来源清单修候选、register_compounds、bind_steps、validate_plan；查看清晰局部图、核对保护基/盐型/楔线/分子式，以 `inspect_structure` 检查候选，再 `set_step_structures` 更新尚未写入的步骤；多物料时检查物料表对应结构，必要时在写笔记前更新计划。
3. 依次 `render_step`、`write_step`；再次验收后 `finish_route`。
4. 已写笔记、已有图片或 CDXML 被用户改动时保留原文件。结构修订需要新路线；不得覆盖实际实验记录来消除验收错误。

缺项属于未完成任务。预算停止或来源不可读时报告具体步骤、已尝试的证据路径和缺少内容，保留会话；不能用通用“尚待确认”替代必需交付，也不能填入简单分子或擅自去掉立体信息来通过解析。

文件验收证明内容完整且导出保持输入结构。它不能独自证明输入 SMILES 与论文图像一致；宿主仍须逐项比较来源图，不能把读回通过表述为来源识别准确率通过。目标软件 ChemDraw 的打开/编辑验收另行记录。

0.2.0全路线验收还核对范围内来源实验恰好一次映射、目标及中间体顺序、原生化合物分子式/盐/明确立体/异构关系和物料结构/平均MW。validate_plan应在写笔记前排除覆盖错误。详细错误恢复见[recovery](recovery.md)。
