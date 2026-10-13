import assert from "node:assert/strict";
import { fixtureDeliveryVerification, fixtureInventory } from "./delivery-fixture";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Chemistry } from "../src/chemistry";
import { ExperimentStep } from "../src/domain";
import { LocalToolkit } from "../tools/portable-toolkit";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const noChemistry: Chemistry = { call: async <T>(request: Record<string, unknown>) => fixtureDeliveryVerification(request) as T };
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const prefix = join(tmpdir(), "organic-lab-test-");
  const root = await mkdtemp(prefix), source = join(root, "source.png"), vault = join(root, "vault");
  await writeFile(source, png);
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(prefix))); await rm(root, { recursive: true, force: true }); });
  const request = { vault, routeId: "route-1", prompt: "fixture, not an experimental protocol", sources: [{ id: "image", path: source }] };
  const toolkit = new LocalToolkit(noChemistry); await toolkit.init(request);
  return { root, vault, source, request, dir: join(vault, "Organic Lab", "route-1"), toolkit };
}
const step = (): ExperimentStep => ({ order: 1, paperStep: "1", title: "fixture step", purpose: "offline fixture only", reactants: ["CCO"], products: ["CC=O"], reagents: [], aboveArrow: [], belowArrow: [], procedure: [], workup: [], purification: [], characterization: [], citations: [{ sourceId: "image", page: 1, quote: "fixture" }], referenceBasisMmol: null, referenceYield: null, yieldScope: null, conflicts: [], sourceImage: null, scaleMmol: null, scaleBasisId: null });

test("portable init reuses identical input without resetting state or handwritten notes", async t => {
  const f = await fixture(t); await writeFile(join(f.dir, "user-note.md"), "handwritten observation");
  const response = await new LocalToolkit(noChemistry).init(f.request); assert.equal(response.reused, true);
  assert.equal(await readFile(join(f.dir, "user-note.md"), "utf8"), "handwritten observation");
  assert.equal((await f.toolkit.status(f.request)).modelRequests, 0);
  await assert.rejects(f.toolkit.init({ ...f.request, prompt: "different task" }), /route_exists/);
});
test("portable source changes cannot overwrite an existing route", async t => {
  const f = await fixture(t); await writeFile(f.source, "different input");
  await assert.rejects(f.toolkit.init(f.request), /route_exists/);
  assert.deepEqual(await readFile(join(f.dir, "sources", "image.png")), png);
});
test("portable paths and malformed tool calls are rejected before execution", async t => {
  const f = await fixture(t);
  await assert.rejects(f.toolkit.status({ vault: f.vault, routeId: "../escape" }), /route_id_invalid/);
  await assert.rejects(f.toolkit.status({ vault: "relative", routeId: "route" }), /vault_invalid/);
  await assert.rejects(f.toolkit.call({ ...f.request, tool: "set_scale", args: { step: 1 }, callId: "bad" }), /tool_arguments_invalid/);
  await assert.rejects(f.toolkit.call({ ...f.request, tool: "ask_user", args: { question: "scale?" }, callId: "ask" }), /host_question/);
  assert.equal((await f.toolkit.status(f.request)).localCalls, 0);
});
test("portable saved receipt prevents duplicate execution across fresh processes and rejects changed arguments", async t => {
  const f = await fixture(t); let executions = 0;
  const chemistry: Chemistry = { call: async <T>() => { executions++; return { smiles: "CCO", mw: 46.07 } as T; } };
  const request = { ...f.request, tool: "inspect_structure", args: { smiles: "CCO" }, callId: "inspect-1" };
  await new LocalToolkit(chemistry).call(request);
  assert.equal((await new LocalToolkit(noChemistry).call(request)).reused, true); assert.equal(executions, 1);
  await assert.rejects(new LocalToolkit(chemistry).call({ ...request, args: { smiles: "CCN" } }), /call_id_conflict/);
  assert.equal((await f.toolkit.status(f.request)).localCalls, 1);
});
test("portable interrupted local call retries its saved checkpoint without charging twice", async t => {
  const f = await fixture(t); let attempts = 0;
  const chemistry: Chemistry = { call: async <T>() => { attempts++; if (attempts === 1) throw new Error("fixture retry"); return { smiles: "CCO" } as T; } };
  const request = { ...f.request, tool: "inspect_structure", args: { smiles: "CCO" }, callId: "retry-1" };
  await assert.rejects(new LocalToolkit(chemistry).call(request), /fixture retry/);
  await new LocalToolkit(chemistry).call(request);
  assert.equal((await f.toolkit.status(f.request)).localCalls, 1); assert.equal(attempts, 2);
});
test("portable lock prevents two instances from operating on the same route", async t => {
  const f = await fixture(t); let release: () => void = () => undefined, started: () => void = () => undefined;
  const pending = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { started = resolve; });
  const chemistry: Chemistry = { call: async <T>() => { started(); await pending; return { smiles: "CCO" } as T; } };
  const request = { ...f.request, tool: "inspect_structure", args: { smiles: "CCO" }, callId: "locked" };
  const first = new LocalToolkit(chemistry).call(request); await requested;
  await assert.rejects(new LocalToolkit(noChemistry).call({ ...request, callId: "other" }), /session_busy/);
  release(); await first; assert.equal((await f.toolkit.status(f.request)).localCalls, 1);
});
test("portable page reads return a real local image for host visual inspection", async t => {
  const f = await fixture(t);
  const chemistry: Chemistry = { call: async <T>() => ({ text: "", png: png.toString("base64") }) as T };
  const response = await new LocalToolkit(chemistry).call({ ...f.request, tool: "read_source_page", args: { sourceId: "image", page: 1, bbox: null }, callId: "read-1" });
  const result = response.result as { imageFile: string; image?: string };
  assert.equal(result.image, undefined); assert.deepEqual(await readFile(result.imageFile), png);
  assert.ok(!(await readFile(join(f.dir, "会话状态.json"), "utf8")).includes(png.toString("base64")));
  const reused = await f.toolkit.call({ ...f.request, tool: "read_source_page", args: { bbox: null, page: 1, sourceId: "image" }, callId: "read-1" });
  assert.equal(reused.reused, true);
});
test("portable batch page read saves ordered real images without base64 in the journal", async t => {
  const f = await fixture(t);
  const chemistry: Chemistry = { call: async <T>(request: Record<string, unknown>) => {
    assert.equal(request.op, "source_pages");
    return { pages: (request.pages as { sourceId: string; page: number }[]).map(page => ({ ...page, text: "fixture", image: png.toString("base64"), mime: "image/png" })) } as T;
  } };
  const response = await new LocalToolkit(chemistry).call({ ...f.request, tool: "read_source_pages", args: { pages: [{ sourceId: "image", page: 1, bbox: [.1, .1, .6, .6] }, { sourceId: "image", page: 1, bbox: null }] }, callId: "batch-read" });
  const result = response.result as { pages: { imageFile: string; image?: string }[] };
  assert.equal(result.pages.length, 2);
  for (const page of result.pages) { assert.equal(page.image, undefined); assert.deepEqual(await readFile(page.imageFile), png); }
  assert.notEqual(result.pages[0].imageFile, result.pages[1].imageFile);
  assert.ok(!(await readFile(join(f.dir, "会话状态.json"), "utf8")).includes(png.toString("base64")));
});

