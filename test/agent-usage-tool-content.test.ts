import { afterEach, describe, expect, it, vi } from "vitest";
import { Tokenizer } from "@huggingface/tokenizers";
import { measureToolContent } from "../src/agent-usage/core/tool-content.js";
import { ModelTokenizers } from "../src/agent-usage/core/tokenizers.js";
import { fixtureProfile } from "./fixtures/agent-usage/tokenizers/helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("observed tool content", () => {
  it.each([
    [[1, 2], 2, 5],
    [[{ id: 1 }], 5, 10],
    [[], 1, 2],
    [{ content: [1, 2] }, 7, 17]
  ])("counts ordinary JSON %j without treating it as content blocks", async (value, tokens, byteLength) => {
    expect(await measureToolContent(value, "result")).toMatchObject({ tokens, byteLength, partial: false });
  });

  it("extracts MCP text and ACP wrapped text, resources and diffs without envelope overhead", async () => {
    expect(await measureToolContent({ content: [
      { type: "text", text: "hello" },
      { type: "content", content: { type: "text", text: "world" } },
      { type: "resource", resource: { uri: "file:///example", text: "你好" } },
      { type: "diff", oldText: "a", newText: "b" }
    ] }, "result")).toMatchObject({ tokens: 6, byteLength: 22, partial: false });
  });

  it("measures structuredContent as JSON when a result has no text blocks", async () => {
    expect(await measureToolContent({ content: [], structuredContent: [1, 2] }, "result")).toMatchObject({ tokens: 2, byteLength: 5, partial: false });
    expect(await measureToolContent({ structuredContent: [1, 2] }, "result")).toMatchObject({ tokens: 2, byteLength: 5, partial: false });
  });

  it("does not count structuredContent twice when equivalent textual content is present", async () => {
    expect(await measureToolContent({ content: [{ type: "text", text: "hello" }], structuredContent: { message: "hello" } }, "result"))
      .toMatchObject({ tokens: 2, byteLength: 5, partial: false });
  });

  it.each([
    { type: "image", data: "a".repeat(5000), mimeType: "image/png" },
    { type: "resource", resource: { uri: "file:///example", blob: "a".repeat(5000), mimeType: "application/octet-stream" } },
    { type: "content", content: { type: "audio", data: "a".repeat(5000), mimeType: "audio/wav" } }
  ])("keeps media-only content unknown rather than counting base64", async (value) => {
    expect(await measureToolContent(value, "result")).toMatchObject({ tokens: null, byteLength: 0, partial: true,
      estimate: { method: "unavailable", reason: "unsupported_content" } });
  });

  it("counts text in mixed blocks while flagging omitted media", async () => {
    expect(await measureToolContent([{ type: "text", text: "你好" }, { type: "image", data: "a".repeat(5000), mimeType: "image/png" }], "result"))
      .toMatchObject({ tokens: 2, byteLength: 6, partial: true });
  });

  it("omits media nested in otherwise ordinary JSON without dropping unrelated values", async () => {
    const measured = await measureToolContent([{ id: 1 }, { type: "image", data: "a".repeat(5000), mimeType: "image/png" }], "result");
    expect(measured?.partial).toBe(true);
    expect(measured?.tokens).toBeGreaterThan(0);
    expect(measured?.byteLength).toBeLessThan(100);
  });

  it("distinguishes missing, empty text and an explicitly empty block envelope", async () => {
    expect(await measureToolContent(undefined, "result")).toBeUndefined();
    expect(await measureToolContent("", "result")).toMatchObject({ tokens: 0, byteLength: 0, partial: false });
    expect(await measureToolContent({ content: [] }, "result")).toMatchObject({ tokens: 0, byteLength: 0, partial: false });
  });

  it("does not replace a configured vocabulary failure with a misleading fallback", async () => {
    const engine = new ModelTokenizers([fixtureProfile()]);
    vi.spyOn(Tokenizer.prototype, "tokenize").mockImplementation(() => { throw new Error("broken vocabulary"); });
    expect(await measureToolContent("你好🚀", "arguments", engine, "fixture-model", "example")).toMatchObject({ tokens: null, byteLength: 10, partial: false,
      estimate: { method: "model_tokenizer", reason: "tokenization_failed", tokenizer: "@huggingface/tokenizers",
        model: "fixture-model", modelProvider: "example" } });
  });

  it.each(["arguments", "result"] as const)("counts a complete 16 MiB %s off the main thread", async (part) => {
    const value = "x".repeat(16 * 1024 * 1024);
    const count = vi.spyOn(ModelTokenizers.prototype, "count");
    const measured = await measureToolContent(value, part);
    expect(measured).toMatchObject({ tokens: 4 * 1024 * 1024, byteLength: 16 * 1024 * 1024, partial: false,
      estimate: { method: "text_heuristic", heuristicVersion: "unicode-weighted-v1", reason: "model_missing" } });
    // Full measurement takes place in a worker, never in this thread.
    expect(count).not.toHaveBeenCalled();
  });

  it("counts every character of large multilingual text", async () => {
    expect(await measureToolContent("🚀你".repeat(100000), "result")).toMatchObject({ byteLength: 700000, partial: false,
      estimate: { method: "text_heuristic", reason: "model_missing" } });
    expect((await measureToolContent("🚀你".repeat(100000), "result"))!.tokens).toBe(300000);
  });

  it("does not propagate malformed serialization or tokenizer failures to tool execution", async () => {
    const circular: unknown[] = []; circular.push(circular);
    expect(await measureToolContent(circular, "arguments")).toBeUndefined();
    const engine = new ModelTokenizers();
    vi.spyOn(engine, "count").mockImplementation(() => { throw new Error("unexpected failure"); });
    expect(await measureToolContent("hello", "result", engine)).toMatchObject({ tokens: 2, estimate: { reason: "tokenization_failed" } });
  });
});
