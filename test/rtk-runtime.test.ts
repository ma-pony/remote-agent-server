import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rtkEnvironment, rtkHookLauncher, rtkManagedHooks, projectHermesRtk } from "../src/runtime/rtk-projector.js";
import type { RtkRunPlan } from "../src/rtk/rtk-types.js";
import { ProviderExtensionManager } from "../src/provider-extensions/provider-extension-manager.js";
import { ProviderExtensionProjector } from "../src/runtime/provider-extension-projector.js";
import { createTestDatabase } from "./helpers.js";
import { pinRtkCommand } from "../src/runtime/rtk-hook-process.js";

const directories: string[] = [];
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }); });
const rootDirectory = async () => { const root = await mkdtemp(join(tmpdir(), "rtk quoted ' runtime-")); directories.push(root); return root; };
const plan = (binaryPath: string): RtkRunPlan => ({ requested: true, enabled: true, version: "1.1.0", mode: "hook", reason: null, binaryPath });
const hook = async (root: string, input: unknown, options: { enabled?: boolean; mode?: string; provider?: "codex" | "hermes"; rewrite?: string } = {}) => {
  const binary = join(root, "rtk");
  await writeFile(binary, `#!${process.execPath}\nlet input=''; process.stdin.on('data', chunk=>input+=chunk); process.stdin.on('end',()=>{const command=process.env.FIXTURE_REWRITE||'rtk git status';if(process.env.FIXTURE_MODE==='fail'){process.exit(1);} else if(process.env.FIXTURE_MODE==='deny'){console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny'}}));}else if(process.env.FIXTURE_MODE==='ask-only'){console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'ask',permissionDecisionReason:'confirmation required'}}));}else if(process.argv[2]==='rewrite'){process.stdout.write(command);}else {console.log(JSON.stringify({hookSpecificOutput:{updatedInput:{command,description:'preserved'},permissionDecision:process.env.FIXTURE_MODE==='ask'?'ask':'allow'}}));}});\n`, { mode: 0o700 });
  const launch = rtkHookLauncher(options.provider ?? "codex");
  const child = spawn(launch[0]!, launch.slice(1), { env: { ...process.env,
    ...await rtkEnvironment({ ...plan(binary), enabled: options.enabled ?? true }, join(root, "workspace")), FIXTURE_MODE: options.mode ?? "", FIXTURE_REWRITE: options.rewrite ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr))); });
  return { stdout, binary };
};

