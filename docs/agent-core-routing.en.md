# Agent Core and Model Runtime Routing Proposal

[简体中文](agent-core-routing.md)

> Status: design proposal, not implemented. This document records the target architecture, constraints, and staged delivery boundary. Current production behavior remains the single-Core model policy described in [Product and architecture](design.en.md).

## 1. Goal

Allow one Agent to select several Agent Cores and use UTC weekday/time rules to choose, as one target:

- the Agent Core for a Run;
- a model actually advertised by that Core;
- the Run concurrency limit for that time window.

A switch must not create a new business Session, Conversation, or Workspace, and must not interrupt an active Run. The server must persist an auditable routing result and must never pass one Core's provider session ID to another Core.

## 2. Terms and boundaries

- **Agent:** the business identity that owns a project environment, instructions, Skills, MCP, and execution policy.
- **Agent Core Profile:** one runnable ACP executor instance, such as a particular Codex, Claude Code, or Hermes configuration.
- **Provider:** the adapter family used by a Core, such as `codex`, `claude_code`, or `hermes`.
- **Model:** a model advertised and selected through a specific Core.
- **Business Session:** Remote Agent Server's durable work context and Workspace.
- **Provider Session:** a Core's native conversation context.

One business Session may own several Provider Sessions. Different Cores cannot share one Provider Session. They can only share the Workspace, persisted business facts, and an explicit handoff; hidden Provider context cannot be migrated.

## 3. Core decisions

### 3.1 Route Core, model, and concurrency together

Do not maintain independent Core and model policies. A model catalog belongs to one Core; separate policies can produce invalid combinations such as a Claude Core with a Codex-only model.

Proposed policy contract:

```json
{
  "mode": "schedule",
  "defaultTarget": {
    "coreProfileId": 1,
    "model": { "mode": "core_default" }
  },
  "rules": [
    {
      "id": "weekday-daytime",
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "periods": [
        { "start": "08:00", "end": "12:00" },
        { "start": "13:00", "end": "20:00" }
      ],
      "target": {
        "coreProfileId": 1,
        "model": { "mode": "fixed", "id": "glm-5.3-flash" }
      },
      "maxConcurrentRuns": 4
    },
    {
      "id": "weekday-night",
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "periods": [{ "start": "20:00", "end": "08:00" }],
      "target": {
        "coreProfileId": 2,
        "model": { "mode": "fixed", "id": "deepseek-v4" }
      },
      "maxConcurrentRuns": 2
    }
  ]
}
```

Rules remain UTC-based: start is inclusive, end is exclusive, an end before the start crosses into the next UTC day, and earlier rules win on overlap. `defaultTarget` is required so every instant has an explicit target.

### 3.2 Resolve a route exactly once when a Run gets a slot

When a Run actually obtains an execution slot, the scheduler creates an immutable `ResolvedRunRoute`:

```ts
type ResolvedRunRoute = {
  resolvedAt: string;
  policyRevision: string;
  ruleId: string | null;
  coreProfileId: number;
  coreGeneration: number;
  provider: Provider;
  model: string | null;
  effectiveConcurrency: number;
};
```

The same object controls admission, Run persistence, and Runtime startup. The executor must not read the clock and resolve the policy again. This prevents a UTC minute boundary from admitting under one rule and executing under another.

Effective concurrency is:

```text
min(global limit, Agent limit, Core Profile limit, time-rule limit)
```

The scheduler adds `activeByCoreProfile` alongside `activeByAgent`. Lowering a configured limit never cancels active Runs; queued Runs use the latest policy at their next admission attempt.

### 3.3 Persist one binding per business Session and Core

Remove the assumption that a Session has one `provider_session_id` and add:

```sql
CREATE TABLE session_core_bindings (
  session_id INTEGER NOT NULL,
  core_profile_id INTEGER NOT NULL,
  core_generation INTEGER NOT NULL,
  provider_session_id TEXT,
  context_cursor_run_id INTEGER,
  last_model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_read_tokens INTEGER,
  cached_write_tokens INTEGER,
  thought_tokens INTEGER,
  total_tokens INTEGER,
  last_used_at TEXT,
  storage_cleaned_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, core_profile_id, core_generation)
);
```

