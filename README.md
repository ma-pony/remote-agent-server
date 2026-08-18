# Remote Agent Server

[English](README.en.md)

Remote Agent Server 是一个自托管的 Agent 运行服务。它把 Claude Code、Codex 等命令行 Agent 接到统一的 Web 界面和 HTTP API，并负责准备项目、隔离工作区、续接多轮对话、保存执行记录，以及接收其他系统提交的异步任务。

执行层基于 [acpx](https://github.com/openclaw/acpx) 和 [Agent Client Protocol（ACP）](https://github.com/agentclientprotocol)。目前支持 Claude Code、Codex 和 Hermes Provider。

## 主要功能

- **统一管理 Agent**：集中配置 Provider、Agent 指令、项目环境、Skills 和 MCP。
- **可复用项目环境**：提前准备一个或多个 Git 仓库及依赖，Session 创建时无需重新安装。
- **隔离 Workspace**：macOS 使用 APFS Clone，Linux 使用 Btrfs Snapshot，为每个 Session 快速创建写时复制环境。
- **多轮 Agent 对话**：同一 Session 可以连续执行多个 Run，并在 Provider 支持时续接 ACP Session。
- **完整执行记录**：在 SQLite 中保存用户消息、Agent 输出、工具调用、状态、错误和最终结果。
- **Skills 管理**：发现本机 Skills、上传 Skill ZIP，并控制每个 Agent 启用的 Skills。
- **MCP 管理**：支持 HTTP 和 stdio MCP，支持固定值、Session 参数和运行时参数，并可查看服务器公开的工具。
- **外部系统接入**：通过 HTTP 提交异步 Task，支持幂等、查询、SSE、取消、多轮会话和签名 Webhook。
- **有头浏览器**：Agent 可以运行在真实桌面会话中，不要求放入容器。

## 一次请求如何执行

从 Web 界面发起：

```text
项目环境 -> Agent -> Session -> Run -> acpx/ACP -> Provider
                         |
                         +-> 消息、工具调用、状态和结果
```

从其他系统发起：

```text
外部系统 -> 接入端点 -> Task -> Session -> Run -> Agent
                |                  |
                |                  +-> Workspace / Skills / MCP
                |
                +-> 状态查询 / Event 查询 / SSE / Webhook
```

| 对象 | 作用 |
| --- | --- |
| 项目环境 | 保存一个或多个 Git 项目及准备完成的依赖，按版本发布。 |
| Agent | 绑定 Provider、项目环境、Agent 指令、Skills 和 MCP。 |
| Session | 一个隔离的 Workspace，也是一段可继续的 Agent 对话。 |
| Run | Session 中的一次输入和完整执行记录。 |
| 接入端点 | 其他系统调用服务的认证入口，绑定一个 Agent。 |
| Conversation | 外部系统的多轮业务会话，内部复用同一个 Session。 |
| Task | 外部系统提交的一次异步请求，最终对应一个 Run。 |

## 运行要求

- Node.js 22（`.nvmrc` 是项目已验证版本）
- 通过 Corepack 使用 pnpm 10
- Git
- 至少安装并登录一个 Provider CLI
- macOS 使用 APFS；Linux 使用服务用户可操作的 Btrfs
- 需要有头浏览器时，服务器必须有真实桌面或 X display

项目环境和 Session Workspace 使用 APFS Clone 或 Btrfs Snapshot 创建写时复制副本。服务不提供普通目录复制回退。新主机请先完成[部署文档](docs/deployment.md)中的文件系统准备。

## 安装并启动

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

把随机值写入 `.env` 的 `API_TOKEN`，并把存储目录改成当前机器上的绝对路径。程序不会自动读取 `.env`，启动前需要加载：

```bash
set -a
source ./.env
set +a
pnpm start
```

检查服务：

```bash
curl --fail http://127.0.0.1:3000/api/health
```

打开 `http://127.0.0.1:3000`，输入 `API_TOKEN`。Web 界面只在当前浏览器会话中保存 Token。

## 从零完成一次 Agent 执行

### 1. 准备 Provider

Provider CLI 必须由运行服务的同一个操作系统用户安装并登录：

```bash
claude login
codex login
claude --version
codex --version
```

服务启动时读取登录 Shell 的 PATH，并合并当前 Node 目录和进程 PATH。每个 Agent 使用独立的 Provider Home，只复用必要的原生登录状态，不会自动继承主机 Skills。

### 2. 创建项目环境

进入 **项目环境 → 新建项目环境**：

1. 添加 Agent 可能使用的一个或多个 Git 仓库。
2. 为每个仓库填写可选的准备命令，例如 `pnpm install`、`bundle install` 或 `uv sync`。
3. 点击 **立即同步**。
4. 等待当前版本变为 **可用**。

同步会在持久目录中构建新版本。所有仓库及准备命令成功后，新版本才会发布。系统每 3 小时检查一次远程仓库，也可以手动同步。已有 Session 保持原版本，新 Session 使用最新可用版本。

### 3. 创建 Agent

进入 **Agent → 新建 Agent**：

1. 选择 Claude Code 或 Codex 等 Provider。
2. 选择已经可用的项目环境。
3. 填写 Agent 的职责、代码规范和交付要求。
4. 保存后运行 **运行检查**，确认 Provider 和项目环境可用。

Agent 页面还可以配置：

- **Skills**：发现本机 Skill、上传 ZIP，并明确启用需要的 Skill。
- **MCP**：添加 HTTP 或 stdio MCP，检查连接并查看工具。

Skill 变更从下一次 Run 生效。MCP 值可以来自固定配置、创建 Session 时提供的参数，或 `agent_id`、`session_id`、`run_id`、`workspace_path`、`browser_profile_path` 等运行时值。敏感值加密保存，管理接口不返回明文。

### 4. 创建 Session 并发送消息

进入 **Session → 新建 Session**，选择 Agent，并填写当前 Session 需要的 MCP 参数。系统从项目环境当前版本创建独立 Workspace。

进入 Session 后发送消息。系统创建 Run 并排队执行，页面会展示 Agent 输出、工具调用、执行状态、错误和最终结果。

在同一 Session 中继续发送消息会创建新的 Run，并在 Provider 支持时续接同一个 ACP Session。每个 Run 仍保留独立的输入、事件和结果。

## 其他系统如何接入

外部接入是异步接口。调用方提交 Task 后立即得到 `202 Accepted`，不需要等待 Agent 完成，也不需要长期保持 SSE 连接。

完整流程：

1. 管理员创建接入端点并保存一次性 Token。
2. 外部系统提交 Task，保存返回的 `taskId`。
3. 外部系统查询 Task，直到进入终态。
4. 通过 Event 查询或 Webhook 取得 Agent 回复。
5. 使用相同 `conversationKey` 继续多轮；不再续接时结束 Conversation。

下面的示例使用 `http://127.0.0.1:3000`。

### 1. 创建接入端点

管理操作使用服务器 `API_TOKEN`：

```bash
export REMOTE_AGENT_URL=http://127.0.0.1:3000
export API_TOKEN='<服务器 .env 中的 API_TOKEN>'
export AGENT_ID='<已经通过运行检查的 Agent ID>'

curl --fail-with-body \
  -X POST "$REMOTE_AGENT_URL/api/integration-endpoints" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{
    \"name\": \"工单处理入口\",
    \"slug\": \"ticket-agent\",
    \"agentId\": \"$AGENT_ID\",
    \"enabled\": true,
    \"promptPrefix\": \"请按项目规范处理以下请求。\",
    \"parameterMappings\": []
  }"
```

响应包含接入端点和只展示一次的 Token：

```json
{
  "endpoint": {
    "id": "6c80c07b-...",
    "name": "工单处理入口",
    "slug": "ticket-agent",
    "agentId": "0abc8611-...",
    "enabled": true,
    "promptPrefix": "请按项目规范处理以下请求。",
    "parameterMappings": []
  },
  "token": "ras_..."
}
```

立即把 `token` 保存到调用方的 Secret 管理系统：

```bash
export ENDPOINT_TOKEN='<创建端点时返回的 ras_...>'
```

服务端只保存 Token 哈希，离开创建结果后无法找回。外部系统使用 Endpoint Token，不能使用管理端 `API_TOKEN`。

`promptPrefix` 会作为普通文本加到每次外部消息之前，不是 ACP 原生 system prompt。如果 Agent 定义了必填 Session 参数，需要在 `parameterMappings` 中把它映射为请求参数或固定值：

```json
[
  {
    "parameterKey": "ticket_id",
    "source": "request",
    "requestKey": "ticketId"
  },
  {
    "parameterKey": "region",
    "source": "fixed",
    "value": "sg"
  }
]
```

### 2. 提交异步 Task

```bash
curl --fail-with-body \
  -X POST "$REMOTE_AGENT_URL/integration/v1/endpoints/ticket-agent/tasks" \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "requestId": "ticket-1332-event-1",
    "conversationKey": "ticket-1332",
    "message": "分析失败原因，修改代码并返回验证结果。",
    "parameters": {}
  }'
```

响应状态为 `202`：

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

`runId` 在 Task 刚入队时可能为 `null`，调度器创建 Run 后会出现在后续查询中。

- `requestId`：调用方生成的幂等键。完全相同的输入重试会返回原 Task；相同 `requestId` 携带不同输入会返回 `409 idempotency_conflict`。
- `conversationKey`：可选业务会话标识。相同 Key 的后续 Task 严格串行，并复用同一个 Session。
- `message`：本次发送给 Agent 的正文。
- `parameters`：只允许提交端点已经声明的动态参数。

### 3. 查询 Task 直到完成

```bash
export TASK_ID='<提交响应中的 taskId>'

curl --fail-with-body \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  "$REMOTE_AGENT_URL/integration/v1/tasks/$TASK_ID"
```

状态为 `queued`、`running`、`succeeded`、`failed` 或 `cancelled`。终态响应示例：

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

Task 状态接口不返回 Agent 文本。最终回复从 Event 查询或 `message.agent.reply` Webhook 获取。

### 4. 读取 Agent 回复和执行轨迹

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  "$REMOTE_AGENT_URL/integration/v1/tasks/$TASK_ID/events?afterSeq=0"
```

消息 Event 示例：

```json
{
  "id": "7f444964-...",
  "runId": "aa526e5b-...",
  "seq": 3,
  "type": "message",
  "contentJson": "{\"stream\":\"output\",\"text\":\"问题已经修复。\"}",
  "createdAt": "2026-08-18T10:20:30.000Z"
}
```

`contentJson` 是 JSON 字符串。Agent 输出可能分成多个 `message/output` Event，应按 `seq` 排序并拼接 `text`：

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

外部 Event 是公开投影：消息正文可见；工具 Event 只包含 `toolCallId`、`kind` 和 `status` 等白名单字段；Agent thought、工具原始输入输出、MCP 密钥和 Provider 私有字段不会返回。完整内部轨迹可以在管理界面的 Session 中查看。

### 5. 选择查询、SSE 或 Webhook

| 方式 | 场景 | 建议 |
| --- | --- | --- |
| Task + Event 查询 | 后端系统、定时任务、可靠状态同步 | 默认选择。保存 `taskId` 和最后处理的 `seq`。 |
| SSE | 浏览器或实时执行界面 | 用作实时通道，断线后用 Event 查询补齐。 |
| Webhook | 希望服务主动通知业务系统 | 验签并按 Event ID 幂等处理，同时保留查询兜底。 |

连接 SSE：

```bash
curl -N \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  "$REMOTE_AGENT_URL/integration/v1/tasks/$TASK_ID/events/stream?afterSeq=0"
```

服务每 20 秒发送心跳。客户端每处理一个 Event 就保存 `seq`，重连时把最后的值传给 `afterSeq`。SSE 断开不会取消 Task。

### 6. 配置 Agent 回复 Webhook

Webhook 由管理员创建。下面订阅 Agent 回复和失败状态：

```bash
export ENDPOINT_ID='<创建端点响应中的 endpoint.id>'

curl --fail-with-body \
  -X POST "$REMOTE_AGENT_URL/api/integration-endpoints/$ENDPOINT_ID/webhooks" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "name": "Agent 回复",
    "url": "https://caller.example.com/webhooks/remote-agent",
    "enabled": true,
    "events": ["message.agent.reply", "task.failed", "task.cancelled"],
    "headers": {},
    "timeoutSeconds": 10
  }'
