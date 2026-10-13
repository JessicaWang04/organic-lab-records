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
export async function sourcePages(store: FileStore, chemistry: Chemistry, sources: SourceAsset[], requests: { sourceId: string; page: number; bbox: number[] | null }[]): Promise<{ pages: { sourceId: string; page: number; text: string; image: string; mime: string }[] }> {
  if (!requests.length || requests.length > 8) throw new Error("page_batch_invalid: 一批1至8页");
  const assets = await Promise.all([...new Set(requests.map(r => r.sourceId))].map(async id => {
    const asset = sources.find(s => s.id === id);
    if (!asset) throw new Error(`source_not_found: ${id}`);
    return { id, mime: asset.mime, data: Buffer.from(await store.readBinary(asset.path)).toString("base64") };
  }));
  const result = await chemistry.call<{ pages: { sourceId: string; page: number; text: string; image: string; mime: string }[] }>({ op: "source_pages", sources: assets, pages: requests });
  if (!Array.isArray(result.pages) || result.pages.length !== requests.length || result.pages.some((page, index) => page.sourceId !== requests[index].sourceId || page.page !== requests[index].page || typeof page.text !== "string" || typeof page.image !== "string" || !page.image.length || page.mime !== "image/png")) throw new Error("page_batch_result_invalid: 缺少与请求顺序对应的真实页面");
  return result;
}
