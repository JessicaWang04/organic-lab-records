export class Element {
  textContent = ""; value = ""; disabled = false; hidden = false;
  children: Element[] = [];
  setText(value: string): void { this.textContent = value; }
  empty(): void { this.children = []; }
  addClass(): void {}
  createEl(_tag: string, options?: { text?: string; value?: string }): Element {
    const element = new Element(); element.textContent = options?.text ?? ""; element.value = options?.value ?? "";
    this.children.push(element); return element;
  }
  createDiv(): Element { return this.createEl("div"); }
}
export class WorkspaceLeaf { view: unknown; constructor(public app: unknown) {} }
export class ItemView {
  app: unknown; contentEl = new Element();
  constructor(public leaf: WorkspaceLeaf) { this.app = leaf.app; }
  registerDomEvent(): void {}
}
export class Plugin {
  viewFactories = new Map<string, (leaf: WorkspaceLeaf) => unknown>();
  saves: unknown[] = []; saveError: Error | null = null;
  constructor(public app: unknown, public manifest: unknown) {}
  async loadData(): Promise<unknown> { return null; }
  async saveData(value: unknown): Promise<void> {
    if (this.saveError) throw this.saveError;
    this.saves.push(structuredClone(value));
  }
  registerView(name: string, factory: (leaf: WorkspaceLeaf) => unknown): void { this.viewFactories.set(name, factory); }
  addRibbonIcon(): void {}
  addCommand(): void {}
  addSettingTab(): void {}
  registerMarkdownCodeBlockProcessor(): void {}
  registerMarkdownPostProcessor(): void {}
}
export const notices: string[] = [];
export class Notice { constructor(text: string) { notices.push(text); } }
export class PluginSettingTab { containerEl = new Element(); constructor(public app: unknown, public plugin: unknown) {} }
export class FileSystemAdapter {}
export class TFile {}
export class TFolder {}
export class Modal {
  titleEl = new Element(); contentEl = new Element(); constructor(public app: unknown) {}
  open(): void {} close(): void {}
}
export class Setting { constructor(public container: unknown) {} }
export async function requestUrl(): Promise<never> { throw new Error("unexpected API request"); }
