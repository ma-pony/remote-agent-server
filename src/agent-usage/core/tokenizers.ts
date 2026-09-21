import { createHash } from "node:crypto";
import { Tokenizer } from "@huggingface/tokenizers";
import type { TokenEstimate } from "./context-types.js";
import { MAX_TOKENIZABLE_BLOCK_BYTES } from "./context.js";

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
  for (const character of text) {
    const code = character.codePointAt(0)!;
    quarters += code > 0xffff ? 8 : code > 0x7f ? 4 : /[A-Za-z0-9\s]/.test(character) ? 1 : 2;
  }
  return Math.ceil(quarters / 4);
};

/** Offline text measurement. The explicit registry, not runtime kind, selects a vocabulary. */
export class ModelTokenizers {
  private readonly profiles = new Map<string, LoadedProfile>();
  private readonly cache = new Map<string, number>();

  constructor(profiles: ModelTokenizerProfile[] = []) {
    const ids = new Set<string>();
    const engines = new Map<string, Tokenizer>();
    for (const profile of profiles) {
      if (ids.has(profile.id)) throw new Error("usage_tokenizer_id_conflict");
      ids.add(profile.id);
      const revision = hash(JSON.stringify([profile.tokenizerJson, profile.tokenizerConfig]));
      let tokenizer = engines.get(revision);
      if (!tokenizer) {
        const json = structuredClone(profile.tokenizerJson);
        // Disabling post-processing alone does not stop added special markers being recognized in text.
        if (Array.isArray(json.added_tokens)) json.added_tokens = json.added_tokens.filter((token) => !token.special);
        tokenizer = new Tokenizer(json, structuredClone(profile.tokenizerConfig));
        clearTextCache(tokenizer);
        engines.set(revision, tokenizer);
      }
      const loaded: LoadedProfile = { tokenizer, metadata: {
        tokenizerId: profile.id, tokenizerRevision: revision, tokenizer: "@huggingface/tokenizers",
        tokenizerVersion: "0.2.0", encoding: null
      } };
      for (const model of profile.models) {
        const key = modelKey(model, profile.modelProvider ?? null);
        if (this.profiles.has(key)) throw new Error("usage_tokenizer_model_conflict");
        this.profiles.set(key, loaded);
      }
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
    if (Buffer.byteLength(text) > MAX_TOKENIZABLE_BLOCK_BYTES) return { ...metadata, tokens: null, reason: "size_limit" };
    const profile = model === null ? undefined : this.resolve(model, modelProvider);
    if (!profile) return { ...metadata, tokens: estimateUnicodeText(text) };
    const key = hash(JSON.stringify([metadata.tokenizerRevision, text]));
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

  private resolve(model: string, provider: string | null): LoadedProfile | undefined {
    return this.profiles.get(modelKey(model, provider)) ?? this.profiles.get(modelKey(model, null));
  }
}
