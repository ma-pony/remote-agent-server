import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HostUsageCollector } from "../src/agent-usage/host-collector.js";
import { UsageQueryWorker } from "../src/agent-usage/query-worker.js";
import { createTestDatabase } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-query-worker-"));
  const { db } = createTestDatabase(join(root, "usage.sqlite"));
  const host = new HostUsageCollector(db), worker = new UsageQueryWorker(host);
  cleanups.push(async () => { await worker.close(); await host.attribution.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  const estimate = JSON.stringify({ measurement: "estimated", method: "text_heuristic", model: null, reason: "model_missing" });
  const insert = db.prepare("INSERT INTO agent_usage_conversation_content (namespace,session_id,agent_id,run_id,event_key,category,occurred_at,runtime_kind,tokens,bytes,partial,estimate_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  db.transaction(() => {
    for (let seq = 0; seq < 200; seq++) insert.run(host.namespace, "1", "1", 1, String(seq), "user_prompt", "2026-09-22T01:00:00Z", "codex", 3, 10, 0, estimate);
  })();
  return { db, host, worker };
};
const options = { sort: "observedTotalTokens", limit: 20, offset: 0 } as const;

it("reads a consistent file-backed ranking off the main thread and sees later commits without migrations", async () => {
  const { db, host, worker } = await setup(), filter = { namespace: host.namespace };
  const expected = host.attribution.rankingsPage(filter, "all", options);
  const version = db.pragma("schema_version", { simple: true });
  vi.spyOn(host.attribution, "rankingsPage").mockImplementation(() => { throw new Error("Main-thread query"); });
  let timerRan = false;
  const timer = setTimeout(() => { timerRan = true; }, 0);
  try {
    expect(await worker.read("rankings", [filter, "all", options])).toEqual(expected);
    expect(timerRan).toBe(true);
    expect(db.pragma("schema_version", { simple: true })).toBe(version);
    db.prepare("UPDATE agent_usage_conversation_content SET tokens=4").run();
    expect((await worker.read("rankings", [filter, "all", options])).items[0]?.observedTotalTokens).toBe(800);
  } finally { clearTimeout(timer); }
});

it("bounds queued work and rejects active and queued requests when closed", async () => {
  const { host, worker } = await setup(), filter = { namespace: host.namespace };
  const requests = Promise.allSettled(Array.from({ length: 20 }, () => worker.read("rankings", [filter, "all", options])));
  await worker.close();
  const results = await requests;
  const codes = results.map(result => result.status === "rejected" ? result.reason.code : "completed");
  expect(codes.filter(code => code === "usage_query_busy")).toHaveLength(3);
  expect(codes.filter(code => code === "usage_query_closed")).toHaveLength(17);
  await expect(worker.read("rankings", [filter, "all", options])).rejects.toMatchObject({ code: "usage_query_closed" });
});

it("redacts SQL errors while allowing another supported query to continue", async () => {
  const { db, host, worker } = await setup();
  db.exec("DROP TABLE agent_usage_invocation_payloads");
  await expect(worker.read("rankings", [{ namespace: host.namespace }, "all", options]))
    .rejects.toMatchObject({ code: "usage_query_failed", message: "usage_query_failed" });
  const expected = host.store.overview({ namespace: host.namespace }, "UTC", "day");
  expect(await worker.read("overview", [{ namespace: host.namespace }, "UTC", "day"]))
    .toEqual({ ...expected, summary: { ...expected.summary, asOf: expect.any(String) } });
});
