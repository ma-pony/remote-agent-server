import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileUsageSource } from "../src/agent-usage/adapters/file-source.js";
import { accountingRequests } from "./fixtures/agent-usage/accounting.js";
import { createProviderLogParser, parseProviderLog } from "../src/agent-usage/adapters/provider-logs.js";
import { readFile } from "node:fs/promises";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-file-")); directories.push(root);
  const path = join(root, "source.jsonl"); await writeFile(path, "one\n");
  const adapter = new FileUsageSource({
    resolve: async () => path,
    capabilities: { usage: "model_request", context: "none", identity: "explicit", version: "test" },
    parse: (text) => text.trim().split("\n").map((_line, index) => ({ sourceSessionKey: "session", observation: accountingRequests()[index]! }))
  });
  return { adapter, path };
};
const entries = async (adapter: FileUsageSource, boundary: string, checkpoint: string | null = null) => {
  const result = [];
  for await (const entry of adapter.collect({}, checkpoint, boundary, new AbortController().signal)) if (entry.observation) result.push(entry);
  return result;
};

describe("bounded file usage source", () => {
  it("resumes Codex cumulative state even when interrupted between the two observations of one line", async () => {
    const { path } = await setup();
    const text = await readFile(new URL("./fixtures/agent-usage/provider-logs/codex-token-count.jsonl", import.meta.url), "utf8");
    await writeFile(path, text);
    const make = () => new FileUsageSource({ resolve: async () => path,
      capabilities: { usage: "provider_session", context: "none", identity: "explicit", version: "test" },
      parse: (value) => parseProviderLog("codex_log", value.split("\n")), incremental: (state) => createProviderLogParser("codex_log", state) });
    const adapter = make(), boundary = await adapter.freeze({});
    const first = [];
    for await (const entry of adapter.collect({}, null, boundary, new AbortController().signal)) {
      if (entry.observation) first.push(entry);
      if (first.length === 3) break;
    }
    const rest = await entries(make(), boundary, first.at(-1)!.checkpoint);
    expect(rest).toHaveLength(1);
    expect(rest[0]!.observation).toMatchObject({ scope: "interval", metrics: { totalTokens: 70 }, revision: 7 });
    expect([...first, ...rest].map(({ observation }) => observation)).toEqual(parseProviderLog("codex_log", text.split("\n")).map((row) => row.observation));
  });
  it("leaves partial UTF-8/JSON unread and accepts a complete final record without LF", async () => {
    const { path } = await setup();
    const record = (id: string) => JSON.stringify({ type: "assistant", sessionId: "native", uuid: id,
      message: { role: "assistant", id, content: "秘密", usage: { input_tokens: 2, output_tokens: 1 }, stop_reason: "end_turn" } });
    const full = Buffer.from(record("one")), cut = full.indexOf(Buffer.from("秘密")) + 1;
    await writeFile(path, full.subarray(0, cut));
    const adapter = new FileUsageSource({ resolve: async () => path,
      capabilities: { usage: "model_request", context: "none", identity: "explicit", version: "test" },
      parse: (text) => parseProviderLog("claude_log", text.split("\n")), incremental: (state) => createProviderLogParser("claude_log", state) });
    let checkpoint: string | null = null;
    await expect(async () => {
      for await (const entry of adapter.collect({}, null, await adapter.freeze({}), new AbortController().signal)) {
        expect(entry.observation).toBeUndefined(); checkpoint = entry.checkpoint;
      }
    }).rejects.toThrow("usage_source_incomplete");
    await appendFile(path, full.subarray(cut));
    const complete = await entries(adapter, await adapter.freeze({}), checkpoint);
    expect(complete).toHaveLength(1); expect(complete[0]!.observation.revision).toBe(1);
    expect(complete[0]!.checkpoint).not.toContain("秘密");
    await appendFile(path, "\n" + record("two") + "\n");
    const next = await entries(adapter, await adapter.freeze({}), complete[0]!.checkpoint);
    expect(next).toHaveLength(1); expect(next[0]!.observation).toMatchObject({ invocationId: "claude-message:two", revision: 2 });
  });
  it("parses only appended complete lines and skips unchanged files", async () => {
    const { path } = await setup(); let parsed = 0;
    const adapter = new FileUsageSource({ resolve: async () => path,
      capabilities: { usage: "model_request", context: "none", identity: "explicit", version: "test" },
      parse: (text) => text.trim().split("\n").map((_line, index) => { parsed++; return { sourceSessionKey: "session", observation: accountingRequests()[index]! }; }),
      incremental: () => ({ snapshot: () => null, validate: () => undefined,
        parseLine: (_line: string, line: number) => { parsed++; return [{ sourceSessionKey: "session", observation: accountingRequests()[line - 1]! }]; } })
    });
    const first = await entries(adapter, await adapter.freeze({}));
    expect(first).toHaveLength(1); expect(parsed).toBe(1);
    expect(await entries(adapter, await adapter.freeze({}), first[0]!.checkpoint)).toHaveLength(0);
    expect(parsed).toBe(1);
    await appendFile(path, "two\n");
    const appended = await entries(adapter, await adapter.freeze({}), first[0]!.checkpoint);
    expect(appended).toHaveLength(1); expect(parsed).toBe(2);
    expect(appended[0]!.observation.metrics.inputTotalTokens).toBe(1400);
  });
  it("reads only the frozen tail and resumes an appended log", async () => {
    const { adapter, path } = await setup();
    const boundary = await adapter.freeze({});
    await appendFile(path, "two\n");
    const first = await entries(adapter, boundary);
    expect(first).toHaveLength(1);
    const second = await entries(adapter, await adapter.freeze({}), first[0]!.checkpoint);
    expect(second).toHaveLength(2);
    expect(second[1]!.observation.metrics.inputTotalTokens).toBe(1400);
  });
  it("rejects replaced or rewritten logs instead of reusing old event identities", async () => {
    const { adapter, path } = await setup();
    const first = await entries(adapter, await adapter.freeze({}));
    await writeFile(path, "new\n");
    await expect(entries(adapter, await adapter.freeze({}), first[0]!.checkpoint)).rejects.toThrow("usage_source_changed");
  });
  it("rejects files beyond the configured limit and checks cancellation", async () => {
    const { adapter } = await setup();
    const boundary = JSON.parse(await adapter.freeze({})) as Record<string, unknown>;
    await expect(entries(adapter, JSON.stringify({ ...boundary, size: 20 * 1024 * 1024 }))).rejects.toThrow("usage_source_too_large");
    const controller = new AbortController(); controller.abort();
    await expect(adapter.collect({}, null, JSON.stringify(boundary), controller.signal).next()).rejects.toThrow();
  });
});
