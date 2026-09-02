# Remote Agent Server: Product and Architecture

[简体中文](design.md)

## 1. Positioning

Remote Agent Server is a self-hosted ACP agent execution gateway for business applications. External systems submit asynchronous tasks over HTTP. The server runs command-line agents such as Claude Code and Codex in isolated workspaces, then returns progress and results through status queries, events, SSE, or signed Webhooks.

The project serves teams that need to embed coding agents in ticketing systems, CI/CD, operations consoles, internal developer platforms, and automation services. Callers do not need to implement ACP process management, project preparation, session recovery, MCP injection, or execution storage.

Providers remain responsible for reasoning, tools, and native sessions. Remote Agent Server owns:

- agent and provider configuration;
- prepared, versioned project environments;
- isolated session workspaces;
- ACP session creation, recovery, cancellation, and reset;
- Skills, provider extensions, and MCP projection;
- run, event, token-usage, and error records;
- external tasks, conversations, SSE, and Webhooks;
- process-local concurrency, queues, and retention.

The calling system owns business approvals, ticket state machines, code-review rules, and deployment workflows. It dispatches work through the Task API and updates its business state from public events.

## 2. Use cases

- Dispatch a defect investigation or code change from a ticketing or operations system.
- Start queryable, cancellable agent tasks from CI/CD after a build failure.
- Manage project environments, MCP, Skills, and concurrency for several coding agents.
- Receive final agent replies and tool lifecycle events through signed Webhooks.
- Create a session in the web console for direct, multi-turn development work.

## 3. Execution model

```text
External system
   |
   v
Integration endpoint (token / parameter mapping / idempotency)
   |
   v
Task -> Conversation -> Session -> Run -> acpx/ACP -> Provider
   |                         |                 |
   |                         |                 +-> Claude Code / Codex / Hermes
   |                         |
   |                         +-> Workspace / Skills / provider extensions / MCP
   |
   +-> task status / event history / SSE / signed Webhook
```

An HTTP submission creates a task and returns `202 Accepted`. The run queues and executes in the background, so the caller does not keep a connection open. Task status and event history are durable records. SSE supplies live increments, and Webhooks push notifications to another service.

The web console uses the same Session, Run, and Event model. Runs created in the console do not pass through an external endpoint and do not create business tasks.

## 4. Core objects

| Object | Responsibility |
| --- | --- |
| Project environment | Stores one or more Git repositories, preparation commands, and the current ready revision. |
| Project revision | A successful build published as the snapshot source for new session workspaces. |
| Agent | Binds a provider, project environment, instructions, Skills, provider extensions, MCP, model policy, and concurrency policy. |
| Session | Owns one isolated workspace and one resumable provider conversation. |
| Run | Records one input, execution state, result, and token usage inside a session. |
| Event | Appends messages, tools, statuses, and errors for a run, ordered by `seq`. |
| Integration endpoint | Authenticates an external caller, maps parameters, and binds requests to one agent. |
| Conversation | Uses a caller-supplied business key to reuse one session and serialize multiple tasks. |
| Task | Represents one asynchronous external request and eventually references one run. |
| Webhook subscription | Selects event types, signs requests, and records each delivery attempt. |

Public database IDs are numeric. Endpoint `slug` and caller-controlled `requestId` and `conversationKey` carry external business identity.

## 5. System structure

The service uses one Node.js process and one deployment unit:

- **Fastify API:** management routes, integration routes, event queries, and SSE.
- **React console:** agents, project environments, sessions, MCP, Skills, provider extensions, endpoints, and concurrency settings.
- **SQLite WAL:** configuration, queue state, execution records, tasks, Webhook deliveries, and token usage.
- **acpx/ACP Runtime:** drives Claude Code, Codex, and Hermes and normalizes provider events.
- **Workspace layer:** APFS clones on macOS and Btrfs snapshots on Linux.
- **In-process schedulers:** separate scheduling for runs, environment builds, and Webhook deliveries.

The main source boundaries are:

