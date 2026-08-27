# Remote Agent Server

[English](README.en.md)

Remote Agent Server 是一个面向业务系统的自托管 ACP Agent 执行网关。调用方通过 HTTP 提交异步任务，服务在隔离 Workspace 中运行 Claude Code、Codex 等命令行 Agent，并通过状态查询、Event、SSE 或签名 Webhook 返回执行过程和结果。

它把现有 Agent CLI 变成可嵌入工单系统、CI/CD、内部平台和自动化服务的持久化后端。Web 管理台负责配置 Agent、项目环境、Skills、执行器扩展、MCP、并发和接入端点；外部调用方只需要 Endpoint Token 和稳定的 Task API。

执行层基于 [acpx](https://github.com/openclaw/acpx) 和 [Agent Client Protocol（ACP）](https://github.com/agentclientprotocol)。目前支持 Claude Code、Codex 和 Hermes Provider。

Agent 的推理、工具使用和原生会话仍由对应 Provider 负责。Remote Agent Server 管理执行生命周期、Workspace 隔离、配置投影、持久化事件和外部回调。业务审批、工单状态机与部署规则由调用方维护。

## 适用场景

- 工单、Issue 或运维平台把任务派发给 Agent，并异步接收执行结果。
- CI/CD 或内部自动化服务需要可查询、可取消、可审计的长任务。
- 团队希望复用现有 Claude Code、Codex 登录状态，同时集中管理项目环境、MCP 和 Skills。
- 自托管环境需要保留代码、凭证、执行记录和 Workspace 的控制权。

## 主要功能

- **异步 Task API**：外部系统通过 HTTP 提交任务，使用幂等键避免重复执行，并可查询、取消或继续多轮 Conversation。
- **可靠事件出口**：支持增量 Event 查询、可续读 SSE 和签名 Webhook；断线不影响正在执行的 Task。
- **统一管理 Agent**：集中配置 Provider、Agent 指令、项目环境、Skills 和 MCP。
- **可复用项目环境**：提前准备一个或多个 Git 仓库及依赖，Session 创建时无需重新安装。
- **隔离 Workspace**：macOS 使用 APFS Clone，Linux 使用 Btrfs Snapshot，为每个 Session 快速创建写时复制环境。
- **多轮 Agent 对话**：同一 Session 可以连续执行多个 Run，并在 Provider 支持时续接 ACP Session。
- **完整执行记录**：在 SQLite 中保存用户消息、Agent 输出、工具调用、状态、错误和最终结果。
- **Skills 管理**：发现本机 Skills、上传 Skill ZIP，并控制每个 Agent 启用的 Skills。
- **执行器扩展**：发现 Codex 和 Claude Code 的系统插件与 Hook，由每个 Agent 单独选择，在运行时投影到它的 Provider Home。
- **MCP 管理**：支持 HTTP 和 stdio MCP，支持固定值、Session 参数和运行时参数，也可从 Provider 系统配置中导入 MCP，并查看服务器公开的工具。
- **并发与队列控制**：在管理台统一调整 Run、Webhook 投递和项目环境构建并发，并可为单个 Agent 设置 Run 上限。
- **有头浏览器**：Agent 可以运行在真实桌面会话中，不要求放入容器。

## 执行模型

外部系统接入是项目的主要服务接口：

```text
外部系统
   |
   v
接入端点（鉴权 / 参数映射 / 幂等）
   |
   v
Task -> Conversation -> Session -> 隔离 Workspace -> acpx/ACP -> Provider
   |                         |
   |                         +-> Skills / 执行器扩展 / MCP
   |
   +-> 状态查询 / Event 查询 / SSE / 签名 Webhook
```

管理人员也可以从 Web 界面直接创建 Session 和 Run：

```text
项目环境 -> Agent -> Session -> Run -> acpx/ACP -> Provider
                         |
                         +-> 消息、工具调用、状态和结果
```

| 对象 | 作用 |
| --- | --- |
| 项目环境 | 保存一个或多个 Git 项目及准备完成的依赖，按版本发布。 |
| Agent | 绑定 Provider、项目环境、Agent 指令、Skills、执行器扩展和 MCP。 |
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
- Linux 需要安装 `btrfs-progs`，且服务用户必须能实际执行 `btrfs subvolume create/snapshot/delete`
- 需要有头浏览器时，服务器必须有真实桌面或 X display

项目环境和 Session Workspace 使用 APFS Clone 或 Btrfs Snapshot 创建写时复制副本。服务不提供普通目录复制回退。新主机请先完成[部署文档](docs/deployment.md)中的文件系统准备。

## 安装并启动

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

把随机值写入 `.env` 的 `API_TOKEN`，并把存储目录改成当前机器上的绝对路径。程序不会自动读取 `.env`，启动前需要加载：

```bash
set -a
source ./.env
set +a
```

Linux 用户必须先按[部署文档](docs/deployment.md#linuxbtrfs-原生部署)准备 Btrfs，并在目录创建完成后执行与服务启动检查一致的预检：

```bash
command -v btrfs
btrfs filesystem show "$PROJECT_ENVIRONMENTS_ROOT"
btrfs filesystem show "$SESSIONS_ROOT"
test "$(stat -c %d "$PROJECT_ENVIRONMENTS_ROOT")" = \
     "$(stat -c %d "$SESSIONS_ROOT")"
```

如果预检失败，不要继续启动：非 Btrfs 主机必须先完成文件系统准备，服务不会回退到普通目录复制。`WorkspaceCheckError` 通常表示 `btrfs` 命令未安装、根目录不在可访问的 Btrfs 上，或两个根目录不在同一文件系统。

启动服务：

```bash
pnpm start
```

`pnpm start` 会先构建服务端和 Web 管理台，再以生产模式启动。若直接执行构建后的 Node 入口但 Web 构建不完整，服务会明确报错退出，不会启动一个只有 API、页面必然白屏的进程。

检查服务：

```bash
curl --fail http://127.0.0.1:3000/api/health
```

打开 `http://127.0.0.1:3000`，输入 `API_TOKEN`。Web 界面只在当前浏览器会话中保存 Token。

### 本地开发

加载 `.env` 后运行：

```bash
pnpm dev
```

该命令会同时启动后端监听和 Vite 前端开发服务器。后端使用 `.env` 中的 `PORT`，Vite 默认位于 `http://127.0.0.1:5173`，并把 `/api` 和 `/integration` 自动代理到该后端端口；前端修改可热更新，无需重复构建或重启后端。

## 从零完成一次 Agent 执行

### 1. 准备 Provider

Provider CLI 必须由运行服务的同一个操作系统用户安装并登录。安装和认证方式以官方文档为准：

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

只需选择实际使用的 Provider，在运行服务的系统用户下完成认证和模型配置。

服务启动时读取登录 Shell 的 PATH，并合并当前 Node 目录和进程 PATH。每个 Agent 使用独立的 Provider Home。服务会从运行用户的 Provider Home 准备基础配置、认证与模型信息，不复制历史会话、日志和临时运行数据。Codex 和 Claude Code 的系统插件、Hook 与全局 MCP 只作为可选配置来源，不会被 Agent 隐式继承。

### 2. 创建项目环境

进入 **项目环境 → 新建项目环境**：

1. 添加 Agent 可能使用的一个或多个 Git 仓库。
2. 为每个仓库填写可选的准备命令，例如 `pnpm install`、`bundle install` 或 `uv sync`。
3. 点击 **立即同步**。
4. 等待当前版本变为 **可用**。

同步会在持久目录中构建新版本。所有仓库及准备命令成功后，新版本才会发布。系统每 3 小时检查一次远程仓库，也可以手动同步。已有 Session 保持原版本，新 Session 使用最新可用版本。Session 直接使用当前版本的 APFS Clone/Btrfs Snapshot，不重复执行清理或准备命令；旧 Session 在首次继续运行时仍会完成一次兼容修复。

项目包含 `uv.lock` 时，服务会在原准备命令前先执行 `uv venv --relocatable .venv`，之后项目原有的 `uv sync` 或 Make 命令会复用这个可迁移环境。服务器需要安装 uv `>= 0.10.8`；升级后需要重新同步项目环境，已有 `.venv` 不会自动转换。同步时会比较 `uv.lock`、`pyproject.toml` 和 `.python-version`：依赖未变只更新源码，依赖变化才清理并重新准备该项目。项目环境只保留当前 Workspace；Session 使用自己的 Btrfs 快照，不依赖旧项目环境 Workspace。

### 3. 创建 Agent

进入 **Agent → 新建 Agent**：

1. 选择 Claude Code 或 Codex 等 Provider。
2. 选择已经可用的项目环境。
3. 填写 Agent 的职责、代码规范和交付要求。
4. 保存后运行 **运行检查**，确认 Provider 和项目环境可用。

Agent 页面还可以配置：

- **Skills**：发现本机 Skill、上传 ZIP，并明确启用需要的 Skill。
- **执行器扩展**：查看当前 Provider 系统配置中发现的插件和 Hook，并为这个 Agent 启用需要的项。
- **MCP**：添加 HTTP 或 stdio MCP，检查连接并查看工具；也可将 Codex 或 Claude Code 的系统全局 MCP 导入当前 Agent。
- **运行并发策略**：默认继承系统 Run 并发，也可以设置当前 Agent 的独立上限；实际上限取两者较小值。

Skills、执行器扩展和 MCP 的变更从下一次 Run 生效。已有 Session 检测到配置变化后会刷新执行器连接；Provider 支持时，会继续原有 Provider Session 和对话上下文。

执行器扩展遵循“发现 → Agent 选择 → 运行时投影”流程。在服务运行用户的 Codex 或 Claude Code 配置中安装新插件、添加 Hook 后，它们会出现在 Agent 的 **执行器扩展** 页面，默认不启用。启用的项只投影到当前 Agent。Hermes 目前不提供这项扩展管理能力。

Provider 系统全局 MCP 使用独立流程：在 Agent 的 **MCP** 页面选择“导入并启用”后，系统把当前配置复制为 Agent 自己的 MCP。后续可以在 Agent 中单独编辑、检查、限制工具范围或删除，不会直接修改 Provider 的系统配置。MCP 值可以来自固定配置、创建 Session 时提供的参数，或 `agent_id`、`session_id`、`run_id`、`workspace_path`、`browser_profile_path` 等运行时值。敏感值加密保存，管理接口不返回明文。

### 并发与队列

进入 **系统设置 → 并发与队列**，可以在线调整：

- 全局 Run 并发；
- Webhook 投递并发；
- 项目环境构建并发。

设置保存在数据库中，修改后立即生效。提高上限会立即继续派发排队工作；降低上限不会取消正在运行的工作，只约束后续派发。系统始终保证同一 Session 的 Run 串行、同一外部 Conversation 串行、同一 Webhook 订阅按顺序投递，并合并同一项目环境的重复同步请求。

这些上限控制当前 Remote Agent Server 进程。项目当前按单进程部署设计，不提供跨多个服务实例的分布式并发配额。

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
| `MAX_CONCURRENT_RUNS` | 否 | `4` | 首次创建数据库时写入的全局 Run 并发默认值，范围 1–64。之后在系统设置中管理。 |
| `MAX_CONCURRENT_WEBHOOK_DELIVERIES` | 否 | `4` | 首次创建数据库时写入的 Webhook 投递并发默认值，范围 1–64。 |
| `MAX_CONCURRENT_ENVIRONMENT_BUILDS` | 否 | `1` | 首次创建数据库时写入的项目环境构建并发默认值，范围 1–64。 |
| `PROJECT_ENVIRONMENT_CHECK_INTERVAL_HOURS` | 否 | `3` | 远程仓库检查间隔。 |
| `PROJECT_PREPARE_TIMEOUT_MINUTES` | 否 | `30` | 单个仓库准备命令超时时间。 |
| `SESSION_RETENTION_HOURS` | 否 | `168` | 空闲 Session 的大体积存储保留时间；服务每小时清理 Workspace、浏览器数据和执行器原生会话，但继续保留 Session、Run、事件、外部接入记录与 Token 统计。设为 `0` 关闭。 |
| `RUN_TIMEOUT_MINUTES` | 否 | `60` | 单个 Run 的最大执行时间；超时后终止当前 Turn、释放执行器并将 Run 标记为 `run_timed_out`。 |
| `RUNTIME_IDLE_MINUTES` | 否 | `5` | 空闲执行器的驻留时间；到期后关闭 ACP/MCP 进程但保留 Provider 会话，下次 Run 自动恢复。设为 `0` 关闭。 |
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

## 文档

- [产品与架构](docs/design.md)：定位、系统边界、核心对象、执行链路和可靠性设计。
- [部署与验收](docs/deployment.md)：生产部署、Provider 登录、文件系统、反向代理和真实 Smoke Test。

## 许可证

本项目使用 [MIT License](LICENSE)。