```

创建响应中的 `signingSecret` 也只展示一次。`message.agent.reply` Payload：

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
    "content": "问题已经修复，并通过验证。",
    "runStatus": "succeeded"
  }
}
```

每次请求包含：

```text
X-Remote-Agent-Event: message.agent.reply
X-Remote-Agent-Event-Id: <eventId>
X-Remote-Agent-Timestamp: <Unix 秒>
X-Remote-Agent-Signature: v1=<HMAC-SHA256 十六进制摘要>
```

签名原文是 `<timestamp>.<未经修改的 HTTP Body>`。Node.js 验签示例：

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const expected = createHmac("sha256", signingSecret)
  .update(`${timestamp}.${rawBody}`)
  .digest("hex");
const actual = signature.startsWith("v1=") ? signature.slice(3) : "";
const valid = actual.length === expected.length
  && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
```

服务会重试网络错误和非 2xx 响应，接收方必须按 `eventId` 幂等。Webhook 投递失败不会改变 Task 结果。

可订阅事件：

- `task.queued`、`task.started`、`task.succeeded`、`task.failed`、`task.cancelled`
- `message.user.received`、`message.agent.reply`、`message.system.notice`
- `tool.started`、`tool.completed`、`tool.failed`

### 7. 继续或结束多轮会话

使用新的 `requestId` 和相同 `conversationKey` 提交下一条消息：

```json
{
  "requestId": "ticket-1332-event-2",
  "conversationKey": "ticket-1332",
  "message": "继续处理刚才发现的第二个问题。",
  "parameters": {}
}
```

新 Task 创建新的 Run，但继续使用原 Session 和 Provider 对话。确认没有 `queued` 或 `running` Task 后，可以结束 Conversation：

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  "$REMOTE_AGENT_URL/integration/v1/endpoints/ticket-agent/conversations/ticket-1332/end"
```