- `src/agents/`: agent configuration, duplication, and doctor checks.
- `src/project-environments/`: repository sync, dependency preparation, revision publication, and cleanup.
- `src/sessions/`: session creation, reset, deletion, and large-storage retention.
- `src/runs/`: queueing, concurrency, execution, cancellation, and event persistence.
- `src/runtime/`: acpx/ACP adapters, provider sessions, and configuration projection.
- `src/mcp/`, `src/skills/`, `src/provider-extensions/`: capability discovery, selection, and projection.
- `src/integrations/`: endpoints, conversations, tasks, public events, and Webhooks.

Business modules use acpx through the Runtime interface, keeping provider and ACP adapter changes inside `src/runtime/`.

## 6. Agent execution

### 6.1 Direct runs from the console

1. An operator selects an agent and creates a session.
2. The server pins the current project revision and creates a copy-on-write workspace.
3. A user message creates a queued run.
4. The run scheduler checks global, agent, and session concurrency constraints.
5. The server prepares the agent Provider Home, projects Skills, provider extensions, and MCP, and resolves the model policy against the current UTC time.
6. The runtime creates or resumes an ACP session. When needed, it updates the Core-advertised ACP `model` option before sending the input.
7. Normalized provider events are persisted and streamed to the console.
8. The server stores the result and token usage, then updates run and session state.

Runs inside one session are serial. Different sessions may run concurrently within the global and agent limits.

Selectable models come exclusively from the catalog advertised by Agent Core over ACP. When a Core does not advertise models, the agent can only use the Core's default behavior. A time policy does not change the Session lifecycle or create a new business Session for a model switch; the resolved model is stored on the Run.

### 6.2 Model discovery, policy, and audit

Model routing builds on the Agent Core's ACP configuration support instead of maintaining a separate global model registry:

1. `GET /api/agents/:id/models` starts a short-lived probe with the agent's current provider, instructions, and ready project environment. It reads `currentModel` and `availableModels` from ACP status, then closes the probe process.
2. The console only offers entries from `availableModels`. Before `PATCH /api/agents/:id` saves a policy, the server refreshes the catalog and rejects fixed or scheduled policies when the Core does not support model discovery or a selected model has disappeared.
3. A queued run does not reserve a model. The executor resolves the policy against the current UTC time only after it obtains a concurrency slot and marks the run as `running`.
4. The runtime creates or resumes the same ACP session and applies the resolved `model` option before sending the turn input. A switch does not create a new business Session, workspace, or Conversation.
5. An explicitly resolved model is stored as the run's `resolvedModel` for the Session page, management API, and Integration Task audit trail. The field is `null` when selection is fully delegated to a Core that does not advertise its default.

An agent accepts three `modelPolicy` shapes:

```json
{ "mode": "provider_default" }

{ "mode": "fixed", "model": "core-advertised-model-id" }

{
  "mode": "schedule",
  "defaultModel": "model-used-outside-windows",
  "windows": [
    {
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "start": "08:00",
      "end": "20:00",
      "model": "model-a"
    },
    {
      "days": ["sat", "sun"],
      "start": "08:00",
      "end": "20:00",
      "model": "model-b"
    }
  ]
}
```

