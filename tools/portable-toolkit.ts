import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { Chemistry } from "../src/chemistry";
import { safePath, slug, SourceAsset, validatePlan } from "../src/domain";
import { AgentRunner, ProtocolItem, SessionState } from "../src/runner";
import { indexSource } from "../src/sources";
import { TOOLS, validateToolCall } from "../src/tools";
import { LocalStore } from "./local-store";
import { auditDelivery } from "../src/delivery";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request_invalid: 需要 JSON 对象");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`request_invalid: 缺少 ${field}`);
  return value;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
function location(value: unknown): { vault: string; routeId: string; dir: string } {
  const request = object(value), vault = text(request.vault, "vault"), routeId = text(request.routeId, "routeId");
  if (!isAbsolute(vault)) throw new Error("vault_invalid: vault 需要绝对路径");
  if (slug(routeId) !== routeId || /^[. ]|[. ]$/.test(routeId) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(routeId)) throw new Error("route_id_invalid: routeId 需要安全的单个文件夹名");
  return { vault: resolve(vault), routeId, dir: safePath(`Organic Lab/${routeId}`) };
}
function assertSession(value: unknown): asserts value is SessionState {
  const state = object(value);
  for (const field of ["id", "dir", "prompt", "status"]) text(state[field], field);
  for (const field of ["turns", "calls"]) if (!Number.isInteger(state[field]) || Number(state[field]) < 0) throw new Error(`session_invalid: ${field}`);
  for (const field of ["sources", "context", "events"]) if (!Array.isArray(state[field])) throw new Error(`session_invalid: ${field}`);
  for (const field of ["rendered", "written", "receipts"]) object(state[field]);
  if (state.executions !== undefined) {
    for (const entry of Object.values(object(state.executions))) {
      const execution = object(entry); text(execution.name, "execution.name");
      if (typeof execution.arguments !== "string" || !["started", "waiting", "completed"].includes(String(execution.phase))) throw new Error("session_invalid: execution");
      if (execution.phase === "completed") object(execution.output);
    }
  }
  if (Array.isArray(state.sources)) for (const sourceValue of state.sources) {
    const source = object(sourceValue);
    for (const field of ["id", "name", "mime", "path"]) text(source[field], `source.${field}`);
    safePath(String(source.path));
    if (!Array.isArray(source.pages) || source.pages.some(page => !Number.isInteger(object(page).page) || typeof object(page).text !== "string")) throw new Error("session_invalid: source.pages");
  }
  // validatePlan checks persisted domain invariants after the state boundary has been checked.
  if (state.plan !== null) {
    const plan = object(state.plan);
    if (typeof plan.title !== "string" || typeof plan.intent !== "string" || !Array.isArray(plan.steps) || !Array.isArray(plan.requestedChanges)) throw new Error("session_invalid: plan");
  }
}

