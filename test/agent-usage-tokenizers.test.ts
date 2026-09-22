import { describe, expect, it, vi } from "vitest";
import { Tokenizer } from "@huggingface/tokenizers";
import { ModelTokenizers } from "../src/agent-usage/core/tokenizers.js";
import { loadConfig } from "../src/config.js";
import { loadModelTokenizers } from "../src/agent-usage/tokenizer-config.js";
import { fixtureProfile, fixtureTokenizerConfig } from "./fixtures/agent-usage/tokenizers/helpers.js";

describe("model-specific text estimates", () => {
  it("reuses one vocabulary engine across provider profiles while retaining provenance", () => {
    const engines = new Set<Tokenizer>();
    const tokenize = Tokenizer.prototype.tokenize;
    const spy = vi.spyOn(Tokenizer.prototype, "tokenize").mockImplementation(function (this: Tokenizer, ...args) {
      engines.add(this); return tokenize.apply(this, args);
    });
    try {
      const engine = new ModelTokenizers([
        { ...fixtureProfile("a"), modelProvider: "a" }, { ...fixtureProfile("b"), modelProvider: "b" }
      ]);
      expect(engine.count("hello", "fixture-model", "a")).toMatchObject({ tokens: 1, tokenizerId: "a", modelProvider: "a" });
      expect(engine.count("world", "fixture-model", "b")).toMatchObject({ tokens: 1, tokenizerId: "b", modelProvider: "b" });
      expect(engines.size).toBe(1);
    } finally { spy.mockRestore(); }
  });
  it("selects exact model IDs and isolates different vocabularies in the cache", () => {
    const a = fixtureProfile();
    const b = fixtureProfile("split", ["split-model"]);
    delete b.tokenizerJson.model.vocab.hello;
    Object.assign(b.tokenizerJson.model.vocab, { he: 30, "##llo": 31 });
    const engine = new ModelTokenizers([a, b]);
    expect(engine.count("hello world", "fixture-model")).toMatchObject({ tokens: 2, method: "model_tokenizer", tokenizerId: "fixture" });
    expect(engine.count("hello world", "split-model")).toMatchObject({ tokens: 3, tokenizerId: "split" });
    expect(engine.count("hello world", "fixture-model").tokens).toBe(2);
    expect(engine.count("hello world", "fixture-model-new")).toMatchObject({ tokens: 3, method: "text_heuristic", reason: "model_unmapped" });
    expect(engine.count("hello world", null)).toMatchObject({ tokens: 3, method: "text_heuristic", reason: "model_missing" });
  });
  it("requires matching provider identity for provider-scoped profiles", () => {
    const profile = { ...fixtureProfile(), modelProvider: "example" };
    const engine = new ModelTokenizers([profile]);
    expect(engine.count("hello", "fixture-model", "example").tokens).toBe(1);
    expect(engine.count("hello", "fixture-model", "another")).toMatchObject({ tokens: 2, method: "text_heuristic" });
    expect(engine.count("hello", "fixture-model")).toMatchObject({ tokens: 2, method: "text_heuristic" });
  });
  it("provides an offline multilingual fallback without treating all scripts as English", () => {
    const engine = new ModelTokenizers();
    expect(engine.count("", null).tokens).toBe(0);
    expect(engine.count("你好", null)).toMatchObject({ tokens: 2, method: "text_heuristic", heuristicVersion: "unicode-weighted-v1", tokenizer: null });
    expect(engine.count("🚀", "closed-model").tokens).toBe(2);
    expect(engine.count("{}[]", "closed-model").tokens).toBe(2);
    expect(engine.count("a".repeat(100), null).tokens).toBeLessThan(engine.count("你".repeat(100), null).tokens!);
    expect(engine.count("你".repeat(100000), null)).toMatchObject({ tokens: 100000, reason: "model_missing" });
  });
  it("counts ordinary special-marker text without injecting BOS or EOS", () => {
    const engine = new ModelTokenizers([fixtureProfile()]);
    expect(engine.count("[CLS]", "fixture-model").tokens).toBe(3);
    expect(engine.count("", "fixture-model").tokens).toBe(0);
    expect(engine.count("你好", "fixture-model").tokens).toBe(2);
    expect(engine.count("你".repeat(100000), "fixture-model")).toMatchObject({ tokens: 1, reason: null });
  });
  it("fails startup on modified assets or ambiguous model mappings", () => {
    const config = fixtureTokenizerConfig();
    expect(loadModelTokenizers([config]).count("hello", "fixture-model").tokens).toBe(1);
    expect(() => loadModelTokenizers([{ ...config, tokenizerSha256: "0".repeat(64) }])).toThrow("usage_tokenizer_asset_invalid");
    expect(() => loadModelTokenizers([config, { ...config, id: "other" }])).toThrow("usage_tokenizer_model_conflict");
  });
  it("validates absolute asset paths and explicit hashes at the configuration boundary", () => {
    const profile = fixtureTokenizerConfig();
    expect(loadConfig({ API_TOKEN: "test", USAGE_TOKENIZERS: JSON.stringify([profile]) }).usageTokenizers).toEqual([profile]);
    expect(() => loadConfig({ API_TOKEN: "test", USAGE_TOKENIZERS: JSON.stringify([{ ...profile, tokenizerPath: "relative.json" }]) })).toThrow();
    expect(() => loadConfig({ API_TOKEN: "test", USAGE_TOKENIZERS: JSON.stringify([{ ...profile, tokenizerSha256: "main" }]) })).toThrow();
  });
});
