import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "./helpers.js";
import { HostUsageCollector } from "../src/agent-usage/host-collector.js";
import { McpUsageObserver } from "../src/agent-usage/mcp-observer.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const setup = () => {
  const { db, seed } = createTestDatabase(); const session = seed.session(); seed.run(session.id, "running");
  const host = new HostUsageCollector(db); const observer = new McpUsageObserver(host);
  cleanup.push(async () => { await observer.close(); db.close(); });
  return { db, seed, session, host, observer };
};

describe("MCP usage observer ownership", () => {
  it("completes calls without reading historical attribution details", () => {
    const { session, host, observer } = setup();
    const token = observer.issueTicket(session.id, 7), invocationId = randomUUID();
    observer.record(token, { invocationId, toolName: "search", phase: "start", occurredAt: "2026-09-21T01:00:00Z" });
    const detail = vi.spyOn(host.attribution, "detail").mockImplementation(() => { throw new Error("historical_query_on_hot_path"); });
    try {
      observer.record(token, { invocationId, toolName: "search", phase: "end", occurredAt: "2026-09-21T01:00:01Z", status: "succeeded" });
      expect(host.attribution.invocations()[0]?.status).toBe("succeeded");
    } finally { detail.mockRestore(); }
  });
  it("revokes only the maintained Session after its final events have drained", async () => {
    const { session, seed, host, observer } = setup();
    const other = seed.session();
    const token = observer.issueTicket(session.id, 7), otherToken = observer.issueTicket(other.id, 7);
    const event = { invocationId: randomUUID(), toolName: "search", phase: "start", occurredAt: "2026-09-21T01:00:00Z" };
    observer.record(token, event);
    await host.prepareMaintenance(session.id, "reset");
    observer.record(token, { ...event, phase: "end", status: "succeeded" });
    host.finishMaintenance(session.id);
    expect(() => observer.record(token, { ...event, phase: "end", status: "succeeded" })).toThrow("usage_observer_unauthorized");
    expect(() => observer.record(otherToken, { ...event, invocationId: randomUUID() })).not.toThrow();
    expect(observer.issueTicket(session.id, 7)).not.toBe(token);
  });
  it("releases removed servers without revoking retained MCP tickets", () => {
    const { session, observer } = setup();
    const removed = observer.issueTicket(session.id, 7), retained = observer.issueTicket(session.id, 8);
    observer.revokeSession(session.id, new Set([8]));
    const event = { invocationId: randomUUID(), toolName: "search", phase: "start", occurredAt: "2026-09-21T01:00:00Z" };
    expect(() => observer.record(removed, event)).toThrow("usage_observer_unauthorized");
    expect(() => observer.record(retained, event)).not.toThrow();
    expect(observer.issueTicket(session.id, 8)).toBe(retained);
  });
  it("freezes inferred Run ownership on start across reused processes and late completions", () => {
    const { db, seed, session, host, observer } = setup();
    const token = observer.issueTicket(session.id, 7);
    const firstRun = (db.prepare("SELECT id FROM runs WHERE session_id = ?").get(session.id) as { id: number }).id;
    const invocationId = randomUUID();
    observer.record(token, { invocationId, toolName: "search", phase: "start", occurredAt: "2026-09-21T01:00:00Z" });
    db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(firstRun); seed.run(session.id, "running");
    observer.record(token, { invocationId, toolName: "search", phase: "end", occurredAt: "2026-09-21T01:01:00Z", status: "tool_error", resultBytes: 32 });
    const calls = host.attribution.invocations({ namespace: host.namespace, runtimeKind: "codex" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ executionId: String(firstRun), executionEvidence: "inferred", status: "tool_error" });
    const ranks = host.attribution.rankings({ namespace: host.namespace }, "mcp_tool");
    expect(ranks[0]).toMatchObject({ calls: 1, failures: 1, totalInputTokens: null, latencyMsP50: 60000 });
  });
  it("separates same-named server tools and rejects late events after deletion", () => {
    const { session, host, observer } = setup();
    const event = { invocationId: randomUUID(), toolName: "search", phase: "start", occurredAt: "2026-09-21T01:00:00Z" };
    const first = observer.issueTicket(session.id, 7), second = observer.issueTicket(session.id, 8);
    observer.record(first, event); observer.record(second, { ...event, invocationId: randomUUID() });
    expect(host.attribution.rankings({ namespace: host.namespace }, "mcp_tool")).toHaveLength(2);
    host.deleteSession(session.id);
    expect(() => observer.record(first, { ...event, phase: "end", status: "succeeded" })).toThrow("usage_observer_unauthorized");
    expect(host.attribution.invocations()).toHaveLength(0);
    expect(() => observer.record("invalid", event)).toThrow("usage_observer_unauthorized");
  });
});
