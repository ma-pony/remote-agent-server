import { expect, it } from "vitest";
import { capturedToolCapability, commandFiles, runtimeToolCapability, toolInput } from "../src/agent-usage/core/tool-capabilities.js";

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

it.each([
  [{ command: "rtk cat '/skills/my skill/SKILL.md'" }, ['/skills/my skill/SKILL.md']],
  [{ cmd: 'head -n 80 -- /skills/demo/SKILL.md' }, ['/skills/demo/SKILL.md']],
  [{ command: 'tail -n20 /skills/demo/SKILL.md' }, ['/skills/demo/SKILL.md']],
  [{ command: `bash -lc "sed -n '1,160p' /skills/demo/SKILL.md"` }, ['/skills/demo/SKILL.md']],
  [{ argv: ['cat', '-n', 'first/SKILL.md', 'second/SKILL.md'] }, ['first/SKILL.md', 'second/SKILL.md']]
])('recognizes actual literal file read operands: %j', (input, readPaths) => {
  expect(commandFiles(input)).toEqual({ readPaths, scriptPaths: [] });
});

it.each([
  ['python3 -u /skills/demo/scripts/check.py --input other.txt', '/skills/demo/scripts/check.py'],
  ['node /skills/demo/scripts/check.mjs other.txt', '/skills/demo/scripts/check.mjs'],
  ['sh /skills/demo/scripts/check.sh', '/skills/demo/scripts/check.sh'],
  ['/skills/demo/scripts/check.py other.txt', '/skills/demo/scripts/check.py']
])('recognizes only the invoked script operand: %s', (command, script) => {
  expect(commandFiles({ command, workdir: '/workspace' })).toEqual({
    readPaths: [], scriptPaths: [script], cwd: '/workspace'
  });
});

it.each([
  'echo /skills/demo/SKILL.md', 'rg /skills/demo/SKILL.md .',
  `python3 -c 'print("/skills/demo/scripts/check.py")'`,
  `node --eval '"/skills/demo/scripts/check.mjs"'`,
  "cat <<'EOF'\n/skills/demo/SKILL.md\nEOF", 'cat "$SKILL_ROOT/SKILL.md"',
  'cat /skills/demo/SKILL.md && git status', 'cat $(echo /skills/demo/SKILL.md)',
  "sed -n '/SKILL.md/p' other.txt", 'head --unknown-option /skills/demo/SKILL.md'
])('does not turn mentions, dynamic commands, or ambiguous options into file activity: %s', command => {
  expect(commandFiles({ command })).toEqual({ readPaths: [], scriptPaths: [] });
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

it.each([
  [{ command: "git status --short" }, "git"],
  [{ cmd: "'/usr/bin/git' status" }, "git"],
  [{ command: "API_TOKEN='private value' env -u DEBUG LANG=C rtk proxy git status" }, "git"],
  [{ command: 'rtk git status' }, 'git'],
  [{ command: 'bash -lc "rtk git status"' }, 'git'],
  [{ command: ['zsh', '-c', 'env LANG=C /usr/bin/git status'] }, 'git'],
  [{ argv: ['bash', '-lc', 'git status'] }, 'git'],
  [{ executable: '/bin/bash', args: ['-lc', 'git status'] }, 'git'],
  [{ command: 'git log --format="%h %s"' }, 'git'],
  [{ command: 'echo SKILL.md' }, 'echo']
])("identifies a single literal executable without using command arguments: %j", (input, name) => {
  expect(runtimeToolCapability('codex', 'execute', input)).toEqual({
    id: `runtime:codex:cli:${name}`, kind: 'cli', name
  });
  expect(capturedToolCapability('codex', 'exec_command', input)).toEqual({
    id: `runtime:codex:cli:${name}`, kind: 'cli', name
  });
});

it.each([
  'git status && npm test', 'git status | head', 'git status; npm test',
  'git status\nnpm test', 'git "$(cat secret)"', 'git `cat secret`',
  '$EXECUTABLE status', 'git *.txt', 'git > output.txt', "git 'unterminated",
  'git status # comment\nnpm test', 'bash -lc "git status && npm test"',
  'env -S "cat /skills/demo/SKILL.md"', 'API_TOKEN=secret',
  'bash -c "$COMMAND"', 'for file in *; do cat "$file"; done'
])('keeps ambiguous commands or shell constructs generic: %s', command => {
  expect(runtimeToolCapability('codex', 'execute', { command }).name).toBe('Shell command');
});

it.each([
  { command: `cat ${'a'.repeat(16_384)}` },
  { command: `cat ${Array.from({ length: 513 }, () => 'file').join(' ')}` },
  { command: `${'rtk proxy '.repeat(10)}cat /skills/demo/SKILL.md` },
  { command: ['cat', 42] },
  { executable: '/bin/bash', args: '-lc cat /skills/demo/SKILL.md' }
])('bounds parsing and rejects malformed command inputs without activity: %j', input => {
  expect(runtimeToolCapability('codex', 'execute', input).name).toBe('Shell command');
  expect(commandFiles(input)).toEqual({ readPaths: [], scriptPaths: [] });
});

it.each([
  { command: "'TOKEN=secret' cat /skills/demo/SKILL.md" },
  { command: 'TOKEN\\=secret cat /skills/demo/SKILL.md' },
  { argv: ['TOKEN=secret', 'cat', '/skills/demo/SKILL.md'] },
  { command: 'rtk proxy TOKEN=secret cat /skills/demo/SKILL.md' }
])('does not interpret literal executable arguments as shell assignments: %j', input => {
  expect(runtimeToolCapability('codex', 'execute', input).name).toBe('Shell command');
  expect(commandFiles(input)).toEqual({ readPaths: [], scriptPaths: [] });
});
