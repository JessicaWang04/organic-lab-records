import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const skill = resolve('portable/organic-lab-records');
await mkdir(skill, { recursive: true });
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(file, join(skill, file));
await mkdir(join(skill, 'scripts'), { recursive: true });
await mkdir(join(skill, 'references'), { recursive: true });
await build({ entryPoints: ['tools/organic-lab-cli.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'es2022', outfile: join(skill, 'scripts/organic-lab.cjs'), logLevel: 'info' });
await copyFile('python/chemistry_worker.py', join(skill, 'scripts/chemistry_worker.py'));
await copyFile('requirements.txt', join(skill, 'scripts/requirements.txt'));
const pluginDir = join(skill, 'assets/obsidian-plugin');
await mkdir(pluginDir, { recursive: true });
const pluginArtifacts = {};
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  const bytes = await readFile(file);
  await copyFile(file, join(pluginDir, file));
  pluginArtifacts[file] = createHash('sha256').update(bytes).digest('hex');
}
await copyFile('python/chemistry_worker.py', join(pluginDir, 'chemistry_worker.py'));
pluginArtifacts['chemistry_worker.py'] = createHash('sha256').update(await readFile(join(pluginDir, 'chemistry_worker.py'))).digest('hex');
// The same schema validators are bundled into the CLI and published for its host.
const schemaModule = resolve('node_modules/.cache/organic-lab-contracts.cjs');
await mkdir(dirname(schemaModule), { recursive: true });
await build({ stdin: { contents: 'import { TOOLS } from "./src/tools"; console.log(JSON.stringify(TOOLS.filter(t=>t.name!=="ask_user"), null, 2));', resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: schemaModule });
const { execFile } = await import('node:child_process');
const { promisify } = await import('node:util');
const contracts = await promisify(execFile)(process.execPath, [schemaModule], { windowsHide: true });
await writeFile(join(skill, 'references/tools.json'), contracts.stdout, 'utf8');
const licensing = join(skill, 'scripts/licenses'); await mkdir(licensing, { recursive: true });
for (const [name, license] of [['ajv','LICENSE'], ['yaml','LICENSE'], ['fast-deep-equal','LICENSE'], ['fast-uri','LICENSE'], ['fast-uri','LICENSE.BSD-3-Clause'], ['json-schema-traverse','LICENSE'], ['require-from-string','license']]) {
  try { await copyFile(join('node_modules', name, license), join(licensing, `${name}-${license}.txt`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (process.argv.includes('--windows-runtime')) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows runtime bundle requires Windows x64 Node');
  const runtime = join(skill, 'scripts/runtime'); await mkdir(runtime, { recursive: true });
  await copyFile(process.execPath, join(runtime, 'node.exe'));
  await copyFile(join(dirname(process.execPath), 'LICENSE'), join(runtime, 'NODE-LICENSE.txt'));
}
const main = await readFile(join(skill, 'scripts/organic-lab.cjs')), worker = await readFile(join(skill, 'scripts/chemistry_worker.py'));
await writeFile(join(skill, 'bundle.json'), JSON.stringify({ version: '0.1.2', modelApiRequired: false, nodeVersion: process.version,
  chemistryWorkerSha256: createHash('sha256').update(worker).digest('hex'), cliSha256: createHash('sha256').update(main).digest('hex'),
  pythonDependencies: ['rdkit', 'Pillow', 'PyMuPDF'], commands: ['doctor','prepare-vault','init','call','status'], obsidianPlugin: { id: 'organic-lab-agent', assets: 'assets/obsidian-plugin', sha256: pluginArtifacts } }, null, 2) + '\n');
console.log(`Portable skill built: ${skill}`);
