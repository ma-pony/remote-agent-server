# Dependency patch maintenance

## Codex ACP 2.2.2

`@agentclientprotocol__codex-acp@2.2.2.patch` replaces the 1.1.14 patch. The adapter is pinned exactly; the lockfile resolves its bundled Codex CLI to 0.160.1.

Upstream now owns the shared `McpSessionStartup` task, its abort controller and session-close cleanup, the generic thread-aware status request, and paginated status collection. The old patches to `CodexAcpClient.listMcpServers` and separate new/load/resume startup-promise setup are removed.

The remaining local policy is:

- Enable networking in default `agent` mode, retaining workspace sandbox roots and temporary-directory rules. Other mode presets and upstream's default `auto_review` reviewer are unchanged.
- Use upstream's paginated query to require every selected MCP server's thread-local `runtimeStatus` to be `connected`, including same-name entries supplied by Codex config. Cached `serverInfo`, global events, and early startup notifications are insufficient. A transient `cancelled` state may recover; `failed`, `disabled`, and `authenticationRequired` fail immediately.
- Share a startup result with prompts and background reporting, retain failures until the Provider Session closes, and end the readiness wait within 30 seconds even when a status request does not respond. Cancellation stops the waiting prompt; close aborts startup and clears timers. An outstanding status RPC is released when its Runtime closes the ACP/app-server processes. A replacement app-server invalidates the old result, so automatic recovery checks the new connections again.

Upstream's optional `_meta.mcpStartupAwaitTimeoutMs` is not equivalent: acpx 0.16.0 does not send it, `session/load` does not read it, and elapsed waits or MCP failure results do not reject the subsequent prompt. Keep the local prompt gate until the released upstream adapter provides the same required-server behavior across creation, loading, resumption, and process recovery.

`pnpm exec vitest run test/codex-acp-patch.test.ts` runs the published adapter and acpx against a local fake app-server without Provider credentials or model calls. It covers default/explicit mode policies, thread isolation, pagination, config conflicts, transient events, cached metadata, failure retention, the real 30-second deadline (including a hung RPC), load/resume, process recovery, cancellation, and close/shutdown cleanup with responsive and hung status requests. Before removing either policy, run these behavior tests against the unpatched candidate release; source-string matches alone are not sufficient.

## acpx 0.16.0

`acpx@0.16.0.patch` supplements the process cleanup shipped in [acpx 0.16.0](https://github.com/openclaw/acpx/releases/tag/v0.16.0). It replaces the larger 0.13.2 patch.

The upstream client snapshots descendants after successful initialization and Session setup. If a bridge creates a detached child and exits before replying to `initialize`, `session/new`, `session/load`, or `session/resume`, the first snapshot can arrive after reparenting and miss that child.

The patch adds bounded `trackDuring()` sampling to the launch's existing `ProcessDescendants`; `AcpClient` only supplies the four operation boundaries. The tracker samples every 100 ms, clears each timer in `finally`, and joins the final capture. `retire()` also clears outstanding sampling timers when process cleanup finishes, even if an operation has not settled yet. Upstream retains ownership of snapshot coalescing, PID birth-identity validation, termination, and cleanup deadlines. Sampling is skipped on Windows and does not continue during idle sessions. As with upstream, this is best-effort observation: a descendant created and orphaned entirely between snapshots may remain unwitnessed.

The Session creation boundary includes Claude's timeout, so sampling stops when that timeout expires even if the underlying RPC remains pending during process cleanup. Joining the final capture can delay operation completion up to the upstream process-helper timeout when process inspection stalls; capture failure does not replace the operation's original error.

The new public `processLifecycle` hooks are not a replacement for this fix. Admission hooks run before ACP initialization; failure and exit hooks are best-effort observers, not awaited cleanup barriers. Moving cleanup there would duplicate upstream process ownership and identity tracking. The public `agentProcessEnv`, registry, Runtime, and `shutdown()` APIs are used by the regression tests so they no longer import a hashed private bundle.

Run `pnpm test:mcp-process` on a host that permits process-table access. `test/acpx-process-cleanup.test.ts` covers close, shutdown, bridge exit, crashes before all four setup responses, and stopped sampling after successful, rejected, or timed-out Session setup without masking the error. It launches local fixtures only. Before removing this patch in a future upgrade, run the same cases against the unpatched published package and confirm that every descendant exits. Real Provider smoke tests remain a separate check.