export class LocalToolkit {
  constructor(private chemistry: Chemistry) {}
  private async locked<T>(vault: string, dir: string, operation: (store: LocalStore) => Promise<T>): Promise<T> {
    const store = new LocalStore(vault); await mkdir(store.full(dir), { recursive: true });
    const lockPath = store.full(`${dir}/.organic-lab.lock`);
    let lock;
    try { lock = await open(lockPath, "wx"); }
    catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new Error("session_busy: 此路线已有本地操作；若上次进程被强制结束，确认已停止后移除 .organic-lab.lock 再重试");
      throw error;
    }
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() })); return await operation(store); }
    finally { await lock.close(); await unlink(lockPath); }
  }
  private async load(store: LocalStore, routeId: string, dir: string): Promise<SessionState> {
    const state: unknown = JSON.parse(await store.read(`${dir}/会话状态.json`)); assertSession(state);
    if (state.id !== routeId || state.dir !== dir) throw new Error("session_location_conflict: 会话身份与输出目录不一致");
    if (state.plan) validatePlan(state.plan);
    return state;
  }
  private runner(state: SessionState, store: LocalStore): AgentRunner {
    return new AgentRunner(state, store, this.chemistry, { turn: async () => { throw new Error("local_only: 本工具不调用模型 API"); } }, () => undefined);
  }
  async init(value: unknown): Promise<ProtocolItem> {
    const request = object(value), { vault, routeId, dir } = location(request), prompt = text(request.prompt, "prompt");
    if (!Array.isArray(request.sources) || !request.sources.length || request.sources.length > 32) throw new Error("sources_invalid: 需要 1–32 个本地来源");
    const ids = new Set<string>();
    const inputs = await Promise.all(request.sources.map(async sourceValue => {
      const source = object(sourceValue), id = text(source.id, "source.id"), path = text(source.path, "source.path");
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id)) throw new Error("source_id_invalid: 来源 ID 需要唯一的字母数字短横线或下划线"); ids.add(id);
      if (!isAbsolute(path)) throw new Error("source_path_invalid: 来源需要绝对路径");
      const extension = extname(path).toLowerCase();
      const mime = extension === ".pdf" ? "application/pdf" : extension === ".png" ? "image/png" : [".jpg", ".jpeg"].includes(extension) ? "image/jpeg" : null;
      if (!mime) throw new Error("source_type_invalid: 仅接受 PDF、PNG、JPEG");
      const name = source.name === undefined ? basename(path) : text(source.name, "source.name");
      return { id, name, mime, path: `${dir}/sources/${id}${extension}`, bytes: new Uint8Array(await readFile(path)) };
    }));
    return this.locked(vault, dir, async store => {
      if (await store.exists(`${dir}/会话状态.json`)) {
        const existing = await this.load(store, routeId, dir);
        if (existing.prompt !== prompt || existing.sources.length !== inputs.length) throw new Error("route_exists: 路线已存在；请选择新 routeId 或读取 status 后继续");
        for (const source of inputs) {
          const archived = existing.sources.find(item => item.id === source.id);
          if (!archived || archived.name !== source.name || archived.path !== source.path || !Buffer.from(await store.readBinary(source.path)).equals(Buffer.from(source.bytes))) throw new Error("route_exists: 来源与已有路线不同，保留原记录");
        }
        if (existing.status === "completed") {
          const delivery = await auditDelivery(existing, store, this.chemistry);
          if (!delivery.complete) {
            existing.status = "deliveryIncomplete";
            await this.runner(existing, store).event("delivery_reopened", { delivery });
          }
          return { ...this.summary(existing, vault), delivery, reused: true };
        }
        return { ...this.summary(existing, vault), reused: true };
      }
      const sources: SourceAsset[] = [];
      for (const input of inputs) {
        if (await store.exists(input.path)) {
          if (!Buffer.from(await store.readBinary(input.path)).equals(Buffer.from(input.bytes))) throw new Error("source_conflict: 保留已有来源文件");
        } else await store.binary(input.path, input.bytes);
        sources.push(await indexSource(store, this.chemistry, { id: input.id, name: input.name, path: input.path, mime: input.mime, pages: [] }));
      }
      const state: SessionState = { id: routeId, dir, prompt, status: "localReady", sources, context: [], turns: 0, calls: 0, plan: null, rendered: {}, written: {}, receipts: {}, events: [], question: null };
      await this.runner(state, store).event("local_initialized", { modelRequests: 0, sourceIds: sources.map(source => source.id) });
      return this.summary(state, vault);
    });
  }
  private summary(state: SessionState, vault: string): ProtocolItem {
    return { vault, routeId: state.id, directory: join(vault, state.dir), status: state.status, modelRequests: state.turns, localCalls: state.calls,
      sources: state.sources.map(source => ({ id: source.id, name: source.name, path: join(vault, source.path), pages: source.pages.length })),
      steps: state.plan?.steps.map(step => ({ order: step.order, title: step.title, written: state.written[step.order] ?? null, artifacts: state.rendered[step.order] ?? null })) ?? [],
      journal: join(vault, state.dir, "会话状态.json") };
  }
  async status(value: unknown): Promise<ProtocolItem> {
    const { vault, routeId, dir } = location(value);
    return this.locked(vault, dir, async store => {
      const state = await this.load(store, routeId, dir);
      const delivery = await auditDelivery(state, store, this.chemistry);
      if (state.status === "completed" && !delivery.complete) {
        state.status = "deliveryIncomplete";
        await this.runner(state, store).event("delivery_reopened", { delivery });
      }
      return { ...this.summary(state, vault), delivery };
    });
  }
  async call(value: unknown): Promise<ProtocolItem> {
    const request = object(value), { vault, routeId, dir } = location(request);
    const tool = text(request.tool, "tool"), callId = text(request.callId, "callId");
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(callId)) throw new Error("call_id_invalid: callId 使用唯一字母数字短横线或下划线");
    if (tool === "ask_user") throw new Error("host_question: 由宿主直接向用户提问，确认后继续本地工具");
    validateToolCall(tool, request.args); const args = object(request.args), argumentsText = JSON.stringify(canonical(args));
    return this.locked(vault, dir, async store => {
      const state = await this.load(store, routeId, dir), runner = this.runner(state, store), previous = state.executions?.[callId];
      if (previous && (previous.name !== tool || previous.arguments !== argumentsText)) throw new Error("call_id_conflict: 同一 callId 对应不同请求，请使用新 ID");
      if (previous?.phase === "completed") {
        if (typeof previous.output.output !== "string") throw new Error("receipt_invalid: 本地回执格式不正确");
        const result: unknown = JSON.parse(previous.output.output);
        try { await runner.validateCachedDelivery(tool, args); }
        catch (error) { await runner.event("cached_delivery_rejected", { tool, callId }); throw error; }
        if (tool === "validate_route") return { callId, tool, reused: false, result: await runner.execute(tool, args), status: state.status };
        return { callId, tool, reused: true, result, status: state.status };
      }
      if (state.status === "completed" && !["validate_route", "read_source_page", "search_sources", "inspect_structure", "locate_reaction", "finish_route", "render_step", "write_step"].includes(tool)) throw new Error("route_completed: 已完成的路线需要由用户修改记录或新建路线");
      state.executions ??= {};
      if (!previous) state.calls++;
      state.executions[callId] = { name: tool, arguments: argumentsText, phase: "started" };
      await runner.event("local_tool_started", { tool, callId });
      let result: ProtocolItem;
      try { result = await runner.execute(tool, args); }
      catch (error: unknown) { await runner.event("local_tool_failed", { tool, callId, message: error instanceof Error ? error.message : String(error) }); throw error; }
      if (tool === "validate_route" && state.status === "completed" && result.complete === false) state.status = "deliveryIncomplete";
      if (tool === "read_source_page" && typeof result.image === "string") {
        const path = `${dir}/assets/read-page-${createHash("sha256").update(argumentsText).digest("hex").slice(0, 14)}.png`;
        const bytes = Buffer.from(result.image, "base64");
        if (await store.exists(path)) {
          if (!Buffer.from(await store.readBinary(path)).equals(bytes)) throw new Error("source_image_conflict: 已保存的来源页面图不同，保留原文件");
        } else await store.binary(path, bytes);
        result = { ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== "image")), imageFile: join(vault, path) };
      }
      state.executions[callId] = { name: tool, arguments: argumentsText, phase: "completed", output: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) } };
      await runner.event("local_tool_completed", { tool, callId, result });
      return { callId, tool, reused: false, result, status: state.status };
    });
  }
  static contracts(): unknown { return TOOLS.filter(tool => tool.name !== "ask_user"); }
}
