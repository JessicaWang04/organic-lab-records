# 本地批量解析微基准

2026-10-13，Windows 11、Python 3.13.0，RDKit本地处理4个固定结构，3轮交替先后顺序。比较真实规范结构/式/MW一致后才记录时间。

| 模式 | Python进程/轮 | 中位耗时 |
| --- | --- | --- |
| 逐个inspect | 4 | 2.193 s |
| inspect_structures批量 | 1 | 0.546 s |

本机本次约4.02倍，主要减少进程启动。命令：`python tools/validation/benchmark_batches.py --output benchmark.json`；[原始数据](PERFORMANCE-0.2.0.json)。

这是微基准，不含下载、版面识别、模型读图、复杂立体识别或整篇路线任务，不能据此承诺端到端4倍。真实模型比较应固定论文/裁剪/标注，分别记录定位、完整立体识别、人工纠错及总耗时。
