# Agent Core Runtime Routing

[简体中文](agent-core-routing.md)

Remote Agent Server lets one Agent use multiple Agent Cores and select the Core, model, and concurrency together when a Run actually starts. The business Session, Workspace, and external Conversation remain stable. Each Core owns an independent provider-native session.

## 1. Goals

Runtime routing supports three common needs:

- one business Agent can use Codex, Claude Code, Hermes, or another supported executor;
- daytime, nighttime, or weekday windows can select different Cores, models, and concurrency limits;
- switching Cores continues the same task without reusing another Core's hidden provider state.

The server does not attempt to migrate internal Provider state. Cores share only the Workspace, server-side business state, and an explicit handoff.

## 2. Four core concepts

### Agent Core Profile

A Core Profile is an execution identity assigned to an Agent. It contains:

- a display name;
- a Provider: `codex`, `claude_code`, or `hermes`;
- an enabled flag;
- an optional concurrency limit.

The Provider is immutable after profile creation. Create a new profile to change Provider so an old Provider session is never silently interpreted as a different executor identity.

### Core routing mode

An Agent supports two modes:

| Mode | Behavior | Use case |
| --- | --- | --- |
| `session_sticky` | The first Run pins the Session to the default Core. Every later Turn reuses it. | Default; strongest context continuity. |
| `scheduled_handoff` | Every Run selects a Core from UTC rules. A switch injects an incremental handoff. | Time-, cost-, or capability-based executor switching. |

One business Session remains serial. Two Cores never operate on the same Workspace concurrently.

### Session Core Binding

A business Session stores one independent binding for every Core it has used:

- Provider Session ID;
- last synchronized Run cursor;
- last model and use time;
- cumulative Token usage reported by that Core.

The default Core keeps the legacy `remote-agent:<sessionId>` persistence key so sessions created before the upgrade remain resumable. Non-default Cores use `remote-agent:<sessionId>:core:<coreProfileId>`. Provider Session IDs are never shared across Cores.

### Resolved Run Route

The scheduler resolves the route once when a Run gets an execution slot and stores the result on the Run:

- Core Profile and Provider;
- model;
- matched rule index;
- policy fingerprint;
- effective concurrency.

The executor consumes this immutable snapshot and does not resolve the policy again at a time boundary.

## 3. Routing rules

The existing model policy accepts optional Core IDs when cross-Core routing is enabled:

```json
{
  "mode": "schedule",
  "defaultCoreProfileId": 1,
  "defaultModel": "glm-5.3-flash",
  "windows": [
    {
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "start": "08:00",
      "end": "20:00",
      "coreProfileId": 1,
      "model": "glm-5.3-flash",
      "maxConcurrentRuns": 4
    },
    {
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "start": "20:00",
      "end": "08:00",
      "coreProfileId": 2,
      "model": "deepseek-v4",
      "maxConcurrentRuns": 2
    }
  ]
}
```

Rule semantics:

- all times use UTC and the 24-hour clock;
- start is inclusive and end is exclusive;
- an end earlier than the start crosses into the next UTC day;
- the first configured rule wins when windows overlap;
- the default Core and model apply outside all windows;
- queued Runs read the latest policy when they obtain a slot; active Runs are unaffected by configuration changes.

The scheduler checks the Agent total and selected Core capacity independently:

```text
Agent capacity = min(global limit, matched window limit ?? Agent default limit)
Core capacity  = min(global limit, Core Profile limit)
```

A matched window overrides the Agent default. A Core Profile limit applies only to that Core and does not throttle sibling Cores. The effective concurrency recorded on a Run is the smaller of these two capacities.

## 4. Run lifecycle

```text
Run obtains an execution slot
  -> resolve and persist Runtime Route
  -> select or create Session Core Binding
  -> prepare Workspace, Skills, extensions, and MCP
  -> resume the target Core Provider Session
  -> inject incremental handoff when needed
  -> startTurn
  -> persist result, usage, and handoff cursor
```

Capabilities are projected for the selected Provider:

- Skills and MCP belong to the Agent and are projected to the current Core;
- plugins and hooks are selected per Provider; profiles using the same Provider share the selection;
- Provider sessions and acpx session keys are isolated by Core, while static configuration for the same Provider is projected at Agent scope;
- one business Session keeps only one live Runtime handle. A switch closes the old handle while preserving its persistent session.

## 5. Handoff

When the target Core's cursor is behind the Session history, the server builds a deterministic handoff from unseen terminal Runs and sends it with the current user request.

The first version contains:

- Run ID, status, Core, Provider, and model;
- user request;
- final result or error.

Thoughts and the full event stream are excluded. Common Authorization, API Key, Token, Password, and Secret values are redacted. Each field is capped at 4 KiB and the whole handoff at 24 KiB, with recent records retained first.

The cursor advances only after `startTurn` was created and that Run reaches a terminal state. Workspace, MCP, or Runtime preparation failures cannot incorrectly mark history as observed.

A handoff restores business context. It does not copy implicit Provider memory, compaction state, or internal caches. `session_sticky` therefore remains the default and recommended mode.

## 6. Configuration and safety constraints

- Fixed models must come from the target Core's ACP model catalog. Unknown model IDs cannot be entered.
- The default Core, a Core referenced by routing policy, or a Core pinned by a Session cannot be disabled.
- A Core with Session Bindings cannot be deleted. Remove the associated Sessions or usage relationship first.
- The server does not switch Core during a Run and does not silently fail over. Startup failure fails the current Run explicitly.
- Profiles select only Providers supported by the service. The ordinary Agent API cannot inject arbitrary shell commands.

## 7. Reset, cleanup, and usage

Rebuilding an executor session:

- closes the active Runtime;
- removes every Core Provider session and acpx persistent state for the business Session;
- clears handoff cursors so future Cores can rebuild context from retained Run history;
- preserves the business Session, Workspace, Runs, events, and Token statistics.

Storage-expiration cleanup also visits every Core Binding. Permanent Session deletion removes its Bindings.

Cumulative Provider usage is stored per Binding and the Session displays the sum across Bindings, preventing one Core from overwriting another Core's usage.

## 8. Management API

```text
GET    /api/agents/:id/core-profiles
POST   /api/agents/:id/core-profiles
PATCH  /api/agents/:id/core-profiles/:profileId
DELETE /api/agents/:id/core-profiles/:profileId
GET    /api/agents/:id/core-profiles/:profileId/models
```

The Agent update endpoint accepts:

- `coreRoutingMode`;
- `defaultCoreProfileId`;
- `modelPolicy` with optional Core IDs.

The extension catalog uses `GET /api/agents/:id/extensions?provider=codex|claude_code`. Extension updates send the same `provider` in the request body.

## 9. Acceptance criteria

1. A sticky Session pins its first Core, and later default-Core changes do not affect it.
2. A scheduled Session can switch Codex -> Claude -> Codex and resume two independent Provider sessions.
3. Core, model, and concurrency come from one UTC snapshot and are persisted on the Run.
4. Returning to a Core injects only unseen terminal Runs; preparation failure does not advance its cursor.
5. A Core switch leaves only one active Runtime process tree for a business Session.
6. Token aggregation, reset, and storage cleanup cover every Session Core Binding.
7. An unavailable Core or model fails explicitly and does not trigger an in-Run fallback.

The implementation deliberately keeps its boundary small: no Core generation, distributed state replication, model-generated summary, mid-Run switch, or automatic fallback. Those capabilities should be added only after a concrete need appears.
