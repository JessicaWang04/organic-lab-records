# 快速定位与结构候选（可选）

拆开在哪里与是什么：文本PDF按编号/标题检索、locate_reaction定位；扫描可接版面检测/OCR；局部单结构识别产SMILES、原子/键、confidence及bbox；宿主比较源图/回绘，再register_compounds。识别输出只作候选，不绕清单/验收。

原作者项目：[DocLayout-YOLO](https://github.com/opendatalab/DocLayout-YOLO)文档区域检测；[MolScribe](https://github.com/thomas0809/MolScribe)分子图到结构；[RxnScribe](https://github.com/thomas0809/RxnScribe)反应图解析。依赖、许可及权重按项目当前说明。技能包不自动下载模型或上传论文。

候选记录为compoundId、sourceId、page、bbox、smiles、confidence、provider。ID由来源清单决定，将compoundId/smiles交登记，其余保留做复查。局部识别不能丢盐或只识主骨架。

截断→重定位；缩写→查定义；式不符→查漏原子/保护基/盐；立体数不符→查楔线/隐氢/EZ；epimer不符→父子逐位比较。优先只重读失败局部。高confidence也不能覆盖化学错误。

接入前评测原生/扫描、单结构/反应、桥环、保护基、盐、EZ及多差向异构体，分别报告定位召回、连接准确率、完整立体准确率、漏步、文件通过率和总耗时。可重放示例验证harness，不是识别模型benchmark。