describe("RTK runtime seam", () => {
  it("pins command words after assignments and cd without changing arguments, comments, or quoted text", () => {
    const binary = "/managed/1.1.0/rtk";
    expect(pinRtkCommand("FOO='rtk' rtk git status", binary)).toBe("FOO='rtk' '/managed/1.1.0/rtk' git status");
    expect(pinRtkCommand("cd 'rtk' && rtk git status", binary)).toBe("cd 'rtk' && '/managed/1.1.0/rtk' git status");
    expect(pinRtkCommand("env FOO=bar rtk git status", binary)).toBe("env FOO=bar '/managed/1.1.0/rtk' git status");
    expect(pinRtkCommand("printf '%s' rtk; rtk git status && rtk git diff # rtk git log", binary))
      .toBe("printf '%s' rtk; '/managed/1.1.0/rtk' git status && '/managed/1.1.0/rtk' git diff # rtk git log");
    expect(pinRtkCommand("printf 'rtk git status'", binary)).toBeNull();
    expect(pinRtkCommand("echo rtk", binary)).toBeNull();
    expect(pinRtkCommand("rtk git status 2>&1 | rtk grep foo", binary)).toBe("'/managed/1.1.0/rtk' git status 2>&1 | '/managed/1.1.0/rtk' grep foo");
    expect(pinRtkCommand("rtk git diff \"${BASE}..HEAD\"", binary)).toBe("'/managed/1.1.0/rtk' git diff \"${BASE}..HEAD\"");
    expect(pinRtkCommand('rtk read "${VALUE:-"echo rtk && rtk git"}"', binary)).toBe('\'/managed/1.1.0/rtk\' read "${VALUE:-"echo rtk && rtk git"}"');
    expect(pinRtkCommand("rtk git status && echo \"$(printf rtk)\"", binary)).toBeNull();
    expect(pinRtkCommand("rtk git status <<EOF\nrtk\nEOF", binary)).toBeNull();
    expect(pinRtkCommand("rtk() { echo literal; }", binary)).toBeNull();
  });

  it("pins executable positions through supported process wrappers and defers shell grammar it cannot preserve", () => {
    const binary = "/managed/rtk";
    for (const prefix of ["command -p", "exec -a name", "env -u FOO -C src", "timeout -s TERM 10", "time -o out", "nice -n 5", "nohup"]) {
      expect(pinRtkCommand(`${prefix} rtk git status`, binary)).toBe(`${prefix} '/managed/rtk' git status`);
    }
    expect(pinRtkCommand("command -v rtk", binary)).toBeNull();
    for (const input of ["[[ true && rtk ]]", "(( rtk ))", "VALUES=(rtk) rtk git status", "rtk ( ) { echo literal; }", "rtk ls @(rtk|src)"]) {
      expect(pinRtkCommand(input, binary)).toBeNull();
    }
  });

  it("preserves environment, working directory and literal arguments when executed by a shell", async () => {
    const root = await rootDirectory();
    await mkdir(join(root, "child"));
    const binary = join(root, "rtk");
    await writeFile(binary, `#!${process.execPath}\nconsole.log(JSON.stringify({cwd:process.cwd(),foo:process.env.FOO,args:process.argv.slice(2)}));\n`, { mode: 0o700 });
    const command = pinRtkCommand("FOO=bar rtk 'literal rtk' && cd child && /usr/bin/env FOO=baz rtk second", binary)!;
    const child = spawn("/bin/sh", ["-c", command], { cwd: root, env: { ...process.env, PATH: "/missing-rtk" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(error))); });
    const actualRoot = await realpath(root);
    expect(output.trim().split("\n").map(line => JSON.parse(line))).toEqual([
      { cwd: actualRoot, foo: "bar", args: ["literal rtk"] }, { cwd: join(actualRoot, "child"), foo: "baz", args: ["second"] }
    ]);
  });

  it.each(["codex", "hermes"] as const)("passes prefixed RTK rewrites through the actual %s gate", async (provider) => {
    const root = await rootDirectory();
    const result = await hook(root, "FOO=bar git status", { provider, rewrite: "FOO=bar rtk git status && cd src && rtk git diff" });
    const expected = pinRtkCommand("FOO=bar rtk git status && cd src && rtk git diff", result.binary);
    expect(expected).not.toBeNull();
    expect(provider === "hermes" ? result.stdout : JSON.parse(result.stdout).hookSpecificOutput.updatedInput.command).toBe(expected);
    if (provider === "codex") {
      const ask = await hook(root, {}, { provider, mode: "ask", rewrite: "FOO=bar rtk git status" });
      expect(JSON.parse(ask.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask", updatedInput: { command: pinRtkCommand("FOO=bar rtk git status", ask.binary) } } });
    }
  });

  it("preserves permission requests even when there is no safely bindable rewrite", async () => {
    const root = await rootDirectory();
    const ask = await hook(root, {}, { mode: "ask-only" });
    expect(JSON.parse(ask.stdout)).toEqual({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "confirmation required" } });
    const unsupported = await hook(root, {}, { mode: "ask", rewrite: "rtk git status && echo $(pwd)" });
    expect(JSON.parse(unsupported.stdout)).toEqual({ hookSpecificOutput: { permissionDecision: "ask" } });
  });

  it.each(["claude_code", "codex"] as const)("takes over selected native %s RTK hooks without changing their saved selections", async (provider) => {
    const root = await rootDirectory();
    const { db, seed } = createTestDatabase();
    db.prepare("UPDATE agents SET provider=? WHERE id=?").run(provider, seed.agent.id);
    const host = join(root, "host"); await mkdir(host);
    const agent = provider === "claude_code" ? "claude" : "codex";
    const native = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [
      { type: "command", command: "existing-check" }, { type: "command", command: `rtk hook ${agent}` },
      { type: "command", command: `'/tools with spaces/rtk' hook ${agent}` },
      { type: "command", command: `env RTK_DB_PATH=tracking.db rtk hook ${agent}` },
      { type: "command", command: `command rtk hook ${agent}` },
      { type: "command", command: `rtk hook ${agent}; existing-check` }
    ] }] } };
    const filename = provider === "codex" ? "hooks.json" : "settings.json";
    await writeFile(join(host, filename), JSON.stringify(native));
    const manager = new ProviderExtensionManager({ db, codexHome: host, claudeHome: host });
    for (const item of manager.list(seed.agent.id)) manager.setEnabled(seed.agent.id, item.id, true);
    const home = join(root, "managed");
    const projector = new ProviderExtensionProjector(manager, root);
    try {
      await projector.prepare({ agentId: seed.agent.id, provider, home, managedHooks: rtkManagedHooks(provider) });
      const entries = JSON.parse(await readFile(join(home, filename), "utf8")).hooks.PreToolUse.flatMap((group: { hooks: unknown[] }) => group.hooks);
      expect(entries).toHaveLength(3);
      expect(entries).toContainEqual({ type: "command", command: "existing-check" });
      expect(entries).toContainEqual({ type: "command", command: `rtk hook ${agent}; existing-check` });
      expect(JSON.stringify(entries)).toContain("rtk-hook-process.ts");
      expect(manager.list(seed.agent.id).filter(item => item.enabled)).toHaveLength(6);
      expect(JSON.parse(await readFile(join(host, filename), "utf8"))).toEqual(native);
      await projector.prepare({ agentId: seed.agent.id, provider, home });
      expect(JSON.parse(await readFile(join(home, filename), "utf8")).hooks.PreToolUse).toHaveLength(6);
    } finally { db.close(); }
  });

  it("rewrites to the pinned absolute binary, preserves hook input fields, and passes through when disabled or failing", async () => {
    const root = await rootDirectory();
    const { stdout, binary } = await hook(root, { tool_name: "Bash", tool_input: { command: "git status" } });
    const response = JSON.parse(stdout);
    expect(response.hookSpecificOutput.updatedInput.command).toContain(binary.replaceAll("'", "'\\''"));
    expect(response.hookSpecificOutput.updatedInput.description).toBe("preserved");
    expect((await hook(root, {}, { enabled: false })).stdout).toBe("");
    expect((await hook(root, {}, { mode: "fail" })).stdout).toBe("");
    expect(JSON.parse((await hook(root, {}, { mode: "deny" })).stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    const hermes = await hook(root, "git status", { provider: "hermes" });
    expect(hermes.stdout).toContain("git status"); expect(hermes.stdout).not.toMatch(/^rtk /);
  });

  it("isolates raw output and accounting per Session without changing HOME", async () => {
    const root = await rootDirectory();
    const first = await rtkEnvironment(plan("/version-one/rtk"), join(root, "one/workspace"));
    const second = await rtkEnvironment(plan("/version-two/rtk"), join(root, "two/workspace"));
    expect(first.HOME).toBeUndefined(); expect(first.RTK_DB_PATH).not.toBe(second.RTK_DB_PATH);
    expect(first.RTK_RECALL_DB).not.toBe(second.RTK_RECALL_DB); expect(first.RTK_TELEMETRY_DISABLED).toBe("1");
    expect(first.REMOTE_AGENT_RTK_BINARY).toBe("/version-one/rtk");
  });

  it.each(["claude_code", "codex"] as const)("composes the stable RTK gate with selected %s hooks", async (provider) => {
    const root = await rootDirectory();
    const { db, seed } = createTestDatabase();
    db.prepare("UPDATE agents SET provider=? WHERE id=?").run(provider, seed.agent.id);
    const host = join(root, "host"); await mkdir(host);
    const configuration = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "existing-check" }] }] } };
    await writeFile(join(host, provider === "codex" ? "hooks.json" : "settings.json"), JSON.stringify(configuration));
    const manager = new ProviderExtensionManager({ db, codexHome: host, claudeHome: host });
    for (const item of manager.list(seed.agent.id)) manager.setEnabled(seed.agent.id, item.id, true);
    const home = join(root, "managed");
    try {
      await new ProviderExtensionProjector(manager, root).prepare({ agentId: seed.agent.id, provider, home, managedHooks: rtkManagedHooks(provider) });
      const projected = JSON.parse(await readFile(join(home, provider === "codex" ? "hooks.json" : "settings.json"), "utf8"));
      const entries = projected.hooks.PreToolUse.flatMap((group: { hooks: unknown[] }) => group.hooks);
      expect(entries).toHaveLength(2); expect(entries).toContainEqual({ type: "command", command: "existing-check" });
      expect(JSON.stringify(entries)).toContain("rtk-hook-process.ts");
      expect(JSON.parse(await readFile(join(host, provider === "codex" ? "hooks.json" : "settings.json"), "utf8"))).toEqual(configuration);
    } finally { db.close(); }
  });

  it("projects Hermes plugin registration while preserving existing settings", async () => {
    const root = await rootDirectory();
    await writeFile(join(root, "config.yaml"), "model: existing\nplugins:\n  enabled: [other, rtk-rewrite]\n");
    await projectHermesRtk(root); await projectHermesRtk(root);
    const contents = await readFile(join(root, "config.yaml"), "utf8");
    expect(contents).toContain("model: existing"); expect(contents).toContain("other");
    expect(contents.match(/remote-agent-rtk/g)).toHaveLength(1);
    expect(contents).not.toContain("rtk-rewrite");
    expect(await readFile(join(root, "plugins/remote-agent-rtk/__init__.py"), "utf8")).toContain("pre_tool_call");
  });

  it("never exposes malformed Hermes configuration content in projection errors", async () => {
    const root = await rootDirectory();
    const original = "private_key: [private-value\n";
    await writeFile(join(root, "config.yaml"), original);
    await expect(projectHermesRtk(root)).rejects.toThrow("rtk_hermes_config_invalid");
    expect(await readFile(join(root, "config.yaml"), "utf8")).toBe(original);
  });
});
