# Remote Agent Server

[简体中文](README.md)

Remote Agent Server is a self-hosted ACP agent execution gateway for business applications. Callers submit asynchronous tasks over HTTP. The server runs command-line agents such as Claude Code and Codex in isolated workspaces, then returns progress and results through status queries, events, SSE, or signed Webhooks.

It turns existing agent CLIs into a durable backend for ticketing systems, CI/CD, internal platforms, and automation services. Operators use the web console to configure agents, project environments, Skills, provider extensions, MCP, model policies, concurrency, and integration endpoints. External callers need only an endpoint token and the stable Task API.

The execution layer uses [acpx](https://github.com/openclaw/acpx) and the [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol). The current provider adapters support Claude Code, Codex, and Hermes.

Each provider remains responsible for reasoning, tool use, and its native session. Remote Agent Server owns the execution lifecycle, workspace isolation, configuration projection, durable events, and external delivery. Business approvals, ticket state machines, and deployment rules stay in the calling system.

## Use cases

- Ticketing, issue, or operations platforms that dispatch work to an agent and consume the result asynchronously.
- CI/CD and internal automation that need queryable, cancellable, auditable long-running tasks.
- Teams that want to reuse existing Claude Code or Codex authentication while managing project environments, MCP, and Skills centrally.
- Self-hosted deployments that need control over source code, credentials, execution records, and workspaces.

## Features

- **Asynchronous Task API:** submit work over HTTP, prevent duplicate execution with idempotency keys, query or cancel tasks, and continue multi-turn conversations.
- **Reliable event delivery:** consume incremental event history, resumable SSE, or signed Webhooks without tying task execution to a live connection.
- **Agent management:** configure providers, instructions, project environments, Skills, and MCP in one place.
- **Reusable project environments:** prepare one or more Git repositories and their dependencies before sessions start.
- **Isolated workspaces:** use APFS clones on macOS or Btrfs snapshots on Linux to create copy-on-write session environments.
- **Multi-turn conversations:** execute multiple runs in one session and resume the ACP session where supported.
- **Recorded executions:** persist user messages, agent output, tool activity, statuses, errors, and results in SQLite.
- **Skill management:** discover host Skills, upload ZIPs or add Git/marketplace sources, preview changes, and update or roll back each agent independently.
- **Provider extensions:** discover system plugins and hooks from Codex and Claude Code, select them per agent, and project them into that agent's Provider Home at runtime.
- **MCP management:** configure HTTP and stdio MCP with fixed, session, or runtime values, import MCP from provider system configuration, and inspect exposed tools.
- **Model policies:** discover models advertised by Agent Core over ACP, follow the Core default, pin one model, or select a model for each new run with UTC weekdays and 24-hour windows.
- **Runtime, storage, and concurrency control:** adjust run timeout, large idle-session storage retention, and three service concurrency limits from the console, with an optional run limit per agent.
- **Headed browser support:** run agents in a real desktop session without requiring containers.

## Execution model

The external integration API is the primary service interface:

```text
External system
   |
   v
Integration endpoint (auth / parameter mapping / idempotency)
   |
   v
Task -> Conversation -> Session -> isolated Workspace -> acpx/ACP -> Provider
   |                         |
   |                         +-> Skills / provider extensions / MCP / model policy
   |
   +-> status / event history / SSE / signed Webhook
```

Operators can also create Sessions and Runs directly from the web console:

```text
Project environment -> Agent -> Session -> Run -> acpx/ACP -> Provider
                               |
                               +-> messages, tool activity, status, result
```

| Object | Purpose |
| --- | --- |
| Project environment | A versioned, prepared set of one or more Git repositories. |
| Agent | A provider, project environment, instructions, Skills, provider extensions, MCP, model policy, and concurrency policy. |
| Session | An isolated workspace and a continuing agent conversation. |
| Run | One input and its recorded execution inside a session. |
| Integration endpoint | An authenticated external entry point bound to one agent. |
| Conversation | A multi-turn external conversation that reuses one session. |
| Task | One asynchronous external request that eventually maps to a run. |

## Requirements

- Node.js 22 (the tested version is pinned in `.nvmrc`)
- pnpm 10 through Corepack
- Git
- At least one installed and authenticated provider CLI
- APFS on macOS, or Btrfs that the service user can operate on Linux
- `btrfs-progs` on Linux, with the service user able to run `btrfs subvolume create/snapshot/delete`
- A real desktop/X display for headed browser automation

Project environments and session workspaces use APFS clones or Btrfs snapshots. There is no ordinary directory-copy fallback. Prepare the filesystem with the [deployment guide](docs/deployment.md) on a new host.

## Install and start

```bash
git clone https://github.com/ma-pony/remote-agent-server.git
cd remote-agent-server

nvm use
corepack enable
pnpm install --frozen-lockfile

cp .env.example .env
chmod 0600 .env
openssl rand -hex 32
```

Put the generated value in `.env` as `API_TOKEN`, then replace the storage paths with absolute paths for the host. The application does not load `.env` itself, so source it before starting:

```bash
set -a
source ./.env
set +a
```

On Linux, prepare Btrfs with the [deployment guide](docs/deployment.md#linuxbtrfs-原生部署) first. After the roots exist, run the same preflight checks used by the service:

```bash
command -v btrfs
btrfs filesystem show "$PROJECT_ENVIRONMENTS_ROOT"
btrfs filesystem show "$SESSIONS_ROOT"
test "$(stat -c %d "$PROJECT_ENVIRONMENTS_ROOT")" = \
     "$(stat -c %d "$SESSIONS_ROOT")"
```

Do not start after a failed preflight. A non-Btrfs host must be prepared first; the service does not fall back to ordinary directory copies. `WorkspaceCheckError` normally means the `btrfs` command is missing, a root is not on accessible Btrfs storage, or the two roots are on different filesystems.

Start the service:

```bash
pnpm start
```

`pnpm start` builds both the server and web console before starting in production mode. If the compiled Node entrypoint is invoked directly with an incomplete web build, the process exits with a clear error instead of starting an API-only service whose UI can only render blank.

Check the server:

```bash
curl --fail http://127.0.0.1:3000/api/health
```

Open `http://127.0.0.1:3000` and enter `API_TOKEN`. The web interface keeps it only in the current browser session.

### Local development

After loading `.env`, run:

```bash
pnpm dev
```

This starts the watched API server and Vite development server together. The API uses `PORT` from `.env`; Vite defaults to `http://127.0.0.1:5173` and proxies `/api` and `/integration` to that API port. Frontend edits use hot module replacement without rebuilding or restarting the API.

## Complete one agent run

### 1. Prepare a provider

Install and authenticate the provider CLI as the same operating-system user that runs the server. Follow the provider's official instructions:

- [Claude Code](https://code.claude.com/docs/en/getting-started)
- [Codex CLI](https://developers.openai.com/codex/cli)
- [Hermes Agent](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart/)

```bash
claude auth login
codex login
claude auth status
codex login status
claude --version
codex --version
hermes --version
```

Authenticate and configure models only for the providers you intend to use, under the operating-system user that runs the service.

At startup, the server reads the login-shell PATH and merges it with the current Node directory and process PATH. Each agent has its own Provider Home. The server prepares baseline configuration, authentication, and model information from the service user's Provider Home while excluding session history, logs, and temporary runtime data. System plugins, hooks, and global MCP from Codex and Claude Code are optional configuration sources; agents never inherit them implicitly.

### 2. Create a project environment

Open **Project environments → New project environment**:

1. Add one or more Git repositories the agent may need.
2. Add an optional preparation command per repository, such as `pnpm install`, `bundle install`, or `uv sync`.
3. Select **Sync now**.
4. Wait for the current revision to become **Ready**.

A sync builds a new revision in persistent storage and publishes it only after every repository and preparation command succeeds. The server checks remotes every three hours, and an operator can sync at any time. Existing sessions keep their revision; new sessions use the latest ready revision. A session directly uses an APFS clone or Btrfs snapshot of that revision without rerunning cleanup or preparation. Legacy sessions still perform one compatibility repair before their next run.

When a project contains `uv.lock`, the server runs `uv venv --relocatable .venv` before the configured preparation command. The project's existing `uv sync` or Make command then reuses that relocatable environment. The server must have uv `>= 0.10.8`; resync the project environment after upgrading because existing `.venv` directories are not converted. During synchronization, the server compares `uv.lock`, `pyproject.toml`, and `.python-version`: unchanged dependencies update source only, while dependency changes clean and prepare that project again. Only the current project-environment Workspace is retained; Sessions use their own Btrfs snapshots and do not depend on an old project-environment Workspace.

### 3. Create an agent

Open **Agents → New agent**:

1. Select a provider such as Claude Code or Codex.
2. Select the ready project environment.
3. Enter the agent role, coding rules, and delivery requirements.
4. Save it and run **Doctor** to verify the provider and project environment.

The agent page also provides:

- **Skills:** discover host Skills, upload a ZIP archive, and enable only the Skills this agent should receive.
- **Provider extensions:** review plugins and hooks discovered in the current provider's system configuration and enable the ones this agent needs.
- **MCP:** add HTTP or stdio servers, check connectivity, inspect their tools, or import a system-global MCP from Codex or Claude Code.
- **Run concurrency policy:** inherit the system run limit by default, or set an Agent-specific cap. The smaller limit is effective.
- **Model policy:** model choices come from the current Agent Core; arbitrary model IDs cannot be entered. Follow the Core default, pin one model, or switch by UTC weekday and 24-hour window. The latter two modes are unavailable when the Core does not advertise models.

The model policy is resolved when a run leaves the queue and actually starts, so queue delay cannot select a model too early. A switch reuses the same Session and provider conversation and updates only the ACP `model` option. It never interrupts an active run; the next run receives the new model. Fixed and scheduled policies record the resolved model on every run for auditability.

#### Model policy quick reference

Open **Agents → target agent → Settings → Model policy**:

| Mode | Behavior | Typical use |
| --- | --- | --- |
| Follow Agent Core default | Uses the default model currently advertised by the Core. | Let Codex, Claude Code, or another Core own model selection. |
| Fixed model | Selects one model for every new run. | Keep one agent on a predictable model. |
| Switch by UTC rule | Uses a rule's model when both its weekday and time window match, and a fallback otherwise. | Use different models on weekdays and weekends, or switch for availability, cost, and throughput policies. |

The console organizes schedules into rule groups. Each group shares one or more UTC weekdays, a model, and an optional run-concurrency limit across multiple 24-hour `HH:mm` windows—for example, weekday windows at `08:00–10:00` and `14:00–18:00` using the same model and concurrency. A start is inclusive and an end is exclusive. An end earlier than its start crosses into the next UTC day, with the selected weekday representing the start day. Earlier rule groups win when they overlap. An empty concurrency limit inherits the Agent's normal policy; a value overrides the Agent limit but remains capped by the system-wide limit. The console provides Weekdays, Weekend, and Every day presets. The fallback model and normal concurrency apply whenever no window matches. The server refreshes the Core catalog when the policy is saved and rejects models that are no longer advertised.

A policy change affects only runs that start afterward. An active run does not switch, while a queued run resolves the policy against the UTC time at which it obtains an execution slot. The Session, workspace, and provider conversation remain in place. When the server resolves an explicit model, the Session page shows it and management API run responses expose it as `resolvedModel`. This field is `null` when the policy fully delegates to a Core that does not advertise its default. See [Product and architecture: Model discovery, policy, and audit](docs/design.en.md#62-model-discovery-policy-and-audit) for the API shapes and resolution flow.

Changes to Skills, provider extensions, and MCP apply on the next run. When an existing session detects a configuration change, it refreshes the provider connection. If the provider supports resumption, the original Provider Session and conversation context continue.

Manage shared Git sources from an agent's **Skills** page. Enter a GitHub, GitLab, or other Git HTTPS/SSH URL, with an optional branch, tag, commit SHA, and repository subdirectory. Supported catalogs include ordinary Skill repositories, Claude's `.claude-plugin/marketplace.json`, Codex's `.agents/plugins/marketplace.json`, and Skills declared in `plugin.json`, `.codex-plugin/plugin.json`, or `.claude-plugin/plugin.json`. Local marketplace directories and Git plugin sources resolve to complete package snapshots. Unsupported entries are reported. Importing supplies Skills only; it does not execute plugin hooks, MCP servers, or dependency installation commands.

Refreshing a source only discovers versions. Enabled agents retain their selections until you preview changed files and explicitly apply a revision to the current agent. Historical revisions can be selected for rollback. Uploading a same-name replacement ZIP publishes a version which must also be applied explicitly. Digests cover complete package file contents and executable permissions, including scripts and references. Enabling an already enabled Skill is idempotent, and local edits block overwrites. Removing a Git source preserves installed copies and revision history; agents remain independent.

Each Run uses its Session's projection, preserving the contents of active Runs. The Run management API records the projected digest as `skillsRevision`; pre-upgrade Runs have `null`. Source and version endpoints use the existing management API Token. See [capability projection](docs/design.en.md#8-agent-capability-projection).

The [2026-09-14 acceptance report](docs/superpowers/validation/2026-09-14-skill-source-updates.md) verifies real Git source imports and Codex `gpt-5.5` reads, updates, rollbacks, and session continuity. The GitLab smoke covers repository transport. Real Claude Code and Hermes execution remains unverified because upstream model permissions and channel availability blocked those runs.

Known runtime limitation: some Providers return upstream model errors as ordinary output while reporting completion. Acceptance must inspect the actual reply and expected artifacts, not only Run status. This error-status propagation issue remains unresolved; see [deployment troubleshooting](docs/deployment.md#provider-验收与已知限制).

Provider extensions follow a discover, select, and runtime projection flow. After a plugin or hook is added to the service user's Codex or Claude Code configuration, it appears on the agent's **Provider extensions** page and remains disabled by default. Enabled items are projected only to that agent. Hermes does not currently support this extension-management flow.

Provider-global MCP uses a separate import flow. Selecting **Import and enable** on the agent's **MCP** page copies the current system configuration into an MCP owned by that agent. The imported configuration can then be edited, checked, restricted to selected tools, or deleted without changing the provider's system configuration. MCP values may come from saved values, declared session parameters, or runtime values such as `agent_id`, `session_id`, `run_id`, `workspace_path`, and `browser_profile_path`. Secrets are encrypted and are never returned in plaintext by management APIs.

### Runtime and concurrency

Open **System settings → Runtime and concurrency** to adjust:

- the hard timeout for one run;
- large idle-Session storage retention;
- global run concurrency;
- Webhook delivery concurrency;
- project-environment build concurrency.

The database stores these settings. Run timeout applies to newly started runs, storage retention applies at the next cleanup, and concurrency changes affect later scheduling immediately. Raising a limit dispatches queued work; lowering one does not cancel active work. The service always keeps runs in one Session serial, reuses one Session for one external Conversation, delivers each Webhook subscription in order, and coalesces duplicate synchronization requests for the same project environment.

The service runs storage cleanup once at startup and then every ten minutes. Retention is measured from the Session's last activity; restarting the service does not restart the retention period for already idle Sessions. Expired idle Sessions lose their Workspace, browser data, provider-native conversation, and Webhook delivery records for all their Tasks, including pending, delivering, and completed deliveries. Removed deliveries are no longer retried. Session, Run, event, Task/Conversation links, and token-usage records remain available. Test deliveries without a Task are unaffected, and resetting Provider context preserves delivery records.

Cleanup rechecks expiry when claiming a Session. A failed cleanup or deletion keeps the Session busy to prevent reuse of partially removed storage. Later cleanup passes retry automatic cleanup; callers can retry a manual deletion through the delete API. Disabling automatic cleanup stops new cleanup claims while allowing operations already started to finish. Restart recovery handles unfinished cleanup, deletion, and reset operations before scheduling Runs.

These limits control the current Remote Agent Server process. The project is designed for single-process deployment and does not provide distributed concurrency quotas across multiple service instances.

### 4. Create a session and send a message

Open **Sessions → New session**, select the agent, and enter required MCP session parameters. The server creates an isolated workspace from the current project-environment revision.

Sending a message creates and queues a run. The page shows agent output, tool activity, status changes, errors, and the final result.

Sending another message in the same session creates a new run and resumes the ACP session where supported. Each run keeps its own input, events, and result.

## Integrating another system

The external API is asynchronous. Submission returns `202 Accepted` without waiting for the agent and does not require a permanent SSE connection.

### Native GitHub / GitLab webhooks

Open **Integration endpoints → Receive events** in the console, select GitHub or GitLab and an authentication mode, enter a Webhook Secret, and save. Copy the receiver URL and the same secret into the platform's webhook settings, then select the events to trigger. No custom request headers or payload templates are needed.

```text
POST /integration/v1/endpoints/:slug/webhook
```

| Platform | Platform settings | Server validation |
| --- | --- | --- |
| GitHub | Payload URL and Secret; JSON and form `payload` are supported | HMAC-SHA256 over the original request body, using `X-Hub-Signature-256` |
| GitLab | URL and generated Signing token (`whsec_` prefix), or Secret token for older versions; keep native JSON | `webhook-signature` HMAC-SHA256, or legacy `X-Gitlab-Token` |

Each endpoint has one source platform. Separate GitHub and GitLab endpoints can share an Agent. Set the business instructions in the endpoint's fixed prompt, for example, “Review this code change and report your findings.” The event type and native JSON payload become the task message and use the existing Task persistence, queue, and execution flow. Each matching new delivery creates an independent Task and Session; PRs, MRs, and branches do not automatically share a Conversation.

- Accepted business events return `202` with the existing Task response. GitHub `ping` returns `200` and `{"status":"ignored","reason":"ping"}` without creating a task. GitLab test deliveries also pass through filtering and create tasks when matched.
- The generated `requestId` is `github:<X-GitHub-Delivery>` or `gitlab:<delivery ID>`. GitLab delivery headers are checked in order: `webhook-id`, `Idempotency-Key`, then `X-Gitlab-Webhook-UUID`. Repeating an ID with the same input within one endpoint returns the original Task; different input returns `409 idempotency_conflict`.
- A parameter mapping's request field is a payload path for this entry point, such as GitLab's `project.id` or `object_attributes.iid`, or GitHub's `repository.full_name`. String, number, and boolean values become strings. Fixed mappings still work. Missing required parameters reject task admission.
- Missing receiver configuration or invalid credentials returns `401 invalid_webhook_credentials`; a disabled receiver or endpoint returns `403 endpoint_disabled`; missing event type or delivery ID, or an invalid JSON object, returns `400 invalid_webhook_request`. The default request-body limit remains 1 MiB; larger requests return `413`.
- `authMode` is required: GitHub uses `signature`; GitLab supports `signature` (Signing token) and `token` (Secret token). The configured mode determines authentication. In signature mode, GitLab `whsec_` signing tokens validate the delivery ID, timestamp, and original body using the native signature format. Multiple candidate signatures are supported; timestamps must be within five minutes of server time. This mode requires a valid signature and cannot fall back to a plain token. Token mode accepts arbitrary valid Secret tokens, including values starting with `whsec_`.
- Secrets are encrypted at rest. Configuration responses expose only `secretConfigured`. Omit `secret` during updates to keep it; changing platform or authentication mode requires a new secret. Receiver secrets, external Task API endpoint tokens, and outgoing webhook signing secrets are managed separately.

The management API uses the server `API_TOKEN`. `GET /api/integration-webhook-providers` exposes the registered platforms, authentication modes, and setup hints used by the console. Receiver configuration: `GET /api/integration-endpoints/:id/webhook-receiver` returns the configuration or `null`; `PUT` on the same path saves:

```json
{
  "provider": "github",
  "authMode": "signature",
  "enabled": true,
  "secret": "<same Secret as the platform>"
}
```

#### Event filters

In **Receive events**, apply the **MR / PR review events** preset, then add project, author, or label conditions. “Match all” means AND; “Match any” means OR. Groups can be nested. The preset selects open, non-draft requests on creation, reopening, new commits, or becoming ready for review. Ordinary GitLab title, label, or approval updates do not trigger this preset; unknown draft status is also rejected. Adding a label alone does not trigger a review; adjust the action conditions if that behavior is required. The preset does not classify authors; add account rules separately.

For example, a GitLab MR whose labels contain `CodeReview` and whose author is not account ID `900`:

```json
{
  "all": [
    { "field": "eventType", "op": "eq", "value": "Merge Request Hook" },
    { "field": "payload.labels.*.title", "op": "contains", "value": "CodeReview" },
    { "field": "payload.object_attributes.author_id", "op": "neq", "value": 900 }
  ]
}
```

Save this object as the receiver's `filter` field. GitHub labels use `payload.pull_request.labels.*.name`, and the author login is `payload.pull_request.user.login`. Native GitLab MR events identify the author through `payload.object_attributes.author_id`; `payload.user.id` is the event actor and must not substitute for the author. GitHub's `payload.sender.id` is also the actor. To review only developer MRs, prefer an author ID allowlist with `in: [101,102]`, or maintain a complete agent ID denylist with `not_in`. Replace example IDs with actual account IDs.

- Fields must be `eventType` or dot-separated paths beginning with `payload.`. A path may contain one `*` to project array elements, such as `labels.*.title`. Filters cannot read headers or execute scripts.
- `eq` / `neq` compare a scalar; `in` / `not_in` check a scalar against a configured list; `contains` checks whether an event array contains a configured scalar, useful for labels; `exists` takes a boolean requiring presence or absence. A wildcard field is present when at least one element has the selected field; empty arrays or only missing fields count as absent. Strings are exact and case-sensitive.
- No coercion: numeric `101` differs from string `"101"`. Missing fields and type mismatches fail comparisons, including negative comparisons. `null` is present; empty arrays never match `contains`.
- Limits: 50 rule nodes, 6 nesting levels, non-empty groups, 100 same-type scalars per list, 256-character field paths, and 1024-character comparison strings. Invalid rules return `400 invalid_request` and preserve the previous configuration.
- Omitting `filter` on a same-provider update preserves it; `null` clears it. Switching provider while omitting `filter` clears the rules. The management UI clears the current filter draft on a platform switch; configure rules for the new platform before saving. Configuration reads include `filter` and `filterVersion`; rule or provider changes increment the version. Existing receivers default to no filtering.
- Non-matches return `200 {"status":"ignored","reason":"filter_not_matched"}`, without a Task, Session, Run, or model call. Failed authentication creates no receipt.
- Each authenticated, valid delivery records one filter decision. Retries with the same provider, endpoint, and delivery ID keep that decision; changing rules never admits previously ignored deliveries. Changed event content returns `409 idempotency_conflict`; admitted deliveries return the original task. Authentication and enabled status are still checked on every request.

**Preview filter** evaluates current unsaved rules and explains individual conditions. It verifies no platform signature, creates no task, and stores no sample payload. **Recent receipts** refreshes the latest 30 records on demand, showing provider, event type, delivery ID, rule version, decision, timestamp, and Task link. If filtering passed but admission failed, the record indicates that a platform retry is needed. Receipts contain neither raw payloads nor authentication data; decisions remain until endpoint deletion, including after Session storage cleanup.

Management API:

- `POST /api/integration-endpoints/:id/webhook-receiver/preview` accepts `{ "provider": "gitlab", "eventType": "Merge Request Hook", "payload": {}, "filter": null }` and returns `{ "matched": true, "reason": "filter_matched", "checks": [] }`. A successful preview does not guarantee authentication, enabled status, or valid parameters on actual delivery.
- `GET /api/integration-endpoints/:id/webhook-receiver/receipts` returns the latest 30 decisions and requires management authentication. The provider catalog also exposes `filterFields` suggestions and `filterPresets`.

Filtering only controls task admission. Separate delivery IDs for the same MR revision are not deduplicated automatically; the review Skill / Agent remains responsible for comment deduplication and publication.

Open the endpoint's Tasks tab to inspect execution. Outgoing webhooks still deliver task progress and results. Posting comments back to GitHub or GitLab requires separately configured Agent tools and permissions.

Protocol references: [GitHub signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [GitLab webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/).

### General Task API flow

The complete flow is:

1. An administrator creates an integration endpoint and stores its one-time token.
2. The external system submits a task and stores the returned `taskId`.
3. It queries the task until the task reaches a terminal status.
4. It reads the agent reply from events or a `message.agent.reply` Webhook.
5. It reuses a `conversationKey` for later turns and ends the conversation when continuity is no longer needed.

The examples below use `http://127.0.0.1:3000`.

### 1. Create an integration endpoint

Management operations use the server `API_TOKEN`:

```bash
export REMOTE_AGENT_URL=http://127.0.0.1:3000
export API_TOKEN='<API_TOKEN from the server .env>'
export AGENT_ID='<ID of an agent that passes Doctor>'

curl --fail-with-body \
  -X POST "$REMOTE_AGENT_URL/api/integration-endpoints" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{
    \"name\": \"Ticket processing\",
    \"slug\": \"ticket-agent\",
    \"agentId\": \"$AGENT_ID\",
    \"enabled\": true,
    \"promptPrefix\": \"Follow the project rules when handling this request.\",
    \"parameterMappings\": []
  }"
```

The response contains the endpoint and a token shown only once:

```json
{
  "endpoint": {
    "id": "6c80c07b-...",
    "name": "Ticket processing",
    "slug": "ticket-agent",
    "agentId": "0abc8611-...",
    "enabled": true,
    "promptPrefix": "Follow the project rules when handling this request.",
    "parameterMappings": []
  },
  "token": "ras_..."
}
```

Store the token in the caller secret manager immediately:

```bash
export ENDPOINT_TOKEN='<ras_... returned when the endpoint was created>'
```

The server stores only the token hash, so the token cannot be recovered later. External systems use the endpoint token, never the management `API_TOKEN`.

`promptPrefix` is prepended to every external message as ordinary prompt text. It is not an ACP-native system prompt. If the agent declares required session parameters, map each one to a request value or fixed value:

```json
[
  { "parameterKey": "ticket_id", "source": "request", "requestKey": "ticketId" },
  { "parameterKey": "region", "source": "fixed", "value": "sg" }
]
```

### 2. Submit an asynchronous task

```bash
curl --fail-with-body \
  -X POST "$REMOTE_AGENT_URL/integration/v1/endpoints/ticket-agent/tasks" \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "requestId": "ticket-1332-event-1",
    "conversationKey": "ticket-1332",
    "message": "Find the failure, fix the code, and return the verification result.",
    "parameters": {}
  }'
```

The response status is `202`:

```json
{
  "taskId": "77d45cc5-...",
  "requestId": "ticket-1332-event-1",
  "conversationKey": "ticket-1332",
  "sessionId": "83b0df95-...",
  "runId": null,
  "status": "queued"
}
```

`runId` may be `null` immediately after submission. It appears in later queries after the scheduler creates the run.

- `requestId` is the caller-generated idempotency key. Retrying identical input returns the original task. Reusing it with different input returns `409 idempotency_conflict`.
- `conversationKey` is optional. Later tasks with the same key run serially and reuse the same session.
- `message` is the instruction sent to the agent; optional when attachments are provided.
- `attachments` is an optional array of images or ordinary files, described below.
- `parameters` may contain only request parameters declared by the endpoint mapping.

#### Images and file attachments

Both the Session composer and the endpoint's “Send test task” form accept file selection, drag and drop, and pasted images. Preview or remove attachments before sending. Attachment-only and mixed text/file messages are supported; failed submissions retain the draft. History offers image previews and original-file downloads.

Add optional `attachments` to an HTTP integration request:

```json
{
  "requestId": "with-attachments-001",
  "message": "Analyze the attached files.",
  "attachments": [
    { "name": "notes.txt", "mediaType": "text/plain", "data": "SGVsbG8=" },
    { "name": "screenshot.png", "mediaType": "image/png", "data": "<standard base64 of image bytes>" }
  ]
}
```

`data` contains canonical base64 with required padding, without a `data:` prefix. Read and encode the file bytes on the client. `name` is a filename without directories or control characters (up to 220 UTF-8 bytes); `mediaType` is a MIME type. Use `application/octet-stream` for unknown file types. Remote URLs and server file paths are not accepted.

- Up to 8 attachments per message, 10 MiB per file, 5 MiB per PNG/JPEG/GIF/WebP image, and 20 MiB total, measured after decoding. Validation failures return `400 invalid_request`; oversized request bodies return `413`.
- PNG/JPEG/GIF/WebP headers are checked before sending native ACP image blocks to the Provider. All attachments are also written to the Session workspace and referenced by file path in the runtime prompt. PDF, Office documents, source code, SVG, and other formats are ordinary files; interpretation depends on the Agent's tools, Provider, and selected model. The service does not perform OCR or document conversion.
- `message` may be omitted for attachment-only requests. Management `POST /api/sessions/:id/runs` accepts the same `attachments`; its text field remains `input`. Text and attachments cannot both be empty.
- Attachment names, MIME types, bytes, and order participate in idempotency checks. Changing an attachment under the same `requestId` returns `409 idempotency_conflict`.
- Management history exposes `attachments` with `id`, `name`, `mediaType`, `size` (bytes), and `available`, without base64. Downloads require the management token: `GET /api/runs/:id/attachments/:attachmentId` or `GET /api/integration-tasks/:id/attachments/:attachmentId`. Public Task status, SSE, and Webhooks do not attach file bytes or server attachment paths.
- Attachments persist with their Task/Run across queues and restarts. Session storage cleanup removes payload bytes and workspace files while preserving filename/type/size metadata and setting `available` to `false`; the UI shows “File cleaned” and downloads return `404 attachment_not_found`. Session deletion also removes attachment records. Resetting Provider context preserves attachments.

The JSON message envelope excluding `attachments` remains limited to 1 MiB, including text and parameters.

### 3. Query the task until completion

```bash
export TASK_ID='<taskId from the submission response>'

curl --fail-with-body \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  "$REMOTE_AGENT_URL/integration/v1/tasks/$TASK_ID"
```

Possible statuses are `queued`, `running`, `succeeded`, `failed`, and `cancelled`. A terminal response looks like this:

```json
{
  "taskId": "77d45cc5-...",
  "requestId": "ticket-1332-event-1",
  "conversationKey": "ticket-1332",
  "sessionId": "83b0df95-...",
  "runId": "aa526e5b-...",
  "status": "succeeded"
}
```

The task status endpoint does not include agent response text. Read that text from events or a `message.agent.reply` Webhook.

### 4. Read the reply and public events

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  "$REMOTE_AGENT_URL/integration/v1/tasks/$TASK_ID/events?afterSeq=0"
```

Example message event:

```json
{
  "id": "7f444964-...",
  "runId": "aa526e5b-...",
  "seq": 3,
  "type": "message",
  "contentJson": "{\"stream\":\"output\",\"text\":\"The issue is fixed.\"}",
  "createdAt": "2026-08-18T10:20:30.000Z"
}
```

`contentJson` is a JSON string. Agent output can be split across several `message/output` events. Sort by `seq` and concatenate their `text` values:

```bash
curl --silent \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  "$REMOTE_AGENT_URL/integration/v1/tasks/$TASK_ID/events?afterSeq=0" \
| jq -r '.[]
    | select(.type == "message")
    | .contentJson | fromjson
    | select(.stream == "output")
    | .text' \
| tr -d '\n'
```

External events are a public projection. Message output is visible. Tool events contain only allowlisted fields such as `toolCallId`, `kind`, and `status`. Agent thought, raw tool input/output, MCP secrets, and private provider fields are omitted. The management session page contains the complete internal trace.

### 5. Choose polling, SSE, or Webhooks

| Method | Use case | Recommendation |
| --- | --- | --- |
| Task and event queries | Backend systems and reliable state sync | Default. Store `taskId` and the last processed `seq`. |
| SSE | Browsers and live execution views | Use as a live channel and recover gaps with event queries. |
| Webhook | Server-to-server push | Verify signatures, deduplicate by event ID, and keep polling as recovery. |

Connect to SSE:

```bash
curl -N \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  "$REMOTE_AGENT_URL/integration/v1/tasks/$TASK_ID/events/stream?afterSeq=0"
```

The server sends a heartbeat every 20 seconds. Persist `seq` after each event and pass the last value as `afterSeq` when reconnecting. Disconnecting SSE does not cancel the task.

### 6. Receive agent replies through a Webhook

Administrators create Webhook subscriptions. This example subscribes to agent replies and unsuccessful task outcomes:

```bash
export ENDPOINT_ID='<endpoint.id from endpoint creation>'

curl --fail-with-body \
  -X POST "$REMOTE_AGENT_URL/api/integration-endpoints/$ENDPOINT_ID/webhooks" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "name": "Agent replies",
    "url": "https://caller.example.com/webhooks/remote-agent",
    "enabled": true,
    "events": ["message.agent.reply", "task.failed", "task.cancelled"],
    "headers": {},
    "timeoutSeconds": 10
  }'
```

The `signingSecret` in the creation response is also shown only once. A `message.agent.reply` payload looks like this:

```json
{
  "eventId": "evt_...",
  "eventType": "message.agent.reply",
  "sequence": 5,
  "occurredAt": "2026-08-18T10:20:30.000Z",
  "endpoint": { "id": "6c80c07b-...", "slug": "ticket-agent" },
  "task": {
    "id": "77d45cc5-...",
    "requestId": "ticket-1332-event-1",
    "conversationKey": "ticket-1332",
    "sessionId": "83b0df95-...",
    "runId": "aa526e5b-...",
    "status": "succeeded"
  },
  "message": {
    "role": "agent",
    "content": "The issue is fixed and verified.",
    "runStatus": "succeeded"
  }
}
```

Each request contains:

```text
X-Remote-Agent-Event: message.agent.reply
X-Remote-Agent-Event-Id: <eventId>
X-Remote-Agent-Timestamp: <Unix seconds>
X-Remote-Agent-Signature: v1=<hex HMAC-SHA256 digest>
```

The signed text is `<timestamp>.<unchanged HTTP body>`. Node.js verification:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const expected = createHmac("sha256", signingSecret)
  .update(`${timestamp}.${rawBody}`)
  .digest("hex");
const actual = signature.startsWith("v1=") ? signature.slice(3) : "";
const valid = actual.length === expected.length
  && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
```

The server retries network errors and non-2xx responses. Receivers must deduplicate by `eventId`. A delivery failure does not change the task result.

The console supports filtering and pagination for delivery history. Each subscription card always shows its most recently created delivery, breaking timestamp ties by descending ID, regardless of the history filters or page.

Supported subscription events:

- `task.queued`, `task.started`, `task.succeeded`, `task.failed`, `task.cancelled`
- `message.user.received`, `message.agent.reply`, `message.system.notice`
- `tool.started`, `tool.completed`, `tool.failed`

### 7. Continue or end a conversation

Use a new `requestId` and the same `conversationKey` for the next turn:

```json
{
  "requestId": "ticket-1332-event-2",
  "conversationKey": "ticket-1332",
  "message": "Continue with the second issue found in the previous turn.",
  "parameters": {}
}
```

The new task creates a new run while reusing the previous session and provider conversation. Once no task is `queued` or `running`, end the conversation:

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  "$REMOTE_AGENT_URL/integration/v1/endpoints/ticket-agent/conversations/ticket-1332/end"
```

Historical sessions and runs remain available. Submitting `ticket-1332` again creates a new session.

Cancel an unfinished task:

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  "$REMOTE_AGENT_URL/integration/v1/tasks/$TASK_ID/cancel"
```

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `API_TOKEN` | Yes | None | Bearer token for the management UI and `/api` routes. |
| `HOST` | No | `0.0.0.0` | Listen address. Prefer `127.0.0.1` behind a reverse proxy. |
| `PORT` | No | `3000` | HTTP port. |
| `DATA_DIR` | No | `/srv/remote-agent/data` | Runtime data and encryption-key directory. |
| `DATABASE_PATH` | No | `/srv/remote-agent/data/remote-agent.sqlite3` | SQLite database path. |
| `PROJECT_ENVIRONMENTS_ROOT` | No | `/srv/remote-agent/environments` | Project-environment revision directory. |
| `SESSIONS_ROOT` | No | `/srv/remote-agent/sessions` | Session workspace directory. |
| `MAX_CONCURRENT_RUNS` | No | `4` | Initial global run concurrency for a new database, from 1–64. Manage later changes in System settings. |
| `MAX_CONCURRENT_WEBHOOK_DELIVERIES` | No | `4` | Initial Webhook-delivery concurrency for a new database, from 1–64. |
| `MAX_CONCURRENT_ENVIRONMENT_BUILDS` | No | `1` | Initial project-environment build concurrency for a new database, from 1–64. |
| `PROJECT_ENVIRONMENT_CHECK_INTERVAL_HOURS` | No | `3` | Remote repository check interval. |
| `PROJECT_PREPARE_TIMEOUT_MINUTES` | No | `30` | Per-repository preparation timeout. |
| `SESSION_RETENTION_HOURS` | No | `168` | Initial large idle-Session storage retention for a new database. Manage later changes under **System settings → Runtime and concurrency**. Set to `0` to disable automatic cleanup. |
| `RUN_TIMEOUT_MINUTES` | No | `60` | Initial maximum Run duration for a new database. Manage later changes under **System settings → Runtime and concurrency**. |
| `RUNTIME_IDLE_MINUTES` | No | `5` | How long an idle Runtime stays resident. Expiry closes ACP/MCP processes while preserving Provider state for the next Run. Set to `0` to disable it. |
| `DISPLAY` / `XAUTHORITY` | Browser use | None | Desktop/X display for headed browsers. |

On first startup, the server creates `DATA_DIR/secret.key` with mode `0600`. The AES-256-GCM master key encrypts MCP secrets, endpoint fixed values, Webhook credentials, and sensitive session parameters. Back it up together with the SQLite database.

## Security boundary

- Run the service as a dedicated unprivileged user.
- Expose it only on a trusted network or behind a TLS reverse proxy.
- Store and authorize the management `API_TOKEN` separately from endpoint tokens.
- An endpoint token can instruct its bound agent. Issue it only to trusted systems.
- Agents can run commands, modify session workspaces, call MCP tools, and control browsers. Treat repositories, Skills, MCP servers, and input messages as trusted execution inputs.
- Never commit `.env`, `secret.key`, SQLite data, provider login state, or session workspaces.

## Development and acceptance

```bash
pnpm test
pnpm typecheck
pnpm build

# Requires real providers
pnpm smoke:providers

# Requires a running server, management token, and ready agent
pnpm smoke:integrations
```

`smoke:integrations` exercises endpoint creation, asynchronous tasks, idempotent retry, event queries, SSE resume, multiple turns in one conversation, a new session after ending the conversation, Webhook signatures, and automatic delivery retry.

## Deployment

The [deployment guide](docs/deployment.md) covers macOS APFS/LaunchAgent, Linux Btrfs/systemd, headed browsers, PATH, provider authentication, backup and restore, and real acceptance checks.

## Documentation

- [Product and architecture](docs/design.en.md): positioning, system boundaries, core objects, execution paths, and reliability design.
- [Agent Core and model runtime routing proposal](docs/agent-core-routing.en.md): the proposed multi-Core, model, concurrency, Session-resume, and handoff architecture; not implemented yet.
- [Deployment and acceptance](docs/deployment.md): production deployment, provider authentication, filesystems, reverse proxies, and real smoke tests.

## License

Released under the [MIT License](LICENSE).
