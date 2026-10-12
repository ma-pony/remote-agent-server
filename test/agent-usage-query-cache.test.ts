import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { UsageQueryCache } from "../src/agent-usage/query-cache.js";
import { trackUsageQueryChanges } from "../src/agent-usage/storage/query-version.js";
import { UsageStore } from "../src/agent-usage/storage/usage-store.js";

it("invalidates projections on local and external commits without caching raw history", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-cache-"));
  const db = new Database(join(root, "usage.sqlite"));
  db.pragma("journal_mode=WAL"); db.exec("CREATE TABLE values_table (n INTEGER)");
  trackUsageQueryChanges(db, "values_table");
  const other = new Database(join(root, "usage.sqlite"));
  try {
    const cache = new UsageQueryCache(db);
    const compute = vi.fn(() => db.prepare("SELECT SUM(n) AS total FROM values_table").get());
    const revision = cache.revision();
    expect(cache.get("summary", compute)).toEqual({ total: null });
    cache.get("summary", compute); expect(compute).toHaveBeenCalledTimes(1);
    expect(cache.revision()).toBe(revision);
    db.prepare("INSERT INTO values_table VALUES (?)").run(10);
    expect(cache.get("summary", compute)).toEqual({ total: 10 });
    const localRevision = cache.revision(); expect(localRevision).not.toBe(revision);
    other.prepare("INSERT INTO values_table VALUES (?)").run(20);
    expect(cache.get("summary", compute)).toEqual({ total: 30 });
    expect(cache.revision()).not.toBe(localRevision);
    db.prepare("DELETE FROM values_table").run();
    expect(cache.get("summary", compute)).toEqual({ total: null });
  } finally { other.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

it("bounds entry count and bytes, and skips oversized responses", () => {
  const db = new Database(":memory:");
  try {
    const cache = new UsageQueryCache(db), compute = vi.fn(() => "small");
    cache.get("first", compute);
    for (let index = 0; index < 32; index++) cache.get(String(index), compute);
    cache.get("first", compute); expect(compute).toHaveBeenCalledTimes(34);
    const medium = vi.fn(() => "x".repeat(300 * 1024));
    cache.get("medium", medium);
    for (let index = 0; index < 14; index++) cache.get(`medium-${index}`, medium);
    cache.get("medium", medium); expect(medium).toHaveBeenCalledTimes(16);
    const oversized = vi.fn(() => "x".repeat(600 * 1024));
    cache.get("large", oversized); cache.get("large", oversized);
    expect(oversized).toHaveBeenCalledTimes(2);
  } finally { db.close(); }
});

it("shares concurrent reads but never caches a result across a write during that read", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE values_table(n INTEGER)");
    trackUsageQueryChanges(db, "values_table");
    const cache = new UsageQueryCache(db);
    let finish!: (value: number) => void;
    const compute = vi.fn(() => new Promise<number>(resolve => { finish = resolve; }));
    const first = cache.getAsync("summary", compute), second = cache.getAsync("summary", compute);
    expect(compute).toHaveBeenCalledTimes(1);
    db.exec("INSERT INTO values_table VALUES(1)");
    finish(0);
    expect(await Promise.all([first, second])).toEqual([0, 0]);
    const current = vi.fn(async () => 1);
    expect(await cache.getAsync("summary", current)).toBe(1);
    expect(await cache.getAsync("summary", current)).toBe(1);
    expect(current).toHaveBeenCalledTimes(1);
  } finally { db.close(); }
});

it("keeps expensive projections across unrelated writes and bounds stale snapshots after usage changes", async () => {
  const db = new Database(":memory:");
  vi.useFakeTimers();
  try {
    db.exec("CREATE TABLE values_table(n INTEGER); CREATE TABLE runtime_events(n INTEGER)");
    trackUsageQueryChanges(db, "values_table");
    const cache = new UsageQueryCache(db);
    const compute = vi.fn(async () => db.prepare("SELECT SUM(n) AS total FROM values_table").get());
    const revision = cache.revision();
    expect(await cache.getAsync("ranking", compute, 30_000)).toEqual({ total: null });
    db.exec("INSERT INTO runtime_events VALUES(1)");
    expect(cache.revision()).toBe(revision);
    await cache.getAsync("ranking", compute, 30_000);
    expect(compute).toHaveBeenCalledTimes(1);
    db.exec("INSERT INTO values_table VALUES(10)");
    expect(cache.revision()).not.toBe(revision);
    expect(await cache.getAsync("ranking", compute, 30_000)).toEqual({ total: null });
    vi.advanceTimersByTime(30_000);
    expect(await cache.getAsync("ranking", compute, 30_000)).toEqual({ total: 10 });
    expect(compute).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); db.close(); }
});

it("shares an in-flight read across usage revisions and retains its bounded snapshot", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE values_table(n INTEGER)");
    trackUsageQueryChanges(db, "values_table");
    const cache = new UsageQueryCache(db);
    let finish!: (value: number) => void;
    const compute = vi.fn(() => new Promise<number>(resolve => { finish = resolve; }));
    const first = cache.getAsync("ranking", compute, 30_000);
    db.exec("INSERT INTO values_table VALUES(10)");
    const second = cache.getAsync("ranking", compute, 30_000);
    expect(compute).toHaveBeenCalledTimes(1);
    finish(0);
    expect(await Promise.all([first, second])).toEqual([0, 0]);
    expect(await cache.getAsync("ranking", compute, 30_000)).toBe(0);
    expect(compute).toHaveBeenCalledTimes(1);
  } finally { db.close(); }
});

it("invalidates stale snapshots immediately when a Session is deleted", async () => {
  const db = new Database(":memory:");
  try {
    const store = new UsageStore(db);
    store.bindSession("test", "1", "1");
    const cache = new UsageQueryCache(db), compute = vi.fn(async () => 1);
    await cache.getAsync("ranking", compute, 30_000);
    store.deleteSession("test", "1");
    await cache.getAsync("ranking", compute, 30_000);
    expect(compute).toHaveBeenCalledTimes(2);
  } finally { db.close(); }
});

it("explicit refresh bypasses an unchanged completed snapshot", async () => {
  const db = new Database(":memory:");
  try {
    const cache = new UsageQueryCache(db), compute = vi.fn(async () => compute.mock.calls.length);
    expect(await cache.getAsync("ranking",compute,30_000)).toBe(1);
    expect(await cache.getAsync("ranking",compute,30_000)).toBe(1);
    expect(await cache.getAsync("ranking",compute,30_000,true)).toBe(2);
  } finally { db.close(); }
});
