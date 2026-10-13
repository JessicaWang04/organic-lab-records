# Organic Lab Records

把有机合成论文、SI 和反应截图整理为有来源的逐步骤实验草稿、计量表、反应 PNG、可编辑 CDXML 和 Obsidian 记录库。

An agent skill and local toolkit for evidence-linked organic synthesis records. The host model reads the sources; local tools calculate, validate and write artifacts.

**当前版本：0.2.0 测试版。** 结构识别依赖宿主模型，复杂立体结构和完整文献的跨模型准确率尚未完成基准测试。每一步必须通过紧裁剪反应 PNG、原生可编辑 CDXML 和笔记链接验收；缺少结构时保留进度并继续修复，不能标为完成。来源图识别准确率仍需独立评测。

## 三步开始

1. 从 [Releases](https://github.com/JessicaWang04/organic-lab-records/releases) 下载 `organic-lab-records-windows.zip` 并解压。
2. 进入 `organic-lab-records`，双击 `setup-opencode.cmd`。安装器同时安装技能并注册 `/lab`，保留已有同名命令。
3. 重开 OpenCode，发送 `/lab 新论文链接` 或 `/lab DOI`。也可附上新 PDF 后发送 `/lab`。

首次使用需要一个能导入 RDKit 的 Python。Windows 完整包自带 Node；安装器会检查并补齐缺少的 Pillow、PyMuPDF，但不会自动安装 RDKit。使用宿主已有模型，不另配一套模型 API key。

Codex 用户双击 `setup-codex.cmd`，通过 `$organic-lab-records` 加链接或附件调用。其他宿主的安装与运行说明见 [使用说明](portable/使用说明.md)。WorkBuddy 包不含 Node 二进制，客户端导入尚未实测。

## 默认结果

- 获取可访问的正文及 SI，保留来源、页码和原文依据。
- 按文献原投料整理完整主路线，每篇文献建立独立目录；指定全部目标或分支时覆盖指定范围。
- 生成路线主页、逐步 Markdown、计量表、单反应 PNG 和每一步必需的可编辑 CDXML。
- 先处理结构并复用已核对中间体，保留 one-pot、粗品续用、合并产率和原文冲突。
- 实际规模、操作、现象及实测结果留空，供使用者记录。

默认使用已确认的 Obsidian 项目或本机个人默认库，否则在当前目录建立 `Organic Lab Records`。分发包不含作者的笔记、论文文件、密钥、默认库路径或运行时配置。

`SKILL.md` 是分层入口，manifest规定始终加载的核心、来源类型和问题专题；化学记录口径见 [workflow.md](portable/organic-lab-records/references/workflow.md)，本地命令见 [commands.md](portable/organic-lab-records/references/commands.md)，参数合同见 [tools.json](portable/organic-lab-records/references/tools.json)。

## 分层流程与提速

来源清单先于生成计划；化合物核对登记后复用，计划与实验/物料绑定，写入前预检，最后验真实文件。门禁检查漏步、重复、结构漂移、式/盐/明确立体、差向异构关系、MW和笔记链接，无法用“尚待确认”或假标记完成。

`guide`一次读取必要层，`contracts`筛选当前schema；PDF/候选解析批量复用Python，文件生成最多2步并行，部分失败只修失败项。普通用户仍使用`/lab <新文献>`，不增加提示词负担。

[完整可重放示例](portable/organic-lab-records/references/worked-examples.md)包含直线和立体分支/粗品/one-pot案例、真实PNG/CDXML/笔记及失败门禁。案例为合成测试材料，另需真实SI识别评测。[快速识别方案](portable/organic-lab-records/references/recognition.md)说明可选开源定位/分子图候选接口；本版不捆绑外部识别权重。

## 开发与验证

需要 Node 20+、Python，以及同一 Python 环境中的 RDKit、Pillow、PyMuPDF。

```sh
npm ci
python -m pip install -r requirements.txt
npm run build
npm test
npm run test:python
npm run check-workbench-budget
```

测试默认调用当前环境的 `python`；使用其他 RDKit 环境时可设置 `ORGANIC_LAB_PYTHON` 为解释器路径。

Windows x64 使用 `npm run build-skill` 构建包含 Node 的技能包，再用 `npm run package-skill` 生成 ZIP。macOS/Linux 可以运行 `node tools/build-portable-skill.mjs` 构建不含 Windows Node 的便携工具，按使用说明配置解释器。

工具测试覆盖计量、HRMS、结构编辑、CDXML 读回、记录保存、断点恢复和既有文件保护。模型图像识别准确率、OpenCode 完整文献流程及原生 ChemDraw 编辑体验另见 [验证范围](docs/VALIDATION.md)，不能由单元测试替代。

## 目录

| 目录 | 内容 |
|---|---|
| `portable/organic-lab-records` | 技能、宿主元数据、安装入口与参考规则 |
| `src` | Obsidian 插件、模型传输、记录和计量 |
| `python` | 本地化学、PNG、PDF、CDXML 工具 |
| `tools` | CLI、便携构建及打包 |
| `test` | 确定性工具测试 |

## 许可证

项目采用 [AGPL-3.0-only](LICENSE)。第三方依赖和分发包内附带的运行时保留各自许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
