# Remote Agent Server 第一版设计

## 1. 目标

Remote Agent Server 是部署在 Agent 服务器上的远程执行服务。调用方可以选择一个 Agent 创建长期 Session，持续发送多轮消息，并实时查看 Agent 的回复和工具调用。

第一版支持 Claude Code、Codex 和 Hermes。底层通过 acpx/ACP 统一执行，不承载工单、审核、部署等业务工作流。

## 2. 第一版范围

第一版必须支持：

- 创建和配置 Claude Code、Codex、Hermes Agent。
- 创建 Session 并向 Agent 发送消息。
- 在同一 Session 中继续多轮对话，优先恢复原 ACP Session。
- 持久化 Agent 回复、工具调用、运行状态和错误。
- 通过 SSE 实时查看执行过程，断开后可以重新读取已有记录。
- 不同 Session 并行执行，同一 Session 串行执行。
- Agent 绑定系统维护的多项目环境；Session 从当时的不可变环境版本创建独立 APFS/Btrfs 可写快照。
- 在具有桌面环境的服务器上运行有头浏览器。
- 从具体 Agent 的目录加载原生 Skills 和简单 Memory 文件。

第一版不实现：

- 业务 Workflow 或 DAG。
- 多 Host 选择、SSH 部署和 Host 连接池。
- Redis、Sidekiq、独立 Worker 或独立 Runner daemon。
- Webhook、Outbox 和回调重试。
- 向量知识库、自动记忆和自动生成 Skill。
- Skill 市场、Skill 数据库和复杂版本管理。
- 服务重启后接管执行中的 Run。
- 容器或强安全沙箱。

## 3. 技术结构

项目采用一个仓库、一个服务进程和一个部署单元：

- Fastify：HTTP API 和 SSE。
- React + Vite：管理界面。
- SQLite WAL：Agent、Session、Run 和事件记录。
- acpx Runtime：Claude Code、Codex、Hermes 的 ACP 执行层。
- Btrfs 和本地文件系统：Workspace 快照、Skills、Memory、浏览器 Profile 和运行时目录。

服务内部只保留四个核心模块：

- `AgentManager`：Agent 配置和运行环境检查。
- `SessionManager`：Session 生命周期和多轮接续。
- `RunExecutor`：封装 acpx，执行、恢复和取消 Agent Run。
- `EventStore`：保存并读取执行事件。

业务代码只能通过 `RunExecutor` 使用 acpx，避免 acpx 的接口变化扩散到整个项目。

## 4. 数据模型

第一版只使用四张表。

### 4.1 agents

```text
id
name
provider          # claude_code / codex / hermes
enabled
created_at
updated_at
```

Agent 第一版只表示一个可选择的 Provider 档案：名称、Provider 类型和是否启用。Agent 的 Skills 和 Memory 使用第 8 节约定的文件目录。

模型、权限模式和 MCP 等 Provider 参数沿用 Claude Code、Codex、Hermes 各自的原生配置；API Key 等敏感凭证使用 `.env` 或 Agent CLI 自己的登录状态；Provider 执行命令在代码中固定映射。Workspace、仓库和浏览器目录属于 Session，并发数、数据目录和服务鉴权属于服务配置。

出现明确需求后再增加对应字段，不使用通用 JSON 配置承载未知参数。

### 4.2 sessions

```text
id
agent_id
title
status            # idle / running
provider_session_id
workspace_path
created_at
updated_at
```

Session 表示一个长期任务，拥有固定 Workspace、浏览器目录和 Provider Session。

### 4.3 runs

```text
id
session_id
status            # queued / running / succeeded / failed / cancelled
input
result
error
created_at
started_at
finished_at
```

一条用户消息对应一个 Run。Run 成功只表示 Agent 正常结束这一轮执行，不表示调用方的业务任务已经完成。

### 4.4 events

```text
id
run_id
seq
type              # message / tool / status / error
content_json
created_at
```

事件只追加，不修改。`seq` 用于 SSE 断线后的继续读取。

## 5. 执行流程

1. 用户选择 Agent 创建 Session，服务从 Agent 当前项目环境版本创建 APFS/Btrfs 可写快照。
2. 用户发送消息，服务创建 `queued` Run。
3. Session 空闲且未超过全局并发数时，Run 进入 `running`。
4. 服务将 Skills、Memory 和 Provider 配置放入已经准备好的 Session Workspace。
5. 有 `provider_session_id` 时通过 acpx 恢复原 Session，否则创建新 Session。
6. acpx 执行当前 Turn，服务将归一化事件写入 SQLite。
7. 页面通过 SSE 读取已保存的事件。
8. acpx 正常返回后保存最终回复，Run 进入 `succeeded`，Session 回到 `idle`。
9. 下一条消息创建新的 Run，并继续使用原 Provider Session。

同一 Session 只允许一个活动 Run。不同 Session 的总并发数由环境变量控制：

```env
MAX_CONCURRENT_RUNS=4
```

浏览器关闭、HTTP 请求结束或 SSE 断开都不终止 Run。

