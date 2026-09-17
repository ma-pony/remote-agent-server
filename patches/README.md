# acpx patch maintenance

`acpx@0.16.0.patch` supplements the process cleanup shipped in [acpx 0.16.0](https://github.com/openclaw/acpx/releases/tag/v0.16.0). It replaces the larger 0.13.2 patch.

The upstream client snapshots descendants after successful initialization and Session setup. If a bridge creates a detached child and exits before replying to `initialize`, `session/new`, `session/load`, or `session/resume`, the first snapshot can arrive after reparenting and miss that child.

The patch adds bounded `trackDuring()` sampling to the launch's existing `ProcessDescendants`; `AcpClient` only supplies the four operation boundaries. The tracker samples every 100 ms, clears each timer in `finally`, and joins the final capture. `retire()` also clears outstanding sampling timers when process cleanup finishes, even if an operation has not settled yet. Upstream retains ownership of snapshot coalescing, PID birth-identity validation, termination, and cleanup deadlines. Sampling is skipped on Windows and does not continue during idle sessions. As with upstream, this is best-effort observation: a descendant created and orphaned entirely between snapshots may remain unwitnessed.

The Session creation boundary includes Claude's timeout, so sampling stops when that timeout expires even if the underlying RPC remains pending during process cleanup. Joining the final capture can delay operation completion up to the upstream process-helper timeout when process inspection stalls; capture failure does not replace the operation's original error.

The new public `processLifecycle` hooks are not a replacement for this fix. Admission hooks run before ACP initialization; failure and exit hooks are best-effort observers, not awaited cleanup barriers. Moving cleanup there would duplicate upstream process ownership and identity tracking. The public `agentProcessEnv`, registry, Runtime, and `shutdown()` APIs are used by the regression tests so they no longer import a hashed private bundle.

Run `pnpm test:mcp-process` on a host that permits process-table access. `test/acpx-process-cleanup.test.ts` covers close, shutdown, bridge exit, crashes before all four setup responses, and stopped sampling after successful, rejected, or timed-out Session setup without masking the error. It launches local fixtures only. Before removing this patch in a future upgrade, run the same cases against the unpatched published package and confirm that every descendant exits. Real Provider smoke tests remain a separate check.
