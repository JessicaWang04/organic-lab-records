# 本地 CLI 命令

以下命令由宿主执行。用户发送新的有机合成论文链接、DOI、PDF 或截图，或在 OpenCode 使用 `/organic-lab-records <论文链接或 DOI>`，即可按默认完整主路线整理；获取可访问的正文和 SI，文献原投料预填，实际规模留空。无需用户填写 JSON 或先选择模式。发送或启动依宿主流程，工具会复制来源并写入本地记录库。请求通过 UTF-8 JSON 文件传递，不把大段 JSON 拼进终端命令。`--request` 后是请求文件路径。命令支持 `doctor`、`prepare-vault`、`init`、`call`、`status`；没有 AI 循环、模型预算或 `ask_user`。

## 选择输出库

宿主依次选用用户本次明确指定的库、当前已确认的 Obsidian 项目库、本技能目录可选 `local-defaults.json` 的 `vault`，否则在当前工作目录下建立 `Organic Lab Records`。本机默认只需配置一次；它不是 CLI 请求合同，不能作为 `--request` 直接执行。宿主读取其中的绝对路径后，仍按下文格式构造 `prepare-vault`、`init` 等请求。

```json
{"vault": "D:/MyObsidianVault"}
```

该文件只接受本地默认库位置，不承载 API key、模型指令或执行权限；不得将示例路径当成用户实际设置。不存在该文件时按其他默认规则继续。用户明确指定的库优先；沿用库时保留既有记录和配置。随包发布不得加入个人路径，安装器同步技能时应保留目标端已有的本机默认文件。