如果 ACP Session 恢复失败，本次 Run 进入 `failed`。用户可以明确重置 Agent 上下文后继续使用原 Workspace，服务不得静默创建新上下文并伪装成成功接续。

## 6. 项目环境、Workspace 和多仓库

管理员在“项目环境”页面登记一个或多个 Git 项目及可选准备命令。系统首次构建时 clone 项目并安装依赖，之后每三小时检查远程默认分支；只有构建全部成功才发布新的不可变环境版本。

Agent 绑定项目环境。创建 Session 时，服务固化 Agent 当时的环境版本，并通过 APFS Clone 或 Btrfs Snapshot 生成独立 Workspace：

```text
/srv/remote-agent/environments/<environment-id>/revisions/<revision-id>/workspace/
  example-service/
  example-web/
  bid-spiders/

/srv/remote-agent/sessions/<session-id>/
  workspace/     # 从不可变项目环境版本创建的独立副本
  runtime/       # ACP Provider 运行目录
  browser/       # 独立浏览器 Profile
```

Agent 启动时项目和基础依赖已经可用，自行判断任务涉及哪些项目。Session 创建不 clone 仓库、不安装基础依赖，也不创建 Git worktree。

项目环境发布新版本只影响之后创建的 Session；已有 Session 永远复用自己的 Workspace。第一版不提供环境池、仓库 MCP、任意分支选择或自动升级 Session。

## 7. 有头浏览器

Remote Agent Server 运行在有桌面环境的专用系统用户下。每个 Session 拥有独立的 `browser/` 目录，目录路径通过环境变量传给 Agent。

浏览器的启动、操作和关闭由各 Agent 的工具或 Skill 负责。第一版不实现浏览器调度、代理或 Profile 管理界面。

## 8. Skills、Memory 和知识库

Skills 和 Memory 属于具体 Agent，第一版使用文件目录：

```text
data/agents/<agent-id>/
  skills/
  MEMORY.md
```

每次 Run 开始前，服务将 `skills/` 中的内容同步到对应 Provider 的原生 Skills 目录。运行中的 Run 不接受 Skill 变更，文件修改从下一 Run 生效。

`MEMORY.md` 只保存长期稳定的事实、偏好和约束，由人工维护。执行轨迹保存在事件表中，不写入 Memory。

第一版不开发 Skills 和 Memory 编辑界面，也不集成 IWE。后续可以通过 MCP 增加 IWE 的 `search` 和 `read`，无需修改当前核心数据模型。

## 9. API

所有 `/api` 接口使用 `.env` 中配置的固定 Bearer Token 鉴权。第一版不实现用户、角色和权限系统。

第一版提供以下接口：

```text
GET  /api/agents
POST /api/agents
PATCH /api/agents/:id
GET  /api/agents/:id/doctor

GET  /api/sessions
POST /api/sessions
GET  /api/sessions/:id
POST /api/sessions/:id/reset

POST /api/sessions/:id/runs
GET  /api/runs/:id
POST /api/runs/:id/cancel

GET  /api/runs/:id/events
GET  /api/runs/:id/events/stream
```

调用方通过 Run 查询执行状态和最终结果。第一版不提供业务完成状态，也不主动回调调用方。

`reset` 只清除失效的 Provider Session ID，不删除 Workspace、历史 Run 和事件。

## 10. 管理界面

第一版只实现三个页面：

- Agent 页面：创建 Agent、配置 Provider 和检查运行环境。
- Session 列表：查看 Session、Agent 和当前状态。
- Session 详情：查看多轮消息、工具调用、错误和当前 Run，并继续发送消息或取消执行。

不实现工作流画布、Host 管理、知识库编辑器和复杂 Dashboard。

## 11. 故障处理

- Agent 或 acpx 异常：当前 Run 进入 `failed`，保存错误事件。
- ACP Session 无法恢复：当前 Run 失败，等待用户明确重置上下文。
- SSE 断开：Run 继续执行，客户端根据 `seq` 重新读取事件。
- 服务重启：`queued` Run 可以重新调度，原来处于 `running` 的 Run 标记为 `failed`。
- Run 失败后不自动重放用户输入，避免重复修改代码、重复提交或重复操作外部系统。

Session 的 Workspace 和 Provider Session ID 在 Run 失败后仍然保留。

## 12. 第一版完成条件

第一版完成必须通过以下实际流程验证：

1. Claude Code、Codex、Hermes 分别能够创建 Session 并完成一轮 Run。
2. 三种 Agent 都能够在同一 Session 中继续第二轮对话。
3. 页面能够实时展示回复、工具调用、状态和错误。
4. SSE 断开后能够继续读取未展示的事件。
5. 两个不同 Session 能够并行执行，同一 Session 不会并行执行两个 Run。
6. 新 Session 能够直接使用项目环境中的两个以上项目，并在后续 Run 中保留自己的代码和环境变更。
7. Agent 能够在独立浏览器目录下完成一次有头浏览器操作。
8. 服务重启后不会把中断的 Run 错误标记为成功，也不会自动重放。
