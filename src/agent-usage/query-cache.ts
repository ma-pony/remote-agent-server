import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/** Caches bounded, body-free query projections until this or another connection writes. */
export class UsageQueryCache {
  private version = "";
  private token = "";
  private bytes = 0;
  private readonly entries = new Map<string, { value: unknown; bytes: number }>();
  private readonly pending = new Map<string, { revision: string; promise: Promise<unknown> }>();

  constructor(private readonly db: Database.Database) {}

  revision(): string {
    const changes = this.db.prepare("SELECT total_changes() AS n").get() as { n: number };
    const version = `${changes.n}:${this.db.pragma("data_version", { simple: true })}`;
    if (version !== this.version) {
      this.version = version; this.token = randomUUID();
      this.entries.clear(); this.bytes = 0;
    }
    return this.token;
  }

  get<T>(key: string, compute: () => T): T {
    this.revision();
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key); this.entries.set(key, cached);
      return cached.value as T;
    }
    const value = compute();
    return this.remember(key, value);
  }

  async getAsync<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const revision = this.revision();
    const cached = this.entries.get(key);
    if (cached) return this.get(key, () => cached.value as T);
    const pending = this.pending.get(key);
    if (pending?.revision === revision) return pending.promise as Promise<T>;
    const promise = compute().then(value => {
      if (this.revision() === revision) this.remember(key, value);
      return value;
    }).finally(() => {
      if (this.pending.get(key)?.promise === promise) this.pending.delete(key);
    });
    this.pending.set(key, { revision, promise });
    return promise;
  }

  private remember<T>(key: string, value: T): T {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > 512 * 1024) return value;
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    while (this.entries.size >= 32 || this.bytes + bytes > 4 * 1024 * 1024) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
    return value;
  }
}
