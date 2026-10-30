# Managed RTK hook trust validation — 2026-10-30

## Root cause and scope

The first real Codex acceptance run on `ec58a32` completed its Git command but produced
no RTK tracking row. Native `hooks/list` discovered the projected entry as enabled and
`untrusted`. Trusting only that entry in the isolated Home made the next enabled Run
record compression; disabling RTK restored the original output. Protocol/projection
tests alone had not covered the native trust boundary.

This correction prepares the service-owned Codex RTK hook before Core Session creation.
It verifies the private projection, queries the same CLI used by the ACP adapter, records
the native current hash, and reads back the exact key/hash/trust result. Other hooks are
not authorized. A disabled native hook feature is enabled only after the owned projection
has been validated. The native CLI hides hook metadata while that feature is disabled;
the fake now reproduces that behavior.

Preparation has a ten-second deadline and a 1 MiB response cap. Its process group is
terminated on success, failure, timeout, Run cancellation, and Runtime shutdown. Failure
prevents model execution and exposes only `codex_managed_hook_trust_failed`. Run abort
signals do not participate in the configuration fingerprint or persisted RTK snapshot.

Claude Code clears inherited user-level `disableAllHooks` only in its private projection
when hooks are selected or service-managed. Hermes explicitly enables its managed plugin
and removes only that name from its deny list. Machine policies remain with the native
Cores. Atomic private-file replacement and recreation of the managed Hermes plugin
directory prevent imported symlinks from mutating host configuration or code.

## Regression coverage

- Core creation waits for verified native trust; unrelated hooks are never authorized.
- Valid trust is reused, changed hashes are refreshed, and a changed hash during
  authorization fails verification.
- Wrong commands, paths, keys, RPC errors, failed writes, oversized responses, and
  conflicting adapter hook overrides fail safely without leaking native diagnostics.
- A disabled native feature hides hooks until enabled. Missing managed projections cause
  no native configuration writes.
- UTF-8 paths split across response chunks remain intact.
- Stalled probes time out; cancellation and shutdown reap the full process group,
  including a descendant that ignores SIGTERM, before Core creation.
- Claude and Hermes enablement retains unrelated configuration/denials. Symlink fixtures
  prove host configuration and plugin code remain unchanged.

The initial regressions failed before their corrections. The native disabled-feature
probe also failed against the real pinned CLI before the projection-first correction;
after correction it reported both feature recovery and native trust present.

## Real Core verification

Tests used real model/ACP calls with temporary service data, a synthetic Git repository,
and APFS Session workspaces. The original command was `git -C fixture status`; the model
was instructed not to add RTK. Host configuration and the existing service were unchanged.

| Core | Evidence | Result |
| --- | --- | --- |
| Codex CLI 0.160.1 / ACP 2.2.2 / RTK OSS 1.1.0 | A fresh Home needed no manual authorization. Enabled tracking changed `0 → 1`; disabled remained `1 → 1`, with raw Git output and the same Provider Session. A later pair changed `1 → 2`, then remained `2 → 2`. | Passed |
| Claude Code 2.1.312 | After an initial authentication-required response, the same business Session completed two enabled Runs (`0 → 1 → 2`) and a disabled Run (`2 → 2`), with raw output restored. No login or credential change was performed by the test. | Passed after authentication retry; initial response retained as a limitation |
| Hermes 0.15.1 | Both model Runs failed with `Hermes upstream request failed` before tool execution. A separate check used the installed native plugin framework: the managed plugin loaded with one hook and no error; enabled calls bound the absolute RTK executable, disabled calls retained the original command. | Native plugin path passed; full model acceptance unavailable |
| DeepSeek Harness | RTK remains explicitly unsupported and no automatic hook/plugin is projected. Its CLI was unavailable on this host. | No new integration or trust exemption claimed |

The real Codex native API was also tested without credentials/model calls using a Home
with `features.hooks=false`; preparation enabled the feature and recorded verified native
trust. Hermes' native plugin check started with the managed plugin in `plugins.disabled`,
so it exercises the inherited-denial correction rather than only the generated files.

Raw Provider payloads, Provider Homes, credentials, SQLite files, and workspaces are not
part of this validation record or commit. Model-token billing reductions are not claimed.

## Final checks and review

- `corepack pnpm test --maxWorkers=2`: 1,597 passed, 18 skipped; 114 files passed and
  one gated file skipped. Duration 125.90 seconds.
- `corepack pnpm test:mcp-process --maxWorkers=1`: 57 passed, 17.63 seconds. This local
  process suite required process-table access outside the sandbox; it used no model APIs.
- Server/web/script type checking and production compilation passed.
- `git diff --check` passed. One concurrent focused run encountered the existing plugin
  cache-cleanup wait timeout; that file passed alone and the final full suite passed.

The review traced authorization scope, native feature enablement, content/hash changes,
Run cancellation, Session continuity, process ownership, private file publication, and
public error redaction. No unresolved blocking findings remain in this change. Hermes'
unavailable model round trip and Claude's initial authentication response remain the
explicit environment limitations above.

Both temporary acceptance directories were removed after checking for surviving test
processes. No Provider credentials, raw captures, databases, or workspaces were retained.
No existing service was restarted or deployed.
