import { Worker } from "node:worker_threads";
import type { HostUsageCollector } from "./host-collector.js";
import type { UsageQueries, UsageQuery } from "./query-reader.js";

type Job = { query: UsageQuery; resolve(value: unknown): void; reject(error: Error): void };
const source = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const module = workerData.tsx
    ? await (await import(workerData.tsx)).tsImport(workerData.moduleUrl, workerData.moduleUrl)
    : await import(workerData.moduleUrl);
  const reader = module.openUsageQueryReader(workerData.filename);
  parentPort.on('message', query => {
    try { parentPort.postMessage({ result: reader.read(query) }); }
    catch { parentPort.postMessage({ failed: true }); }
  });
})().catch(() => { throw new Error('usage_query_failed'); });
`;

export class UsageQueryWorkerError extends Error {
  constructor(readonly code: "usage_query_busy" | "usage_query_closed" | "usage_query_failed") { super(code); }
}

/** One read-only SQLite worker and a bounded queue keep analytics off the request event loop. */
export class UsageQueryWorker {
  private worker?: Worker;
  private active?: Job;
  private readonly pending: Job[] = [];
  private idleTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly collector: Pick<HostUsageCollector, "db" | "store" | "attribution">) {}

  async read<K extends keyof UsageQueries>(kind: K, args: UsageQueries[K]["args"]): Promise<UsageQueries[K]["result"]> {
    if (this.closed) throw new UsageQueryWorkerError("usage_query_closed");
    const query = { kind, args } as UsageQuery;
    // In-memory databases belong to their connection and cannot be opened by another worker.
    if (this.collector.db.memory) return (query.kind === "overview"
      ? this.collector.store.overview(...query.args) : query.kind === "sessionSummaries"
        ? this.collector.store.summariesBySession(...query.args)
        : this.collector.attribution.rankingsPage(...query.args)) as UsageQueries[K]["result"];
    if (this.pending.length >= 16) throw new UsageQueryWorkerError("usage_query_busy");
    return new Promise((resolve, reject) => {
      this.pending.push({ query, resolve: value => resolve(value as UsageQueries[K]["result"]), reject });
      this.next();
    });
  }

  private next(): void {
    if (this.active || !this.pending.length || this.closed) return;
    clearTimeout(this.idleTimer);
    this.active = this.pending.shift()!;
    try {
      if (!this.worker) {
        const moduleUrl = new URL(import.meta.url.endsWith(".ts") ? "./query-reader.ts" : "./query-reader.js", import.meta.url).href;
        const worker = new Worker(source, { eval: true, execArgv: [], workerData: {
          filename: this.collector.db.name, moduleUrl,
          ...(moduleUrl.endsWith(".ts") ? { tsx: import.meta.resolve("tsx/esm/api") } : {})
        } });
        this.worker = worker;
        worker.on("message", (message: { result?: unknown; failed?: boolean }) => {
          if (this.worker !== worker) return;
          const active = this.active; this.active = undefined;
          if (message.failed) active?.reject(new UsageQueryWorkerError("usage_query_failed"));
          else active?.resolve(message.result);
          if (this.pending.length) this.next();
          else {
            worker.unref();
            this.idleTimer = setTimeout(() => { this.worker = undefined; void worker.terminate(); }, 60_000);
            this.idleTimer.unref();
          }
        });
        worker.on("error", () => this.failed(worker));
        worker.on("exit", () => this.failed(worker));
      }
      this.worker.ref();
      this.worker.postMessage(this.active.query);
    } catch { this.failed(this.worker); }
  }

  private failed(worker: Worker | undefined): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    void worker?.terminate();
    this.active?.reject(new UsageQueryWorkerError("usage_query_failed")); this.active = undefined;
    for (const job of this.pending.splice(0)) job.reject(new UsageQueryWorkerError("usage_query_failed"));
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.idleTimer);
    const worker = this.worker; this.worker = undefined;
    this.active?.reject(new UsageQueryWorkerError("usage_query_closed")); this.active = undefined;
    for (const job of this.pending.splice(0)) job.reject(new UsageQueryWorkerError("usage_query_closed"));
    await worker?.terminate();
  }
}