Use this acpx persistence key:

```text
remote-agent:<sessionId>:core:<coreProfileId>:generation:<generation>
```

Changing a Core's Provider, command, Provider Home, or credential identity publishes a new generation. An old Provider Session must never silently enter a different execution identity.

### 3.4 Keep only one live Core handle per business Session

Runs in one Session remain strictly serial. When switching Cores:

1. close the previous Core's live handle without discarding persistent state;
2. store its Provider Session ID and cumulative usage;
3. create or resume the target Core's handle;
4. continue releasing the current handle after the idle timeout.

Do not keep several Core processes resident for one Session. Otherwise MCP, browser, and Provider processes multiply memory use by the number of Cores.

## 4. Cross-Core context synchronization

Workspace changes are shared naturally, but Provider-native conversations are not. Each binding uses `context_cursor_run_id` to record how much business history that Core has seen.

Before the target Core runs, the server:

1. reads completed Runs after the cursor that were executed by other Cores;
2. builds a deterministic, redacted incremental handoff;
3. sends the handoff together with the current user input;
4. advances the cursor after the target Core successfully processes the turn.

A handoff may contain Run ID, status, Core, model, user input, final reply, Workspace change summary, open work, and public external-task state. It must exclude thoughts, credentials, unredacted tool arguments, and full event streams.

Handoff is not limited to the first use of a Core. When other Cores have completed work while a Core was inactive, switching back must supply the missing delta. Consecutive Runs on the same Core do not repeat it.

The first version uses deterministic handoff generation and does not call another model to summarize. Apply per-Run and total byte limits. When truncated, retain the newest outcomes and structured state and identify the omitted range.

## 5. Core Catalog and capabilities

The system Core Catalog stores trusted executable configurations:

```yaml
agentCores:
  - key: codex-primary
    name: Codex
    adapter: codex
    enabled: true
    maxConcurrentRuns: 6
  - key: claude-primary
    name: Claude Code
    adapter: claude_code
    enabled: true
    maxConcurrentRuns: 3
```

Ordinary Agent configuration only selects registered Cores. Arbitrary shell commands, Provider Home sources, and credential references are trusted system configuration and are not exposed through the normal Agent API.

Capabilities combine:

- platform-declared behavior for instructions, Skills, plugins, Hooks, and Provider Home projection;
- ACP-discovered behavior for model catalogs, configuration options, and Session resume/load.

Discover and cache models by `(agentId, coreProfileId, coreGeneration)`, because accounts, Provider Homes, and permissions can differ by Agent. A fixed model must come from the target Core's actual `availableModels`; a Core without model selection only permits `core_default`.

Before saving a policy, validate that every target Core is enabled, assigned to the Agent, still advertises the selected model, and supports the Agent's required instructions, MCP, Skills, and extensions. Probe on configuration save, manual doctor checks, and low-frequency refreshes, not before every Run, to avoid spawning short-lived Core/MCP process trees repeatedly.

## 6. Runtime capability projection

Route resolution must precede runtime preparation. The target flow is:

```text
resolve and persist Runtime Route
  -> prepare the target Core's Provider Home
  -> project target-Core Skills, plugins, and Hooks
  -> prepare and inject MCP
  -> resume the target Core's Provider Session
  -> apply the model
  -> inject the incremental handoff
  -> startTurn
```

Skills can remain Agent-owned and be written to the appropriate directory by the projector for the resolved Core. Plugins and Hooks are Provider-native and should be stored by `(agent_id, core_profile_id, extension_id)`. MCP remains Agent-owned by default, but a Core can enter the route only when it supports MCP injection required by that Agent.

Provider Homes must be isolated by Core Profile. Even two Codex Profiles cannot share ambiguous session directories, runtime caches, or authentication identity.

## 7. Usage, audit, reset, and cleanup

Add immutable audit fields to each Run:

