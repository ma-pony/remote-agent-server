import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { UsageQueryCache } from "../src/agent-usage/query-cache.js";

it("invalidates projections on local and external commits without caching raw history", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-cache-"));
  const db = new Database(join(root, "usage.sqlite"));
  db.pragma("journal_mode=WAL"); db.exec("CREATE TABLE values_table (n INTEGER)");
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
