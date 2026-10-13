import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { FileStore, safePath } from "../src/domain";
export class LocalStore implements FileStore {
  constructor(public root: string) {}
  full(path: string): string { return join(this.root, safePath(path)); }
  async exists(path: string) { try { await stat(this.full(path)); return true; } catch { return false; } }
  async read(path: string) { return readFile(this.full(path), "utf8"); }
  async readBinary(path: string) { return new Uint8Array(await readFile(this.full(path))); }
  async write(path: string, content: string, overwrite = false) { const full = this.full(path); await mkdir(dirname(full), { recursive: true }); await writeFile(full, content, { flag: overwrite ? "w" : "wx" }); }
  async binary(path: string, content: Uint8Array) { const full = this.full(path); await mkdir(dirname(full), { recursive: true }); await writeFile(full, content, { flag: "wx" }); }
}
