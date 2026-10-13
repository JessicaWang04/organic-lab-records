import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { prepareObsidianVault } from "../tools/prepare-obsidian-vault";

const pluginId = "organic-lab-agent";
const pluginFiles = ["main.js", "manifest.json", "styles.css", "chemistry_worker.py"] as const;
const sourceContent: Record<(typeof pluginFiles)[number], string> = {
  "main.js": "/* isolated fixture; never executed */\nmodule.exports = {};\n",
  "manifest.json": JSON.stringify({ id: pluginId, name: "Organic Lab Agent", version: "0.1.0", minAppVersion: "1.8.0", description: "fixture", author: "fixture", isDesktopOnly: true }, null, 2),
  "styles.css": ".organic-lab-agent { display: block; }\n",
  "chemistry_worker.py": "# isolated fixture; never executed\n",
};

async function exists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

// Include directories and links, so even empty directories created during a rejected
// request count as mutations. Never follow a junction out of the fixture root.
async function snapshot(root: string): Promise<Record<string, string>> {
  if (!await exists(root)) return {};
  const result: Record<string, string> = {};
  async function visit(path: string, key: string): Promise<void> {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) { result[key] = `link:${await fs.readlink(path)}`; return; }
    if (stat.isDirectory()) {
      result[key] = "directory";
      for (const entry of (await fs.readdir(path)).sort()) await visit(join(path, entry), key ? `${key}/${entry}` : entry);
      return;
    }
    result[key] = (await fs.readFile(path)).toString("base64");
  }
  await visit(root, "");
  return result;
}

async function fixture(t: TestContext) {
  const tempRoot = resolve(await fs.mkdtemp(join(tmpdir(), "organic-lab-vault-test-")));
  t.after(async () => {
    // Check the resolved deletion target before recursively removing the temp fixture.
    assert.equal(dirname(tempRoot), resolve(tmpdir()));
    assert.ok(basename(tempRoot).startsWith("organic-lab-vault-test-"));
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  const pluginDir = join(tempRoot, "source-plugin");
  const vault = join(tempRoot, "vault");
  const pythonPath = join(tempRoot, "python.exe");
  await fs.mkdir(pluginDir);
  await fs.writeFile(pythonPath, "fixture; never executed");
  for (const file of pluginFiles) await fs.writeFile(join(pluginDir, file), sourceContent[file]);
  const obsidian = join(vault, ".obsidian");
  const pluginPath = join(obsidian, "plugins", pluginId);
  const startNote = join(vault, "开始使用.md");
  const data = join(pluginPath, "data.json");
  const community = join(obsidian, "community-plugins.json");
  const core = join(obsidian, "core-plugins.json");
  return { tempRoot, pluginDir, vault, pythonPath, obsidian, pluginPath, startNote, data, community, core };
}

function assertNotice(messages: string[]): void {
  assert.ok(Array.isArray(messages));
  assert.ok(messages.length > 0, "preparing files must still remind the user to confirm enabling plugins");
  for (const message of messages) assert.match(message, /[\u4e00-\u9fff]/, "enable notices must be clear Chinese text");
  assert.ok(messages.some(message => /启用|开启/.test(message)), "include an explicit enabling reminder");
}

function assertAbsolutePaths(result: { created: string[]; reused: string[]; preserved: string[] }): void {
  for (const key of ["created", "reused", "preserved"] as const) {
    assert.ok(Array.isArray(result[key]));
    for (const path of result[key]) assert.ok(isAbsolute(path), `${key} entry must be an absolute path: ${path}`);
    assert.equal(new Set(result[key]).size, result[key].length, `${key} must not contain duplicate paths`);
  }
}

test("new vault receives the complete plugin and minimal configuration without executing anything", async t => {
  const f = await fixture(t);
  const result = await prepareObsidianVault({ vault: f.vault }, { pluginDir: f.pluginDir, pythonPath: f.pythonPath });
  assert.equal(result.status, "prepared");
  assert.equal(result.vault, f.vault);
  assert.equal(result.pluginPath, f.pluginPath);
  assert.equal(result.startNote, f.startNote);
  const expected = [...pluginFiles.map(file => join(f.pluginPath, file)), f.data, f.community, f.core, f.startNote].sort();
  assert.deepEqual([...result.created].sort(), expected);
  assert.deepEqual(result.reused, []);
  assert.deepEqual(result.preserved, []);
  assertAbsolutePaths(result);
  assertNotice(result.needsEnable);
  for (const file of pluginFiles) assert.deepEqual(await fs.readFile(join(f.pluginPath, file)), await fs.readFile(join(f.pluginDir, file)));
  assert.deepEqual(JSON.parse(await fs.readFile(f.data, "utf8")), { pythonPath: f.pythonPath });
  assert.deepEqual(JSON.parse(await fs.readFile(f.community, "utf8")), [pluginId]);
  assert.deepEqual(JSON.parse(await fs.readFile(f.core, "utf8")), { bases: true });
  assert.ok((await fs.readFile(f.startNote, "utf8")).trim().length > 0);
});

test("repeating preparation reuses identical plugin files and leaves all bytes and modification times unchanged", async t => {
  const f = await fixture(t);
  const options = { pluginDir: f.pluginDir, pythonPath: f.pythonPath };
  const first = await prepareObsidianVault({ vault: f.vault }, options);
  const before = await snapshot(f.vault);
  const beforeTimes = await Promise.all(first.created.map(async path => [path, (await fs.stat(path)).mtimeMs] as const));
  const second = await prepareObsidianVault({ vault: f.vault }, options);
  assert.deepEqual(await snapshot(f.vault), before);
  assert.deepEqual(second.created, []);
  assert.deepEqual([...second.reused].sort(), pluginFiles.map(file => join(f.pluginPath, file)).sort());
  for (const path of [f.data, f.community, f.core, f.startNote]) assert.ok(second.preserved.includes(path), `preserve ${path}`);
  for (const [path, modified] of beforeTimes) assert.equal((await fs.stat(path)).mtimeMs, modified, `do not rewrite ${path}`);
  assertAbsolutePaths(second);
  assertNotice(second.needsEnable);
});

for (const alreadyEnabled of [false, true]) {
  test(`existing settings and start note remain byte-identical even when plugin ${alreadyEnabled ? "is" : "is not"} already enabled`, async t => {
    const f = await fixture(t);
    await fs.mkdir(f.pluginPath, { recursive: true });
    const original = new Map<string, Buffer>([
      [f.data, Buffer.from('{\r\n  "pythonPath": "Z:\\\\custom\\\\python.exe",\r\n  "model": "user-choice", "apiKey": "fixture-only"\r\n}\r\n')],
      [f.community, Buffer.from(`${JSON.stringify(alreadyEnabled ? ["another-plugin", pluginId] : ["another-plugin"], null, 4)}\r\n`)],
      [f.core, Buffer.from('{ "bases": false, "file-explorer": true }\r\n')],
      [f.startNote, Buffer.from("# 用户已有笔记\r\n\r\n必须逐字保留。\r\n")],
      [join(f.vault, "已有实验.md"), Buffer.from("用户原有实验记录\n")],
    ]);
    for (const [path, bytes] of original) await fs.writeFile(path, bytes);
    const result = await prepareObsidianVault({ vault: f.vault }, { pluginDir: f.pluginDir, pythonPath: f.pythonPath });
    assert.equal(result.status, "prepared");
    assert.deepEqual([...result.created].sort(), pluginFiles.map(file => join(f.pluginPath, file)).sort());
    for (const [path, bytes] of original) assert.deepEqual(await fs.readFile(path), bytes, `keep bytes in ${path}`);
    for (const path of [f.data, f.community, f.core, f.startNote]) assert.ok(result.preserved.includes(path), `report preserved ${path}`);
    assertAbsolutePaths(result);
    assertNotice(result.needsEnable);
  });
}

test("a late plugin-file conflict rejects before creating or replacing any target files", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.pluginPath, { recursive: true });
  // Earlier plugin files and every settings file are missing. A sequential
  // copy-before-check implementation would mutate the vault before reaching this file.
  await fs.writeFile(join(f.pluginPath, "chemistry_worker.py"), "# user's different worker\n");
  await fs.writeFile(join(f.vault, "原有记录.md"), "original\n");
  const before = await snapshot(f.vault);
  await assert.rejects(async () => prepareObsidianVault({ vault: f.vault }, { pluginDir: f.pluginDir, pythonPath: f.pythonPath }), /plugin_conflict/);
  assert.deepEqual(await snapshot(f.vault), before, "conflict preflight must not create main.js, settings, notes or any other file");
});

