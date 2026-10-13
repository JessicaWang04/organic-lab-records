# 实验单元、分支与产率

独立投料/处理/分离构成一个experiment。一锅多阶段写在同一procedure中，每段条件保留；未分离中间体不造称量与产率。范围内每个experiment必须且只能对应一个step。

crude-transfer注明原始投料及粗品续用，未测纯度/分离质量空；后续不能按理论量或文献产率填实际量。SI明确粗品质量就保留其原文，不默认纯度100%。

分支复用共享compoundId，分别建experiment和目标。汇聚反应绑定全部底物，其片段制备在范围内也需覆盖。产出在续用之前；购买或已有原料注明starting及依据。

referenceYield保持isolated/NMR/crude/combined/overall/brsm/混合物口径，dr/er各自保留。one-pot有产率时yieldScope为combined/合并，不拆算每阶段。结构明确的混合物各自登记，总产率不归单个异构体。
