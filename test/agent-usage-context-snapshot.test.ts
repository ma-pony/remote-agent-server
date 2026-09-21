import { describe, expect, it } from "vitest";
import { parseContextSnapshot } from "../src/agent-usage/adapters/context-snapshot.js";

import { snapshotFixture } from "./fixtures/agent-usage/context-snapshot.js";

describe("Canonical context snapshot", () => {
  it("uses the resolved response model rather than a requested alias for tokenizer routing", () => {
    const snapshot = snapshotFixture();
    const response = JSON.parse(snapshot.requests[0]!.canonical_response_body);
    response.model = "resolved-model-revision";
    snapshot.requests[0]!.canonical_response_body = JSON.stringify(response);
    const entries = parseContextSnapshot(JSON.stringify(snapshot));
    expect(entries[0]!.context?.model).toBe("resolved-model-revision");
    expect(entries[0]!.observation.model).toBe("resolved-model-revision");
  });
  it("uses canonical request bodies and reported usage, without counting response configuration echoes", () => {
    const entries = parseContextSnapshot(JSON.stringify(snapshotFixture()));
    expect(entries).toHaveLength(2);
    expect(entries[0]!.observation.metrics).toMatchObject({ inputTotalTokens: 100, outputTotalTokens: 20, totalTokens: 120 });
    expect(entries[0]!.context?.blocks.filter((block) => block.kind === "definition")).toHaveLength(1);
    expect(entries[1]!.context?.blocks).toHaveLength(1);
    expect(entries[1]!.context?.blocks[0]).toMatchObject({ kind: "result", toolInvocationId: "capture-session:call-1",
      capabilities: [{ capability: { id: "mcp:server-1:search" }, evidence: "direct" }] });
    expect(entries[1]!.invocations).toHaveLength(1);
    expect(entries[1]!.invocations?.[0]?.startedAt).toBeNull();
    expect(entries[0]!.observation.occurredAt).toBe("2026-09-21T01:00:00.000Z");
  });
  it("keeps missing retained bodies, unrecognized tools and opaque state explicit", () => {
    const snapshot = snapshotFixture();
    snapshot.capabilities = [];
    snapshot.requests[0]!.canonical_request_body = "null";
    snapshot.requests[1]!.context_fidelity = "opaque";
    const entries = parseContextSnapshot(JSON.stringify(snapshot));
    expect(entries[0]!.context?.coverage).toBe("none");
    expect(entries[1]!.context?.coverage).toBe("opaque");
    expect(entries[1]!.context?.blocks[0]?.capabilities[0]?.capability.kind).toBe("unknown");
  });
  it("keeps stable request identity while accepting a later snapshot revision", () => {
    const first = parseContextSnapshot(JSON.stringify(snapshotFixture(1)))[0]!;
    const next = snapshotFixture(2);
    const body = JSON.parse(next.requests[0]!.canonical_response_body);
    body.usage.output_tokens = 30;
    next.requests[0]!.canonical_response_body = JSON.stringify(body);
    const second = parseContextSnapshot(JSON.stringify(next))[0]!;
    expect(second.observation.invocationId).toBe(first.observation.invocationId);
    expect(second.observation.eventId).not.toBe(first.observation.eventId);
    expect(second.observation.revision).toBe(2);
    expect(second.observation.metrics.totalTokens).toBe(130);
  });

  it("normalizes the known Claude alias at the snapshot edge and preserves custom runtimes", () => {
    const snapshot = snapshotFixture();
    snapshot.requests[0]!.agent = "claude-code";
    snapshot.requests[1]!.agent = "custom-runtime";

    const entries = parseContextSnapshot(JSON.stringify(snapshot));

    expect(entries[0]).toMatchObject({
      observation: { runtimeKind: "claude_code" },
      context: { runtimeKind: "claude_code" }
    });
    expect(entries[1]).toMatchObject({
      observation: { runtimeKind: "custom-runtime" },
      context: { runtimeKind: "custom-runtime" },
      invocations: [expect.objectContaining({ runtimeKind: "custom-runtime" })]
    });
  });

  it("retains Anthropic system blocks and unsupported media as explicit input evidence", () => {
    const snapshot = snapshotFixture();
    snapshot.requests = [snapshot.requests[0]!];
    snapshot.requests[0]!.endpoint = "/v1/messages";
    snapshot.requests[0]!.canonical_request_body = JSON.stringify({
      system: [{ type: "text", text: "System instructions" }, { type: "image", source: { type: "base64", data: "synthetic" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }]
    });
    snapshot.requests[0]!.canonical_response_body = JSON.stringify({ usage: {
      input_tokens: 80, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, output_tokens: 5
    } });
    const entry = parseContextSnapshot(JSON.stringify(snapshot))[0]!;
    expect(entry.context?.blocks.map((block) => block.content)).toEqual([
      expect.objectContaining({ modality: "text", text: "System instructions" }),
      expect.objectContaining({ modality: "unsupported", mediaType: "image" }),
      expect.objectContaining({ modality: "text", text: "Hello" })
    ]);
    expect(entry.observation.metrics).toMatchObject({ inputTotalTokens: 110, outputTotalTokens: 5, totalTokens: 115 });
  });

  it("does not count Chat tool-result content a second time as unrelated message text", () => {
    const snapshot = snapshotFixture();
    snapshot.requests = [snapshot.requests[0]!];
    snapshot.requests[0]!.endpoint = "/v1/chat/completions";
    snapshot.requests[0]!.canonical_request_body = JSON.stringify({ messages: [
      { role: "assistant", tool_calls: [{ id: "chat-call", type: "function", function: { name: "search", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "chat-call", content: [{ type: "text", text: "Result" }] }
    ] });
    const blocks = parseContextSnapshot(JSON.stringify(snapshot))[0]!.context!.blocks;
    expect(blocks.map((block) => block.kind)).toEqual(["arguments", "result"]);
  });

  it("does not invent empty arguments or claim a complete parse of an unsupported endpoint", () => {
    const snapshot = snapshotFixture();
    snapshot.requests = [snapshot.requests[0]!];
    snapshot.requests[0]!.endpoint = "/private-api";
    snapshot.requests[0]!.canonical_request_body = JSON.stringify({ input: [{ type: "function_call", call_id: "missing-args", name: "search" }] });
    const entry = parseContextSnapshot(JSON.stringify(snapshot))[0]!;
    expect(entry.context?.coverage).toBe("partial");
    expect(entry.context?.blocks[0]?.content.modality).toBe("unsupported");
    expect(entry.observation.normalizationProfile).toBeNull();
  });
});
