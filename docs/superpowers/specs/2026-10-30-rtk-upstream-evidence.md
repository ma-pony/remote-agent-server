# RTK v1.1.0 upstream integration evidence

## Scope and version

This note records the upstream behaviour used to design the initial RTK
integration. It deliberately does not claim that the installed ACP adapters
have executed these hooks. That requires a later provider-level integration
test.

- Upstream release: `rtk-ai/rtk` **v1.1.0**, commit
  `753a3b0e939f2e4490fc24e3a1984010f40a103c`.
- This design uses the `rtk-oss` release artifact: Apache-2.0 hooks and command
  filters, without the BUSL engine or the separate API-traffic proxy. The two
  editions expose the same executable name, `rtk`; they must not be installed
  together.
- The server must acquire a release-specific artifact, verify its recorded
  checksum, place it in a server-owned immutable version directory, and put
  that absolute path in every projected hook. It must not rely on `PATH` or run
  `rtk init`.

Sources:

- [v1.1.0 README](https://raw.githubusercontent.com/rtk-ai/rtk/v1.1.0/README.md)
- [v1.1.0 Cargo manifest](https://raw.githubusercontent.com/rtk-ai/rtk/v1.1.0/Cargo.toml)

## RTK's native hook contracts

### Codex

`rtk hook codex` is a `PreToolUse` processor. It accepts a JSON payload with
`hook_event_name: "PreToolUse"`, `tool_name: "Bash"` (or `"bash"`), a supported
`permission_mode`, and `tool_input.command`. On a rewrite it emits:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "RTK auto-rewrite",
    "updatedInput": { "command": "rtk git status" }
  }
}
```

The upstream implementation says Codex requires the protocol-level `allow` to
accept `updatedInput`; it then performs its normal approval and sandbox checks
on the rewritten command. RTK intentionally emits no stdout for malformed
input, unsupported or unknown permission modes, unsupported commands, no
matching filter, heredocs, substitutions, or file-target redirects. The
original command then runs.

The default RTK installer registers a `Bash` matcher in `hooks.json` and uses
the bare command `rtk hook codex`. Upstream tests recognize both bare and
absolute executable paths. We should therefore project the same JSON shape but
with a quoted, absolute server-managed v1.1.0 binary path. That pins the
version for every Run and avoids a host PATH change altering hook behaviour.

Sources:

- [v1.1.0 Codex hook guide](https://raw.githubusercontent.com/rtk-ai/rtk/v1.1.0/hooks/codex/README.md)
- [v1.1.0 generic hook protocol](https://raw.githubusercontent.com/rtk-ai/rtk/v1.1.0/hooks/README.md)
- [v1.1.0 Codex hook implementation](https://github.com/rtk-ai/rtk/blob/v1.1.0/src/hooks/hook_cmd.rs#L974-L1094)
- [v1.1.0 Codex init implementation](https://github.com/rtk-ai/rtk/blob/v1.1.0/src/hooks/init/codex.rs#L917-L986)

### Claude Code

`rtk hook claude` uses the Claude `PreToolUse` JSON protocol: it reads
`tool_name: "Bash"` and `tool_input.command`, then emits the same
`hookSpecificOutput.updatedInput` shape as above when it rewrites. The current
native processor is fail-open: absent or malformed payload, no match, or a
processing failure produces no rewrite response. Historic shell-script
integration required `jq`; the v1.1.0 native hook command is the relevant
integration target.

Sources:

- [v1.1.0 Claude hook guide](https://raw.githubusercontent.com/rtk-ai/rtk/v1.1.0/hooks/claude/README.md)
- [v1.1.0 generic hook protocol](https://raw.githubusercontent.com/rtk-ai/rtk/v1.1.0/hooks/README.md)

### Hermes

Upstream Hermes support is a Python plugin, not a shell hook. The plugin
registers `pre_tool_call`, handles only the mutable `terminal` tool payload,
and executes `rtk rewrite <command>` without a shell. Exit codes `0` and `3`
may contain a replacement command; `1` and `2` deliberately leave the original
command unchanged. It has a two-second timeout and fails open for every error.

The minimum installed plugin consists of:

```text
plugins/rtk-rewrite/plugin.yaml
plugins/rtk-rewrite/__init__.py
```

with `plugin.yaml` declaring `pre_tool_call`, and the provider configuration
enabling plugin `rtk-rewrite`. The server should vendor this minimal adapter
under its own managed provider-home projection and replace its bare `rtk`
subprocess argument with the pinned absolute binary path. It should not invoke
`rtk init --agent hermes`, which modifies a user-managed Hermes home.

Sources:

- [v1.1.0 Hermes plugin source](https://raw.githubusercontent.com/rtk-ai/rtk/v1.1.0/hooks/hermes/rtk-rewrite/__init__.py)
- [v1.1.0 Hermes plugin manifest](https://raw.githubusercontent.com/rtk-ai/rtk/v1.1.0/hooks/hermes/rtk-rewrite/plugin.yaml)
- [v1.1.0 Hermes guide](https://raw.githubusercontent.com/rtk-ai/rtk/v1.1.0/hooks/hermes/README.md)

## Server projection evidence and consequence

The current server already supplies a provider-specific home to each ACP
process: `CODEX_HOME` for Codex, `CLAUDE_CONFIG_DIR` for Claude, and
`HERMES_HOME` for Hermes. `ProviderExtensionProjector` serializes selected
extensions into the Codex `hooks.json` or Claude `settings.json` using an
event, matcher, and command-hook object. This is the correct seam for RTK
projection; it avoids mutating either the repository or the service user's
provider configuration.

Current source evidence:

- `src/runtime/provider-extension-projector.ts` constructs groups as
  `{ hooks: [hook], matcher? }` and writes `{ hooks }` to Codex `hooks.json`.
- `src/runtime/provider-extension-projector.ts` writes the same grouped hook
  shape to Claude `settings.json`.
- `src/runtime/acpx-runtime.ts` prepares and exports the provider-specific home
  before starting its ACP command.

The installed `@agentclientprotocol/codex-acp@2.2.2` package identifies itself
as an ACP server that starts the Codex App Server. Its packaged documentation
does not itself prove an end-to-end invocation of the projected RTK hook.
Implementation must therefore add a focused projection test, then a separate
authorized provider smoke test before claiming transparent rewriting works
through ACP.

## Configuration and graceful degradation requirements

- A Run must snapshot `enabled`, exact RTK version/path, and the projection
  fingerprint before execution. A setting change is applied only to a later
  Run.
- When disabled, omit the projected hook (or have a server-owned gate consume
  stdin and exit 0 without stdout). Do not set `RTK_DISABLED=1` as a process
  flag: it is an upstream command-prefix bypass, while manually invoked `rtk`
  commands should remain available.
- Missing binary, unsupported hook payload, no rewrite candidate, malformed
  input, and adapter errors must all execute the original command. Record a
  server-side degraded status rather than treating this as a successful
  optimization.
- Use explicit per-session `RTK_DB_PATH`, `RTK_RECALL_DB`, and `RTK_TEE_DIR`;
  set `RTK_TELEMETRY_DISABLED=1`. Do not alter the complete provider `HOME`.
  This keeps tracking and full-output recall out of a shared service-user
  location while retaining the existing provider credential behaviour.
- The product claim is limited to reduced shell-output bytes. RTK documents
  its token estimate as bytes divided by four; it is neither total-token nor
  billing evidence.

Sources:

- [v1.1.0 configuration guide](https://raw.githubusercontent.com/rtk-ai/rtk/v1.1.0/docs/guide/getting-started/configuration.md)
- [v1.1.0 supported agents guide](https://raw.githubusercontent.com/rtk-ai/rtk/v1.1.0/docs/guide/getting-started/supported-agents.md)
