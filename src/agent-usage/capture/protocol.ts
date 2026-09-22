import * as zlib from "node:zlib";
import type { CaptureProtocol } from "./config.js";
import type { CapturedExchange } from "./http-relay.js";

type Json = Record<string, unknown>;
type DecodeErrorCode = "unsupported_encoding" | "decode_failed" | "event_limit" | "call_limit";
type Decoder = (bytes: Buffer, options: { maxOutputLength: number },
  callback: (error: Error | null, output: Buffer) => void) => void;

class CaptureDecodeError extends Error {
  constructor(readonly code: DecodeErrorCode) {
    super(code);
  }
}

const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const array = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_STREAM_CALLS = 1024;

async function decode(bytes: Buffer, encoding: string): Promise<Buffer> {
  if (encoding === "identity" || encoding === "") return bytes;
  const decoders: Record<string, Decoder | undefined> = {
    gzip: zlib.gunzip, deflate: zlib.inflate, br: zlib.brotliDecompress, zstd: zlib.zstdDecompress
  };
  const decoder = Object.hasOwn(decoders, encoding) ? decoders[encoding] : undefined;
  if (!decoder) throw new CaptureDecodeError("unsupported_encoding");
  return new Promise((resolve, reject) => {
    decoder(bytes, { maxOutputLength: MAX_BYTES }, (error, result) => {
      if (error) reject(new CaptureDecodeError("decode_failed"));
      else resolve(result);
    });
  });
}

export type DecodedExchange = {
  request: Json | null;
  response: Json | null;
  complete: boolean;
  issue: string | null;
};

function decodeStream(body: string, protocol: CaptureProtocol, result: DecodedExchange): void {
  const response: Json = {};
  const tools = new Map<number, Json>();
  const argumentsByIndex = new Map<number, string>();
  result.response = response;
  let terminal = false;
  const frames = body.replace(/\r\n/g, "\n").split("\n\n");
  const tail = frames.pop();
  if (tail?.trim()) result.issue ??= "incomplete_stream";

  for (const frame of frames) {
    if (Buffer.byteLength(frame) > MAX_EVENT_BYTES) throw new CaptureDecodeError("event_limit");
    const data = frame.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    if (data === "[DONE]") {
      if (protocol === "chat_completions") terminal = true;
      continue;
    }
    const event = object(JSON.parse(data));
    if (protocol === "responses") {
      if (event.type === "response.completed") {
        Object.assign(response, object(event.response));
        terminal = true;
      } else if (event.type === "response.incomplete" || event.type === "response.failed") {
        Object.assign(response, object(event.response));
      }
    } else if (protocol === "anthropic_messages") {
      if (event.type === "message_start") Object.assign(response, object(event.message));
      if (event.type === "message_delta") response.usage = { ...object(response.usage), ...object(event.usage) };
      if (event.type === "message_stop") terminal = true;
      if (event.type === "content_block_start") tools.set(Number(event.index), object(event.content_block));
      const delta = object(event.delta);
      if (delta.type === "input_json_delta") {
        const index = Number(event.index);
        argumentsByIndex.set(index, (argumentsByIndex.get(index) ?? "") + String(delta.partial_json ?? ""));
      }
    } else {
      if (event.id) response.id = event.id;
      if (typeof event.model === "string" && event.model.trim()) response.model = event.model;
      if (event.usage) response.usage = event.usage;
      for (const choice of array(event.choices)) {
        for (const tool of array(object(choice.delta).tool_calls)) {
          const index = Number(tool.index);
          const previous = tools.get(index) ?? { type: "function" };
          const fn = object(tool.function);
          if (tool.id) previous.id = tool.id;
          previous.function = { ...object(previous.function), ...(fn.name ? { name: fn.name } : {}) };
          tools.set(index, previous);
          argumentsByIndex.set(index, (argumentsByIndex.get(index) ?? "") + String(fn.arguments ?? ""));
        }
      }
    }
    if (tools.size > MAX_STREAM_CALLS) throw new CaptureDecodeError("call_limit");
  }

  for (const [index, args] of argumentsByIndex) {
    const tool = tools.get(index);
    if (!tool) continue;
    if (protocol === "anthropic_messages") {
      try {
        tool.input = JSON.parse(args);
      } catch {
        result.issue ??= "incomplete_tool_arguments";
      }
    } else if (protocol === "chat_completions") {
      object(tool.function).arguments = args;
    }
  }
  if (protocol === "anthropic_messages") response.content = [...tools.values()];
  else if (protocol === "chat_completions") response.choices = [{ message: { tool_calls: [...tools.values()] } }];
  result.complete = terminal && result.issue === null;
  if (!terminal) result.issue ??= "incomplete_stream";
}

/** Parse an observation copy only. Repeated usage snapshots replace fields instead of summing them. */
export async function decodeExchange(exchange: CapturedExchange, protocol: CaptureProtocol): Promise<DecodedExchange> {
  const result: DecodedExchange = { request: null, response: null, complete: false, issue: exchange.issue };
  // Transport interruption can still carry a valid request and complete SSE prefix.
  // Capacity/retention gaps deliberately have no usable observation buffers.
  const interrupted = ["downstream_aborted", "upstream_aborted", "upstream_failed", "interrupted"];
  if (exchange.issue && !interrupted.includes(exchange.issue)) return result;
  const endpoint = {
    responses: "/responses", chat_completions: "/chat/completions", anthropic_messages: "/messages"
  }[protocol];
  if (!exchange.endpoint.endsWith(endpoint)) return { ...result, issue: "unsupported_endpoint" };
  try {
    const request = await decode(exchange.request, exchange.requestEncoding);
    result.request = object(JSON.parse(request.toString("utf8")));
    const body = (await decode(exchange.response, exchange.responseEncoding)).toString("utf8");
    if (exchange.status < 200 || exchange.status >= 300) return { ...result, issue: result.issue ?? "upstream_status" };
    if (exchange.contentType.includes("text/event-stream")) {
      decodeStream(body, protocol, result);
    } else {
      result.response = object(JSON.parse(body));
      result.complete = exchange.issue === null;
    }
    if (typeof result.response?.id !== "string") result.issue ??= "missing_response_identity";
    if (!result.response?.usage) result.issue ??= "missing_usage";
  } catch (error) {
    result.issue ??= error instanceof CaptureDecodeError ? error.code : "unsupported_payload";
  }
  return result;
}
