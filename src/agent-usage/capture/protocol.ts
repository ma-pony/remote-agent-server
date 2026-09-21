import * as zlib from "node:zlib";
import type { CaptureProtocol } from "./config.js";
import type { CapturedExchange } from "./http-relay.js";
type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const array = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const MAX_BYTES = 4 * 1024 * 1024;
async function decode(bytes: Buffer, encoding: string): Promise<Buffer> {
  if (encoding === "identity" || encoding === "") return bytes;
  const decoder = ({ gzip: zlib.gunzip, deflate: zlib.inflate, br: zlib.brotliDecompress, zstd: zlib.zstdDecompress } as Record<string, undefined | ((bytes: Buffer, options: { maxOutputLength: number }, callback: (error: Error | null, output: Buffer) => void) => void)>)[encoding];
  if (!decoder) throw new Error("unsupported_encoding");
  return new Promise((resolve, reject) => decoder(bytes, { maxOutputLength: MAX_BYTES }, (error, result) => error ? reject(new Error("decode_failed")) : resolve(result)));
}
export type DecodedExchange = { request: Json | null; response: Json | null; complete: boolean; issue: string | null };
/** Parse an observation copy only. Repeated usage snapshots replace fields instead of summing them. */
export async function decodeExchange(exchange: CapturedExchange, protocol: CaptureProtocol): Promise<DecodedExchange> {
  const result: DecodedExchange = { request: null, response: null, complete: false, issue: exchange.issue };
  // Transport interruption can still carry a valid request and complete SSE prefix.
  // Capacity/retention gaps deliberately have no usable observation buffers.
  if (exchange.issue && !["downstream_aborted", "upstream_aborted", "upstream_failed", "interrupted"].includes(exchange.issue)) return result;
  const endpoint = { responses: "/responses", chat_completions: "/chat/completions", anthropic_messages: "/messages" }[protocol];
  if (!exchange.endpoint.endsWith(endpoint)) return { ...result, issue: "unsupported_endpoint" };
  try {
    result.request = object(JSON.parse((await decode(exchange.request, exchange.requestEncoding)).toString("utf8")));
    const body = (await decode(exchange.response, exchange.responseEncoding)).toString("utf8");
    if (exchange.status < 200 || exchange.status >= 300) return { ...result, issue: result.issue ?? "upstream_status" };
    if (!exchange.contentType.includes("text/event-stream")) {
      result.response = object(JSON.parse(body)); result.complete = exchange.issue === null;
    } else {
      const response: Json = {}; const tools = new Map<number, Json>(); const argumentsByIndex = new Map<number, string>();
      result.response = response;
      let terminal = false;
      const frames = body.replace(/\r\n/g, "\n").split("\n\n");
      const tail = frames.pop();
      if (tail?.trim()) result.issue ??= "incomplete_stream";
      for (const frame of frames) {
        if (Buffer.byteLength(frame) > 1024 * 1024) throw new Error("event_limit");
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") { if (protocol === "chat_completions") terminal = true; continue; }
        const event = object(JSON.parse(data));
        if (protocol === "responses") {
          if (event.type === "response.completed") { Object.assign(response, object(event.response)); terminal = true; }
          else if (["response.incomplete", "response.failed"].includes(String(event.type))) Object.assign(response, object(event.response));
        } else if (protocol === "anthropic_messages") {
          if (event.type === "message_start") Object.assign(response, object(event.message));
          if (event.type === "message_delta") response.usage = { ...object(response.usage), ...object(event.usage) };
          if (event.type === "message_stop") terminal = true;
          if (event.type === "content_block_start") tools.set(Number(event.index), object(event.content_block));
          const delta = object(event.delta);
          if (delta.type === "input_json_delta") argumentsByIndex.set(Number(event.index), (argumentsByIndex.get(Number(event.index)) ?? "") + String(delta.partial_json ?? ""));
        } else {
          if (event.id) response.id = event.id;
          if (typeof event.model === "string" && event.model.trim()) response.model = event.model;
          if (event.usage) response.usage = event.usage;
          for (const choice of array(event.choices)) for (const tool of array(object(choice.delta).tool_calls)) {
            const index = Number(tool.index); const old = tools.get(index) ?? { type: "function" }; const fn = object(tool.function);
            if (tool.id) old.id = tool.id;
            old.function = { ...object(old.function), ...(fn.name ? { name: fn.name } : {}) };
            tools.set(index, old);
            argumentsByIndex.set(index, (argumentsByIndex.get(index) ?? "") + String(fn.arguments ?? ""));
          }
        }
        if (tools.size > 1024) throw new Error("call_limit");
      }
      if (protocol === "anthropic_messages") {
        for (const [index, args] of argumentsByIndex) if (tools.has(index)) {
          try { tools.get(index)!.input = JSON.parse(args); }
          catch { result.issue ??= "incomplete_tool_arguments"; }
        }
        response.content = [...tools.values()];
      } else if (protocol === "chat_completions") {
        for (const [index, args] of argumentsByIndex) if (tools.has(index)) object(tools.get(index)!.function).arguments = args;
        response.choices = [{ message: { tool_calls: [...tools.values()] } }];
      }
      result.response = response; result.complete = terminal && result.issue === null;
      if (!terminal) result.issue ??= "incomplete_stream";
    }
    if (typeof result.response?.id !== "string") result.issue ??= "missing_response_identity";
    if (!result.response?.usage) result.issue ??= "missing_usage";
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    result.issue ??= ["unsupported_encoding", "decode_failed", "event_limit", "call_limit"].includes(code) ? code : "unsupported_payload";
  }
  return result;
}