test("a missing source file rejects before even creating the requested vault", async t => {
  const f = await fixture(t);
  await fs.unlink(join(f.pluginDir, "chemistry_worker.py"));
  await assert.rejects(async () => prepareObsidianVault({ vault: f.vault }, { pluginDir: f.pluginDir, pythonPath: f.pythonPath }), /plugin_source_missing/);
  assert.equal(await exists(f.vault), false);
});

test("a missing source file also leaves an existing vault completely unchanged", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.vault);
  await fs.writeFile(join(f.vault, "原有记录.md"), "original\n");
  await fs.unlink(join(f.pluginDir, "styles.css"));
  const before = await snapshot(f.vault);
  await assert.rejects(async () => prepareObsidianVault({ vault: f.vault }, { pluginDir: f.pluginDir, pythonPath: f.pythonPath }), /plugin_source_missing/);
  assert.deepEqual(await snapshot(f.vault), before);
});

test("request validation rejects non-objects, extra fields, and non-absolute vault paths before writing", async t => {
  const f = await fixture(t);
  const options = { pluginDir: f.pluginDir, pythonPath: f.pythonPath };
  const invalid: unknown[] = [
    null, undefined, [], "vault", {}, { vault: null }, { vault: 42 }, { vault: "" }, { vault: " " },
    { vault: "." }, { vault: ".." }, { vault: join("relative", "vault") }, { vault: "~/vault" },
    { vault: f.vault, pythonPath: f.pythonPath }, { vault: f.vault, unexpected: true },
    Object.assign(Object.create({ vault: f.vault }), { unexpected: true }),
  ];
  const before = await snapshot(f.tempRoot);
  for (const request of invalid) {
    await assert.rejects(async () => prepareObsidianVault(request, options), `reject request ${JSON.stringify(request)}`);
    assert.deepEqual(await snapshot(f.tempRoot), before, `validation must not write for ${JSON.stringify(request)}`);
  }
});

test("a linked .obsidian directory cannot redirect writes outside the requested vault", async t => {
  const f = await fixture(t);
  const external = join(f.tempRoot, "external-settings");
  await fs.mkdir(external);
  await fs.writeFile(join(external, "community-plugins.json"), '["external-plugin"]\n');
  await fs.mkdir(f.vault);
  await fs.symlink(external, f.obsidian, process.platform === "win32" ? "junction" : "dir");
  const externalBefore = await snapshot(external);
  const vaultBefore = await snapshot(f.vault);
  await assert.rejects(async () => prepareObsidianVault({ vault: f.vault }, { pluginDir: f.pluginDir, pythonPath: f.pythonPath }));
  assert.deepEqual(await snapshot(external), externalBefore, "the linked destination must remain untouched");
  assert.deepEqual(await snapshot(f.vault), vaultBefore, "reject before creating any vault files");
});
