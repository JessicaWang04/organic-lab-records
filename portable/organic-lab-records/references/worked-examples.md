# 完整可重放示例

示例是明确标记的合成测试材料，不是真实论文、实验建议或结构识别模型benchmark。固定候选与来源断言用来检验流程、失败门禁和实际文件。每次运行生成独立正文/SI PDF、来源清单、真实PNG/CDXML、逐步Markdown、主页/gallery、状态与验收报告。没有模型API调用。

在已setup的包根目录运行：`python scripts/replay_examples.py --output <新的绝对目录>`。默认两个案例全跑，输出目录必须尚不存在，避免覆盖笔记。Python应是doctor通过的解释器。重放脚本自动准备请求文件，普通用户仍只用`/lab <文献>`。

## 案例一：直线路线

A ethanol→B acetaldehyde→C acetic acid→D ethyl acetate，3个独立来源实验，4个登记身份，1个目标。原投料在fixture明确时保留参考量；实际scale和实际操作栏全空。源清单与计划独立，结构一次登记，bind后先预检再生成。

## 案例二：共享中间体与异构体分支

A两中心底物→B粗品共享中间体；B→P0为one-pot两操作阶段；B→P1为独立替代分支。P1与P0为单中心翻转的epimer，两个目标独立ID。3个来源实验对应3个记录，one-pot不能变成两个实验，粗品不造独立产率/纯度。

## 已生成样例

[完整示例库](../assets/examples/expected/README.md)包含两条路线全部6步实际笔记、PNG/CDXML和自有测试来源；以expected目录为Obsidian库根可查看。可重放脚本会在新的绝对目录重新生成，避免覆盖静态示例。

## 真实工具序列与文件

init→record_inventory→register_compounds→record_route→bind_steps→validate_plan→materialize_steps→validate_route→finish_route。脚本逐次保存UTF-8请求、回执和完整来源，report.json列每步文件哈希、原生验收数量和失败演示结果。

```
<output>/<case>/
  sources/main.pdf, si.pdf
  requests/                 # 本次真正使用的工具请求
  vault/Organic Lab/<case>/
    来源清单、会话状态、运行日志
    assets/                 # 3组紧裁PNG、原生CDXML、质量信息
    3个单步实验Markdown
    路线.md、路线.base
  report.json
```

错误候选演示：式不符、丢立体、把epimer写成同构型均必须失败，修复候选后重新登记。源清单故意包含计划遗漏的实验时预检必须失败；补回计划后才能生成。完成后替换PNG且伪造quality标记，旧finish回执仍须拒绝；恢复真实原件后实时验收通过。

测试报告不能代表真实SI已被模型完整识别。要比较Qwen/DeepSeek或局部识别器，另用recognition专题的真实标注评测集，报告连接及完整立体正确率和总耗时。
