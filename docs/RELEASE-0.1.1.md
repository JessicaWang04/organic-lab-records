# v0.1.1 — OpenCode /lab preview

首个公开测试版，包含源码、本地工具、Obsidian 插件与可安装技能包。

## 安装

Windows 用户下载 `organic-lab-records-windows.zip`，解压后双击 `setup-opencode.cmd`，重开 OpenCode，再发送 `/lab 新论文链接` 或附上 PDF 后发送 `/lab`。Codex 用户使用 `setup-codex.cmd` 和 `$organic-lab-records`。

需要已有 RDKit Python；Windows 包自带 Node，并检查 Pillow、PyMuPDF。分发包不携带作者的密钥、默认库、笔记或运行时配置。

## 本次检查

- 公开源码构建通过。
- 78 项 TypeScript 测试、10 项 Python 化学工具测试及 5 项工作台模拟检查通过。
- ZIP 解压后的本地工具启动、OpenCode `/lab` 注册、重复安装及已有命令保护检查通过。

## 质量边界

结构识别由宿主模型承担。OpenCode 配合 Qwen / DeepSeek 的完整文献准确率、复杂立体结构基准及原生 ChemDraw 编辑体验尚未完成验收。CDXML 读回验证输入结构是否被导出改变，不代替与来源图的核对。

完整多模型提速调度与专用结构识别器尚未实现。本版按实际生成数量报告 CDXML，无法确认的结构保留原图及具体待核对项。

项目源代码采用 AGPL-3.0-only，第三方运行时及依赖保留原许可。详见 LICENSE 与 THIRD_PARTY_NOTICES.md。