test("portable toolkit creates the complete record set without any model API", async t => {
  const f = await fixture(t);
  const chemistry: Chemistry = { call: async <T>(request: Record<string, unknown>) => {
    if (["verify_delivery", "verify_compounds", "check_binding"].includes(String(request.op))) return fixtureDeliveryVerification(request) as T;
    assert.equal(request.op, "render_step"); return { png: png.toString("base64"), cdxml: "fixture CDXML", quality: {}, properties: [] } as T;
  } };
  const toolkit = new LocalToolkit(chemistry);
  await toolkit.call({ ...f.request, tool: "record_inventory", args: { inventory: fixtureInventory([step()], "image") }, callId: "inventory" });
  await toolkit.call({ ...f.request, tool: "register_compounds", args: { structures: [{ compoundId: "c1", smiles: "CCO" }, { compoundId: "c2", smiles: "CC=O" }] }, callId: "compounds" });
  const calls = [{ tool: "record_route", args: { plan: { title: "fixture route", intent: "offline reusable tool validation", requestedChanges: [], steps: [step()] } } }, { tool: "render_step", args: { step: 1 } }, { tool: "write_step", args: { step: 1 } }, { tool: "finish_route", args: {} }];
  for (const [index, call] of calls.entries()) {
    const request = { ...f.request, ...call, callId: `tool-${index}` };
    const response = await toolkit.call(request);
    if (call.tool === "record_route") await toolkit.call({ ...f.request, tool: "bind_steps", args: { bindings: [{ step: 1, experimentId: "e1", reagents: [] }] }, callId: "bind" });
    if (call.tool === "render_step" || call.tool === "write_step") {
      const result = response.result as { image?: string; imageFile?: string; artifacts?: { image: string } };
      assert.equal(result.imageFile, undefined, "rendered image paths must not be decoded as source-page base64");
      const imagePath = call.tool === "render_step" ? result.artifacts?.image : result.image;
      assert.equal(typeof imagePath, "string");
      assert.deepEqual(await readFile(join(f.vault, imagePath!)), png);
      const reused = await new LocalToolkit(noChemistry).call(request);
      assert.equal(reused.reused, true);
      assert.deepEqual(reused.result, result);
    }
  }
  assert.ok(!(await readdir(join(f.dir, "assets"))).some(name => name.startsWith("read-page-")), "render/write must not manufacture a source-page image");
  const status = await toolkit.status(f.request); assert.equal(status.status, "completed"); assert.equal(status.modelRequests, 0);
  assert.ok((await readFile(join(f.dir, "route-1-01-R01-fixture step.md"), "utf8")).includes("实际操作与现象记录"));
  assert.ok((await readFile(join(f.dir, "路线.base"), "utf8")).includes("imageFit: contain"));
  assert.equal((await toolkit.call({ ...f.request, ...calls[3], callId: "tool-3" })).reused, true);
  const completedState = JSON.parse(await readFile(join(f.dir, "会话状态.json"), "utf8"));
  await rm(join(f.vault, completedState.rendered[1].cdxml));
  await assert.rejects(toolkit.call({ ...f.request, ...calls[3], callId: "tool-3" }), /artifact_missing/);
  const reopened = await toolkit.status(f.request);
  assert.equal(reopened.status, "deliveryIncomplete");
  assert.equal((reopened.delivery as { complete: boolean }).complete, false);
  const freshReport = await toolkit.call({ ...f.request, tool: "validate_route", args: {}, callId: "audit-1" });
  assert.equal((freshReport.result as { complete: boolean }).complete, false);
  await writeFile(join(f.vault, completedState.rendered[1].cdxml), "fixture CDXML");
  const repeatReport = await toolkit.call({ ...f.request, tool: "validate_route", args: {}, callId: "audit-1" });
  assert.equal((repeatReport.result as { complete: boolean }).complete, true, "read-only audits must refresh even with the same call ID");
});
