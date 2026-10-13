# 流程设计与参考

本版参考[nature-skills](https://github.com/Yuan1z0825/nature-skills)的组织方式：短入口、manifest、始终加载核心、按来源及任务加载专题、明确输出合同、渲染后验收。尤其参考其[nature-reader入口](https://github.com/Yuan1z0825/nature-skills/blob/main/skills/nature-reader/SKILL.md)与[nature-figure QA合同](https://github.com/Yuan1z0825/nature-skills/blob/main/skills/nature-figure/references/qa-contract.md)。本包的化学规则、接口及实现独立编写，没有复制该项目代码或原文规程。

## 阶段与职责

```
获取/索引 → 来源清单 → 化合物核对登记
                         ↓
实验文字提取 → 路线计划 → 绑定/预检 → 批量生成 → 实际文件验收 → 主页/图库
```

来源清单与生成计划分开，防止只检验模型自己挑选出的步骤。化合物登记后复用并保持身份；epimer独立ID。候选失败不变更登记，来源约束不可静默降低。预检发生在任何实验笔记写入前，允许补回漏步后重新绑定。已写用户记录保留，新修改走独立路线。

自动检查不是化学真值证明。规范图、分子式、立体数量及异构关系都一致仍可能识别错位置；覆盖来源清单也不能证明清单完整代表论文。报告区分原生交付检查、来源视觉核对及真实模型评测。

## 提速

portable guide并发读取必要内容并携带hash；contracts仅输出本阶段schema。核心不可省。OpenCode等宿主可按层加载；Obsidian工作台缺少宿主文件读取工具，嵌入必要专业规程，不声称它已采用相同上下文裁剪。

read_source_pages把≤8次页面读取合到一次Python进程，同一来源只解码一次；inspect_structures和register_compounds批量核对。materialize_steps每批≤8步，内部最多2步并行，单步render/write顺序固定，返回按输入顺序逐项结果。一个路线写入者持有锁；plan/scale/edit/finish不并行。成功文件与用户笔记不覆写。

## Jev类判断与局部识别

可选判断器只选择有限sourceFormat/topics、页面优先级或修复类型；确定规则由代码执行，判断器无完成权限。来源类型不确定时保留多层规则，错误候选进入具体局部复查。

定位/识别用独立候选接口；布局检测→局部裁图→MolScribe/RxnScribe等候选→宿主核对→register_compounds。此版只提供接口口径与流程，不自动装外部权重、调用第三方识别服务，未声称完成这些模型的真实SI准确率评测。微基准测进程开销，不能推算论文端到端加速。

## 完整示例与持续验收

脚本重建两套自有合成正文/SI，实际调用发布CLI，产出6份完整记录及PNG/CDXML，演示错误候选、漏步骤预检、损坏PNG/旧finish回执拒绝及恢复。代码仓库CI执行相同重放。示例只用于工具与文件检查，不是真实论文、可执行实验方案或OCR benchmark。
