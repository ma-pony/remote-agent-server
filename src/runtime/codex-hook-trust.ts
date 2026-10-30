import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { z } from "zod";
import { terminateProcessTree } from "../project-environments/project-environment-commands.js";
import { removeServiceSecretsFromEnvironment } from "./service-path.js";
import { rtkManagedHooks } from "./rtk-projector.js";

const require = createRequire(import.meta.url);
const codex = createRequire(require.resolve("@agentclientprotocol/codex-acp")).resolve("@openai/codex/bin/codex.js");
const responseSchema = z.object({ data: z.array(z.object({ hooks: z.array(z.unknown()) })).length(1) });
const hookSchema = z.object({
  key: z.string(), sourcePath: z.string(), source: z.literal("user"), eventName: z.literal("preToolUse"),
  handlerType: z.literal("command"), command: z.string(), matcher: z.literal("Bash"), enabled: z.literal(true),
  async: z.literal(false), currentHash: z.string().min(1).max(256), trustStatus: z.string()
});
type Hook = z.infer<typeof hookSchema>;

export class CodexHookTrustError extends Error {
  constructor(readonly aborted = false) { super("codex_managed_hook_trust_failed"); }
}

/** Prepare only the service-owned RTK hook through the installed Core's hash/trust API. */
export const trustCodexManagedRtkHook = async ({ home, cwd, signal }: {
  home: string; cwd: string; signal: AbortSignal;
}): Promise<void> => {
  signal.throwIfAborted();
  // This adapter override replaces hooks at app-server startup, hiding hooks.json.
  if (process.env.CODEX_CONFIG) {
    try { if (JSON.parse(process.env.CODEX_CONFIG)?.hooks !== undefined) throw new CodexHookTrustError(); }
    catch { throw new CodexHookTrustError(); }
  }
  const config = rtkManagedHooks("codex")[0]!.configuration as { hook: { command: string } };
  const expectedPath = join(await realpath(home), "hooks.json");
  // Disabled Cores hide all hook metadata. Verify the owned projection before enabling that feature.
  try {
    const metadata = await lstat(expectedPath);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new CodexHookTrustError();
    const projected = z.object({ hooks: z.object({ PreToolUse: z.array(z.object({
      matcher: z.string().optional(), hooks: z.array(z.unknown())
    })).default([]) }) }).parse(JSON.parse(await readFile(expectedPath, "utf8")));
    const owned = z.object({ type: z.literal("command"), command: z.literal(config.hook.command), async: z.literal(false).optional() });
    const matches = projected.hooks.PreToolUse.filter(group => group.matcher === "Bash")
      .flatMap(group => group.hooks).filter(hook => owned.safeParse(hook).success);
    if (matches.length !== 1) throw new CodexHookTrustError();
  } catch { throw new CodexHookTrustError(signal.aborted); }
  const environment = { ...process.env, CODEX_HOME: home };
  removeServiceSecretsFromEnvironment(environment);
  const child = process.env.CODEX_PATH
    ? spawn(process.env.CODEX_PATH, ["app-server"], { cwd: home, env: environment, detached: true, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(process.execPath, [codex, "app-server"], { cwd: home, env: environment, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const stopped = new Promise<void>(resolve => child.once("close", () => resolve()));
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  let pending: { id: number; resolve(value: unknown): void; reject(error: Error): void } | undefined;
  let nextId = 0, bytes = 0, buffer = "", failed = false;
  const fail = () => { failed = true; pending?.reject(new CodexHookTrustError(signal.aborted)); pending = undefined; };
  child.on("error", fail); child.on("close", fail); child.stdin.on("error", fail);
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 1024 * 1024) { fail(); return; }
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (!pending || message.id !== pending.id) continue;
        const current = pending; pending = undefined;
        if (message.error) current.reject(new CodexHookTrustError()); else current.resolve(message.result);
      } catch { fail(); }
    }
  });
  deadline.addEventListener("abort", fail, { once: true });
  const request = (method: string, params: unknown): Promise<unknown> => {
    if (failed || deadline.aborted) return Promise.reject(new CodexHookTrustError(signal.aborted));
    return new Promise((resolve, reject) => {
      const id = ++nextId; pending = { id, resolve, reject };
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };
  const list = async (): Promise<Hook> => {
    const response = responseSchema.parse(await request("hooks/list", { cwds: [cwd] }));
    const matches: Hook[] = [];
    for (const value of response.data[0]!.hooks) {
      const parsed = hookSchema.safeParse(value);
      if (!parsed.success || parsed.data.command !== config.hook.command) continue;
      const hook = parsed.data;
      if (await realpath(hook.sourcePath).catch(() => "") !== expectedPath) continue;
      if (!hook.key.startsWith(`${hook.sourcePath}:pre_tool_use:`) || !/^\d+:\d+$/.test(hook.key.slice(`${hook.sourcePath}:pre_tool_use:`.length))) continue;
      matches.push(hook);
    }
    if (matches.length !== 1) throw new CodexHookTrustError();
    return matches[0]!;
  };
  let failure: CodexHookTrustError | undefined;
  try {
    await request("initialize", { clientInfo: { name: "remote-agent-hook-trust", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const loaded = z.object({ config: z.object({ features: z.record(z.string(), z.unknown()).optional() }) }).parse(
      await request("config/read", { cwd, includeLayers: false })
    );
    if (loaded.config.features?.hooks === false) {
      await request("config/batchWrite", {
        edits: [{ keyPath: "features.hooks", value: true, mergeStrategy: "replace" }], reloadUserConfig: true
      });
    }
    const hook = await list();
    if (hook.trustStatus !== "trusted") {
      await request("config/batchWrite", { edits: [{
        keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: "replace"
      }], reloadUserConfig: true });
      const verified = await list();
      if (verified.key !== hook.key || verified.currentHash !== hook.currentHash || verified.trustStatus !== "trusted") throw new CodexHookTrustError();
    }
    deadline.throwIfAborted();
  } catch { failure = new CodexHookTrustError(signal.aborted); }
  finally {
    deadline.removeEventListener("abort", fail);
    child.stdin.end();
    try { await terminateProcessTree(child, true); await stopped; }
    catch { failure = new CodexHookTrustError(); }
  }
  if (failure) throw failure;
};