历史 Session 和 Run 会保留。以后再使用 `ticket-1332` 会创建新 Session。

取消尚未完成的 Task：

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  "$REMOTE_AGENT_URL/integration/v1/tasks/$TASK_ID/cancel"
```

## 配置

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `API_TOKEN` | 是 | 无 | 管理界面和 `/api` 管理接口的 Bearer Token。 |
| `HOST` | 否 | `0.0.0.0` | 监听地址；反向代理场景建议使用 `127.0.0.1`。 |
| `PORT` | 否 | `3000` | HTTP 端口。 |
| `DATA_DIR` | 否 | `/srv/remote-agent/data` | 运行数据和加密主密钥目录。 |
| `DATABASE_PATH` | 否 | `/srv/remote-agent/data/remote-agent.sqlite3` | SQLite 数据库路径。 |
| `PROJECT_ENVIRONMENTS_ROOT` | 否 | `/srv/remote-agent/environments` | 项目环境版本目录。 |
| `SESSIONS_ROOT` | 否 | `/srv/remote-agent/sessions` | Session Workspace 目录。 |
| `MAX_CONCURRENT_RUNS` | 否 | `4` | 同时执行的 Run 数量上限。 |
| `PROJECT_ENVIRONMENT_CHECK_INTERVAL_HOURS` | 否 | `3` | 远程仓库检查间隔。 |
| `PROJECT_PREPARE_TIMEOUT_MINUTES` | 否 | `30` | 单个仓库准备命令超时时间。 |
| `DISPLAY` / `XAUTHORITY` | 浏览器场景 | 无 | 有头浏览器使用的桌面或 X display。 |

首次启动会创建权限为 `0600` 的 `DATA_DIR/secret.key`。该 AES-256-GCM 主密钥用于加密 MCP 敏感值、端点固定参数、Webhook 凭证和 Session 敏感参数。请把它和 SQLite 数据库一起备份。

## 安全边界

- 使用无特权的专用用户运行服务。
- 只在可信网络开放，或放在 TLS 反向代理后。
- 管理 `API_TOKEN` 与 Endpoint Token 分开保存和授权。
- Endpoint Token 可以向绑定的 Agent 发送指令，只应发给受信任系统。
- Agent 可以运行命令、修改 Session Workspace、调用 MCP 和操作浏览器。仓库、Skills、MCP 与输入消息都属于受信任的执行输入。
- 不要把 `.env`、`secret.key`、SQLite、Provider 登录状态或 Session Workspace 提交到 Git。

## 开发与验收

```bash
pnpm test
pnpm typecheck
pnpm build

# 需要真实 Provider
pnpm smoke:providers

# 需要已启动服务、管理 Token 和可用 Agent
pnpm smoke:integrations
```

`smoke:integrations` 会真实验证端点创建、异步 Task、幂等重试、Event 查询、SSE 续读、同一 Conversation 多轮、结束后新建 Session、Webhook 签名与自动重试。

## 部署

[部署文档](docs/deployment.md)包含 macOS APFS/LaunchAgent、Linux Btrfs/systemd、有头浏览器、PATH、Provider 登录、备份恢复和真实验收步骤。
