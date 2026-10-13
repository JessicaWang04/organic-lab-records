import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

const pluginId = "organic-lab-agent";
const pluginFiles = ["main.js", "manifest.json", "styles.css", "chemistry_worker.py"] as const;
export interface PrepareVaultOptions { pluginDir: string; pythonPath: string }
export interface PreparedObsidianVault {
  status: "prepared";
  vault: string; pluginPath: string; startNote: string;
  created: string[]; reused: string[]; preserved: string[]; needsEnable: string[];
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\x00-\x1f]/.test(value) || !isAbsolute(value)) {
    throw new Error(`vault_request_invalid: ${label} 必须是绝对本地路径`);
  }
  const path = resolve(value);
  if (path === parse(path).root) throw new Error(`vault_request_invalid: ${label} 不能是磁盘根目录`);
  return path;
}

async function statIfPresent(path: string) {
  try { return await fs.lstat(path); }
  catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function checkParents(path: string): Promise<void> {
  let parent = dirname(path);
  while (true) {
    const stat = await statIfPresent(parent);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error(`vault_path_invalid: 目标父目录不是普通目录，未写入 ${parent}`);
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
}

async function enabled(path: string, id: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path, "utf8"));
    return Array.isArray(value) ? value.includes(id) : !!value && typeof value === "object" && id in value && value[id as keyof typeof value] === true;
  } catch { return false; }
}

const startText = `# 开始使用这个实验记录库

在 Obsidian 中选择“打开文件夹作为仓库”，打开本文件所在的根目录；不要选择 Organic Lab 子目录或 .obsidian 目录。

首次打开时，请由你在 Obsidian 设置中确认信任并允许社区插件，然后确认启用“Organic Lab Agent”。在核心插件中确认开启“Bases”，即可打开路线图库。工具不会替你关闭受限模式。

本库的计量编辑、填写实际实验结果及新建重复实验无需模型 API key。反应资料的理解和新记录生成由 Codex/OpenCode 宿主中的 organic-lab-records 技能完成；Obsidian 插件内部的 AI 生成入口仍需要单独配置自己的 API。

生成的实验记录位于 Organic Lab 中。文献操作、产率、现象及表征属于参考内容；本次实际投料、操作、观察、产率及图谱由你填写，不能把参考结果当成实测结果。

本库包含待人工核对的实验草稿。结构、立体化学、文献冲突和缺失数据请核对后再使用；资料不足时保留待核对项，不补猜测值。
`;

/** Install only missing files. Existing configuration is never merged or rewritten. */
export async function prepareObsidianVault(request: unknown, options: PrepareVaultOptions): Promise<PreparedObsidianVault> {
  if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).length !== 1 || Object.keys(request)[0] !== "vault" || !("vault" in request)) {
    throw new Error("vault_request_invalid: 请求仅允许 {vault: 绝对路径}");
  }
  const vault = absolutePath(request.vault, "vault");
  const source = absolutePath(options.pluginDir, "pluginDir");
  if (typeof options.pythonPath !== "string" || !options.pythonPath.trim() || /[\x00-\x1f]/.test(options.pythonPath)) {
    throw new Error("vault_request_invalid: pythonPath 不能为空或包含控制字符");
  }
  const sourceBytes: Buffer[] = [];
  for (const name of pluginFiles) {
    const path = join(source, name);
    const stat = await statIfPresent(path);
    if (!stat?.isFile()) throw new Error(`plugin_source_missing: 分发包缺少插件文件 ${path}`);
    sourceBytes.push(await fs.readFile(path));
  }
  const obsidian = join(vault, ".obsidian");
  const pluginPath = join(obsidian, "plugins", pluginId);
  const startNote = join(vault, "开始使用.md");
  const community = join(obsidian, "community-plugins.json");
  const core = join(obsidian, "core-plugins.json");
  const targets = [
    ...pluginFiles.map((name, index) => ({ path: join(pluginPath, name), bytes: sourceBytes[index]!, plugin: true })),
    { path: join(pluginPath, "data.json"), bytes: Buffer.from(`${JSON.stringify({ pythonPath: options.pythonPath }, null, 2)}\n`), plugin: false },
    { path: community, bytes: Buffer.from(`${JSON.stringify([pluginId], null, 2)}\n`), plugin: false },
    { path: core, bytes: Buffer.from(`${JSON.stringify({ bases: true }, null, 2)}\n`), plugin: false },
    { path: startNote, bytes: Buffer.from(startText), plugin: false }
  ];
  const result: PreparedObsidianVault = { status: "prepared", vault, pluginPath, startNote, created: [], reused: [], preserved: [],
    needsEnable: ["首次打开时，请在 Obsidian 中自行确认信任并允许社区插件，再确认启用 Organic Lab Agent 和 Bases。"] };
  const missing: typeof targets = [];
  // Validate every source and target before the first mkdir/write. A conflict in
  // even the final plugin file must leave the entire existing vault unchanged.
  for (const target of targets) {
    await checkParents(target.path);
    const stat = await statIfPresent(target.path);
    if (!stat) { missing.push(target); continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`vault_path_invalid: 目标不是普通文件，未写入 ${target.path}`);
    if (target.plugin) {
      if (!(await fs.readFile(target.path)).equals(target.bytes)) throw new Error(`plugin_conflict: 已有插件文件内容不同，保留原文件 ${target.path}`);
      result.reused.push(target.path);
    } else result.preserved.push(target.path);
  }
  if (result.preserved.includes(community)) {
    result.needsEnable.push(await enabled(community, pluginId)
      ? "已保留现有社区插件配置，其中包含 Organic Lab Agent；请在 Obsidian 中确认它已启用。"
      : "已保留现有社区插件配置，请在 Obsidian 设置 → 社区插件中手动启用 Organic Lab Agent。");
  }
  if (result.preserved.includes(core)) {
    result.needsEnable.push(await enabled(core, "bases")
      ? "已保留现有核心插件配置，其中包含 Bases；请在 Obsidian 中确认图库可以打开。"
      : "已保留现有核心插件配置，请在 Obsidian 设置 → 核心插件中手动开启 Bases。");
  }
  for (const target of missing) {
    await fs.mkdir(dirname(target.path), { recursive: true });
    await fs.writeFile(target.path, target.bytes, { flag: "wx" });
    result.created.push(target.path);
  }
  return result;
}
