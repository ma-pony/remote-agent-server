import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trustCodexManagedRtkHook } from "../src/runtime/codex-hook-trust.js";
import { rtkManagedHooks } from "../src/runtime/rtk-projector.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fixture = async (mode = "") => {
  const root = await mkdtemp(join(tmpdir(), "codex-hook-trust-")); roots.push(root);
  const home = join(root, mode === "chunked_utf8" ? "私有目录" : "home"), cwd = join(root, "workspace"); await mkdir(home); await mkdir(cwd);
  const launcher = join(root, "codex");
  await writeFile(launcher, `#!${process.execPath}\nrequire(${JSON.stringify(join(import.meta.dirname, "fixtures/codex-hook-trust.cjs"))});\n`); await chmod(launcher, 0o700);
  const config = rtkManagedHooks("codex")[0]!.configuration as { matcher: string; hook: unknown };
  await writeFile(join(home, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [
    { matcher: "Bash", hooks: [{ type: "command", command: "unrelated-hook" }] }, { matcher: config.matcher, hooks: [config.hook] }
  ] } }));
  vi.stubEnv("CODEX_PATH", launcher); vi.stubEnv("CODEX_CONFIG", ""); vi.stubEnv("CODEX_TRUST_TEST_MODE", mode);
  vi.stubEnv("CODEX_TRUST_TEST_LOG", join(root, "requests.jsonl")); vi.stubEnv("CODEX_TRUST_TEST_PID", join(root, "pid"));
  vi.stubEnv("CODEX_TRUST_TEST_CHILD_PID", join(root, "child.pid"));
  const requests = async () => existsSync(join(root, "requests.jsonl"))
    ? (await readFile(join(root, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)) : [];
  const stopped = async () => {
    const pid = Number(await readFile(join(root, "pid"), "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 });
  };
  return { root, home, cwd, requests, stopped, run: (signal = new AbortController().signal) => trustCodexManagedRtkHook({ home, cwd, signal }) };
};

describe("Codex managed hook trust", () => {
  it("handles native UTF-8 paths split across protocol chunks", async () => {
    const f = await fixture("chunked_utf8"); await f.run(); await f.stopped();
  });
  it("reuses native trust and refreshes a changed hash without trusting unrelated hooks", async () => {
    const f = await fixture();
    await f.run(); await f.run();
    expect((await f.requests()).filter(r => r.method === "config/batchWrite")).toHaveLength(1);
    vi.stubEnv("CODEX_TRUST_TEST_HASH", "b".repeat(64));
    await f.run();
    const edits = (await f.requests()).filter(r => r.method === "config/batchWrite").flatMap(r => r.params.edits);
    expect(edits).toHaveLength(2);
    expect(edits.every(edit => edit.keyPath.endsWith('pre_tool_use:1:0".trusted_hash'))).toBe(true);
    expect(edits[1].value).toBe("b".repeat(64));
    await f.stopped();
  });

  it("enables an inherited disabled native hook feature only in the managed Home", async () => {
    const f = await fixture("disabled_feature"); await f.run();
    const writes = (await f.requests()).filter(r => r.method === "config/batchWrite");
    expect(writes[0].params.edits).toEqual([{ keyPath: "features.hooks", value: true, mergeStrategy: "replace" }]);
    expect(writes[1].params.edits).toHaveLength(1);
    await f.stopped();
  });

  it.each(["wrong_command", "wrong_path", "wrong_key", "error", "ignore_write", "changed_during_write", "oversized"])("fails safely on %s without leaking native diagnostics", async mode => {
    const f = await fixture(mode);
    await expect(f.run()).rejects.toThrow(/^codex_managed_hook_trust_failed$/);
    if (!["ignore_write", "changed_during_write"].includes(mode)) expect((await f.requests()).some(r => r.method === "config/batchWrite")).toBe(false);
    await f.stopped();
  });

  it("cancels a stalled native probe and reaps its entire process group before rejecting", async () => {
    const f = await fixture("hang_tree"), controller = new AbortController();
    const pending = f.run(controller.signal); const rejected = expect(pending).rejects.toMatchObject({ aborted: true });
    await vi.waitFor(() => expect(existsSync(join(f.root, "child.pid"))).toBe(true));
    controller.abort(); await rejected; await f.stopped();
    const child = Number(await readFile(join(f.root, "child.pid"), "utf8"));
    await vi.waitFor(() => expect(() => process.kill(child, 0)).toThrow(), { timeout: 3000 });
  });

  it("bounds a hung native API without an external cancellation signal", async () => {
    const f = await fixture("hang");
    await expect(f.run()).rejects.toMatchObject({ message: "codex_managed_hook_trust_failed", aborted: false });
    await f.stopped();
  }, 15_000);

  it("rejects adapter hook overrides before starting a conflicting native process", async () => {
    const f = await fixture(); vi.stubEnv("CODEX_CONFIG", JSON.stringify({ hooks: {} }));
    await expect(f.run()).rejects.toThrow("codex_managed_hook_trust_failed");
    expect(await f.requests()).toEqual([]);
    vi.stubEnv("CODEX_CONFIG", "null");
    await expect(f.run()).resolves.toBeUndefined();
    await f.stopped();
  });

  it("does not enable native hooks when the managed hook is absent", async () => {
    const f = await fixture("disabled_feature");
    await writeFile(join(f.home, "hooks.json"), JSON.stringify({ hooks: {} }));
    await expect(f.run()).rejects.toThrow("codex_managed_hook_trust_failed");
    expect((await f.requests()).some(r => r.method === "config/batchWrite")).toBe(false);
    expect(existsSync(join(f.root, "pid"))).toBe(false);
  });
});
