import { Worker } from "node:worker_threads";
import type { HostUsageCollector } from "./host-collector.js";
import type { UsageQueries, UsageQuery, UsageQuerySnapshot } from "./query-reader.js";
import { usageQueryVersion } from "./storage/query-version.js";
import { executeUsageQuery } from "./query-reader.js";

type Job = { query: UsageQuery; resolve(value: unknown): void; reject(error: Error): void;
  deadline: number; queueTimer?: NodeJS.Timeout };
const source = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const module = workerData.tsx
    ? await (await import(workerData.tsx)).tsImport(workerData.moduleUrl, workerData.moduleUrl)
    : await import(workerData.moduleUrl);
  const reader = module.openUsageQueryReader(workerData.filename);
  parentPort.on('message', query => {
    try { parentPort.postMessage({ result: reader.readSnapshot(query) }); }
    catch { parentPort.postMessage({ failed: true }); }
  });
})().catch(() => { throw new Error('usage_query_failed'); });
`;

export class UsageQueryWorkerError extends Error {
  constructor(readonly code: "usage_query_busy" | "usage_query_closed" | "usage_query_failed" | "usage_query_timeout") { super(code); }
}

/** One read-only SQLite worker and a bounded queue keep analytics off the request event loop. */
export class UsageQueryWorker {
  private worker?: Worker;
  private active?: Job;
  private readonly pending: Job[] = [];
  private idleTimer?: NodeJS.Timeout;
  private activeTimer?: NodeJS.Timeout;
  private retiring?: Promise<void>;
  private closed = false;

  constructor(private readonly collector: Pick<HostUsageCollector, "db" | "store" | "attribution">, private readonly timeoutMs = 30_000) {}

  async read<K extends keyof UsageQueries>(kind: K, args: UsageQueries[K]["args"]): Promise<UsageQueries[K]["result"]> {
    return (await this.readSnapshot(kind,args)).value;
  }

  async readSnapshot<K extends keyof UsageQueries>(kind: K, args: UsageQueries[K]["args"]): Promise<UsageQuerySnapshot<UsageQueries[K]["result"]>> {
    if (this.closed) throw new UsageQueryWorkerError("usage_query_closed");
    const query = { kind, args } as UsageQuery;
    // In-memory databases belong to their connection and cannot be opened by another worker.
    if (this.collector.db.memory) return this.collector.db.transaction(() => ({
      revision: usageQueryVersion(this.collector.db).revision, asOf: new Date().toISOString(),
      value: executeUsageQuery(this.collector.store,this.collector.attribution,query) as UsageQueries[K]["result"]
    }))();
    if (this.pending.length >= 16) throw new UsageQueryWorkerError("usage_query_busy");
    return new Promise((resolve, reject) => {
      const job: Job = { query, deadline: Date.now()+this.timeoutMs,
        resolve: value => resolve(value as UsageQuerySnapshot<UsageQueries[K]["result"]>), reject };
      this.pending.push(job);
      job.queueTimer = setTimeout(() => {
        const index = this.pending.indexOf(job);
        if (index<0) return;
        this.pending.splice(index,1);
        job.reject(new UsageQueryWorkerError("usage_query_timeout"));
      },this.timeoutMs);
      this.next();
    });
  }

  private next(): void {
    if (this.active || this.retiring || !this.pending.length || this.closed) return;
    clearTimeout(this.idleTimer);
    this.active = this.pending.shift()!;
    clearTimeout(this.active.queueTimer);
    const remainingMs = this.active.deadline-Date.now();
    if (remainingMs<=0) {
      this.active.reject(new UsageQueryWorkerError("usage_query_timeout")); this.active = undefined;
      this.next(); return;
    }
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
          clearTimeout(this.activeTimer);
          const active = this.active; this.active = undefined;
          if (message.failed) active?.reject(new UsageQueryWorkerError("usage_query_failed"));
          else active?.resolve(message.result);
          if (this.pending.length) this.next();
          else {
            worker.unref();
            this.idleTimer = setTimeout(() => { void this.retireWorker(); }, 60_000);
            this.idleTimer.unref();
          }
        });
        worker.on("error", () => this.failed(worker));
        worker.on("exit", () => this.failed(worker));
      }
      this.worker.ref();
      this.worker.postMessage(this.active.query);
      this.activeTimer = setTimeout(() => {
        this.active?.reject(new UsageQueryWorkerError("usage_query_timeout")); this.active = undefined;
        void this.retireWorker();
      },remainingMs);
    } catch { this.failed(this.worker); }
  }

  private failed(worker: Worker | undefined): void {
    if (this.worker !== worker) return;
    clearTimeout(this.activeTimer);
    this.active?.reject(new UsageQueryWorkerError("usage_query_failed")); this.active = undefined;
    for (const job of this.pending.splice(0)) { clearTimeout(job.queueTimer); job.reject(new UsageQueryWorkerError("usage_query_failed")); }
    void this.retireWorker();
  }

  /** A synchronous native SQLite call can delay thread exit after terminate() is requested. */
  private retireWorker(): Promise<void> {
    const worker = this.worker;
    if (!worker) return this.retiring ?? Promise.resolve();
    this.worker = undefined;
    const retiring = worker.terminate().then(() => {
      this.retiring = undefined;
      this.next();
    });
    this.retiring = retiring;
    return retiring;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.activeTimer);
    this.active?.reject(new UsageQueryWorkerError("usage_query_closed")); this.active = undefined;
    for (const job of this.pending.splice(0)) { clearTimeout(job.queueTimer); job.reject(new UsageQueryWorkerError("usage_query_closed")); }
    await this.retireWorker();
  }
}
