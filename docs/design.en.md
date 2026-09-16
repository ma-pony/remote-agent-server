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

The current implementation fixes one Agent Core and selects models only within that Core. The future architecture for switching Core, model, and concurrency by time is recorded in the [Agent Core and model runtime routing proposal](agent-core-routing.en.md). The proposal is not implemented and does not describe current API behavior.

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
      "model": "model-a",
      "maxConcurrentRuns": 4
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

`days` is required and uses `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, and `sun`. Each window must select at least one unique day. The API accepts 24-hour UTC `HH:mm` values from `00:00` through `23:59`, and the start and end must differ. A window includes its start and excludes its end. An end earlier than its start crosses into the next UTC day, with `days` identifying the start weekday. The same model may appear in multiple windows. `maxConcurrentRuns` may be omitted or `null` to inherit the Agent's normal limit, or set from 1–64 to override that limit for the window; the system-wide limit always remains authoritative. `defaultModel` and the normal Agent concurrency apply unless both weekday and time match, and the first matching window in configuration order wins when windows overlap. A policy can contain at most 16 windows.

The console groups adjacent windows with identical `days`, `model`, and `maxConcurrentRuns` into one editor. Weekdays, model, and concurrency are set once, while the group can contain multiple start/end pairs. Saving expands the group back into the `windows` contract above, so the presentation model does not change runtime resolution or the external API.

An active run keeps the model and concurrency slot resolved at startup and ignores policy edits made mid-turn. A queued run uses the latest Agent policy and UTC time when it actually starts. The scheduler re-evaluates the queue at the next UTC minute boundary: a higher limit starts more queued runs, while a lower limit never cancels active runs. This prevents queue delay from selecting a scheduled model too early and preserves multi-turn context inside one Session.

### 6.3 External tasks

1. The caller submits a `requestId`, optional `conversationKey`, message, and declared parameters with an endpoint token.
2. The server performs endpoint-scoped idempotency checks.
3. An existing conversation reuses its session; the first request creates one.
4. The task queues and returns its ID. The integration scheduler creates a run afterward.
5. Run events are projected into public integration events. Raw tool arguments and provider-private fields stay internal.
6. The caller consumes progress and results through task queries, event queries, SSE, or Webhooks.
7. Ending a conversation preserves its history. A later task with the same key creates a new session.

Tasks sharing one conversation run serially, protecting the shared workspace and provider context from concurrent modification.

The Webhook delivery list builds its `latest` summary from the current endpoint's subscriptions. A covering index on `webhook_deliveries(subscription_id, created_at DESC, id DESC)` locates one delivery per subscription before a primary-key lookup loads its details. Subscriptions without deliveries are omitted; history filters and pagination do not affect the summary. This avoids a correlated lookup and sort for every historical delivery, which can block the event loop through synchronous SQLite execution. Startup migration creates the index idempotently for both new and existing databases.

### 6.4 Native webhook admission

`WebhookIngress` is the shared GitHub and GitLab receiver. The public `/integration/v1/endpoints/:slug/webhook` route preserves raw request bytes in an isolated Fastify scope, accepting JSON and GitHub form `payload` bodies without changing JSON parsing elsewhere. `integration_webhook_receivers` stores one configuration per endpoint, encrypts its secret through SecretStore, and cascades deletion when its endpoint is deleted.

Admission proceeds through endpoint/provider lookup, GitHub raw-body HMAC-SHA256 or GitLab signature/token verification, enabled-state checks, event/delivery-ID/JSON-object validation, deduplication and durable filter evaluation, matching-event parameter extraction, and `IntegrationCoordinator.submit`. GitHub `ping` is acknowledged without a task. Business events use the provider-prefixed delivery ID as `requestId` and the event type plus native payload as their message. They reuse the existing transactional persistence, idempotency locks, Session creation, queue, event projection, and restart recovery. The receiver adds no separate task queue; `202` means the Task is durable.

Each matching new delivery creates an independent Task/Session without inferring PR/MR conversations. Repeated IDs with identical input reuse the original Task; different input returns an idempotency conflict. GitLab checks `webhook-id`, `Idempotency-Key`, and `X-Gitlab-Webhook-UUID` in that order. Parameter mappings read only the payload's own properties through dot-separated paths and convert scalar values to strings. The existing Endpoint Manager still validates required parameters.

GitLab `authMode: signature` validates a Signing token with the `whsec_` prefix: decode the Base64 key, calculate HMAC-SHA256 over `webhook-id.webhook-timestamp.rawBody`, compare the candidate signatures in `webhook-signature` in constant time, and enforce a five-minute timestamp tolerance. This mode cannot fall back to plain-token authentication; `authMode: token` explicitly selects `X-Gitlab-Token`. Secret contents never select authentication policy.

Management responses expose the provider, authentication mode, enabled state, `secretConfigured`, `filter`, and `filterVersion`. Updates omitting the secret retain its ciphertext; switching provider or authentication mode requires a new secret. Disabling a receiver affects subsequent incoming requests; accepted tasks remain owned by the existing scheduler. Native payloads become Task user input and follow the existing user-message event contract. Authentication headers and the receiver secret never enter messages or public events.

Receiver `filter_json` and `filter_version` hold the policy; startup migration leaves existing receivers unfiltered. `webhook-filter.ts` provides shared bounded validation and a pure evaluator for `all/any`, scalar comparisons, existence, and array membership. Missing fields and type mismatches fail negative comparisons. Paths access only event/payload own properties, with at most one array wildcard. Adapters provide field suggestions and review presets; the UI has no provider-specific rule logic. Preview and admission share the evaluator.

`integration_webhook_receipts` records one decision per `(endpoint_id, provider, delivery_id)`, including event type, message SHA-256, rule version, and timestamp, without another payload or secret copy. Authentication, enabled-state, or parsing failures create no receipt. Fingerprint conflicts return 409; ignored decisions return 200; durable Tasks return 202. Versions increment only on policy/provider changes, which affect only new deliveries.

Decisions are stored before Session I/O; ignored events stop there. Admitted events use the existing Coordinator, with same-process duplicate requests sharing an admission Promise. The existing deterministic `requestId` makes this two-phase flow recoverable: after a crash before Task creation, a platform retry keeps the stored decision and retries admission; after Task commit, a retry returns that Task without resolving parameters again or starting another run. Receipts join Tasks through this key without another write transaction. Failed admission preserves its accepted decision and appears as awaiting platform retry; there is no new background ingress retry queue. Pre-upgrade native Tasks retain their original admission.

Receipt metadata cascades on endpoint deletion and survives Session storage cleanup. The latest-30 management query omits fingerprints, payloads, comparison values, and credentials. Preview requires management authentication and returns condition paths, matches, and missing/type/value mismatch reasons without side effects. Delivery deduplication does not implement MR revision or comment deduplication; those remain review-workflow concerns.

### 6.5 Webhook extension boundaries

- Routes own HTTP transport, original bytes, management authentication, input validation, and error mapping.
- `WebhookAdapter` implementations in `webhook-adapters/` own the source protocol: supported authentication modes, secret validation, request authentication, and normalization into event type, delivery ID, and payload. Connection tests may return an ignore reason. Adapters never access the database, create Sessions, or start Agents.
- `webhook-filter.ts` defines the shared frontend/backend contract and pure evaluator. `all/any` combine scalar comparisons, presence checks, and array containment/exclusion. Missing fields and type mismatches fail closed. `not_contains` requires every array element to be present and of the same scalar type as the comparison value; empty arrays match, while missing projected fields or incompatible values do not. Preview and ingress use the same evaluator.
- `WebhookIngress` owns receiver configuration, declared parameter extraction, and submission to the existing Coordinator. Existing components retain transactional Task admission, idempotency, Sessions, concurrency, cancellation, and recovery.

To add a source, implement an adapter, register it with its source type, and add native-request tests. The management catalog is generated from the static registry, and frontend/backend share receiver configuration types. Provider and authentication columns store strings whose supported values are validated by adapters, so adding a source needs neither another business table nor Task scheduling changes. Runtime plugin loading, user scripts, and a generic workflow engine are outside this boundary.

## 7. Project environments and workspaces

Project environments move repository checkout and dependency preparation out of individual agent runs:

1. The builder synchronizes one or more repositories.
2. It runs preparation commands when dependency inputs change. An unchanged dependency fingerprint updates source only.
3. A revision becomes current after every repository succeeds.
4. A new session receives an APFS clone or Btrfs snapshot of that revision.

Session creation does not repeat cloning, `git clean`, or dependency installation. The writable session workspace cannot modify its project environment. A failed environment sync leaves the previous ready revision active.

Python projects using `uv` receive a relocatable virtual environment. The server requires uv `>= 0.10.8` and prepares a relocatable `.venv` when the project contains `uv.lock`.

Session retention removes large workspace, browser, and native provider-session data, plus all Webhook delivery records linked through its Tasks. Delivery deletion and the `storage_cleaned_at` update share the terminal transaction, rolling back on failure and recovering idempotently after restart. Removed deliveries stop retrying; late delivery results do not recreate them, and explicit projection repair skips cleaned Sessions. Startup recovery can still reconcile Task state and public events without creating deliveries for cleaned Sessions. Session, Run, Event, Task/Conversation links, public events, and token statistics remain available. Test deliveries without a Task are unaffected, and context reset preserves delivery records.

Cleanup eligibility uses an idle Session's `updated_at` and excludes Sessions with queued or running Runs. After listing candidates, the cleanup claim rechecks the cutoff in the same transaction so activity while earlier directories are being removed is respected. Restart recovery updates activity timestamps only for Sessions with interrupted running Runs. Restarting does not extend retention for already idle or cleaned Sessions. Run terminal states, error events, and Session recovery are committed in one transaction; repeating recovery does not refresh activity timestamps again.

A nullable internal `pending_operation` field records `cleanup`, `delete`, or `reset`. The marker and the `running` claim are committed before external work; an in-process guard also rejects concurrent maintenance on one Session. Normal completion and restart recovery share transactional finalization that checks operation ownership, busy state, and absence of active Runs before clearing the marker or deleting records. Generic Run recovery does not release marked Sessions.

Startup retries incomplete-creation cleanup, recovers maintenance, then recovers and schedules Runs. Unfinished cleanup and deletion retain their marker and busy state. Later cleanup passes retry admitted storage cleanup even after retention changes or automatic cleanup is disabled; the delete API can retry a pending deletion. Both failed-creation compensation and startup recovery remove pending Session records only after directory deletion succeeds. Reset recovery removes the old local Provider/ACP conversation and clears current-context cumulative usage while preserving the Workspace and Run history. The next Run creates a new Provider context.

## 8. Agent capability projection

Each agent has an independent Provider Home. The service discovers reusable capabilities from the service user's provider configuration, then requires an explicit agent selection:

```text
System provider configuration -> discover -> select for agent -> project on next run
```

- **Skills:** discover host Skills, upload ZIPs, or refresh Git/marketplace sources, then select content revisions per agent.
- **Provider extensions:** discover Codex and Claude Code plugins and hooks, then project selected entries.
- **MCP:** manage HTTP and stdio servers, saved values, session parameters, runtime values, secrets, and tool filters.

Provider Home initialization excludes host conversation history, logs, and caches. When upgrading a legacy business conversation, Hermes migrates only the target conversation and its parent lineage, as described below. `DATA_DIR/secret.key` encrypts sensitive configuration saved through management APIs, which do not return plaintext secrets; native Provider authentication files retain their own format.

Configuration changes take effect on the next run. Existing sessions refresh their runtime connection and keep the provider session when the provider supports resumption.

Git source identity derives from the configured URL, ref, and subdirectory; Skill identity additionally includes plugin identity and package-relative path. Source operations are serialized in the process and use bounded, cancellable Git commands with process-tree cleanup. Paths, file types, and content size are validated before atomically replacing the catalog. Failed refreshes preserve the last usable versions. The catalog repository and referenced plugin repositories retain actual commits separately; external plugins without a ref follow their own HEAD.

Claude marketplace entries use strict mode by default: plugin-manifest and marketplace-entry Skill declarations are merged with the default `skills/` scan. When an entry targets the marketplace root and explicitly selects subpaths, only those paths are imported. A `strict: false` conflict with the plugin's own Skill declaration produces a warning and preserves that plugin's previous catalog. Codex plugins use explicit paths when declared and default directories otherwise. Ordinary repositories are scanned recursively; unsupported source types produce warnings.

Complete packages are limited to 50 MiB, 10,000 directory entries, and 32 levels of depth; internal symbolic links and special files are not distributed. Source manifests are limited to 1 MiB and marketplaces to 1,000 plugin entries. Text previews are limited to 8 KiB per file and 64 KiB in total; larger content still exposes file change status and permissions.

`DATA_DIR/skill-sources/` stores the source index and immutable complete package snapshots; `skill-revisions/` retains selected content versions. Each agent's `skills/<id>/` is a private package copy containing its revision record and Skill-relative path. Legacy direct directories remain readable. Updates retain the old revision and swap the installation using staging and backup directories; startup recovers interrupted swaps. Digests include file paths, contents, and executable permissions. Text diffs are bounded while binary and large files still expose change status. Applying requires a matching `expectedRevision` and an unmodified installation, preventing stale pages from overwriting newer choices.

Complete packages are copied into Session-owned directories before execution. Managed entries for nested Skills link to their corresponding package projection, preserving relative references to sibling resources. Runtime fingerprints use projected contents and are recorded in `runs.skills_revision`. Codex/Claude use Workspace directories; Hermes uses `agents/<id>/provider-home/hermes/sessions/<sessionId>/skills` so concurrent Sessions cannot overwrite each other. An atomic completion marker makes first-time Hermes initialization retryable. Migration retains the resumed conversation and parent lineage from a consistent backup of the old shared `state.db`; missing state fails resumption explicitly. Cleanup removes only the target Session Home and matching legacy conversation records.

| Management endpoint (prefix `/api`) | Behavior |
| --- | --- |
| `GET/POST /skill-sources` | List sources; add and perform initial refresh |
| `POST /skill-sources/:id/refresh` | Discover versions without changing agents |
| `DELETE /skill-sources/:id` | Remove discovery while preserving installations and history |
| `GET /agents/:id/skills/:skillId/revisions` | Current/latest revisions and history |
| `GET /agents/:id/skills/:skillId/diff?revision=<sha256>` | Compare against installed contents |
| `POST /agents/:id/skills/:skillId/revision` | Explicitly apply or roll back using `{revision, expectedRevision}` |
| `POST /agents/:id/skills/:skillId/upload` | Publish a same-name version using the existing ZIP payload without applying it |

Checking and applying are separate operations. Source deletion, failed refreshes, and unchanged content do not alter active projections. This phase does not include automatic updates, repository write-back, package-manager installation, or revision garbage collection.

`skillsRevision` identifies the contents projected for a Run; it does not prove the model read or executed a Skill successfully. Some observed upstream model errors arrive as ordinary output while the Runtime reports `completed`. This error-status propagation issue remains unresolved, so business acceptance must verify the actual reply or artifact. The [acceptance report](superpowers/validation/2026-09-14-skill-source-updates.md) distinguishes passing checks from Provider environment blockers.

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

Management routes use one global `API_TOKEN`. The general Task API uses a separate endpoint token whose hash is stored by the server. Native webhook receivers use independently encrypted per-endpoint secrets for GitHub HMAC-SHA256 or GitLab Signing token / legacy `X-Gitlab-Token` verification. Outgoing webhook subscriptions each have a separate HMAC-SHA256 signing secret.

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

## Message attachments

Messages retain their existing text field and may include structured `attachments`. Shared boundary validation limits counts, decoded sizes, canonical base64, filenames, and MIME types, and checks PNG/JPEG/GIF/WebP headers. Only message submission routes receive a larger JSON body limit.

`message_attachments` separates BLOB payloads from history metadata and references the owning Session and Task/Run. Task admission inserts attachments in the same transaction. Dispatch binds attachments while creating the Run and linking the Task, without duplicate payloads on retry. Lists and history query only metadata; execution and authenticated downloads load bytes. Attachment digests participate in request fingerprints; requests without attachments retain their original fingerprint.

After a Run starts, it creates a fresh exclusive random directory in the Session workspace and writes files using attachment IDs plus filenames, without reusing existing paths or overwriting files. The runtime prompt includes JSON file references; supported images also become native acpx image attachments. Original user text does not contain internal paths. Files remain available in later turns until Session cleanup or deletion. Failed or aborted preparation removes its incomplete directory.

Session cleanup clears attachment BLOBs within the existing maintenance transaction while retaining metadata; workspace files use the established cleanup flow. Context reset retains attachments. Session deletion cascades attachment records. Downloads require management authentication and force attachment disposition, no caching, and no MIME sniffing. The frontend previews only supported raster images through Blob URLs. Public event projection does not add attachment bytes or internal paths.

The JSON message envelope excluding `attachments` remains limited to 1 MiB, including text and parameters.
