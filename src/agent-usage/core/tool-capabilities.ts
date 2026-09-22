import { basename } from "node:path";
import type { Capability } from "./context-types.js";

type ToolInput = Record<string, unknown>;
export type StructuredExecutable = { name?: string; path: string };

export const toolInput = (value: unknown): ToolInput | undefined => {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as ToolInput : undefined;
  } catch {
    return undefined;
  }
};

export const structuredExecutable = (kind: string, input: ToolInput | undefined): StructuredExecutable | undefined => {
  if (kind !== "execute" || input === undefined) return undefined;
  const path = [input.executable, input.program, Array.isArray(input.argv) ? input.argv[0] : undefined]
    .find((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096);
  if (path === undefined) return undefined;
  const name = basename(path);
  return { path, name: /^[a-zA-Z0-9._+-]{1,128}$/.test(name) ? name : undefined };
};

const builtinNames: Record<string, string> = {
  read: "Read file", edit: "Edit file", search: "Search files",
  fetch: "Fetch resource", delete: "Delete file", move: "Move file"
};

const cliCapability = (runtimeKind: string, executable?: StructuredExecutable): Capability => ({
  id: `runtime:${runtimeKind}:cli:${executable?.name ?? "shell"}`,
  kind: "cli",
  name: executable?.name ?? "Shell command"
});

/** Shared identities for ACP events and supported Provider HTTP tool schemas. */
export const runtimeToolCapability = (runtimeKind: string, kind: string, input?: ToolInput): Capability => {
  const executable = structuredExecutable(kind, input);
  if (kind === "execute" && (executable !== undefined
    || typeof input?.command === "string" || typeof input?.cmd === "string")) {
    return cliCapability(runtimeKind, executable);
  }
  if (Object.hasOwn(builtinNames, kind)) {
    return { id: `runtime:${runtimeKind}:builtin:${kind}`, kind: "builtin_tool", name: builtinNames[kind]! };
  }
  return { id: `runtime:${runtimeKind}:unknown`, kind: "unknown", name: "Runtime tool" };
};

// Exact protocol names only. MCP aliases take precedence at the caller; arbitrary tool names stay unknown.
const nativeTools: Record<string, Record<string, string>> = {
  codex: {
    Read: "read", read_file: "read", apply_patch: "edit",
    exec_command: "execute", shell: "execute", shell_command: "execute"
  },
  claude_code: {
    Read: "read", Edit: "edit", MultiEdit: "edit", Write: "edit",
    Glob: "search", Grep: "search", WebFetch: "fetch", WebSearch: "fetch", Bash: "execute"
  }
};

export const capturedToolCapability = (runtimeKind: string, name: string, args?: unknown): Capability | undefined => {
  const tools = Object.hasOwn(nativeTools, runtimeKind) ? nativeTools[runtimeKind] : undefined;
  if (!tools || !Object.hasOwn(tools, name)) return undefined;
  const kind = tools[name]!;
  const input = toolInput(args);
  // Shell definitions and unstructured command strings have no individual executable identity.
  return kind === "execute" ? cliCapability(runtimeKind, structuredExecutable(kind, input))
    : runtimeToolCapability(runtimeKind, kind, input);
};
