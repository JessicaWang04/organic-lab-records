import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { guidance, loadManifest } from "../tools/guidance";
const root = resolve("portable/organic-lab-records");
test("manifest resolves every real layer and core cannot be omitted", async () => {
  const manifest = await loadManifest(root);
  for (const sourceFormat of Object.keys(manifest.source_formats)) {
    const result = await guidance(root, { sourceFormat, topics: [] });
    assert.equal(result.modelRequests, 0);
    assert.ok(manifest.always_load.every(path => result.layers.some(layer => layer.path === path && layer.reasons.includes("always"))));
    assert.ok(result.layers.every(layer => /^[a-f0-9]{64}$/.test(layer.sha256) && layer.content.length > 20));
  }
});
test("only requested topics load; duplicate topics do not repeat content", async () => {
  const minimal = await guidance(root, { sourceFormat: "pdf-text", topics: [] });
  const selected = await guidance(root, { sourceFormat: "pdf-text", topics: ["stereo", "stereo", "recovery"] });
  assert.equal(selected.layers.length, minimal.layers.length + 2);
  assert.ok(!selected.layers.some(layer => layer.path.includes("worked-examples")));
  const manifest = await loadManifest(root);
  const full = await guidance(root, { sourceFormat: "pdf-text", topics: Object.keys(manifest.topics) });
  assert.ok(minimal.bytes < full.bytes);
});
test("unknown or malformed selections cannot control paths or skip core", async () => {
  for (const request of [{ sourceFormat: "../../secret", topics: [] }, { sourceFormat: "pdf-text", topics: ["../../secret"] }, { sourceFormat: "pdf-text", topics: [], always_load: [] }, { sourceFormat: "pdf-text", topics: "stereo" }]) await assert.rejects(guidance(root, request), /guide_request_invalid/);
});
