# Remote Agent Server

[简体中文](README.md)

Remote Agent Server is a self-hosted control plane for running coding agents on a dedicated machine. It manages agents, reusable project environments, isolated session workspaces, multi-turn runs, Skills, MCP servers, and authenticated integrations through one web interface and HTTP API.

The execution layer uses [acpx](https://github.com/openclaw/acpx) and the [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol). The current provider adapters support Claude Code, Codex, and Hermes. Sessions keep their provider session ID, so later runs can continue the same conversation while each run remains independently recorded.

## What it provides

- **Provider-neutral agents:** configure a provider, instructions, project environment, Skills, and MCP servers once.
- **Reusable project environments:** prepare one or more Git repositories and their dependencies before a session starts.
- **Isolated workspaces:** create fast copy-on-write session workspaces with APFS clones on macOS or Btrfs snapshots on Linux.
- **Multi-turn sessions:** send multiple runs to one session and resume the underlying ACP session where supported.
- **Observable runs:** persist messages, tool activity, status changes, errors, and final results in SQLite.
- **MCP management:** configure HTTP and stdio MCP servers with fixed, session, or runtime values, then inspect their tools from the UI.
- **Skill management:** discover host Skills, upload Skill archives, and explicitly enable the Skills copied into each agent home.
- **External integrations:** accept asynchronous tasks over HTTP and expose polling, SSE, cancellation, conversation reuse, and signed Webhooks.
- **Headed browser support:** run providers in a normal desktop session instead of a container-only environment.

## Core model

| Concept | Purpose |
| --- | --- |
| Project environment | A versioned, reusable set of Git repositories and prepared dependencies. |
| Agent | Provider configuration, instructions, project environment, Skills, and MCP configuration. |
| Session | An isolated workspace and a continuing provider conversation. |
| Run | One user input and its recorded execution inside a session. |
| Integration endpoint | An authenticated external entry point mapped to an agent and optional session parameters. |

An external request follows this path:

```text
HTTP request -> Integration task -> Session -> Run -> acpx/ACP -> Provider
                                      |
                                      +-> SQLite events -> query / SSE / Webhook
```

SSE is optional. A caller can submit a task, store the returned `taskId`, and poll the task and event endpoints. Webhooks are available when the caller wants push delivery.

## Requirements

- macOS with APFS, or Linux with a Btrfs filesystem available to the service user
- Node.js 22 (`.nvmrc` pins the tested version)
- pnpm 10 through Corepack
- Git
- At least one installed and authenticated provider CLI
- A real desktop/X display when an agent needs headed browser automation

Remote Agent Server deliberately has no ordinary directory-copy fallback. The project environment and session roots must satisfy the APFS or Btrfs checks at startup.

The commands below assume those storage directories are already prepared. Follow the [deployment guide](docs/deployment.md) first if this is a new macOS or Linux host.

## Quick start

```bash
git clone https://github.com/ma-pony/remote-agent-server.git
cd remote-agent-server

nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm build

cp .env.example .env
chmod 0600 .env
openssl rand -hex 32
```

Put the generated value in `API_TOKEN`, set absolute storage paths for the current machine, and then start the service:

```bash
set -a
source ./.env
set +a
pnpm start
```

Check the service:

```bash
curl --fail http://127.0.0.1:3000/api/health
```

Open `http://127.0.0.1:3000`. The web UI asks for `API_TOKEN` and keeps it only in the current browser session.

The application does not load `.env` by itself. Source it before `pnpm start`, or provide the same variables through the process manager.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `API_TOKEN` | Yes | None | Management UI and `/api` Bearer token. |
| `HOST` | No | `0.0.0.0` | Listen address. Use `127.0.0.1` behind a local reverse proxy. |
| `PORT` | No | `3000` | HTTP port. |
| `DATA_DIR` | No | `/srv/remote-agent/data` | Runtime data and encryption key directory. |
| `DATABASE_PATH` | No | `/srv/remote-agent/data/remote-agent.sqlite3` | SQLite database path. |
| `PROJECT_ENVIRONMENTS_ROOT` | No | `/srv/remote-agent/environments` | Immutable project environment revisions. |
| `SESSIONS_ROOT` | No | `/srv/remote-agent/sessions` | Isolated session workspaces. |
| `MAX_CONCURRENT_RUNS` | No | `4` | Maximum concurrently executing runs. |
| `PROJECT_ENVIRONMENT_CHECK_INTERVAL_HOURS` | No | `3` | Remote repository check interval. |
| `PROJECT_PREPARE_TIMEOUT_MINUTES` | No | `30` | Timeout for a repository preparation command. |
| `DISPLAY` / `XAUTHORITY` | Browser only | None | Desktop/X display used by headed browsers. |

On first startup, the service creates `DATA_DIR/secret.key` with mode `0600`. This AES-256-GCM key encrypts MCP secrets, integration fixed values, Webhook credentials, and sensitive session parameters. Back up the key with the SQLite database. Existing encrypted values cannot be recovered if the key is lost.

## First-run workflow

1. Create a **project environment**.
2. Add one or more Git repositories and an optional preparation command for each repository.
3. Run **Sync now** and wait for a ready revision.
4. Create an **agent**, choose its provider and project environment, and enter its instructions.
5. Enable or upload the Skills the agent needs.
6. Add HTTP or stdio MCP servers and run their connection check.
7. Create a **session** and send the first message.

Project environment synchronization builds a new revision and publishes it only after every repository is ready. Existing sessions keep their current revision; new sessions clone the latest ready revision with APFS or Btrfs copy-on-write support.

## Providers and PATH

Install and authenticate provider CLIs as the same operating-system user that runs the service. For example:

```bash
claude login
codex login
claude --version
codex --version
```

At startup, the service reads the login shell PATH and merges it with the current Node directory and process PATH. This lets LaunchAgent and systemd deployments find tools installed by Homebrew, NVM, pnpm, or a user-local package manager without duplicating the whole PATH in application configuration.

Provider homes are isolated per agent. Required native login state is reused selectively; host Skills are not implicitly injected into an agent.

## Skills

The Skill catalog discovers compatible `SKILL.md` directories from Codex, shared agent, Claude, and plugin locations. A ZIP archive can also be uploaded from the agent page. Enabling a Skill copies it into the managed agent home; disabling it removes only the managed copy.

Changes take effect on the next run. The runtime refreshes the provider handle while retaining the ACP session ID when a continuing session is available.

## MCP servers

Each agent can have multiple MCP servers:

- **HTTP**: URL and Headers
- **stdio**: command, Arguments, and Environment

Each configurable value can come from:

- a fixed value stored by the server;
- a declared session parameter supplied when the session is created; or
- a runtime value such as `agent_id`, `session_id`, `run_id`, `workspace_path`, or `browser_profile_path`.

Sensitive fixed and session values are encrypted and are never returned in plaintext by management APIs. Use **Check connection** to validate the resolved configuration. After a successful check, click the tool count to inspect all tools currently advertised by that MCP server.

## Management API

All management endpoints except `/api/health` require the server API token:

```bash
curl http://127.0.0.1:3000/api/agents \
  -H "Authorization: Bearer $API_TOKEN"
```

The web UI uses the same `/api` endpoints for agents, project environments, sessions, runs, MCP configuration, and integration administration.

## External integration API

Create an integration endpoint in the web UI, select its agent, map any required session parameters, and copy the one-time endpoint token. External calls use this endpoint token, not the management `API_TOKEN`.

An endpoint token cannot call management APIs, but it can send instructions to an agent running with approved tools. It is therefore a credential for a trusted calling system, not an isolation boundary for untrusted tenants. Provider login state and every file readable by the service user remain inside the agent's trust boundary. Provider and project-preparation processes do not inherit the management or smoke-test tokens.

Submit an asynchronous task:

```bash
curl -X POST http://127.0.0.1:3000/integration/v1/endpoints/example/tasks \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "request-001",
    "conversationKey": "issue-42",
    "message": "Inspect the repository and report the failing check.",
    "parameters": {}
  }'
```

`requestId` is the idempotency key. Reusing it with the same input returns the same task. `conversationKey` is optional; repeated tasks with the same key continue the same session until the conversation is ended.

Query task state and events:

```bash
curl http://127.0.0.1:3000/integration/v1/tasks/$TASK_ID \
  -H "Authorization: Bearer $ENDPOINT_TOKEN"

curl "http://127.0.0.1:3000/integration/v1/tasks/$TASK_ID/events?afterSeq=0" \
  -H "Authorization: Bearer $ENDPOINT_TOKEN"
```

Optional SSE stream:

```bash
curl -N "http://127.0.0.1:3000/integration/v1/tasks/$TASK_ID/events/stream?afterSeq=0" \
  -H "Authorization: Bearer $ENDPOINT_TOKEN"
```

The stream sends heartbeats and supports reconnection with `afterSeq`. Disconnecting does not cancel the task. For long-running production integrations, use task polling as the recovery path even when SSE is enabled.

## Webhooks

An integration endpoint can subscribe an HTTP(S) URL to task, message, system notice, and tool events. Deliveries are persisted and retried by the service. Requests include:

- `X-Remote-Agent-Event`
- `X-Remote-Agent-Event-Id`
- `X-Remote-Agent-Timestamp`
- `X-Remote-Agent-Signature: v1=<hex digest>`

Verify the signature as HMAC-SHA256 over:

```text
<timestamp>.<unmodified request body>
```

The Webhook signing secret is shown once when the subscription is created or rotated. Configure a reasonable receiver timeout and process duplicate event IDs idempotently.

## Development and verification

```bash
pnpm test
pnpm typecheck
pnpm build

# Requires configured real providers
pnpm smoke:providers

# Requires a running service, management token, and ready agent
pnpm smoke:integrations
```

## Deployment

See [docs/deployment.md](docs/deployment.md) for APFS/LaunchAgent and Btrfs/systemd setup, headed browser requirements, backup guidance, and real-provider acceptance checks.

Recommended production boundaries:

- run the service as an unprivileged dedicated user;
- expose it only on a trusted network or behind TLS;
- do not run the Node process as root or grant broad filesystem capabilities;
- keep `.env`, `secret.key`, the SQLite database, provider login state, and session workspaces out of Git;
- treat agent commands, repository code, MCP tools, and browser access as trusted execution inputs.
