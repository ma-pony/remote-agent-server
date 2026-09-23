import { createHash } from "node:crypto";
import { Tokenizer } from "@huggingface/tokenizers";
import { UsageError } from "./errors.js";
import type { TokenEstimate } from "./context-types.js";
import { TokenizerWorker } from "./tokenizer-worker.js";
import { LazyTokenizerAssets } from "./tokenizer-assets.js";
import { automaticTokenizerProfile, automaticTokenizerProfiles } from "./tokenizer-catalog.js";

export type ModelTokenizerProfile = {
  id: string;
  models: string[];
  modelProvider?: string;
  tokenizerJson: Record<string, unknown>;
  tokenizerConfig: Record<string, unknown>;
};
type LoadedProfile = { tokenizer: Tokenizer; metadata: Pick<TokenEstimate,
  "tokenizerId" | "tokenizerRevision" | "tokenizer" | "tokenizerVersion" | "encoding"> };
export type TokenCount = TokenEstimate & { tokens: number | null };
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
// Upstream exposes these BPE controls, but its NodeNext re-export declarations do not resolve.
const clearTextCache = (tokenizer: Tokenizer): void => {
  const model = tokenizer.model as { max_length_to_cache?: number; clear_cache?: () => void } | null;
  if (typeof model?.max_length_to_cache === "number") model.max_length_to_cache = 0;
  model?.clear_cache?.();
};
const modelKey = (model: string, provider: string | null): string => JSON.stringify([provider, model]);
// Directional fallback, not a model vocabulary: ASCII letters/digits/space 1/4,
// ASCII punctuation 1/2, other BMP code points 1, supplementary code points 2.
// Versioned independently so future calibration cannot relabel historical counts.
const estimateUnicodeText = (text: string): number => {
  let quarters = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      quarters += 8; index++;
    } else {
      quarters += code > 0x7f ? 4 : code >= 48 && code <= 57 || code >= 65 && code <= 90
        || code >= 97 && code <= 122 || code === 32 || code >= 9 && code <= 13 ? 1 : 2;
    }
  }
  return Math.ceil(quarters / 4);
};

/** Model identity selects a vocabulary; runtime kind never substitutes for a model. */
export type ModelTokenizerOptions = { automaticCacheDirectory?: string; worker?: boolean };

export class ModelTokenizers {
  private readonly profiles = new Map<string, LoadedProfile>();
  private readonly cache = new Map<string, number>();
  private readonly worker: TokenizerWorker;
  private readonly assets?: LazyTokenizerAssets;
  private readonly ids = new Set<string>();
  private readonly engines = new Map<string, Tokenizer>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly configuredModels: string[];

  constructor(profiles: ModelTokenizerProfile[] = [], private readonly options: ModelTokenizerOptions = {}) {
    this.worker = new TokenizerWorker(profiles, import.meta.url, options.automaticCacheDirectory);
    if (options.automaticCacheDirectory) this.assets = new LazyTokenizerAssets(options.automaticCacheDirectory);
    this.configuredModels = [...new Set(profiles.flatMap(profile => profile.models))];
    this.register(profiles);
  }

  private register(profiles: ModelTokenizerProfile[]): void {
    for (const profile of profiles) {
      if (this.ids.has(profile.id)) throw new UsageError("usage_tokenizer_id_conflict");
      const keys = profile.models.map(model => modelKey(model, profile.modelProvider ?? null));
      if (new Set(keys).size !== keys.length || keys.some(key => this.profiles.has(key))) {
        throw new UsageError("usage_tokenizer_model_conflict");
      }
      const revision = hash(JSON.stringify([profile.tokenizerJson, profile.tokenizerConfig]));
      let tokenizer = this.engines.get(revision);
      if (!tokenizer) {
        const json = structuredClone(profile.tokenizerJson);
        // Disabling post-processing alone does not stop added special markers being recognized in text.
        if (Array.isArray(json.added_tokens)) json.added_tokens = json.added_tokens.filter((token) => !token.special);
        tokenizer = new Tokenizer(json, structuredClone(profile.tokenizerConfig));
        clearTextCache(tokenizer);
        this.engines.set(revision, tokenizer);
      }
      const loaded: LoadedProfile = { tokenizer, metadata: {
        tokenizerId: profile.id, tokenizerRevision: revision, tokenizer: "@huggingface/tokenizers",
        tokenizerVersion: "0.2.0", encoding: null
      } };
      this.ids.add(profile.id);
      for (const key of keys) this.profiles.set(key, loaded);
    }
  }

