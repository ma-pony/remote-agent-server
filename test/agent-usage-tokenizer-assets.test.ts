import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyTokenizerAssets, type AutomaticTokenizerProfile } from "../src/agent-usage/core/tokenizer-assets.js";
import { ModelTokenizers } from "../src/agent-usage/core/tokenizers.js";
import { fixtureProfile } from "./fixtures/agent-usage/tokenizers/helpers.js";

const directories: string[] = [];
const engines: ModelTokenizers[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(engines.splice(0).map(engine => engine.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-tokenizer-"));
  directories.push(directory);
  const data = fixtureProfile("automatic", ["deepseek-flash"]);
  const json = JSON.stringify(data.tokenizerJson), config = JSON.stringify(data.tokenizerConfig);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const profile: AutomaticTokenizerProfile = { id: data.id, models: data.models, repository: "example/model",
    revision: "pinned-revision", tokenizerSha256: hash(json), configSha256: hash(config) };
  const request = vi.fn<typeof fetch>().mockImplementation(async input =>
    new Response(String(input).endsWith("tokenizer_config.json") ? config : json));
  return { directory, profile, data, json, config, request };
};

describe("lazy tokenizer assets", () => {
  it("fetches only on first use, shares in-flight downloads, and reuses verified disk assets offline", async () => {
    const f = await fixture();
    const assets = new LazyTokenizerAssets(f.directory, f.request);
    expect(f.request).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([assets.load(f.profile), assets.load(f.profile)]);
    expect(first).toEqual(f.data); expect(second).toEqual(first);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls.map(call => call[0])).toContain("https://huggingface.co/example/model/resolve/pinned-revision/tokenizer.json");
    expect(await readFile(join(f.directory, `${f.profile.tokenizerSha256}.json`), "utf8")).toBe(f.json);
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    expect(await new LazyTokenizerAssets(f.directory, offline).load(f.profile)).toEqual(first);
    expect(offline).not.toHaveBeenCalled();
    expect((await readdir(f.directory)).sort()).toEqual([`${f.profile.tokenizerSha256}.json`, `${f.profile.configSha256}.json`].sort());
  });

  it("replaces a corrupt cache only with pinned bytes", async () => {
    const f = await fixture();
    await writeFile(join(f.directory, `${f.profile.tokenizerSha256}.json`), "corrupt");
    await new LazyTokenizerAssets(f.directory, f.request).load(f.profile);
    expect(await readFile(join(f.directory, `${f.profile.tokenizerSha256}.json`), "utf8")).toBe(f.json);
  });

  it("rejects unexpected bytes and avoids retrying a failed download for every block", async () => {
    const f = await fixture();
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}"));
    const assets = new LazyTokenizerAssets(f.directory, request);
    await expect(assets.load(f.profile)).rejects.toThrow("usage_tokenizer_download_failed");
    await expect(assets.load(f.profile)).rejects.toThrow("usage_tokenizer_download_failed");
    expect(request).toHaveBeenCalledTimes(4);
    expect(await readdir(f.directory)).toEqual([]);
  });

  it("preserves manual overrides and does not fetch for unknown models", async () => {
    const f = await fixture();
    const load = vi.spyOn(LazyTokenizerAssets.prototype, "load").mockResolvedValue(f.data);
    const engine = new ModelTokenizers([fixtureProfile("manual", ["deepseek-flash"])], { automaticCacheDirectory: f.directory, worker: false });
    engines.push(engine);
    expect(await engine.countAsync("hello", "deepseek-flash")).toMatchObject({ tokens: 1, tokenizerId: "manual" });
    expect(await engine.countAsync("你好", "unknown-model")).toMatchObject({ tokens: 2, method: "text_heuristic" });
    expect(load).not.toHaveBeenCalled();
  });

  it("installs a vocabulary once for concurrent first measurements and retains other manual aliases", async () => {
    const f = await fixture();
    const load = vi.spyOn(LazyTokenizerAssets.prototype, "load").mockResolvedValue({ ...f.data, models: ["deepseek-flash", "manual-alias"] });
    const engine = new ModelTokenizers([fixtureProfile("manual", ["manual-alias"])], { automaticCacheDirectory: f.directory, worker: false });
    engines.push(engine);
    const counts = await Promise.all([engine.countAsync("hello", "deepseek-flash"), engine.countAsync("world", "deepseek-flash")]);
    expect(counts.every(count => count.tokens === null && count.reason === "tokenizer_pending")).toBe(true);
    await vi.waitFor(async () => expect(await engine.countAsync("hello", "deepseek-flash")).toMatchObject({ tokens: 1, method: "model_tokenizer" }));
    expect(await engine.countAsync("hello", "manual-alias")).toMatchObject({ tokenizerId: "manual" });
    load.mockClear();
    await engine.countAsync("hello world", "deepseek-flash");
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps known models pending instead of storing a fallback when vocabulary download fails", async () => {
    const f = await fixture();
    vi.spyOn(LazyTokenizerAssets.prototype, "load").mockRejectedValue(new Error("unavailable"));
    const engine = new ModelTokenizers([], { automaticCacheDirectory: f.directory, worker: false });
    engines.push(engine);
    expect(await engine.countAsync("你好🚀", "deepseek-flash")).toMatchObject({ tokens: null,
      method: "unavailable", reason: "tokenizer_pending", tokenizer: null });
  });

  it("retries a timed-out official asset through the mirror and validates the same pinned hash", async () => {
    const f = await fixture();
    const request = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      expect(init).toMatchObject({ credentials: "omit" });
      if (String(input).startsWith("https://huggingface.co/")) throw new DOMException("timeout", "TimeoutError");
      expect(String(input)).toMatch(/^https:\/\/hf-mirror\.com\/example\/model\/resolve\/pinned-revision\//);
      return new Response(String(input).endsWith("tokenizer_config.json") ? f.config : f.json);
    });
    expect(await new LazyTokenizerAssets(f.directory, request).load(f.profile)).toEqual(f.data);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("retries after the cooldown without needing a process restart", async () => {
    const f = await fixture();
    let now = 100000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const assets = new LazyTokenizerAssets(f.directory, request);
    await expect(assets.load(f.profile)).rejects.toThrow();
    await expect(assets.load(f.profile)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(4);
    now += 60001;
    request.mockImplementation(f.request);
    expect(await assets.load(f.profile)).toEqual(f.data);
    expect(request).toHaveBeenCalledTimes(6);
  });
});
