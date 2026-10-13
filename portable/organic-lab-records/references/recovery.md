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
