# 投料、当量与规模

原文分别保存mg、mmol、ml、M、eq与referenceBasisMmol。可复算：mg=mmol×平均MW；溶液ml=mmol/M；纯液体ml=mg/(1000×密度g/ml)。只有明确形态与含量才用于换算。

质量/mmol冲突保留两值写conflicts，查盐型、单位、纯度、笔误。催化mol%转换eq注明原始基准；多底物不默认都1eq。非空eq/投料附对应引文，物性附属性来源。

未给实际规模则scaleMmol和scaleBasisId均null，不追问才能开始。不用文献产率推下步实际投料。首步规模只绑定首步底物；理论计算不写作实测。修结构同时修式/MW，旧密度、浓度、形态等失效。
