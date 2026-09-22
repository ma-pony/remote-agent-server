import { afterEach, expect, it, vi } from "vitest";
import { HostUsageCollector } from "../src/agent-usage/host-collector.js";
import { createTestDatabase } from "./helpers.js";

const databases: Array<ReturnType<typeof createTestDatabase>["db"]> = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

it("pages grouped skill stages in SQL with dimension, subject and date filters", () => {
  const { db } = createTestDatabase(); databases.push(db);
  const host = new HostUsageCollector(db);
  const insert = db.prepare(`INSERT INTO agent_usage_runtime_activity
    (namespace,agent_id,session_id,generation,provider_epoch_id,execution_id,runtime_kind,native_call_id,event_id,capability_json,stage,observed_at)
    VALUES (?, '1', ?, 0, 'epoch', 'run', 'codex', NULL, ?, ?, ?, ?)`);
  const skill = { id: "skill-a", kind: "skill", name: "A" };
  const plugin = { id: "plugin-a", kind: "plugin", name: "Plugin" };
  insert.run(host.namespace, "1", "1", JSON.stringify(skill), "body_read", "2026-09-21T00:00:00Z");
  insert.run(host.namespace, "1", "2", JSON.stringify(skill), "body_read", "2026-09-21T01:00:00Z");
  insert.run(host.namespace, "1", "3", JSON.stringify(skill), "reference_read", "2026-09-21T02:00:00Z");
  insert.run(host.namespace, "1", "4", JSON.stringify(plugin), "body_read", "2026-09-21T02:00:00Z");
  insert.run(host.namespace, "2", "5", JSON.stringify(skill), "script_executed", "2026-09-20T00:00:00Z");
  const all = vi.spyOn(host.runtimeCapabilities, "stageCounts");
  const filter = { namespace: host.namespace, sessionId: "1", from: "2026-09-21T00:00:00Z", to: "2026-09-22T00:00:00Z" };
  expect(host.runtimeCapabilities.stageCountsPage(filter, { dimension: "skill", limit: 1, offset: 0 }))
    .toEqual({ total: 2, items: [{ capability: skill, stage: "body_read", count: 2 }] });
  expect(host.runtimeCapabilities.stageCountsPage(filter, { dimension: "skill", limit: 1, offset: 1 }))
    .toEqual({ total: 2, items: [{ capability: skill, stage: "reference_read", count: 1 }] });
  expect(host.runtimeCapabilities.stageCountsPage(filter, { dimension: "all", limit: 1, offset: 9 }))
    .toEqual({ total: 3, items: [] });
  expect(host.runtimeCapabilities.stageCountsPage({ ...filter, runtimeKind: "claude_code" }, { dimension: "all", limit: 20, offset: 0 }))
    .toEqual({ total: 0, items: [] });
  expect(all).not.toHaveBeenCalled();
});
