import { spawn } from "node:child_process";
export interface Chemistry { call<T = Record<string, unknown>>(request: Record<string, unknown>): Promise<T> }
export class PythonChemistry implements Chemistry {
  constructor(private python: string, private worker: string) {}
  async call<T>(request: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, [this.worker], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" }, stdio: ["pipe", "pipe", "pipe"] });
      const output: Buffer[] = []; let size = 0; let finished = false;
      const done = (error?: Error, value?: T) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(value as T); };
      const timer = setTimeout(() => { child.kill(); done(new Error("本地工具超时（90 秒）")); }, 90000);
      child.on("error", error => done(new Error(`无法启动本地 Python：${error.message}`)));
      child.stdin.on("error", () => undefined);
      child.stderr.on("data", () => undefined);
      child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024 * 1024) { child.kill(); done(new Error("本地工具输出超过64MB")); } else output.push(chunk); });
      child.on("close", code => {
        try {
          if (code !== 0) throw new Error(`本地工具进程退出：${code}`);
          const envelope = JSON.parse(Buffer.concat(output).toString("utf8"));
          if (!envelope.ok) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
          done(undefined, envelope.result as T);
        } catch (error) { done(error instanceof Error ? error : new Error(String(error))); }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}
