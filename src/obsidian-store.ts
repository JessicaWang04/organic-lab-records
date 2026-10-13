import { App, TFile, TFolder } from "obsidian";
import { FileStore, safePath } from "./domain";
export class ObsidianStore implements FileStore {
  constructor(private app: App) {}
  async parents(path: string): Promise<void> {
    const pieces = safePath(path).split("/"); pieces.pop();
    let current = "";
    for (const piece of pieces) {
      current = current ? `${current}/${piece}` : piece;
      const file = this.app.vault.getAbstractFileByPath(current);
      if (file && !(file instanceof TFolder)) throw new Error("父路径不是文件夹");
      if (!file) await this.app.vault.createFolder(current);
    }
  }
  async exists(path: string): Promise<boolean> { return await this.app.vault.adapter.exists(safePath(path)); }
  async read(path: string): Promise<string> { return this.app.vault.adapter.read(safePath(path)); }
  async readBinary(path: string): Promise<Uint8Array> { return new Uint8Array(await this.app.vault.adapter.readBinary(safePath(path))); }
  async write(path: string, content: string, overwrite = false): Promise<void> {
    path = safePath(path); await this.parents(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      if (!overwrite || !(existing instanceof TFile)) throw new Error(`文件已存在：${path}`);
      await this.app.vault.modify(existing, content);
    } else await this.app.vault.create(path, content);
  }
  async binary(path: string, data: Uint8Array, overwrite = false): Promise<void> {
    path = safePath(path); await this.parents(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    if (existing) {
      if (!overwrite || !(existing instanceof TFile)) throw new Error(`文件已存在：${path}`);
      await this.app.vault.modifyBinary(existing, buffer);
    } else await this.app.vault.createBinary(path, buffer);
  }
}
