---
type: reaction-experiment
route_id: branched-stereo-fixture
step_number: 2
paper_step: E2
attempt: 1
attempts_count: 0
status: draft
worked: null
image: "[[Organic Lab/branched-stereo-fixture/assets/S02-1e7ad9abb051dd.png]]"
cdxml: "[[Organic Lab/branched-stereo-fixture/assets/S02-1e7ad9abb051dd.cdxml]]"
structure_status: graph-validated-source-review-required
quality: "[[Organic Lab/branched-stereo-fixture/assets/S02-1e7ad9abb051dd-quality.json]]"
scale_mmol: null
scale_basis: null
previous_step: "[[Organic Lab/branched-stereo-fixture/branched-stereo-fixture-01-R01-E1 synthetic fixture.md]]"
next_step: "[[Organic Lab/branched-stereo-fixture/branched-stereo-fixture-03-R01-E3 synthetic fixture.md]]"
sources:
  - "[[Organic Lab/branched-stereo-fixture/sources/si.pdf#page=6]]"
reference_yield: null
reference_yield_scope: combined (synthetic fixture)
measured_yield_percent: null
spectra: []
skill_version: experiment-records/2.0.0
harness_version: organic-lab/0.2.0
reference_spectra: []
---

# E2 synthetic fixture

## 实验目的

仅用于工具与文件验收，非实验指导

## 反应式

![[Organic Lab/branched-stereo-fixture/assets/S02-1e7ad9abb051dd.png]]

可编辑结构：[[Organic Lab/branched-stereo-fixture/assets/S02-1e7ad9abb051dd.cdxml]]

参考条件：SYNTHETIC FIXTURE；one-pot

## 计量输入

```organic-stoich
{
  "scaleMmol": null,
  "basisId": null,
  "rows": [
    {
      "id": "substrate-B",
      "name": "B shared crude intermediate",
      "role": "substrate",
      "smiles": "COC(=O)[C@@H](N)[C@H](C)O",
      "mw": 133.14700000000002,
      "formula": "C5H11NO3",
      "equivalents": null,
      "referenceAmountMmol": null,
      "referenceMassMg": null,
      "referenceVolumeMl": null,
      "concentrationM": null,
      "densityGml": null,
      "purityPercent": null,
      "physicalState": null,
      "citations": [
        {
          "sourceId": "si",
          "page": 2,
          "quote": "Synthetic compound B: formula C5H11NO3; specified centers 2; specified double bonds 0; components 1."
        }
      ],
      "propertySources": [
        {
          "kind": "structure",
          "reference": "RDKit：当前SMILES的分子式与平均摩尔质量；不推算密度或形态。",
          "citation": null,
          "url": null,
          "temperatureC": null,
          "property": "formula"
        },
        {
          "kind": "structure",
          "reference": "RDKit：当前SMILES的分子式与平均摩尔质量；不推算密度或形态。",
          "citation": null,
          "url": null,
          "temperatureC": null,
          "property": "mw"
        }
      ]
    },
    {
      "id": "product-P0",
      "name": "P0 target",
      "role": "product",
      "smiles": "COC(=O)[C@@H](NC(C)=O)[C@H](C)OC(C)=O",
      "mw": 217.22099999999998,
      "formula": "C9H15NO5",
      "equivalents": null,
      "referenceAmountMmol": null,
      "referenceMassMg": null,
      "referenceVolumeMl": null,
      "concentrationM": null,
      "densityGml": null,
      "purityPercent": null,
      "physicalState": null,
      "citations": [
        {
          "sourceId": "si",
          "page": 3,
          "quote": "Synthetic compound P0: formula C9H15NO5; specified centers 2; specified double bonds 0; components 1."
        }
      ],
      "propertySources": [
        {
          "kind": "structure",
          "reference": "RDKit：当前SMILES的分子式与平均摩尔质量；不推算密度或形态。",
          "citation": null,
          "url": null,
          "temperatureC": null,
          "property": "formula"
        },
        {
          "kind": "structure",
          "reference": "RDKit：当前SMILES的分子式与平均摩尔质量；不推算密度或形态。",
          "citation": null,
          "url": null,
          "temperatureC": null,
          "property": "mw"
        }
      ]
    }
  ]
}
```

## Stoichiometry

<!-- organic-lab:stoich-start -->
| 组分 | 常温形态 | MW (g/mol) | eq | mmol | 纯品 mg | 称量 mg | 理论体积 mL | 实配体积 mL |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| B shared crude intermediate | 待补 | 133.147 | — | — | — | — | — | — |
| P0 target | 待补 | 217.221 | — | — | — | — | — | — |

计算：mmol = 已选基准底物规模 × 参考eq / 基准参考eq。纯品 mg = mmol × 平均MW；称量 mg = 纯品 mg / 纯度。液体理论体积按100%纯品计算；实配体积采用已知有效浓度，或已确认的纯度及密度。固体不按密度换算体积。

### 物料性质与来源

| 组分 | 分子式／密度 | 性质与投料来源 |
|---|---|---|
| B shared crude intermediate | C5H11NO3；密度待补 | 分子式：RDKit；MW：RDKit；投料：si:p2 |
| P0 target | C9H15NO5；密度待补 | 分子式：RDKit；MW：RDKit；投料：si:p3 |
<!-- organic-lab:stoich-end -->

## 文献参考步骤

1. 合成测试阶段 1：未提供可执行实验操作。
2. 合成测试阶段 2：未提供可执行实验操作。

## 实际操作与现象记录

| 时间 | 操作／观察 | TLC／取样 | 附件 |
|---|---|---|---|
| | | | |

## 后处理

### 文献参考
原文未给出，待补充。

### 实际记录


## 纯化

### 文献参考
原文未给出，待补充。

### 实际记录


## 表征与图谱

### 文献参考
- 测试固定结构，不是实测表征。

### 本次实验

将本次 NMR、LCMS、HRMS、IR 或原始数据拖入此处，并在 YAML 的 spectra 中登记。

## 结果

- 本次产物质量：
- 本次实测产率：
- 本次是否跑通：
- 备注：

文献产率：未知；口径：combined (synthetic fixture)。本次实验结果单独记录。

## 来源与核对

- [[Organic Lab/branched-stereo-fixture/sources/si.pdf#page=6|si.pdf · p6]]
  > Synthetic experiment E2: B to P0; handling one-pot; 2 simulated stage(s). Reference basis 1.00 mmol is synthetic. No experimental conditions or measured yields are supplied.

- 本记录为合成测试材料，不能用于真实实验。

质量报告：[[Organic Lab/branched-stereo-fixture/assets/S02-1e7ad9abb051dd-quality.json]]

## 文献参考图谱附件
