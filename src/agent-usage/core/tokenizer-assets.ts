import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { ModelTokenizerProfile } from "./tokenizers.js";

export type AutomaticTokenizerProfile = {
  id: string; models: string[]; repository: string; revision: string;
  tokenizerSha256: string; configSha256: string;
};
const ASSET_BYTES = 32 * 1024 * 1024;
// Both endpoints serve the same pinned bytes. Mirrors are never trusted without the digest.
const ASSET_ORIGINS = ["https://huggingface.co", "https://hf-mirror.com"];
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Fetches vocabulary data only. Content being measured never leaves the process. */
export class LazyTokenizerAssets {
  private readonly pending = new Map<string, Promise<ModelTokenizerProfile>>();
  private readonly failures = new Map<string, number>();

  constructor(private readonly directory: string, private readonly request: typeof fetch = fetch) {}

  load(profile: AutomaticTokenizerProfile): Promise<ModelTokenizerProfile> {
    const pending = this.pending.get(profile.id);
    if (pending) return pending;
    const failedAt = this.failures.get(profile.id);
    if (failedAt !== undefined && Date.now() - failedAt < 60_000) {
      return Promise.reject(new Error("usage_tokenizer_download_failed"));
    }
    const work = Promise.allSettled([
      this.asset(profile, "tokenizer.json", profile.tokenizerSha256),
      this.asset(profile, "tokenizer_config.json", profile.configSha256)
    ]).then(([tokenizer, config]) => {
      if (tokenizer.status !== "fulfilled" || config.status !== "fulfilled") throw new Error("usage_tokenizer_download_failed");
      return { id: profile.id, models: profile.models, tokenizerJson: tokenizer.value, tokenizerConfig: config.value };
    })
      .catch(() => {
        this.failures.set(profile.id, Date.now());
        throw new Error("usage_tokenizer_download_failed");
      }).finally(() => this.pending.delete(profile.id));
    this.pending.set(profile.id, work);
    return work;
  }

  private async asset(profile: AutomaticTokenizerProfile, filename: string, sha256: string): Promise<Record<string, unknown>> {
    const path = join(this.directory, `${sha256}.json`);
    let cached: Buffer | undefined;
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (stat.isFile() && stat.size <= ASSET_BYTES) cached = await file.readFile();
      } finally { await file.close(); }
    } catch { /* Missing or damaged caches are replaced only after validating a fresh download. */ }
    if (cached && digest(cached) === sha256) return this.parse(cached);

    for (const origin of ASSET_ORIGINS) {
      try { return await this.download(`${origin}/${profile.repository}/resolve/${profile.revision}/${filename}`, path, sha256); }
      catch { /* Retry the same pinned asset through the next origin. */ }
    }
    throw new Error("usage_tokenizer_download_failed");
  }

  private async download(url: string, path: string, sha256: string): Promise<Record<string, unknown>> {
    const response = await this.request(url,
      { signal: AbortSignal.timeout(15_000), credentials: "omit" });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("usage_tokenizer_download_failed");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > ASSET_BYTES) throw new Error("usage_tokenizer_asset_invalid");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const bytes = Buffer.concat(chunks, size);
    if (digest(bytes) !== sha256) throw new Error("usage_tokenizer_asset_invalid");
    const parsed = this.parse(bytes);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    return parsed;
  }

  private parse(bytes: Buffer): Record<string, unknown> {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("usage_tokenizer_asset_invalid");
    return parsed as Record<string, unknown>;
  }
}
