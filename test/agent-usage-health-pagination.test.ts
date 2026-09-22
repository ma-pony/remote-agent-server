import { afterEach, expect, it, vi } from "vitest";
import { HostUsageCollector } from "../src/agent-usage/host-collector.js";
import { HostUsageCapture } from "../src/agent-usage/capture/host-capture.js";
import { createTestDatabase } from "./helpers.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it("counts and pages collection failures without reading the full failure list", () => {
  const { db, seed } = createTestDatabase(); cleanup.push(() => db.close());
  const host = new HostUsageCollector(db);
  const sessions = Array.from({ length: 4 }, () => seed.session());
  for (const session of sessions) db.prepare("INSERT INTO agent_usage_harvests(namespace,session_id,status,error_code) VALUES (?,?,'failed','usage_collection_failed')")
    .run(host.namespace, String(session.id));
  db.prepare("UPDATE sessions SET storage_cleaned_at='2026-09-01' WHERE id=?").run(sessions[3]!.id);
  const all = vi.spyOn(host, "collectionFailures");
  expect(host.collectionFailureCount({})).toBe(3);
  expect(host.collectionFailurePage({}, { page: 2, pageSize: 2 })).toMatchObject({ total: 3, totalPages: 2, items: [{ sessionId: String(sessions[2]!.id) }] });
  expect(host.collectionFailureCount({ sessionId: String(sessions[1]!.id) })).toBe(1);
  expect(host.collectionFailureCount({ runtimeKind: "claude" })).toBe(0);
  expect(all).not.toHaveBeenCalled();
});

it("pages capture epochs with consistent status counts and date-scoped aggregates", async () => {
  const { db } = createTestDatabase(); cleanup.push(() => db.close());
  const host = new HostUsageCollector(db);
  const capture = new HostUsageCapture(host, {}, new Map()); cleanup.push(() => capture.close());
  for (let index = 1; index <= 3; index++) {
    db.prepare("INSERT INTO agent_usage_capture_sessions VALUES (?, '1', ?, 'epoch', 'codex', 'waiting')").run(host.namespace, String(index));
  }
  db.prepare("INSERT INTO agent_usage_captures VALUES ('one', ?, '1', '1', 'epoch', NULL, 'codex', '2026-09-01', 'incomplete', 'interrupted')").run(host.namespace);
  db.prepare("INSERT INTO agent_usage_captures VALUES ('two', ?, '1', '2', 'epoch', NULL, 'codex', '2026-09-02', 'pending', NULL)").run(host.namespace);
  const all = vi.spyOn(capture, "health");
  expect(capture.healthCounts({})).toEqual({ incomplete: 1, pending: 1, waiting: 1 });
  expect(capture.healthPage({}, { page: 2, pageSize: 2 })).toMatchObject({ total: 3, totalPages: 2, items: [{ sessionId: "3", status: "waiting" }] });
  expect(capture.healthCounts({ from: "2026-09-02" })).toEqual({ pending: 1, waiting: 2 });
  expect(capture.healthPage({ sessionId: "1" }, { page: 1, pageSize: 20 }).items).toEqual([expect.objectContaining({ status: "incomplete", incomplete: 1, errorCode: "interrupted" })]);
  expect(capture.healthCounts({ runtimeKind: "claude" })).toEqual({});
  expect(all).not.toHaveBeenCalled();
});