`days` is required and uses `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, and `sun`. Each rule must select at least one unique day. The API accepts explicit 24-hour UTC `HH:mm` values from `00:00` through `23:59`, and a window's end must be later than its start. A window includes its start and excludes its end. `defaultModel` applies unless both weekday and time match. If windows overlap, the first matching window in configuration order wins. A policy can contain at most 16 windows.

An active run keeps the model resolved at startup and ignores policy edits made mid-turn. A queued run uses the latest agent policy and UTC time when it actually starts. This prevents queue delay from selecting a scheduled model too early and preserves multi-turn context inside one Session.

### 6.3 External tasks

1. The caller submits a `requestId`, optional `conversationKey`, message, and declared parameters with an endpoint token.
2. The server performs endpoint-scoped idempotency checks.
3. An existing conversation reuses its session; the first request creates one.
4. The task queues and returns its ID. The integration scheduler creates a run afterward.
5. Run events are projected into public integration events. Raw tool arguments and provider-private fields stay internal.
6. The caller consumes progress and results through task queries, event queries, SSE, or Webhooks.
7. Ending a conversation preserves its history. A later task with the same key creates a new session.

Tasks sharing one conversation run serially, protecting the shared workspace and provider context from concurrent modification.

## 7. Project environments and workspaces

Project environments move repository checkout and dependency preparation out of individual agent runs:

1. The builder synchronizes one or more repositories.
2. It runs preparation commands when dependency inputs change. An unchanged dependency fingerprint updates source only.
3. A revision becomes current after every repository succeeds.
4. A new session receives an APFS clone or Btrfs snapshot of that revision.

Session creation does not repeat cloning, `git clean`, or dependency installation. The writable session workspace cannot modify its project environment. A failed environment sync leaves the previous ready revision active.

Python projects using `uv` receive a relocatable virtual environment. The server requires uv `>= 0.10.8` and prepares a relocatable `.venv` when the project contains `uv.lock`.

Session retention removes large workspace, browser, and native provider-session data. Session, Run, Event, integration links, and token statistics remain available.

## 8. Agent capability projection

Each agent has an independent Provider Home. The service discovers reusable capabilities from the service user's provider configuration, then requires an explicit agent selection:

```text
System provider configuration -> discover -> select for agent -> project on next run
```

- **Skills:** discover host Skills or upload ZIP archives, then enable them per agent.
- **Provider extensions:** discover Codex and Claude Code plugins and hooks, then project selected entries.
- **MCP:** manage HTTP and stdio servers, saved values, session parameters, runtime values, secrets, and tool filters.

Provider history, logs, and caches are excluded from the agent Provider Home. `DATA_DIR/secret.key` encrypts sensitive values, and management APIs do not return plaintext secrets.

Configuration changes take effect on the next run. Existing sessions refresh their runtime connection and keep the provider session when the provider supports resumption.

## 9. Reliability and concurrency

- Global run, per-agent run, Webhook-delivery, and project-build concurrency are configurable at runtime.
- Sessions and conversations serialize their work.
- Each Webhook subscription delivers events in order.
- Duplicate sync requests for one project environment are coalesced.
- Events are persisted before clients query them; `seq` supports gap recovery.
- Disconnecting SSE does not cancel a run.
- Webhooks use at-least-once delivery, so receivers deduplicate by stable `eventId`.
- Queued work resumes after a service restart. Interrupted runs fail without replaying their input.
- A failed provider-session recovery keeps the workspace and history until an operator rebuilds the executor session.

Concurrency limits belong to one process. Multiple instances do not share quotas and must not operate on the same SQLite database or workspace roots.

## 10. Security boundary

Management routes use one global `API_TOKEN`. Every integration endpoint has a separate token whose hash is stored by the server. Each Webhook subscription has a separate HMAC-SHA256 signing secret.

Agents run with the operating-system permissions of the service user. They can execute commands, modify their workspace, call MCP tools, and reach files and networks available to that user. `approve-all` is a provider interaction policy and provides no sandbox boundary. Production deployments use a dedicated unprivileged user, trusted repositories and MCP servers, plus a trusted network or TLS reverse proxy.

## 11. Deployment boundary

The current release targets a self-hosted, single-machine, single-process deployment:

- macOS uses a logged-in user, APFS, and LaunchAgent;
- Linux uses a dedicated service user, Btrfs, and systemd;
- SQLite, the encryption key, project environments, and session roots require persistent storage;
- headed browsers require a real desktop or X display.

See the [deployment and acceptance guide](deployment.md) for commands, filesystem preflight checks, provider authentication, and smoke tests.

## 12. Current scope

Remote Agent Server focuses on the single-machine execution gateway. The calling system or another service owns:

- business workflows, ticket state machines, and approval rules;
- multi-host scheduling and distributed quotas;
- strong isolation for untrusted tenants;
- agent reasoning frameworks, model routing, and custom tool loops;
- Git-host business rules and deployment orchestration.

This boundary gives external systems a stable API for existing coding agents while preserving their own business model.
