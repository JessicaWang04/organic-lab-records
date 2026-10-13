import { ProtocolItem, Transport, Turn } from "./runner";
import { TOOLS } from "./tools";
export interface ProviderConfig { baseUrl: string; model: string; apiKey: string; instructions: string; maxOutputTokens: number }
export interface HttpResponse { status: number; text: string }
export type Http = (method: string, url: string, headers: Record<string, string>, body?: string) => Promise<HttpResponse>;
export function endpoint(base: string, path: string): string {
  const url = new URL(base.replace(/\/+$/, "") + "/" + path);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)))) throw new Error("API地址需要HTTPS（本机可用HTTP），不能夹带凭据或查询参数");
  return url.toString();
}
function failure(response: HttpResponse, key: string): Error {
  let code = "request_rejected", message = "模型请求失败";
  try {
    const error = JSON.parse(response.text).error;
    code = String(error?.code || error?.type || code).replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80);
    message = String(error?.message || message).split(key).join("[key]").replace(/data:[^\s"']+/g, "[image]").replace(/Bearer\s+\S+/gi, "Bearer [token]").slice(0, 500);
  } catch {}
  return new Error(`HTTP ${response.status} · ${code}: ${message}`);
}
export function parseResponse(text: string): Turn {
  let data: Record<string, unknown>;
  if (text.trim().startsWith("data:") || text.includes("event: response.")) {
    const completed = text.split(/\r?\n/).filter(line => line.startsWith("data:")).flatMap(line => {
      try { return [JSON.parse(line.slice(5).trim())]; } catch { return []; }
    }).find(event => event.type === "response.completed");
    if (!completed?.response) throw new Error("response_incomplete: 流式响应未完整结束");
    data = completed.response;
  } else data = JSON.parse(text);
  if (data.status === "incomplete" || data.status === "failed" || data.error) throw new Error("response_incomplete: 模型没有完成输出");
  if (!Array.isArray(data.output)) throw new Error("native_tools_missing: 服务未返回Responses原生output，不把普通JSON冒充工具调用");
  const output = (data.output as ProtocolItem[]).map(item => {
    if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || typeof item.arguments !== "string") throw new Error("tool_envelope_invalid: 工具调用缺少有效call_id/name/arguments");
      return { type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments };
    }
    if (item.type === "reasoning") return { type: "reasoning", id: item.id, summary: item.summary ?? [], ...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}) };
    return item;
  });
  const callIds = output.filter(item => item.type === "function_call").map(item => item.call_id);
  if (new Set(callIds).size !== callIds.length) throw new Error("duplicate_call_id: 模型响应含重复工具调用ID");
  return { output, usage: data.usage };
}
export class ResponsesTransport implements Transport {
  constructor(private config: ProviderConfig, private http: Http) {}
  async turn(input: ProtocolItem[]): Promise<Turn> {
    const response = await this.http("POST", endpoint(this.config.baseUrl, "responses"), {
      Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json"
    }, JSON.stringify({
      model: this.config.model, instructions: this.config.instructions, input, tools: TOOLS,
      store: false, stream: false, include: ["reasoning.encrypted_content"],
      max_output_tokens: this.config.maxOutputTokens, parallel_tool_calls: true
    }));
    if (response.status < 200 || response.status >= 300) throw failure(response, this.config.apiKey);
    return parseResponse(response.text);
  }
}
export async function modelCatalog(baseUrl: string, apiKey: string, http: Http): Promise<string[]> {
  const response = await http("GET", endpoint(baseUrl, "models"), { Authorization: `Bearer ${apiKey}` });
  if (response.status < 200 || response.status >= 300) throw failure(response, apiKey);
  const data = JSON.parse(response.text);
  if (!Array.isArray(data.data)) throw new Error("模型目录格式不正确");
  return data.data.map((item: { id: string }) => item.id).filter((id: unknown): id is string => typeof id === "string").sort();
}
