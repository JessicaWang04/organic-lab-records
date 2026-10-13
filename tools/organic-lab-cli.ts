import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { PythonChemistry } from "../src/chemistry";
import { LocalToolkit } from "./portable-toolkit";
import { prepareObsidianVault } from "./prepare-obsidian-vault";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const base = dirname(process.argv[1]);
  let python = process.env.ORGANIC_LAB_PYTHON;
  if (!python) {
    try {
      const config: unknown = JSON.parse(await readFile(join(base, "..", "runtime.json"), "utf8"));
      if (config && typeof config === "object" && "pythonPath" in config && typeof config.pythonPath === "string") python = config.pythonPath;
    } catch {}
  }
  python ??= "python";
  if (command === "doctor") {
    const code = "import sys,json,importlib.util; print(json.dumps({'python':sys.executable,'version':sys.version.split()[0],'rdkit':importlib.util.find_spec('rdkit') is not None,'Pillow':importlib.util.find_spec('PIL') is not None,'PyMuPDF':importlib.util.find_spec('pymupdf') is not None}))";
    const { stdout } = await promisify(execFile)(python, ["-c", code], { windowsHide: true, timeout: 15000 });
    const dependencies: unknown = JSON.parse(stdout);
    if (!dependencies || typeof dependencies !== "object" || !("rdkit" in dependencies) || !dependencies.rdkit || !("Pillow" in dependencies) || !dependencies.Pillow || !("PyMuPDF" in dependencies) || !dependencies.PyMuPDF) throw new Error(`dependencies_missing: ${stdout.trim()}；完整图片/PDF流程需要 RDKit、Pillow 和 PyMuPDF`);
    const chemistry = new PythonChemistry(python, join(base, "chemistry_worker.py"));
    const check = await chemistry.call({ op: "inspect", smiles: "CCO" });
    console.log(JSON.stringify({ status: "ready", dependencies, chemistry: check, modelRequests: 0 })); return;
  }
  if ([undefined, "help", "--help", "-h"].includes(command)) {
    console.log("Organic Lab 本地工具（无模型 API）\n  doctor\n  prepare-vault --request vault.json\n  init --request init.json\n  call --request call.json\n  status --request status.json\n使用 UTF-8 JSON 文件传参；工作流和工具参数见 Skill 的 references/commands.md 与 tools.json。"); return;
  }
  if (!["init", "call", "status", "prepare-vault"].includes(command ?? "") || args.length !== 2 || args[0] !== "--request") throw new Error("command_invalid: 使用 prepare-vault|init|call|status --request <JSON文件>");
  const request: unknown = JSON.parse((await readFile(args[1], "utf8")).replace(/^\uFEFF/, ""));
  if (command === "prepare-vault") {
    const interpreter = await promisify(execFile)(python, ["-B", "-X", "utf8", "-c", "import sys; print(sys.executable)"], { windowsHide: true, timeout: 15000 });
    const result = await prepareObsidianVault(request, { pluginDir: join(base, "..", "assets", "obsidian-plugin"), pythonPath: interpreter.stdout.trim() });
    console.log(JSON.stringify(result, null, 2)); return;
  }
  const toolkit = new LocalToolkit(new PythonChemistry(python, join(base, "chemistry_worker.py")));
  const result = command === "init" ? await toolkit.init(request) : command === "call" ? await toolkit.call(request) : await toolkit.status(request);
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error: unknown) => { console.error(JSON.stringify({ status: "error", message: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });
