import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { loadConfig } from "../src/config.js";
import { UsageHttpRelay, type CapturedExchange } from "../src/agent-usage/capture/http-relay.js";
import { decodeExchange } from "../src/agent-usage/capture/protocol.js";
import { parseContextSnapshot } from "../src/agent-usage/adapters/context-snapshot.js";
import { ModelTokenizers } from "../src/agent-usage/core/tokenizers.js";
import { fixtureProfile } from "./fixtures/agent-usage/tokenizers/helpers.js";
const servers: Server[] = [];
const relays: UsageHttpRelay[] = [];
afterEach(async () => { for (const relay of relays.splice(0)) await relay.close(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } });
async function upstream(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}
it("validates complete API-key-only routing before startup", () => {
  const env = { API_TOKEN: "management", CAPTURE_KEY: "secret", USAGE_CAPTURE_UPSTREAMS: JSON.stringify({ codex: { baseUrl: "https://api.example.test/v1", protocol: "responses", apiKeyEnv: "CAPTURE_KEY" } }) };
  expect(loadConfig(env).usageCaptureUpstreams?.codex?.protocol).toBe("responses");
  for (const value of [{ codex: { baseUrl: "http://evil.test", protocol: "responses", apiKeyEnv: "CAPTURE_KEY" } }, { codex: { baseUrl: "https://api.test?secret=x", protocol: "responses", apiKeyEnv: "CAPTURE_KEY" } }, { codex: { baseUrl: "https://api.test", protocol: "chat_completions", apiKeyEnv: "CAPTURE_KEY" } }, { hermes: { baseUrl: "https://api.test", protocol: "chat_completions", apiKeyEnv: "CAPTURE_KEY" } }]) expect(() => loadConfig({ ...env, USAGE_CAPTURE_UPSTREAMS: JSON.stringify(value) })).toThrow();
  expect(() => loadConfig({ ...env, CAPTURE_KEY: undefined })).toThrow();
});
it("forwards compressed request and split UTF-8 SSE bytes unchanged with fixed authentication", async () => {
  const events = `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", output: [{ type: "message", content: [{ text: "你好" }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } })}\n\n`;
  let observedHeaders: Record<string, unknown> = {}; let body = Buffer.alloc(0); let path = "";
  const baseUrl = await upstream((req, res) => { path = req.url!; observedHeaders = req.headers; req.on("data", (chunk) => { body = Buffer.concat([body, chunk]); }); req.on("end", () => { res.setHeader("content-type", "text/event-stream"); const bytes = Buffer.from(events); for (let i = 0; i < bytes.length; i += 2) res.write(bytes.subarray(i, i + 2)); res.end(); }); });
  const captured: CapturedExchange[] = []; const relay = new UsageHttpRelay(); relays.push(relay);
  const route = await relay.register({ baseUrl, protocol: "responses", apiKey: "configured-secret" }, () => "run-1", (_binding, exchange) => { captured.push(exchange); });
  const compressed = zstdCompressSync(Buffer.from(JSON.stringify({ input: "request sentinel", model: "example" })));
  const result = await fetch(`${route.baseUrl}/v1/responses`, { method: "POST", headers: { authorization: "Bearer wrong", "x-api-key": "wrong", cookie: "wrong", "content-encoding": "zstd", "content-type": "application/json" }, body: compressed });
  expect(await result.text()).toBe(events); expect(body).toEqual(compressed); expect(path).toBe("/v1/responses");
  expect(observedHeaders.authorization).toBe("Bearer configured-secret"); expect(observedHeaders["x-api-key"]).toBeUndefined(); expect(observedHeaders.cookie).toBeUndefined();
  await relay.drain(); expect(captured).toHaveLength(1);
  const decoded = await decodeExchange(captured[0]!, "responses");
  expect(decoded.request?.input).toBe("request sentinel"); expect(decoded.response?.usage).toEqual({ input_tokens: 10, output_tokens: 2, total_tokens: 12 }); expect(decoded.complete).toBe(true);
});
it.each([
  ["chat_completions", "/chat/completions", [ { id: "chat1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call1", function: { name: "Read", arguments: '{"path":' } }] } }] }, { id: "chat1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"/skill/SKILL.md"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }, "[DONE]" ], { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 }],
  ["anthropic_messages", "/messages", [ { type: "message_start", message: { id: "msg1", content: [], usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call1", name: "Read", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"/skill/SKILL.md"}' } }, { type: "message_delta", usage: { output_tokens: 4 } }, { type: "message_stop" } ], { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]
] as const)("assembles %s cumulative streaming usage and call identity", async (protocol, endpoint, events, usage) => {
  const baseUrl = await upstream((_req, res) => { res.setHeader("content-type", "text/event-stream"); res.end(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("")); });
  const captures: CapturedExchange[] = []; const relay = new UsageHttpRelay(); relays.push(relay);
  const route = await relay.register({ baseUrl, protocol, apiKey: "secret" }, () => true, (_, exchange) => { captures.push(exchange); });
  await (await fetch(route.baseUrl + endpoint, { method: "POST", body: JSON.stringify({ messages: [] }) })).text(); await relay.drain();
  const result = await decodeExchange(captures[0]!, protocol); expect(result.complete).toBe(true); expect(result.response?.usage).toEqual(usage);
  expect(JSON.stringify(result.response)).toContain("/skill/SKILL.md"); expect(JSON.stringify(result.response)).toContain("call1");
});
it("marks oversize observation and error status without damaging successful forwarding or following redirects", async () => {
  const baseUrl = await upstream((req, res) => { if (req.url?.includes("redirect")) { res.writeHead(307, { location: "https://never.test" }); res.end(); } else res.end("x".repeat(2048)); });
  const captures: CapturedExchange[] = []; const relay = new UsageHttpRelay({ maxBodyBytes: 1024 }); relays.push(relay);
  const route = await relay.register({ baseUrl, protocol: "responses", apiKey: "secret" }, () => true, (_, exchange) => { captures.push(exchange); });
  expect((await (await fetch(route.baseUrl + "/responses", { method: "POST", body: "{}" })).text()).length).toBe(2048);
  await relay.drain(); expect(captures[0]?.issue).toBe("body_limit");
  expect((await fetch(route.baseUrl + "/redirect", { redirect: "manual" })).status).toBe(307);
});
it("retains the resolved model from streaming chat chunks when a request uses an alias", async () => {
  const response = [
    { id: "chat-model", model: "resolved-model-revision", choices: [] },
    { id: "chat-model", model: "", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  const result = await decodeExchange({ request: Buffer.from('{"model":"requested-alias","messages":[]}'),
    response: Buffer.from(response), requestEncoding: "identity", responseEncoding: "identity",
    contentType: "text/event-stream", endpoint: "/chat/completions", status: 200, issue: null }, "chat_completions");
  expect(result).toMatchObject({ complete: true, response: { model: "resolved-model-revision" } });
  const entries = parseContextSnapshot(JSON.stringify({ format: "context-snapshot-v1", revision: 1, requests: [{
    id: "stream", session_id: "test", timestamp: "2026-09-21T00:00:00Z", provider: "openai", endpoint: "/chat/completions",
    modelProvider: "example", canonical_request_body: JSON.stringify(result.request), canonical_response_body: JSON.stringify(result.response)
  }] }));
  const context = entries[0]!.context!;
  const tokenizers = new ModelTokenizers([{ ...fixtureProfile("actual-profile", ["resolved-model-revision"]), modelProvider: "example" }]);
  expect(tokenizers.count("hello world", context.model, context.modelProvider)).toMatchObject({
    tokens: 2, model: "resolved-model-revision", modelProvider: "example", method: "model_tokenizer", tokenizerId: "actual-profile"
  });
});

it("decodes gzip only on the observation copy", async () => {
  const decoded = await decodeExchange({ request: gzipSync(Buffer.from('{"input":"hello"}')), response: Buffer.from('{"id":"r","usage":{"input_tokens":1}}'), requestEncoding: "gzip", responseEncoding: "identity", contentType: "application/json", endpoint: "/responses", status: 200, issue: null }, "responses");
  expect(decoded.request?.input).toBe("hello");
});
it("aborts upstream on downstream cancellation and marks pending exchanges interrupted on shutdown", async () => {
  const { request } = await import("node:http"); const { vi } = await import("vitest");
  let closed = 0;
  const baseUrl = await upstream((_req, res) => { res.on("close", () => closed++); res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"type":"message_start"}\n\n'); });
  const captures: CapturedExchange[] = []; const relay = new UsageHttpRelay(); relays.push(relay);
  const route = await relay.register({ baseUrl, protocol: "anthropic_messages", apiKey: "key" }, () => true, (_, exchange) => { captures.push(exchange); });
  const client = request(route.baseUrl + "/messages", { method: "POST" }); client.on("error", () => {});
  const received = new Promise<void>((resolve) => client.on("response", (res) => { res.once("data", () => { res.destroy(); resolve(); }); })); client.end('{}');
  await received; await vi.waitFor(() => expect(closed).toBe(1)); await relay.drain(); expect(captures[0]?.issue).toBe("downstream_aborted");
  const second = request(route.baseUrl + "/messages", { method: "POST" }); second.on("error", () => {});
  const started = new Promise<void>((resolve) => second.on("response", (res) => { res.on("error", () => {}); res.once("data", () => resolve()); })); second.end('{}');
  await started; await relay.close(); await vi.waitFor(() => expect(closed).toBe(2));
  expect(captures[1]?.issue).toBe("interrupted");
});
it("exposes decompression failures and interrupted streams instead of inventing final usage", async () => {
  const base: CapturedExchange = { request: Buffer.from('{}'), response: Buffer.from('data: {"type":"message_start","message":{"id":"msg1","usage":{"input_tokens":20}}}\n\n'), requestEncoding: "identity", responseEncoding: "identity", contentType: "text/event-stream", endpoint: "/messages", status: 200, issue: null };
  expect(await decodeExchange(base, "anthropic_messages")).toMatchObject({ complete: false, issue: "incomplete_stream", response: { id: "msg1", usage: { input_tokens: 20 } } });
  expect(await decodeExchange({ ...base, requestEncoding: "gzip" }, "anthropic_messages")).toMatchObject({ issue: "decode_failed" });
  expect(await decodeExchange({ ...base, requestEncoding: "future" }, "anthropic_messages")).toMatchObject({ issue: "unsupported_encoding" });
});
it("reserves capture capacity until asynchronous observation processing settles", async () => {
  const { vi } = await import("vitest");
  const baseUrl = await upstream((req, res) => { req.resume(); req.on("end", () => res.end('{"id":"response","usage":{"input_tokens":1}}')); });
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
  const captures: CapturedExchange[] = []; const relay = new UsageHttpRelay({ maxObservedRequests: 1 }); relays.push(relay);
  const route = await relay.register({ baseUrl, protocol: "responses", apiKey: "key" }, () => true, async (_, exchange) => {
    captures.push(exchange); if (captures.length === 1) await blocked;
  });
  const send = async () => { const response = await fetch(route.baseUrl + "/responses", { method: "POST", body: '{"input":"private body"}' }); expect(response.status).toBe(200); return response.text(); };
  try {
    await send(); await vi.waitFor(() => expect(captures).toHaveLength(1));
    await send(); await vi.waitFor(() => expect(captures).toHaveLength(2));
    expect(captures[1]).toMatchObject({ issue: "capture_capacity", request: Buffer.alloc(0), response: Buffer.alloc(0) });
    release(); await relay.drain();
    await send(); await relay.drain(); expect(captures[2]?.issue).toBeNull(); expect(captures[2]?.request.length).toBeGreaterThan(0);
  } finally { release(); }
});
it("keeps complete SSE prefix usage and identity when the final frame is truncated during transport failure", async () => {
  const decoded = await decodeExchange({ request: Buffer.from('{"messages":[{"role":"user","content":"hello"}]}'),
    response: Buffer.from('data: {"type":"message_start","message":{"id":"msg-prefix","usage":{"input_tokens":20,"output_tokens":1}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\ndata: {"type":"message_delta","usage":'),
    requestEncoding: "identity", responseEncoding: "identity", contentType: "text/event-stream", endpoint: "/messages", status: 200, issue: "upstream_aborted" }, "anthropic_messages");
  expect(decoded).toMatchObject({ complete: false, issue: "upstream_aborted", request: { messages: [{ role: "user", content: "hello" }] }, response: { id: "msg-prefix", usage: { input_tokens: 20, output_tokens: 3 } } });
});
