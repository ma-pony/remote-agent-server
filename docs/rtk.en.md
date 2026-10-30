# Managed RTK

[简体中文](rtk.md)

RTK compresses terminal output before the model reads it. The server uses the Apache-2.0
`rtk-oss` executable, without RTK Proxy or model-API routing changes. Command-output
reduction is separate from actual model token usage, which keeps its existing accounting.

## Installation and controls

`pnpm run init` installs the recommended version (`1.1.0`) and enables automatic
compression by default. Existing installations retain their selected version and enabled
state. Failure is reported without failing basic setup; Runs use original command output.
`pnpm run doctor` only inspects local installation state and never downloads or upgrades.
Running initialization again self-tests the current version and reinstalls it if its
executable is missing, non-executable, or corrupted.

Open **System settings → Runtime and concurrency → RTK command output compression**
to enable, disable, check, install, update, or confirm a rollback. Disabling retains the
executable and allows explicit `rtk` commands. Each Run resolves its configuration when
execution starts, including queued Runs. Changes never interrupt active work. Runtime
refresh resumes the same Provider Session.

The service checks the official latest stable release asynchronously after startup and
every 24 hours. Failed startup checks retry hourly. Successful results are persisted;
failure retains the previous successful timestamp/version and exposes a sanitized error.
Updates are manual. Disabling compression leaves version checks available. Starting a Run
never downloads RTK.

Claude Code and Codex use a managed `PreToolUse` hook; Hermes uses a managed
`pre_tool_call` plugin. DeepSeek Harness has no automatic integration yet. Coverage is
limited to terminal commands the provider permits rewriting; built-in Read/Grep tools do
not automatically pass through RTK. Verify hook execution with the installed CLI/ACP
versions separately: projection alone does not prove effective interception.

Projection replaces selected standalone native `rtk hook` entries with the managed gate;
Hermes replaces its enabled `rtk-rewrite` plugin. This avoids duplicate rewriting and
bypassing the system setting. Host configuration, saved extension selections, and other
hooks remain intact. Custom hooks containing additional commands retain their own controls.

## Publication and recovery

`DATA_DIR/tools/rtk/state.json` (mode `0600`) owns enabled state, active and previous
versions, and check results. One manager owns the state and binaries, publishing state
through temporary-file rename instead of duplicating an activation pointer in SQLite.
Runs persist a separate configuration snapshot in SQLite without local executable paths.

Executables live at `DATA_DIR/tools/rtk/versions/<version>/rtk`. Updates accept an
explicit detected stable version; first installation accepts the recommended version.
The manager fetches the platform OSS asset and SHA-256 from the official GitHub Release,
bounds downloads and decompression, extracts only a regular `rtk` file, and checks version
and rewrite behaviour. A complete candidate is published before switching active state.
Healthy same-version executables are reused. An unusable executable is atomically replaced
only after the candidate passes verification and self-tests. Same-version repair preserves
enabled state and the rollback target; failure retains the old file. Rollback tests the
retained executable before switching the pointer.

A process lock excludes concurrent initialization and background mutations. Shutdown
cancels downloads and self-tests and awaits cleanup. Failure or interruption preserves the
active version. Startup recovery removes incomplete staging before dispatch. Published but
unactivated candidates may be reclaimed. Installed versions remain during the process
lifetime to protect active Runs and idle runtime handles; the next startup retains only
the current and previous versions.

The stable hook gate reads the Runtime's configuration snapshot. Rewritten commands pin
the corresponding absolute executable path, independent of a mutable global link. Missing
tools, unmatched commands, or preprocessing failures leave the original command intact;
already executed business commands are never automatically rerun. Permission denials remain.
Binding recognizes executable positions after environment assignments, `cd`, compound
commands, and common process wrappers, retaining arguments, quoting, and comments.
Shell control syntax that cannot be safely parsed leaves the original command intact.

Tracking, recall and tee data use each Session's `runtime/rtk/` directory and follow large
Session storage cleanup. They are not projected into public integration events. Telemetry
and hook auditing are disabled. The complete Provider HOME remains unchanged so Git and
other tools retain their credential behaviour; RTK may still read the service user's
existing read-only filter configuration.

## Management API

All routes require the management API Token. Background operations return `202`; poll
status for progress.

| Method and path | Input | Behaviour |
| --- | --- | --- |
| `GET /api/system-settings/rtk` | None | Settings, versions, successful-check timestamp, errors and operation progress |
| `PUT /api/system-settings/rtk` | `{"enabled":true}` | Save automatic compression setting |
| `POST /api/system-settings/rtk/check` | `{}` | Check latest stable release; coalesce duplicate checks |
| `POST /api/system-settings/rtk/update` | `{"version":"1.1.0"}` | Install the explicitly selected candidate |
| `POST /api/system-settings/rtk/rollback` | `{"version":"1.0.0"}` | Activate the recorded previous version |

Version fields accept three-part stable versions only. Invalid requests return
`400 invalid_request`; conflicts return `409 rtk_busy` or `409 rtk_version_conflict`.
Stages are checking, downloading, verifying, testing, activating, succeeded and failed.
Background failures expose controlled codes rather than raw exceptions.

Back up all of `DATA_DIR/tools/rtk/`, SQLite and Session storage using the existing
deployment procedures. Do not manually delete version directories while the service runs.
RTK rollback switches the tool only; service-code/database rollback follows the deployment
guide.
