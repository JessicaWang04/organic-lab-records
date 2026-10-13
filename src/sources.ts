import { Chemistry } from "./chemistry";
import { FileStore, SourceAsset, SourcePage } from "./domain";
export async function indexSource(store: FileStore, chemistry: Chemistry, asset: SourceAsset): Promise<SourceAsset> {
  if (asset.mime !== "application/pdf") return asset;
  const data = Buffer.from(await store.readBinary(asset.path)).toString("base64");
  const index = await chemistry.call<{ pages: SourcePage[] }>({ op: "pdf_index", data });
  return { ...asset, pages: index.pages };
}
export function searchSources(sources: SourceAsset[], query: string, limit = 8): { sourceId: string; name: string; page: number; text: string; score: number }[] {
  if (!query.trim()) throw new Error("需要检索词");
  const tokens = query.toLowerCase().match(/[a-z\d]+|[\u4e00-\u9fff]+/g) ?? [];
  return sources.flatMap(source => source.pages.map(page => {
    const text = page.text.toLowerCase();
    const score = tokens.reduce((sum, token) => sum + (text.includes(token) ? token.length + 1 : 0), 0) + (text.includes(query.toLowerCase()) ? 30 : 0);
    const first = Math.max(0, text.indexOf(query.toLowerCase()));
    return { sourceId: source.id, name: source.name, page: page.page, text: page.text.slice(Math.max(0, first - 300), first + 9000), score };
  })).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.min(20, Math.max(1, limit)));
}
export async function sourcePage(store: FileStore, chemistry: Chemistry, asset: SourceAsset, page: number, bbox: number[] | null = null): Promise<{ text: string; png: string }> {
  const data = Buffer.from(await store.readBinary(asset.path)).toString("base64");
  if (asset.mime !== "application/pdf") return chemistry.call({ op: "image_crop", data, bbox });
  return chemistry.call({ op: "pdf_page", data, page, bbox });
}
