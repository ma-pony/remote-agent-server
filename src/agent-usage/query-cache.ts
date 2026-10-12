import type Database from "better-sqlite3";
import { ensureUsageQueryVersion, usageQueryVersion } from "./storage/query-version.js";

/** Bounded projections; lightweight metadata stays live and expensive reads share one task. */
export class UsageQueryCache {
  private generation = -1;
  private bytes = 0;
  private readonly entries = new Map<string, { value: unknown; bytes: number; revision: string; createdAt: number }>();
  private readonly pending = new Map<string, { generation: number; promise: Promise<unknown> }>();

  constructor(private readonly db: Database.Database) { ensureUsageQueryVersion(db); }

  revision(): string {
    const version = usageQueryVersion(this.db);
    if (version.generation !== this.generation) {
      this.generation = version.generation;
      this.entries.clear(); this.bytes = 0;
    }
    return version.revision;
  }

  get<T>(key: string, compute: () => T): T {
    this.revision();
    const changes = this.db.prepare("SELECT total_changes() AS n").get() as { n: number };
    const revision = `metadata:${changes.n}:${this.db.pragma("data_version", { simple: true })}`;
    const cached = this.entries.get(key);
    if (cached?.revision === revision) {
      this.entries.delete(key); this.entries.set(key, cached);
      return cached.value as T;
    }
    const value = compute();
    return this.remember(key, value, revision, Date.now());
  }

  async getAsync<T>(key: string, compute: () => Promise<T>, maxAgeMs = 0, forceFresh = false): Promise<T> {
    const revision = this.revision();
    const generation = this.generation, startedAt = Date.now();
    const cached = this.entries.get(key);
    if (!forceFresh && cached && (cached.revision === revision || startedAt - cached.createdAt < maxAgeMs)) {
      this.entries.delete(key); this.entries.set(key, cached);
      return cached.value as T;
    }
    const pending = this.pending.get(key);
    if (pending?.generation === generation) return pending.promise as Promise<T>;
    const promise = compute().then(value => {
      this.revision();
      if (this.generation === generation) this.remember(key, value, revision, startedAt);
      return value;
    }).finally(() => {
      if (this.pending.get(key)?.promise === promise) this.pending.delete(key);
    });
    this.pending.set(key, { generation, promise });
    return promise;
  }

  private remember<T>(key: string, value: T, revision: string, createdAt: number): T {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > 512 * 1024) return value;
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    while (this.entries.size >= 32 || this.bytes + bytes > 4 * 1024 * 1024) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, bytes, revision, createdAt }); this.bytes += bytes;
    return value;
  }
}
