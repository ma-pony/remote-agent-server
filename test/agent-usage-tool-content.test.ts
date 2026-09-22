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
  ])("counts ordinary JSON %j without treating it as content blocks", (value, tokens, byteLength) => {
    expect(measureToolContent(value, "result")).toMatchObject({ tokens, byteLength, partial: false });
  });

  it("extracts MCP text and ACP wrapped text, resources and diffs without envelope overhead", () => {
    expect(measureToolContent({ content: [
      { type: "text", text: "hello" },
      { type: "content", content: { type: "text", text: "world" } },
      { type: "resource", resource: { uri: "file:///example", text: "你好" } },
      { type: "diff", oldText: "a", newText: "b" }
    ] }, "result")).toMatchObject({ tokens: 6, byteLength: 22, partial: false });
  });

  it("measures structuredContent as JSON when a result has no text blocks", () => {
    expect(measureToolContent({ content: [], structuredContent: [1, 2] }, "result")).toMatchObject({ tokens: 2, byteLength: 5, partial: false });
    expect(measureToolContent({ structuredContent: [1, 2] }, "result")).toMatchObject({ tokens: 2, byteLength: 5, partial: false });
  });

  it("does not count structuredContent twice when equivalent textual content is present", () => {
    expect(measureToolContent({ content: [{ type: "text", text: "hello" }], structuredContent: { message: "hello" } }, "result"))
      .toMatchObject({ tokens: 2, byteLength: 5, partial: false });
  });

  it.each([
    { type: "image", data: "a".repeat(5000), mimeType: "image/png" },
    { type: "resource", resource: { uri: "file:///example", blob: "a".repeat(5000), mimeType: "application/octet-stream" } },
    { type: "content", content: { type: "audio", data: "a".repeat(5000), mimeType: "audio/wav" } }
  ])("keeps media-only content unknown rather than counting base64", (value) => {
    expect(measureToolContent(value, "result")).toMatchObject({ tokens: null, byteLength: 0, partial: true,
      estimate: { method: "unavailable", reason: "unsupported_content" } });
  });

  it("counts text in mixed blocks while flagging omitted media", () => {
    expect(measureToolContent([{ type: "text", text: "你好" }, { type: "image", data: "a".repeat(5000), mimeType: "image/png" }], "result"))
      .toMatchObject({ tokens: 2, byteLength: 6, partial: true });
  });

  it("omits media nested in otherwise ordinary JSON without dropping unrelated values", () => {
    const measured = measureToolContent([{ id: 1 }, { type: "image", data: "a".repeat(5000), mimeType: "image/png" }], "result");
    expect(measured?.partial).toBe(true);
    expect(measured?.tokens).toBeGreaterThan(0);
    expect(measured?.byteLength).toBeLessThan(100);
  });

  it("distinguishes missing, empty text and an explicitly empty block envelope", () => {
    expect(measureToolContent(undefined, "result")).toBeUndefined();
    expect(measureToolContent("", "result")).toMatchObject({ tokens: 0, byteLength: 0, partial: false });
    expect(measureToolContent({ content: [] }, "result")).toMatchObject({ tokens: 0, byteLength: 0, partial: false });
  });

  it("falls back to the Unicode heuristic when a configured vocabulary fails", () => {
    const engine = new ModelTokenizers([fixtureProfile()]);
    vi.spyOn(Tokenizer.prototype, "tokenize").mockImplementation(() => { throw new Error("broken vocabulary"); });
    expect(measureToolContent("你好🚀", "arguments", engine, "fixture-model", "example")).toMatchObject({ tokens: 4, byteLength: 10, partial: false,
      estimate: { method: "text_heuristic", heuristicVersion: "unicode-weighted-v1", reason: "tokenization_failed", tokenizer: null,
        model: "fixture-model", modelProvider: "example" } });
  });

  it.each(["arguments", "result"] as const)("bounds fallback work for a 16 MiB %s while retaining full byte length", (part) => {
    const value = "x".repeat(16 * 1024 * 1024);
    const count = vi.spyOn(ModelTokenizers.prototype, "count");
    const measured = measureToolContent(value, part);
    expect(measured).toMatchObject({ tokens: 4 * 1024 * 1024, byteLength: 16 * 1024 * 1024, partial: true,
      estimate: { method: "text_heuristic", heuristicVersion: "unicode-weighted-v1", reason: "size_limit" } });
    // The production boundary must not send the oversized payload into a tokenizer.
    expect(count.mock.calls.every(([text]) => Buffer.byteLength(text) <= 256 * 1024)).toBe(true);
  });

  it("samples multilingual oversized text without splitting supplementary characters", () => {
    expect(measureToolContent("🚀你".repeat(100000), "result")).toMatchObject({ byteLength: 700000, partial: true,
      estimate: { method: "text_heuristic", reason: "size_limit" } });
    expect(measureToolContent("🚀你".repeat(100000), "result")!.tokens).toBeCloseTo(300000, -3);
  });

  it("does not propagate malformed serialization or tokenizer failures to tool execution", () => {
    const circular: unknown[] = []; circular.push(circular);
    expect(measureToolContent(circular, "arguments")).toBeUndefined();
    const engine = new ModelTokenizers();
    vi.spyOn(engine, "count").mockImplementation(() => { throw new Error("unexpected failure"); });
    expect(measureToolContent("hello", "result", engine)).toMatchObject({ tokens: 2, estimate: { reason: "tokenization_failed" } });
  });
});
