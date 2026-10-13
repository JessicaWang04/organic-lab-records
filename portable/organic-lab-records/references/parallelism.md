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