Windows 使用 `scripts/run-lab.ps1`；macOS/Linux 使用 `sh scripts/run-lab.sh`。入口自动定位本包，无需切换输出库或修改系统 PATH。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '/path/to/organic-lab-records/scripts/run-lab.ps1' doctor
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '/path/to/organic-lab-records/scripts/run-lab.ps1' prepare-vault --request '/path/to/vault.json'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '/path/to/organic-lab-records/scripts/run-lab.ps1' init --request '/path/to/init.json'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '/path/to/organic-lab-records/scripts/run-lab.ps1' call --request '/path/to/call.json'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '/path/to/organic-lab-records/scripts/run-lab.ps1' status --request '/path/to/status.json'
```

```sh
sh '/path/to/organic-lab-records/scripts/run-lab.sh' doctor
sh '/path/to/organic-lab-records/scripts/run-lab.sh' prepare-vault --request '/path/to/vault.json'
sh '/path/to/organic-lab-records/scripts/run-lab.sh' init --request '/path/to/init.json'
```

入口的底层命令为 `node scripts/organic-lab.cjs <command> [--request <file>]`。Python 化学 worker 为 `scripts/chemistry_worker.py`。`ORGANIC_LAB_PYTHON` 可指定 Python；Windows `setup.ps1` 保存本机 `runtime.json` 后，入口会使用探测到的解释器。

## prepare-vault：准备完整记录库

```json
{"vault": "D:/CurrentProject/Organic Lab Records"}
```

`vault` 为按上述优先级选出的绝对本地库根路径。该命令准备随包预构建的 Organic Lab 插件和新库缺失配置，保留既有配置与用户文件，再用同一 `vault` 执行 `init`。

成功回执只证明文件和配置备齐。首次在 Obsidian 打开仍需允许社区插件；既有库按保留配置的实际状态启用所需插件，不能声称此命令完成了桌面交互验收。

## init：建立路线

```json
{
  "vault": "D:/CurrentProject/Organic Lab Records",
  "routeId": "Route-paper-compound-01",
  "prompt": "按文献沿用原底物整理逐步骤实验草稿；实际规模留空。",
  "sources": [
    {"id": "scheme", "path": "D:/Literature/scheme.png", "name": "反应截图"},
    {"id": "paper", "path": "D:/Literature/paper.pdf", "name": "正文"},
    {"id": "si", "path": "D:/Literature/si.pdf", "name": "补充信息"}
  ]
}
```

示例路径需替换为实际输出库和附件路径。`vault` 是本地输出库的绝对根目录；`routeId` 由宿主自动生成安全、唯一的单个文件夹名，不能含 `/`、`\\`、`..` 或 Windows 禁用字符。各来源 `id` 唯一，`path` 是 PNG/JPEG/PDF 的绝对文件路径；`name` 可省略。未给实际规模时保持 `scaleMmol=null`，文献有依据的当量和性质先预填，用户可在生成后的 Obsidian 计量表输入规模。

本次路线位于 `<vault>/Organic Lab/<routeId>/`。来源会复制到路线 `sources` 内。已有路线的恢复先使用 `status`，不要用新路线冒充已有进度。

## call：运行一个本地工具

```json
{
  "vault": "D:/CurrentProject/Organic Lab Records",
  "routeId": "Route-paper-compound-01",
  "tool": "read_source_page",
  "args": {"sourceId": "si", "page": 19, "bbox": null},
  "callId": "read-si-page-19-v1"
}
```

`callId` 必填。同一逻辑调用的恢复或重发保留 ID 与参数；修改参数或明确创建新操作时换 ID。返回错误时按错误修正，不能把旧成功回执当作新参数已经执行。

`read_source_page` 返回本地 `imageFile` 绝对路径。用宿主图片查看工具读取该文件，再判断结构和图上文字；不要只读文本索引就声称已看图。

参数的完整定义在 [tools.json](tools.json)，构建时由工具 schema 生成。当前本地工具包括：

| 工具 | 用途 |
|---|---|
| `search_sources` | 检索本次来源文本 |
| `read_source_page` | 读取页面文字和本地页面图像 |
| `record_route` | 保存完整路线计划与证据 |
| `inspect_structure` | 解析结构、分子式、MW 与原子索引 |
| `lookup_reagent` | 补可核对的物料性质 |
| `edit_structure` | 执行明确的局部结构编辑 |
| `set_scale` | 绑定当前步底物与 mmol |
| `locate_reaction` | 按实验标题定位反应局部区域，供读取查看 |
| `set_step_structures` | 补齐尚未写入的一步结构，不重做其他步骤 |
| `validate_route` | 重读实际文件，报告必需交付物与逐步缺项 |
| `render_step` | 生成紧裁剪单反应 PNG 与必需的原生 CDXML |
| `write_step` | 保存单步 Markdown 和计量表 |
| `finish_route` | 校验步骤并保存路线主页与图库 |

`record_route` 中的步骤与试剂对象字段以 schema 为准；未知字段仍需用合同要求的 `null` 或 `[]` 表示，不能省略必填项。来源短引必须确实存在于本次来源，不能补造。

## status：读取进度

```json
{"vault": "D:/CurrentProject/Organic Lab Records", "routeId": "Route-paper-compound-01"}
```

先读取状态与已有回执，再决定尚未执行的操作。输出产物冲突时保留已有文件，核对实际记录与本次计划后处理。

## 环境依赖

- 已安装 RDKit 的 Python；化学工具不依赖本机安装 ChemDraw。
- `Pillow` 是 worker 启动和 PNG 处理必需项。
- `PyMuPDF` 为 PDF 索引、页面渲染和裁剪所需；只处理图片时不调用 PDF 分支。本包完整能力使用该依赖。
- 本包随附编译后的 Node CLI；Windows 完整包带 `scripts/runtime/node.exe`（Node 24），轻量包和其他平台需可用 Node 20 或更新版本。

worker 不含 OCR 引擎或图像到 SMILES 的自动识别器。结构识别与文献理解由宿主模型完成，本地工具验证输入结构并明确保存核对状态。


## 分层指南与筛选合同（0.2.0）

`guide --request guide.json`：请求 `{"sourceFormat":"pdf-text","topics":["stereo","one-pot","recovery"]}`。sourceFormat/topics来自manifest.yaml；输出核心与选中层的真实内容/路径/hash，并发读取，不调用模型。核心始终保留。宿主自己组织JSON，普通用户仍只给新文献。

`contracts --request names.json`：names.json为工具名数组，例如 `["record_inventory","register_compounds"]`。只返回选中schema，减少重复上下文。无参数contracts返回全部本地schema。

新增工作流：record_inventory → register_compounds → record_route → bind_steps → validate_plan → materialize_steps → validate_route → finish_route。初次先读core/workflow。每次call仍带vault/routeId/tool/args/callId。read_source_pages一次≤8，inspect_structures≤64，materialize_steps≤8且内部最多2步并行；同一路线多个CLI写入仍受锁保护。

完整离线重放：`python scripts/replay_examples.py --output <新的绝对目录>`，生成两个完整合成示例及正常/拒绝检查报告，不是实验方案或识别benchmark。
