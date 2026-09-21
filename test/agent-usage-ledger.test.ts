import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";
import { normalizeUsage } from "../src/agent-usage/core/usage.js";
import { accountingRequests } from "./fixtures/agent-usage/accounting.js";

const databases: Database.Database[] = [];
const setup = () => {
  const db = new Database(":memory:"); databases.push(db);
  const store = new UsageStore(db);
  const binding = store.bindSession("test", "agent-1", "session-1");
  return { db, store, binding };
};
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("usage ledger", () => {
  it("retains known totals while exposing missing requests and cache subsets", () => {
    const { store, binding } = setup();
    for (const observation of accountingRequests()) store.observe(binding, observation);
    expect(store.summary({ namespace: "test" })).toMatchObject({
      usage: { inputTotalTokens: 3000, outputTotalTokens: 300, cacheReadTokens: 1000, totalTokens: 3300 },
      completeness: "partial", observedModelRequests: 4, requestsWithCompleteUsage: 3,
      requestsWithMissingUsage: 1, requestsWithPartialUsage: 0
    });
  });

  it("does not turn unknown values into zero or sum context occupancy", () => {
    expect(normalizeUsage({ contextUsedTokens: 12000 })).toMatchObject({ totalTokens: null, inputTotalTokens: null });
    expect(normalizeUsage({ inputTotalTokens: 1000, outputTotalTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 0, reasoningOutputTokens: 50 }))
      .toMatchObject({ totalTokens: 1100, inputUncachedTokens: 500 });
    expect(normalizeUsage({ inputTotalTokens: 1000, cacheReadTokens: 300 }).inputUncachedTokens).toBeNull();
    expect(() => normalizeUsage({ inputTotalTokens: -1 })).toThrow("invalid_usage_metric");
  });

  it("deduplicates replay but counts separate requests with equal content", () => {
    const { store, binding } = setup();
    const request = accountingRequests()[0]!;
    store.observe(binding, request); store.observe(binding, request);
    store.observe(binding, { ...request, eventId: "other", coverageId: "other", invocationId: "other" });
    expect(store.summary({ namespace: "test" }).usage.totalTokens).toBe(2200);
  });

  it("keeps more than 100 records and survives a new store instance", () => {
    const { store, binding, db } = setup();
    for (let n = 0; n < 150; n++) store.observe(binding, {
      ...accountingRequests()[0]!, eventId: `e${n}`, coverageId: `r${n}`, invocationId: `r${n}`
    });
    expect(new UsageStore(db).summary({ namespace: "test" }).usage.totalTokens).toBe(165000);
  });

  it("replaces a snapshot and never lets late interim overwrite final", () => {
    const { store, binding } = setup();
    const request = accountingRequests()[0]!;
    store.observe(binding, { ...request, finality: "interim", revision: 1, metrics: { inputTotalTokens: 100 } });
    store.observe(binding, { ...request, eventId: "final", revision: 2 });
    store.observe(binding, { ...request, eventId: "late-interim", finality: "interim", revision: 3, metrics: { totalTokens: 9999 } });
    expect(store.summary({ namespace: "test" }).usage.totalTokens).toBe(1100);
  });

  it("retains observations with unverified semantics without counting them", () => {
    const { store, binding } = setup();
    store.observe(binding, { ...accountingRequests()[0]!, semantics: "unknown", normalizationProfile: null });
    const summary = store.summary({ namespace: "test" });
    expect(summary.usage.totalTokens).toBeNull();
    expect(summary.completeness).toBe("partial");
    expect(summary.unverifiedObservations).toBe(1);
  });

  it("chooses a range total without adding overlapping request detail", () => {
    const { store, binding } = setup();
    for (const observation of accountingRequests()) store.observe(binding, observation);
    store.observe(binding, {
      ...accountingRequests()[0]!, eventId: "session-total", scope: "provider_session",
      coverageId: "epoch-1", invocationId: null, occurredAt: null,
      metrics: { inputTotalTokens: 4000, outputTotalTokens: 400 }
    });
    const summary = store.summary({ namespace: "test" });
    expect(summary.usage.totalTokens).toBe(4400);
    expect(summary.accountingBasis).toBe("range_totals");
    expect(summary.unplacedUsage.totalTokens).toBe(1100);
    expect(store.summary({ namespace: "test", from: "2026-09-20T00:00:00Z", to: "2026-09-21T00:00:00Z" }).usage.totalTokens).toBe(3300);
  });

  it("does not count the same explicit request identity from two sources twice", () => {
    const { store, binding } = setup();
    const request = accountingRequests()[0]!;
    store.observe(binding, request);
    store.observe(binding, { ...request, eventId: "second-source", sourceId: "other" });
    expect(store.summary({ namespace: "test" }).usage.totalTokens).toBe(1100);
  });

  it("rejects stale bindings, replay and re-registration after deletion", () => {
    const { store, binding, db } = setup();
    store.observe(binding, accountingRequests()[0]!);
    store.deleteSession("test", "session-1");
    expect(store.summary({ namespace: "test" }).usage.totalTokens).toBeNull();
    expect(() => store.observe(binding, { ...accountingRequests()[0]!, eventId: "late" })).toThrow("usage_subject_deleted");
    expect(() => new UsageStore(db).bindSession("test", "agent-1", "session-1")).toThrow("usage_subject_deleted");
    const other = store.bindSession("test", "agent-1", "session-2");
    store.observe(other, { ...accountingRequests()[0]!, eventId: "other-session", coverageId: "other-request" });
    expect(store.summary({ namespace: "test" }).usage.totalTokens).toBe(1100);
  });

  it("adds independent delta events within a request exactly once", () => {
    const { store, binding } = setup();
    const delta = { ...accountingRequests()[0]!, semantics: "delta" as const, metrics: { inputTotalTokens: 10, outputTotalTokens: 2 } };
    store.observe(binding, delta);
    store.observe(binding, { ...delta, eventId: "delta-2" });
    store.observe(binding, { ...delta, eventId: "delta-2" });
    expect(store.summary({ namespace: "test" }).usage.totalTokens).toBe(24);
  });

  it("retains competing source facts and reports their conflict", () => {
    const { store, binding } = setup();
    store.observe(binding, accountingRequests()[0]!);
    store.observe(binding, { ...accountingRequests()[0]!, sourceId: "second", metrics: { inputTotalTokens: 2000, outputTotalTokens: 100 } });
    expect(store.summary({ namespace: "test" })).toMatchObject({ completeness: "conflict", conflictingRanges: 1, usage: { totalTokens: 1100 } });
  });

  it("does not let an empty parent erase detail or label contradictory totals complete", () => {
    const { store, binding } = setup();
    const request = accountingRequests()[0]!;
    store.observe(binding, request);
    const parent = { ...request, eventId: "parent", scope: "provider_session" as const, coverageId: "epoch-1", invocationId: null, metrics: {} };
    store.observe(binding, parent);
    expect(store.summary({ namespace: "test" }).usage.totalTokens).toBe(1100);
    store.observe(binding, { ...parent, eventId: "parent-final", revision: 2, metrics: { inputTotalTokens: 100, outputTotalTokens: 10 } });
    expect(store.summary({ namespace: "test" }).completeness).toBe("conflict");
  });

  it("flags an unexplained cumulative decrease and retains the prior accounting basis", () => {
    const { store, binding } = setup();
    const range = { ...accountingRequests()[0]!, semantics: "cumulative" as const, scope: "provider_session" as const, coverageId: "epoch-1" };
    store.observe(binding, range);
    store.observe(binding, { ...range, eventId: "decreased", revision: 2, metrics: { inputTotalTokens: 100, outputTotalTokens: 10 } });
    expect(store.summary({ namespace: "test" })).toMatchObject({ completeness: "conflict", usage: { totalTokens: 1100 } });
  });

  it("keeps source-local request IDs separate without a common invocation identity", () => {
    const { store, binding } = setup();
    const request = { ...accountingRequests()[0]!, invocationId: null };
    store.observe(binding, request);
    store.observe(binding, { ...request, sourceId: "unrelated" });
    expect(store.summary({ namespace: "test" })).toMatchObject({ observedModelRequests: 2, usage: { totalTokens: 2200 } });
  });

  it.each(["turn", "model_request"] as const)("does not add a partial parent total to its %s detail", (scope) => {
    const { store, binding } = setup();
    const base = accountingRequests()[0]!;
    store.observe(binding, { ...base, eventId: "parent", scope: "provider_session", coverageId: "epoch-1", metrics: { totalTokens: 2200 } });
    store.observe(binding, { ...base, scope, metrics: scope === "turn" ? { totalTokens: 1100 } : base.metrics });
    const result = store.summary({ namespace: "test" });
    expect(result.usage.totalTokens).toBe(2200);
    expect(result.unplacedUsage.totalTokens).toBe(1100);
  });

  it("retains a cumulative comparison baseline across a missing-field snapshot", () => {
    const { store, binding } = setup();
    const range = { ...accountingRequests()[0]!, semantics: "cumulative" as const, scope: "provider_session" as const, coverageId: "epoch-1" };
    store.observe(binding, range);
    store.observe(binding, { ...range, eventId: "empty", revision: 2, metrics: {} });
    expect(store.summary({ namespace: "test" }).completeness).toBe("partial");
    store.observe(binding, { ...range, eventId: "decreased", revision: 3, metrics: { inputTotalTokens: 100, outputTotalTokens: 10 } });
    expect(store.summary({ namespace: "test" })).toMatchObject({ completeness: "conflict", usage: { totalTokens: 1100 } });
  });
});
