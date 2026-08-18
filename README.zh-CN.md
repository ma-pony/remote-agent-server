# Remote Agent Server

[English](README.md)

Remote Agent Server 是一个部署在独立机器上的 Agent 控制与执行服务。它通过同一套 Web 界面和 HTTP API 管理 Agent、可复用项目环境、隔离的 Session Workspace、多轮 Run、Skills、MCP 服务器和外部系统接入。

执行层基于 [acpx](https://github.com/openclaw/acpx) 和 [Agent Client Protocol（ACP）](https://github.com/agentclientprotocol)。当前 Provider 适配器支持 Claude Code、Codex 和 Hermes。Session 会保存 Provider Session ID，后续 Run 可以继续同一段对话，同时每次执行仍有独立、可查询的记录。

## 主要能力

- **统一管理 Agent**：集中配置 Provider、Agent 指令、项目环境、Skills 和 MCP。
- **复用项目环境**：提前准备一个或多个 Git 仓库及其依赖，创建 Session 时不再重复安装。
- **隔离 Workspace**：macOS 使用 APFS Clone，Linux 使用 Btrfs Snapshot，快速创建写时复制的 Session 环境。
- **Session 多轮对话**：同一 Session 可以连续发送多个 Run，并在 Provider 支持时续接 ACP Session。
- **完整执行记录**：在 SQLite 中持久化消息、工具调用、状态、错误和最终结果。
- **MCP 管理**：同时支持 HTTP 和 stdio，支持固定值、Session 参数和运行时参数，并可在界面查看工具列表。
- **Skill 管理**：发现本机 Skills、上传 Skill 压缩包，并明确控制每个 Agent 启用哪些 Skills。
- **外部系统接入**：通过 HTTP 异步提交任务，支持查询、SSE、取消、会话复用和签名 Webhook。
- **有头浏览器**：服务可以运行在真实桌面会话中，不要求把 Agent 放进容器。

## 核心概念

| 概念 | 用途 |
| --- | --- |
| 项目环境 | 包含一个或多个 Git 项目及依赖的可复用、带版本环境。 |
| Agent | Provider、Agent 指令、项目环境、Skills 和 MCP 的组合配置。 |
| Session | 独立 Workspace 和一段可续接的 Provider 对话。 |
| Run | Session 中的一次用户输入及其完整执行记录。 |
| 接入端点 | 绑定 Agent 的外部系统入口，可映射 Session 参数。 |

外部请求的执行路径如下：

```text
HTTP 请求 -> 接入任务 -> Session -> Run -> acpx/ACP -> Provider
                              |
                              +-> SQLite 事件 -> 查询 / SSE / Webhook
```

SSE 不是必需依赖。调用方可以提交任务、保存返回的 `taskId`，然后轮询任务和事件接口；需要主动推送时再配置 Webhook。

## 运行要求

- 使用 APFS 的 macOS，或能让服务用户操作 Btrfs 的 Linux
- Node.js 22（`.nvmrc` 固定了已验证版本）
- 通过 Corepack 使用 pnpm 10
- Git
- 至少安装并登录一个 Provider CLI
- Agent 需要操作有头浏览器时，服务器必须有真实桌面或 X display

Remote Agent Server 不提供普通目录复制回退。启动时会检查项目环境和 Session 根目录是否满足 APFS 或 Btrfs 要求。

下面的命令假设存储目录已经准备完成。如果是新 macOS 或 Linux 主机，请先执行[部署文档](docs/deployment.md)中的文件系统准备步骤。

## 快速启动

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

把生成的随机值写入 `API_TOKEN`，并根据当前机器修改存储目录的绝对路径，然后启动服务：

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

打开 `http://127.0.0.1:3000`。Web 界面会要求输入 `API_TOKEN`，并且只把它保存在当前浏览器会话中。

程序不会自行读取 `.env`。使用 `pnpm start` 前需要先加载它，或者由进程管理器提供同名环境变量。

## 配置项

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `API_TOKEN` | 是 | 无 | 管理界面和 `/api` 使用的 Bearer Token。 |
| `HOST` | 否 | `0.0.0.0` | 监听地址；本机反向代理场景建议使用 `127.0.0.1`。 |
| `PORT` | 否 | `3000` | HTTP 端口。 |
| `DATA_DIR` | 否 | `/srv/remote-agent/data` | 运行数据和加密主密钥目录。 |
| `DATABASE_PATH` | 否 | `/srv/remote-agent/data/remote-agent.sqlite3` | SQLite 数据库路径。 |
| `WORKSPACE_TEMPLATE` | 否 | `/srv/remote-agent/template/workspace` | 旧版全局 Workspace 的一次性导入来源。 |
| `PROJECT_ENVIRONMENTS_ROOT` | 否 | `/srv/remote-agent/environments` | 不可变项目环境版本目录。 |
| `SESSIONS_ROOT` | 否 | `/srv/remote-agent/sessions` | 独立 Session Workspace 目录。 |
| `MAX_CONCURRENT_RUNS` | 否 | `4` | 同时执行的 Run 数量上限。 |
| `PROJECT_ENVIRONMENT_CHECK_INTERVAL_HOURS` | 否 | `3` | 远程仓库定时检查间隔。 |
| `PROJECT_PREPARE_TIMEOUT_MINUTES` | 否 | `30` | 单个仓库准备命令的超时时间。 |
| `DISPLAY` / `XAUTHORITY` | 浏览器场景 | 无 | 有头浏览器使用的桌面或 X display。 |

服务首次启动会创建权限为 `0600` 的 `DATA_DIR/secret.key`。该 AES-256-GCM 主密钥用于加密 MCP 敏感值、接入端点固定参数、Webhook 凭证和 Session 敏感参数。请把它和 SQLite 数据库一起备份；主密钥丢失后，已有密文无法恢复。

## 首次使用流程

1. 创建一个**项目环境**。
2. 添加一个或多个 Git 仓库，并按需填写各仓库的准备命令。
3. 点击**立即同步**，等待项目环境生成可用版本。
4. 创建 **Agent**，选择 Provider 和项目环境，填写 Agent 指令。
5. 启用或上传 Agent 需要的 Skills。
6. 添加 HTTP 或 stdio MCP，并执行连接检查。
7. 创建 **Session**，发送第一条消息。

项目环境同步会构建一个新版本，所有仓库准备成功后才会发布。已有 Session 继续使用创建时的版本；新 Session 使用最新可用版本，并通过 APFS 或 Btrfs 写时复制创建独立 Workspace。

## Provider 与 PATH

Provider CLI 必须由运行服务的同一个操作系统用户安装并登录。例如：

```bash
claude login
codex login
claude --version
codex --version
```

服务启动时会读取登录 Shell 的 PATH，再与当前 Node 目录和进程 PATH 合并去重。因此 LaunchAgent 和 systemd 可以找到 Homebrew、NVM、pnpm 或用户目录中安装的工具，不需要在应用配置里重复维护整条 PATH。

每个 Agent 都有独立的 Provider Home。服务只复用必要的原生登录状态，不会把主机上的 Skills 隐式注入 Agent。

## Skills

Skill 目录会发现 Codex、共享 Agent、Claude 和插件目录中兼容的 `SKILL.md`，也可以在 Agent 页面上传 ZIP 压缩包。启用 Skill 会把它复制到受管理的 Agent Home；停用只删除系统管理的副本。

Skill 变更从下一次 Run 开始生效。对于可续接的 Session，运行时会刷新 Provider Handle，同时保留 ACP Session ID。

## MCP 服务器

每个 Agent 可以配置多个 MCP：

- **HTTP**：URL 和 Headers
- **stdio**：命令、Arguments 和 Environment

每个可配置值可以来自：

- 服务保存的固定值；
- 创建 Session 时提供的已声明 Session 参数；
- `agent_id`、`session_id`、`run_id`、`workspace_path`、`browser_profile_path` 等运行时值。

敏感固定值和 Session 参数会加密保存，管理接口不会返回明文。使用**检查连接**验证解析后的配置；检查成功后，点击工具数量即可查看 MCP 当前公开的全部工具。

## 管理 API

除 `/api/health` 外，所有管理接口都要求服务器 API Token：

```bash
curl http://127.0.0.1:3000/api/agents \
  -H "Authorization: Bearer $API_TOKEN"
```

Web 界面也使用同一组 `/api` 接口管理 Agent、项目环境、Session、Run、MCP 和外部接入。

## 外部接入 API

先在 Web 界面创建接入端点，选择 Agent，映射所需 Session 参数，并复制只展示一次的端点 Token。外部请求使用端点 Token，不使用管理端 `API_TOKEN`。

端点 Token 不能调用管理接口，但可以向拥有工具权限的 Agent 发送指令，因此它只适合发放给受信任的调用系统，不能作为不受信任租户之间的安全隔离。Provider 登录状态以及服务用户可读取的文件都属于 Agent 的信任边界。Provider 进程和项目准备命令不会继承管理 Token 或验收脚本 Token。

异步提交任务：

```bash
curl -X POST http://127.0.0.1:3000/integration/v1/endpoints/example/tasks \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "request-001",
    "conversationKey": "issue-42",
    "message": "检查仓库并说明失败的质量检查。",
    "parameters": {}
  }'
```

`requestId` 是幂等键；相同输入重复提交会返回同一个任务。`conversationKey` 可选，相同 Key 的后续任务会继续同一个 Session，直到调用结束会话接口。

查询任务状态和事件：

```bash
curl http://127.0.0.1:3000/integration/v1/tasks/$TASK_ID \
  -H "Authorization: Bearer $ENDPOINT_TOKEN"

curl "http://127.0.0.1:3000/integration/v1/tasks/$TASK_ID/events?afterSeq=0" \
  -H "Authorization: Bearer $ENDPOINT_TOKEN"
```

可选 SSE 实时流：

```bash
curl -N "http://127.0.0.1:3000/integration/v1/tasks/$TASK_ID/events/stream?afterSeq=0" \
  -H "Authorization: Bearer $ENDPOINT_TOKEN"
```

SSE 会发送心跳，并可使用 `afterSeq` 断线续传。断开 SSE 不会取消任务。生产环境即使使用 SSE，也应保留任务查询接口作为长时间执行和网络断线时的恢复方式。

## Webhook

接入端点可以把任务、消息、系统通知和工具事件推送到 HTTP(S) 地址。服务会持久化投递记录并自动重试。请求包含以下 Header：

- `X-Remote-Agent-Event`
- `X-Remote-Agent-Event-Id`
- `X-Remote-Agent-Timestamp`
- `X-Remote-Agent-Signature: v1=<十六进制摘要>`

签名是下列原文的 HMAC-SHA256：

```text
<timestamp>.<未经修改的请求 Body>
```

签名 Secret 只在创建或轮换订阅时展示一次。接收方应设置合理的处理超时，并按 Event ID 幂等处理重复请求。

## 开发与验收

```bash
pnpm test
pnpm typecheck
pnpm build

# 需要已经配置好的真实 Provider
pnpm smoke:providers

# 需要已启动的服务、管理 Token 和可用 Agent
pnpm smoke:integrations
```

## 部署

[docs/deployment.md](docs/deployment.md) 包含 macOS APFS/LaunchAgent、Linux Btrfs/systemd、有头浏览器、备份和真实 Provider 验收步骤。

生产环境建议遵循以下边界：

- 使用无特权的专用用户运行服务；
- 只在可信网络开放，或放在 TLS 反向代理后；
- 不要用 root 运行 Node，也不要授予宽泛的文件系统能力；
- 不要把 `.env`、`secret.key`、SQLite 数据库、Provider 登录状态和 Session Workspace 提交到 Git；
- 把 Agent 命令、仓库代码、MCP 工具和浏览器权限视为受信任的执行输入。
