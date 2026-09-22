import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { HostUsageCollector } from "../src/agent-usage/host-collector.js";
import { createTestDatabase } from "./helpers.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const setup = () => {
  const { db, seed } = createTestDatabase(); databases.push(db);
  const session = seed.session();
  seed.run(session.id, "running");
  const run = db.prepare("SELECT id FROM runs WHERE session_id = ?").get(session.id) as { id: number };
  const host = new HostUsageCollector(db);
  return { db, session, run, host };
};

describe("default tool content measurement", () => {
  it("ranks ordinary runtime content without enabling HTTP capture, preserving sparse updates", async () => {
    const { host, run, session } = setup();
    await host.runtimeCapabilities.recordTool(run.id, { toolCallId: "read", kind: "read", status: "in_progress",
      rawInput: { path: "README.md" } });
    await host.runtimeCapabilities.recordTool(run.id, { toolCallId: "read", status: "completed", rawOutput: "abcdefgh" });
    await host.runtimeCapabilities.recordTool(run.id, { toolCallId: "read", status: "completed" });
    const [row] = host.attribution.rankings({ namespace: host.namespace, sessionId: String(session.id) }, "builtin_tool");
    expect(row).toMatchObject({ calls: 1, observedResultTokens: 2, observedArgumentCalls: 1, observedResultCalls: 1,
      totalInputTokens: null, exposureCount: 0 });
    expect(row!.observedArgumentTokens).toBeGreaterThan(0);
    expect(row!.observedTotalTokens).toBe(row!.observedArgumentTokens! + 2);
    expect(row!.payloadEstimates).toEqual([expect.objectContaining({ method: "text_heuristic" })]);
    expect(host.attribution.invocations()[0]).toMatchObject({ resultEstimate: { tokens: 2, byteLength: 8, partial: false } });
  });

  it("measures ACP text results without counting image base64 as text tokens", async () => {
    const { host, run } = setup();
    await host.runtimeCapabilities.recordTool(run.id, { toolCallId: "content", kind: "read", status: "completed",
      rawInput: { path: "notes.md" }, content: [
        { type: "content", content: { type: "text", text: "abcdefgh" } },
        { type: "content", content: { type: "image", data: "a".repeat(100_000), mimeType: "image/png" } }
      ] });
    const [row] = host.attribution.rankings({ namespace: host.namespace }, "builtin_tool");
    expect(row).toMatchObject({ observedResultTokens: 2, observedResultCalls: 1 });
    const detail = host.attribution.invocations()[0]!;
    expect(detail).toMatchObject({ resultEstimate: { tokens: 2, partial: true } });
  });

  it("keeps payload estimates through restart and removes them on explicit Session deletion", async () => {
    const { host, run, db, session } = setup();
    await host.runtimeCapabilities.recordTool(run.id, { toolCallId: "private", kind: "read", status: "completed",
      rawInput: { path: "private-file.md" }, rawOutput: "never-persist-this-content" });
    const reopened = new HostUsageCollector(db);
    expect(reopened.attribution.rankings({}, "builtin_tool")[0]!.observedResultTokens).toBeGreaterThan(0);
    const stored = JSON.stringify(db.prepare("SELECT * FROM agent_usage_invocation_payloads").all());
    expect(stored).not.toContain("never-persist-this-content");
    expect(stored).not.toContain("private-file.md");
    reopened.deleteSession(session.id);
    expect(db.prepare("SELECT count(*) AS n FROM agent_usage_invocation_payloads").get()).toEqual({ n: 0 });
  });
});
