import { expect, it } from "vitest";
import { capturedToolCapability, runtimeToolCapability, toolInput } from "../src/agent-usage/core/tool-capabilities.js";

it.each([
  ["codex", "read_file", "read", { path: "/workspace/README.md" }],
  ["claude_code", "Read", "read", { file_path: "/workspace/README.md" }],
  ["claude_code", "Grep", "search", { pattern: "TODO" }],
  ["codex", "exec_command", "execute", { executable: "/usr/bin/git" }],
  ["claude_code", "Bash", "execute", { argv: ["git", "status"] }]
])("shares %s/%s identities with Runtime evidence", (runtime, name, kind, args) => {
  expect(capturedToolCapability(runtime, name, JSON.stringify(args)))
    .toEqual(runtimeToolCapability(runtime, kind, args));
});

it("keeps shell commands generic and leaves unrecognized tool and runtime names unknown", () => {
  const shell = capturedToolCapability("claude_code", "Bash", { command: "git status && npm test" });
  expect(shell).toMatchObject({ kind: "cli", id: "runtime:claude_code:cli:shell" });
  expect(capturedToolCapability("claude_code", "Bash")).toEqual(shell);
  expect(capturedToolCapability("codex", "exec_command", "invalid JSON")).toMatchObject({ kind: "cli", name: "Shell command" });
  expect(capturedToolCapability("custom", "Read", {})).toBeUndefined();
  expect(capturedToolCapability("__proto__", "constructor", {})).toBeUndefined();
  expect(capturedToolCapability("codex", "mcp__docs__read_file", {})).toBeUndefined();
  expect(capturedToolCapability("codex", "arbitraryRead", {})).toBeUndefined();
  expect(capturedToolCapability("codex", "toString", {})).toBeUndefined();
  expect(toolInput("[]")).toBeUndefined();
});
