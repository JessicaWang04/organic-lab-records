# v0.1.2 — 必需交付物验收

解决旧版可用整页 PDF 充当 gallery 图片、缺少 CDXML 仍能完成的问题。

- 每一步必需紧裁剪单反应 PNG、含原生原子和键的 CDXML，以及链接两者的笔记。
- 本地验收重读真实文件，核对分子图、反应方向、立体信息、条件文字、PNG 内容和笔记引用。质量 JSON 或旧成功回执不能替代验收。
- 新增 `locate_reaction` 局部图定位、`set_step_structures` 逐步补齐和 `validate_route` 缺项报告。完整路线验收共用一个 Python 进程。
- 旧的不完整会话会重新标记为 deliveryIncomplete；原笔记和用户实际记录保留，结构修订建立新路线。

用户入口保持 `/lab <新论文链接或 DOI>`。更新后重新打开 OpenCode 会话；Obsidian 插件重启或重新加载后生效。已有产物不会自动重做。

验证：83 项 TypeScript 测试、16 项 Python 测试和 5 项预算模拟检查；另验收 ZIP 解压安装与发布包实际调用。

本地验收保证文件内容和导出往返一致。论文图像识别准确率、Qwen / DeepSeek 完整新文献对比及原生 ChemDraw 编辑验收仍需要独立评测。
