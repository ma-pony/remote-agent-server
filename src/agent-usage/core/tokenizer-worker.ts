import { Worker } from "node:worker_threads";
import type { ModelTokenizerProfile, TokenCount } from "./tokenizers.js";

type Job = { text: string; model: string | null; provider: string | null;
  signal?: AbortSignal; abort?: () => void; resolve(value: TokenCount): void; reject(error: Error): void };

// Development loads TypeScript through the existing tsx dependency; builds import plain JS.
const source = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const module = workerData.tsx
    ? await (await import(workerData.tsx)).tsImport(workerData.moduleUrl, workerData.moduleUrl)
    : await import(workerData.moduleUrl);
  const engine = new module.ModelTokenizers(workerData.profiles, { automaticCacheDirectory: workerData.automaticCacheDirectory, worker: false });
  parentPort.on('message', async ({ text, model, provider }) => {
    try { parentPort.postMessage({ result: await engine.countAsync(text, model, provider) }); }
    catch { parentPort.postMessage({ failed: true }); }
  });
})().catch(() => { throw new Error('usage_tokenizer_worker_failed'); });
`;

/** One active measurement per engine; idle workers release their vocabulary and text caches. */
export class TokenizerWorker {
  private worker?: Worker;
  private active?: Job;
  private readonly pending: Job[] = [];
  private idleTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly profiles: ModelTokenizerProfile[], private readonly moduleUrl: string, private readonly automaticCacheDirectory?: string) {}

  count(text: string, model: string | null, provider: string | null, signal?: AbortSignal): Promise<TokenCount> {
    if (this.closed) return Promise.reject(new Error("usage_tokenizer_closed"));
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const job: Job = { text, model, provider, resolve, reject, signal };
      job.abort = () => {
        if (this.active === job) {
          const worker = this.worker;
          this.worker = undefined; this.active = undefined;
          void worker?.terminate();
        } else {
          const index = this.pending.indexOf(job);
          if (index >= 0) this.pending.splice(index, 1);
        }
        this.detach(job);
        reject(new Error("usage_tokenizer_cancelled"));
        this.next();
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.pending.push(job);
      this.next();
    });
  }

  private next(): void {
    if (this.active || !this.pending.length) return;
    clearTimeout(this.idleTimer);
    const job = this.pending.shift()!;
    this.active = job;
    try {
      if (!this.worker) {
        const worker = new Worker(source, { eval: true, execArgv: [], workerData: {
          moduleUrl: this.moduleUrl, profiles: this.profiles, automaticCacheDirectory: this.automaticCacheDirectory,
          ...(this.moduleUrl.endsWith(".ts") ? { tsx: import.meta.resolve("tsx/esm/api") } : {})
        } });
        this.worker = worker;
        worker.on("message", (message: { result?: TokenCount }) => {
          if (this.worker !== worker) return;
          const active = this.active;
          this.active = undefined;
          if (active) this.detach(active);
          if (message.result) active?.resolve(message.result);
          else active?.reject(new Error("usage_tokenizer_worker_failed"));
          if (this.pending.length) this.next();
          else {
            worker.unref();
            this.idleTimer = setTimeout(() => {
              this.worker = undefined;
              void worker.terminate();
            }, 60_000);
            this.idleTimer.unref();
          }
        });
        worker.on("error", () => this.failed(worker));
        worker.on("exit", () => this.failed(worker));
      }
      this.worker.ref();
      this.worker.postMessage({ text: job.text, model: job.model, provider: job.provider });
    } catch {
      this.active = undefined;
      this.detach(job);
      job.reject(new Error("usage_tokenizer_worker_failed"));
      this.next();
    }
  }

  private failed(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    if (this.active) { this.detach(this.active); this.active.reject(new Error("usage_tokenizer_worker_failed")); }
    this.active = undefined;
    for (const job of this.pending.splice(0)) { this.detach(job); job.reject(new Error("usage_tokenizer_worker_failed")); }
  }

  private detach(job: Job): void {
    if (job.abort) job.signal?.removeEventListener("abort", job.abort);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.idleTimer);
    const worker = this.worker;
    this.worker = undefined;
    if (this.active) { this.detach(this.active); this.active.reject(new Error("usage_tokenizer_closed")); }
    this.active = undefined;
    for (const job of this.pending.splice(0)) { this.detach(job); job.reject(new Error("usage_tokenizer_closed")); }
    await worker?.terminate();
  }
}
