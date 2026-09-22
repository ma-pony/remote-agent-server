import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/** Caches bounded, body-free query projections until this or another connection writes. */
export class UsageQueryCache {
  private version = "";
  private token = "";
  private bytes = 0;
  private readonly entries = new Map<string, { value: unknown; bytes: number }>();

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
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > 512 * 1024) return value;
    while (this.entries.size >= 32 || this.bytes + bytes > 4 * 1024 * 1024) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
    return value;
  }
}