  describe(model: string | null, modelProvider: string | null = null): TokenEstimate {
    const profile = model === null ? undefined : this.resolve(model, modelProvider);
    return {
      measurement: "estimated", method: profile ? "model_tokenizer" : "text_heuristic", model, modelProvider,
      tokenizer: null, tokenizerVersion: null, tokenizerId: null, tokenizerRevision: null, encoding: null,
      reason: profile ? null : model ? "model_unmapped" : "model_missing",
      ...(profile ? profile.metadata : { heuristicVersion: "unicode-weighted-v1" as const })
    };
  }

  count(text: string, model: string | null, modelProvider: string | null = null): TokenCount {
    const metadata = this.describe(model, modelProvider);
    const profile = model === null ? undefined : this.resolve(model, modelProvider);
    if (!profile) return { ...metadata, tokens: estimateUnicodeText(text) };
    const key = createHash("sha256").update(metadata.tokenizerRevision!).update("\0").update(text).digest("hex");
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.cache.delete(key); this.cache.set(key, cached);
      return { ...metadata, tokens: cached };
    }
    try {
      const tokens = profile.tokenizer.tokenize(text, { add_special_tokens: false }).length;
      this.cache.set(key, tokens);
      if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
      return { ...metadata, tokens };
    } catch {
      return { ...metadata, tokens: null, reason: "tokenization_failed" };
    } finally {
      // Also clear on errors; input fragments must not outlive a measurement in upstream caches.
      clearTextCache(profile.tokenizer);
    }
  }

  /** The threshold changes scheduling only: the worker always counts the complete text. */
  async countAsync(text: string, model: string | null, modelProvider: string | null = null, signal?: AbortSignal): Promise<TokenCount> {
    signal?.throwIfAborted();
    const automatic = model !== null && !this.resolve(model, modelProvider) && this.assets
      ? automaticTokenizerProfile(model) : undefined;
    if (this.options.worker !== false && (automatic || text.length > 64 * 1024)) {
      // Check readiness without cloning a potentially large body while a download is pending.
      if (automatic) {
        const ready = await this.worker.count("", model, modelProvider, signal);
        if (ready.reason === "tokenizer_pending") return ready;
      }
      return this.worker.count(text, model, modelProvider, signal);
    }
    if (automatic) {
      if (!this.loading.has(automatic.id)) {
        const cached = await this.assets!.loadCached(automatic);
        signal?.throwIfAborted();
        if (cached) {
          // Another concurrent measurement may have registered the same profile while reading.
          if (!this.resolve(model!, modelProvider)) this.register([{ ...cached, models: cached.models.filter(name => !this.resolve(name, null)) }]);
          return this.count(text, model, modelProvider);
        }
        if (this.resolve(model!, modelProvider)) return this.count(text, model, modelProvider);
      }
      if (!this.loading.has(automatic.id)) {
        const loading = this.assets!.load(automatic).then(profile => {
          this.register([{ ...profile, models: profile.models.filter(name => !this.resolve(name, null)) }]);
        }).catch(() => { /* The asset loader enforces the retry cooldown. */ })
          .finally(() => this.loading.delete(automatic.id));
        this.loading.set(automatic.id, loading);
      }
      return { measurement: "estimated", method: "unavailable", model, modelProvider, tokens: null,
        tokenizer: null, tokenizerVersion: null, tokenizerId: automatic.id, tokenizerRevision: null,
        encoding: null, reason: "tokenizer_pending" };
    }
    return this.count(text, model, modelProvider);
  }

  async close(): Promise<void> { await this.worker.close(); }

  hasVocabulary(model: string | null, provider: string | null = null): boolean {
    return model !== null && (this.resolve(model, provider) !== undefined || this.assets !== undefined && automaticTokenizerProfile(model) !== undefined);
  }

  knownModels(): string[] {
    return [...new Set([...this.configuredModels, ...(this.assets ? automaticTokenizerProfiles.flatMap(profile => profile.models) : [])])]
      .filter(model => this.hasVocabulary(model));
  }

  private resolve(model: string, provider: string | null): LoadedProfile | undefined {
    return this.profiles.get(modelKey(model, provider)) ?? this.profiles.get(modelKey(model, null));
  }
}
