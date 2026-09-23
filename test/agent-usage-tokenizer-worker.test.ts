import { afterEach, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelTokenizers } from "../src/agent-usage/core/tokenizers.js";
import { TokenizerWorker } from "../src/agent-usage/core/tokenizer-worker.js";
import { fixtureProfile, fixtureTokenizerConfig } from "./fixtures/agent-usage/tokenizers/helpers.js";

const engines: ModelTokenizers[] = [];
afterEach(async () => { await Promise.all(engines.splice(0).map(engine => engine.close())); });

describe("complete text measurement in a worker", () => {
  it("uses verified automatic assets on the first measurement after each worker restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "usage-worker-cache-")), config = fixtureTokenizerConfig();
    try {
      await copyFile(config.tokenizerPath, join(directory, `${config.tokenizerSha256}.json`));
      await copyFile(config.configPath, join(directory, `${config.configSha256}.json`));
      for (let restart = 0; restart < 2; restart++) {
        const worker = new TokenizerWorker([], new URL("./fixtures/agent-usage/tokenizers/automatic-worker.ts", import.meta.url).href, directory);
        try {
          expect(await worker.count("hello world", "deepseek-flash", null))
            .toMatchObject({ tokens: 2, method: "model_tokenizer", reason: null });
        } finally { await worker.close(); }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("uses the model vocabulary beyond both former size limits and allows main-thread timers to run", async () => {
    const engine = new ModelTokenizers([fixtureProfile()]); engines.push(engine);
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 0);
    try {
      const count = await engine.countAsync("hello world ".repeat(100000), "fixture-model");
      expect(timerRan).toBe(true);
      expect(count).toMatchObject({ tokens: 200000, method: "model_tokenizer", reason: null, tokenizerId: "fixture" });
    } finally { clearTimeout(timer); }
  });

  it("counts heterogeneous full text without sampling and keeps queued results separate", async () => {
    const engine = new ModelTokenizers(); engines.push(engine);
    const counts = await Promise.all([
      engine.countAsync("a".repeat(500000) + "你".repeat(12345) + "b".repeat(500000), "unknown"),
      engine.countAsync("🚀".repeat(50000), null)
    ]);
    expect(counts.map(count => count.tokens)).toEqual([262345, 100000]);
    expect(counts.map(count => count.reason)).toEqual(["model_unmapped", "model_missing"]);
  });

  it("rejects active and queued work when closed without leaving a worker running", async () => {
    const engine = new ModelTokenizers(); engines.push(engine);
    const results = Promise.allSettled([engine.countAsync("a".repeat(100000), null), engine.countAsync("b".repeat(100000), null)]);
    await engine.close();
    expect((await results).map(result => result.status)).toEqual(["rejected", "rejected"]);
    await expect(engine.countAsync("c".repeat(100000), null)).rejects.toThrow("usage_tokenizer_closed");
  });

  it("cancels a large measurement and continues unrelated queued work", async () => {
    const engine = new ModelTokenizers(); engines.push(engine);
    const controller = new AbortController();
    const cancelled = engine.countAsync("a".repeat(100000), null, null, controller.signal);
    const assertion = expect(cancelled).rejects.toThrow("usage_tokenizer_cancelled");
    const next = engine.countAsync("你".repeat(100000), null);
    controller.abort();
    await assertion;
    expect(await next).toMatchObject({ tokens: 100000 });
  });
});
