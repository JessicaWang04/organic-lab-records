const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const project = path.resolve(process.argv[2] || path.join(__dirname, "../../.."));
const outputDir = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(os.tmpdir(), "organic-lab-budget-"));
fs.mkdirSync(outputDir, { recursive: true });
const dependencyPaths = [project, process.cwd()];
const ts = require(require.resolve("typescript", { paths: dependencyPaths }));
const esbuild = require(require.resolve("esbuild", { paths: dependencyPaths }));
const nodeModules = path.dirname(path.dirname(require.resolve("typescript/package.json", { paths: dependencyPaths })));
const typeRoot = path.dirname(path.dirname(require.resolve("@types/node/package.json", { paths: dependencyPaths })));

async function main() {
  const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, skipLibCheck: true, esModuleInterop: true, noEmit: true,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: ["node"], typeRoots: [typeRoot]
  };
  const host = ts.createCompilerHost(options);
  host.resolveModuleNames = (names, file) => names.map(name => {
    let resolved = ts.resolveModuleName(name, file, options, host).resolvedModule;
    if (!resolved && !name.startsWith(".")) resolved = ts.resolveModuleName(name, path.join(path.dirname(nodeModules), "src/main.ts"), options, host).resolvedModule;
    return resolved;
  });
  const sources = ["src/main.ts", "src/runner.ts", "src/budget.ts", "src/assets.d.ts", "test/budget.test.ts"].map(file => path.join(project, file));
  sources.push(path.join(__dirname, "workbench-budget.test.ts"), path.join(__dirname, "obsidian-stub.ts"));
  const program = ts.createProgram(sources, options, host);
  const errors = ts.getPreEmitDiagnostics(program).filter(item => item.category === ts.DiagnosticCategory.Error).map(item => ({
    file: item.file?.fileName,
    line: item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start).line + 1 : null,
    message: ts.flattenDiagnosticMessageText(item.messageText, "\n")
  }));
  const report = { project, typeErrors: errors, tests: null, noRealApi: true, outputsRoot: outputDir };
  if (errors.length) {
    fs.writeFileSync(path.join(outputDir, "validation.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ typeErrors: errors })); process.exitCode = 1; return;
  }
  const common = { bundle: true, platform: "node", format: "cjs", nodePaths: [nodeModules] };
  await esbuild.build({ ...common, entryPoints: [path.join(__dirname, "workbench-budget.test.ts")], outfile: path.join(outputDir, "workbench-budget-tests.cjs"), plugins: [{
    name: "headless-obsidian", setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(__dirname, "obsidian-stub.ts") }));
      build.onResolve({ filter: /\.md$/ }, () => ({ path: "skill-fixture", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export default "fixture skill";', loader: "js" }));
    }
  }] });
  const checked = spawnSync(process.execPath, ["--test", path.join(outputDir, "workbench-budget-tests.cjs")], { encoding: "utf8" });
  report.tests = { exitCode: checked.status, stdout: checked.stdout, stderr: checked.stderr };
  fs.writeFileSync(path.join(outputDir, "validation.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ typeErrors: [], validation: path.join(outputDir, "validation.json") }));
  process.stdout.write(checked.stdout); process.stderr.write(checked.stderr);
  process.exitCode = checked.status || 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
