import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import type { DiscoveredProviderExtension } from "../provider-extensions/provider-extension-manager.js";
import type { Provider } from "../domain.js";
import type { RtkRunPlan } from "../rtk/rtk-types.js";
import { writeProviderHomeFile } from "./provider-home-files.js";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export const rtkHookLauncher = (provider: Provider): string[] => {
  const source = import.meta.url.endsWith(".ts");
  const path = fileURLToPath(new URL(`./rtk-hook-process.${source ? "ts" : "js"}`, import.meta.url));
  return [process.execPath, ...(source ? ["--import", createRequire(import.meta.url).resolve("tsx")] : []), path,
    provider === "claude_code" ? "claude" : provider === "codex" ? "codex" : "hermes"];
};

export const rtkManagedHooks = (provider: Provider): DiscoveredProviderExtension[] => {
  if (provider !== "claude_code" && provider !== "codex") return [];
  return [{ id: "remote-agent:rtk", provider, kind: "hook", name: "RTK", description: "Managed command output compression", version: "1",
    available: true, sourceFingerprint: "remote-agent-rtk-v1", sourcePath: null,
    configuration: { event: "PreToolUse", matcher: "Bash", hook: { type: "command", command: rtkHookLauncher(provider).map(quote).join(" ") } } }];
};

export const rtkEnvironment = async (plan: RtkRunPlan, workspacePath: string): Promise<Record<string, string>> => {
  const root = join(dirname(workspacePath), "runtime", "rtk");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return {
    REMOTE_AGENT_RTK_ENABLED: plan.enabled ? "1" : "0", REMOTE_AGENT_RTK_BINARY: plan.binaryPath ?? "",
    ...(plan.binaryPath ? { PATH: `${dirname(plan.binaryPath)}:${process.env.PATH ?? ""}` } : {}),
    RTK_DB_PATH: join(root, "tracking.db"), RTK_RECALL_DB: join(root, "recall.db"), RTK_TEE_DIR: join(root, "tee"),
    RTK_TELEMETRY_DISABLED: "1", RTK_SUPPRESS_HOOK_WARNING: "1"
  };
};

/** Adapt upstream's pre_tool_call contract without mutating the service user's Hermes home. */
export const projectHermesRtk = async (home: string): Promise<void> => {
  const root = join(home, "plugins", "remote-agent-rtk");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "plugin.yaml"), "name: remote-agent-rtk\nversion: '1.0.0'\ndescription: Managed RTK command output compression\nhooks: [pre_tool_call]\nprovides_hooks: [pre_tool_call]\n", { mode: 0o600 });
  const launcher = JSON.stringify(rtkHookLauncher("hermes"));
  await writeFile(join(root, "__init__.py"), `import os\nimport subprocess\n\ndef register(ctx):\n    ctx.register_hook("pre_tool_call", _rewrite)\n\ndef _rewrite(tool_name=None, args=None, **kwargs):\n    if os.environ.get("REMOTE_AGENT_RTK_ENABLED") != "1" or tool_name != "terminal" or not isinstance(args, dict):\n        return\n    command = args.get("command")\n    if not isinstance(command, str) or not command.strip():\n        return\n    try:\n        result = subprocess.run(${launcher}, input=command, text=True, capture_output=True, timeout=3)\n        if result.returncode == 0 and result.stdout.strip():\n            args["command"] = result.stdout.strip()\n    except Exception:\n        pass\n`, { mode: 0o600 });
  const path = join(home, "config.yaml");
  let config: Record<string, unknown> = {};
  try {
    const loaded: unknown = parse(await readFile(path, "utf8"));
    if (loaded !== null && (typeof loaded !== "object" || Array.isArray(loaded))) throw new Error("invalid_config");
    config = (loaded ?? {}) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("rtk_hermes_config_invalid");
  }
  if (config.plugins !== undefined && (config.plugins === null || typeof config.plugins !== "object" || Array.isArray(config.plugins))) throw new Error("rtk_hermes_config_invalid");
  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  const enabled = Array.isArray(plugins.enabled) ? plugins.enabled : [];
  plugins.enabled = [...new Set([...enabled.filter(name => name !== "rtk-rewrite"), "remote-agent-rtk"])];
  if (Array.isArray(plugins.disabled)) plugins.disabled = plugins.disabled.filter(name => name !== "remote-agent-rtk");
  config.plugins = plugins;
  await writeProviderHomeFile(path, stringify(config));
};
