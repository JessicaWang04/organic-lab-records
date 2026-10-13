import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { parse } from "yaml";

interface Manifest { version: number; always_load: string[]; source_formats: Record<string, string[]>; topics: Record<string, string[]> }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("guide_request_invalid");
  return value as Record<string, unknown>;
}
export async function loadManifest(root: string): Promise<Manifest> {
  const value = object(parse(await readFile(resolve(root, "manifest.yaml"), "utf8")));
  if (value.version !== 1 || !Array.isArray(value.always_load) || !value.always_load.length) throw new Error("guide_manifest_invalid");
  const maps = [object(value.source_formats), object(value.topics)];
  for (const paths of [value.always_load, ...maps.flatMap(map => Object.values(map))]) {
    if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== "string" || !path.endsWith(".md"))) throw new Error("guide_manifest_invalid");
  }
  const manifest = value as unknown as Manifest;
  const paths = [...new Set([...manifest.always_load, ...maps.flatMap(map => Object.values(map) as string[][]).flat()])];
  await Promise.all(paths.map(path => readGuideFile(root, path)));
  return manifest;
}
async function readGuideFile(root: string, path: string) {
  if (isAbsolute(path)) throw new Error("guide_path_invalid");
  const base = await realpath(root), target = await realpath(resolve(base, path)), rel = relative(base, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("guide_path_invalid");
  const content = await readFile(target, "utf8");
  if (!content.trim()) throw new Error(`guide_empty: ${path}`);
  return { path, absolutePath: target, sha256: createHash("sha256").update(content).digest("hex"), content };
}
export async function guidance(root: string, input: unknown) {
  const request = object(input), manifest = await loadManifest(root);
  if (Object.keys(request).some(key => !["sourceFormat", "topics"].includes(key)) || typeof request.sourceFormat !== "string" || !Object.hasOwn(manifest.source_formats, request.sourceFormat) || !Array.isArray(request.topics) || request.topics.some(topic => typeof topic !== "string" || !Object.hasOwn(manifest.topics, topic))) throw new Error("guide_request_invalid: 使用manifest中的sourceFormat和topics");
  const selections = new Map<string, string[]>();
  const add = (paths: string[], reason: string) => paths.forEach(path => selections.set(path, [...(selections.get(path) ?? []), reason]));
  add(manifest.always_load, "always"); add(manifest.source_formats[request.sourceFormat], `source:${request.sourceFormat}`);
  for (const topic of new Set(request.topics as string[])) add(manifest.topics[topic], `topic:${topic}`);
  const layers = await Promise.all([...selections].map(async ([path, reasons]) => ({ ...await readGuideFile(root, path), reasons })));
  return { sourceFormat: request.sourceFormat, topics: request.topics, layers, bytes: layers.reduce((n, layer) => n + Buffer.byteLength(layer.content), 0), modelRequests: 0 };
}