- `resolved_core_profile_id`;
- `resolved_core_generation`;
- `resolved_provider`;
- `resolved_model`;
- `resolved_rule_id`;
- `routing_policy_revision`;
- `fallback_reason`, always null in the first version.

Store cumulative Provider token usage on the matching `session_core_bindings` row. Session totals are the sum of all bindings. A current Core's cumulative counters must not overwrite the whole business Session.

Reset actions distinguish:

- reset the current Core context;
- reset a selected Core context;
- reset every Core context.

Session retention cleanup iterates over every binding, removes its acpx record and Provider-native history, and retains Run audit and token statistics. Permanent Session deletion also removes bindings and statistics.

## 8. Failure semantics

The first version has no silent automatic fallback:

- `core_unavailable`: the selected Core cannot start or connect;
- `model_unavailable`: the model disappeared or the Core rejected it;
- `core_capability_mismatch`: the Core lacks a required Agent capability;
- `session_resume_failed`: the target Core's Provider Session cannot be resumed safely.

Never switch Core after a Run has started or produced tool side effects. A later fallback feature may only run before `startTurn`, must be explicit, and must persist the original target, fallback target, and reason.

A Core referenced by an Agent route cannot be disabled directly. The operator first assigns replacement targets to affected Agents, then disables the Core.

## 9. Management API and console

Add:

- a Core page for enablement, adapter, health, model catalog, concurrency, and generation;
- an Agent Core tab for allowed Cores and Core-native plugin/Hook selection;
- Agent runtime routing with a default target plus weekday/multi-period rules that set Core, model, and concurrency together;
- a route preview showing the current UTC target, next switch, and conflicts;
- actual Core, model, rule, and policy revision on each Session Run;
- current, selected, or all-Core reset actions.

External Endpoint and Task APIs remain Agent-oriented. Callers may read the final resolved Core and model from Task/Run responses for audit.

## 10. Delivery stages

### Stage one: Core model and route snapshots

- add Core Profiles, Agent Core assignments, and the unified runtime policy;
- resolve Core, model, and concurrency once in the scheduler;
- persist the full route snapshot on the Run;
- temporarily allow each Agent to execute through only one Core to prove no behavior regression.

### Stage two: multi-Core Sessions

- add `session_core_bindings`;
- make acpx keys, Provider Homes, token usage, reset, and cleanup Core-aware;
- verify Core A -> Core B -> Core A resumes each independent Provider Session;
- keep only one live handle during switches.

### Stage three: context and capability projection

- add incremental handoff and cursors;
- project Skills, plugins, Hooks, and MCP for the target Core;
- add the capability matrix, model catalog cache, and save-time validation;
- complete the management UI and Run audit display.

The first version excludes online editing of arbitrary ACP commands, concurrent Cores inside one Session, mid-Run switching, automatic fallback, and model-generated handoff summaries.

## 11. Required acceptance scenarios

1. Switching models inside Codex does not create a new Provider Session.
2. Codex -> Claude -> Codex keeps two Provider Sessions and resumes the original Codex context.
3. Switching back supplies only Runs missed while that Core was inactive and never duplicates handoff.
4. A queued Run crossing a UTC boundary uses one consistent Core/model/concurrency resolution.
5. Policy edits do not affect active Runs; queued Runs use the latest policy at actual admission.
6. Only one Core/MCP process tree remains live after a switch, and idle release closes it completely.
7. Each Core binding resumes independently after a service restart.
8. Core token totals do not overwrite one another and the Session total remains correct.
9. Session storage cleanup removes every Core's native history while preserving statistics and Run audit.
10. Unavailable Cores, models, or capabilities fail explicitly without silently choosing another target.

## 12. Feasibility conclusion

acpx already provides the independent Session keys, distinct Agent commands, Provider Session resume, and dynamic model configuration needed by this design. No acpx patch is required; the main work belongs in Remote Agent Server's persistence and orchestration layers.

This feature is not safely implemented by adding `provider` to the existing model windows. The minimum complete delivery includes a unified route snapshot, per-Core Session bindings, incremental handoff, Core-aware capability projection, and multi-Core token/cleanup semantics.
