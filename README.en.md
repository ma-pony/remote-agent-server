# Remote Agent Server

[简体中文](README.md)

Remote Agent Server is a self-hosted runtime for command-line agents such as Claude Code and Codex. It provides one web interface and HTTP API for preparing projects, isolating workspaces, continuing multi-turn conversations, recording executions, and accepting asynchronous work from other systems.

The execution layer uses [acpx](https://github.com/openclaw/acpx) and the [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol). The current provider adapters support Claude Code, Codex, and Hermes.

## Features

- **Agent management:** configure providers, instructions, project environments, Skills, and MCP in one place.
- **Reusable project environments:** prepare one or more Git repositories and their dependencies before sessions start.
- **Isolated workspaces:** use APFS clones on macOS or Btrfs snapshots on Linux to create copy-on-write session environments.
- **Multi-turn conversations:** execute multiple runs in one session and resume the ACP session where supported.
- **Recorded executions:** persist user messages, agent output, tool activity, statuses, errors, and results in SQLite.
- **Skill management:** discover host Skills, upload Skill ZIP files, and choose which Skills each agent receives.
- **MCP management:** configure HTTP and stdio MCP with fixed, session, or runtime values and inspect exposed tools.
- **External integrations:** submit asynchronous HTTP tasks with idempotency, polling, SSE, cancellation, conversations, and signed Webhooks.
- **Headed browser support:** run agents in a real desktop session without requiring containers.

## How a request runs

From the web interface:

```text
Project environment -> Agent -> Session -> Run -> acpx/ACP -> Provider
                               |
                               +-> messages, tool activity, status, result
```

From another system:

```text
External system -> Integration endpoint -> Task -> Session -> Run -> Agent
                         |                            |
                         |                            +-> workspace / Skills / MCP
                         |
                         +-> status query / event query / SSE / Webhook
```

| Object | Purpose |
| --- | --- |
| Project environment | A versioned, prepared set of one or more Git repositories. |
| Agent | A provider, project environment, instructions, Skills, and MCP configuration. |
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

At startup, the server reads the login-shell PATH and merges it with the current Node directory and process PATH. Each agent has its own provider home. When Codex, Claude Code, or Hermes starts, the server copies the service user's configuration, authentication, models, plugins, and Skills while excluding session history, caches, logs, and temporary runtime data.

### 2. Create a project environment

Open **Project environments → New project environment**:

1. Add one or more Git repositories the agent may need.
2. Add an optional preparation command per repository, such as `pnpm install`, `bundle install`, or `uv sync`.
3. Select **Sync now**.
4. Wait for the current revision to become **Ready**.

A sync builds a new revision in persistent storage and publishes it only after every repository and preparation command succeeds. The server checks remotes every three hours, and an operator can sync at any time. Existing sessions keep their revision; new sessions use the latest ready revision.

### 3. Create an agent

Open **Agents → New agent**:

1. Select a provider such as Claude Code or Codex.
2. Select the ready project environment.
3. Enter the agent role, coding rules, and delivery requirements.
4. Save it and run **Doctor** to verify the provider and project environment.

The agent page also provides:

- **Skills:** discover host Skills, upload a ZIP archive, and enable only the Skills this agent should receive.
- **MCP:** add HTTP or stdio servers, check connectivity, and inspect their tools.

Skill changes apply on the next run. MCP values may come from saved values, declared session parameters, or runtime values such as `agent_id`, `session_id`, `run_id`, `workspace_path`, and `browser_profile_path`. Secrets are encrypted and are never returned in plaintext by management APIs.

### 4. Create a session and send a message

Open **Sessions → New session**, select the agent, and enter required MCP session parameters. The server creates an isolated workspace from the current project-environment revision.

Sending a message creates and queues a run. The page shows agent output, tool activity, status changes, errors, and the final result.

Sending another message in the same session creates a new run and resumes the ACP session where supported. Each run keeps its own input, events, and result.

## Integrating another system

The external API is asynchronous. Submission returns `202 Accepted` without waiting for the agent and does not require a permanent SSE connection.

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
- `message` is the instruction sent to the agent for this task.
- `parameters` may contain only request parameters declared by the endpoint mapping.

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
| `MAX_CONCURRENT_RUNS` | No | `4` | Maximum concurrently executing runs. |
| `PROJECT_ENVIRONMENT_CHECK_INTERVAL_HOURS` | No | `3` | Remote repository check interval. |
| `PROJECT_PREPARE_TIMEOUT_MINUTES` | No | `30` | Per-repository preparation timeout. |
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
