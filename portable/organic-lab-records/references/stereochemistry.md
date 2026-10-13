# 立体化学逐项核对

1. 对每个明确四面体中心记录邻接、楔线/虚线指向、隐氢；双键是否明确E/Z。桥头、环并合、同位素中心不可漏。约束数量指明确指定中心，不是所有潜在中心。
2. 不比较SMILES的@/@@字符判同构型，邻接顺序变会改字符。用规范图和对应CIP/邻接比较。转化保留构型但优先序变化可使R变S，不据此说差向异构化。
3. specified时centers/doubleBonds不可null；achiral/unspecified候选不能补明确立体。仅真实未报告可用unspecified。相对构型scope=relative，步骤标relative configuration; absolute configuration not assigned。当前输出代表性楔线，不证明绝对归属；需要ChemDraw增强立体分组时另检该编码。
4. epimer需同连接、同位素、盐型，至少2个明确中心且映射后仅1个翻转。enantiomer需所有明确中心翻转。只有1个中心的两结构是对映体。E/Z变化、缺楔线、换盐/保护基不能算epimer。
5. 父结构先登记或同批。对称映射不唯一时逐位查证，不改关系绕错误。数量/关系检查不证明原文的具体位置仍须源图逐位比较。
6. 原生CDXML读回与isomeric结构比较。丢楔线、改键级、少组分或嵌入图片会拒绝。用户编辑结构保留本地回执，不能冒称文献原结构。
