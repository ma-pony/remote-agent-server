# Remote Agent Server 产品与架构

[English](design.en.md)

## 1. 产品定位

Remote Agent Server 是一个面向业务系统的自托管 ACP Agent 执行网关。外部系统通过 HTTP 提交异步任务，服务在隔离 Workspace 中运行 Claude Code、Codex 等命令行 Agent，并通过状态查询、Event、SSE 或签名 Webhook 返回执行过程和结果。

项目服务于需要把 Coding Agent 接入现有系统的团队。典型调用方包括工单平台、CI/CD、运维后台、内部研发平台和自动化服务。调用方无需实现 ACP 进程管理、项目依赖准备、会话恢复、MCP 注入或执行记录存储。

Agent 的推理、工具和原生会话由 Provider 负责。Remote Agent Server 管理以下平台职责：

- Agent 与 Provider 配置；
- 项目环境准备和版本发布；
- Session Workspace 隔离；
- ACP Session 创建、恢复、取消和重置；
- Skills、执行器扩展和 MCP 投影；
- Run、Event、Token 用量和错误记录；
- 外部 Task、Conversation、SSE 和 Webhook；
- 进程内并发、队列和保留策略。

业务审批、工单状态机、代码审核规则和部署流程留在调用方。调用方使用 Task API 派发工作，并根据公开事件更新自己的业务状态。

## 2. 适用场景

- 工单系统把缺陷修复、排查或代码修改派发给指定 Agent。
- CI/CD 在构建失败后创建可追踪、可取消的 Agent Task。
- 内部平台统一管理多个 Coding Agent 的项目环境、MCP、Skills 和并发。
- 后端服务通过 Webhook 接收 Agent 最终回复和工具生命周期事件。
- 管理人员通过 Web 控制台直接创建 Session，进行多轮排查或开发。

## 3. 执行模型

```text
外部系统
   |
   v
接入端点（Endpoint Token / 参数映射 / 幂等）
   |
   v
Task -> Conversation -> Session -> Run -> acpx/ACP -> Provider
   |                         |                 |
   |                         |                 +-> Claude Code / Codex / Hermes
   |                         |
   |                         +-> Workspace / Skills / 执行器扩展 / MCP
   |
   +-> Task 状态 / Event 查询 / SSE / 签名 Webhook
```

HTTP 提交只负责创建 Task，成功响应使用 `202 Accepted`。Run 在后台排队和执行，调用方无需保持连接。Task 状态与 Event 历史是持久化事实；SSE 提供实时增量，Webhook 提供主动通知。

Web 控制台复用同一套 Session、Run 和 Event 模型。控制台创建的 Run 不经过外部 Endpoint，也不会产生业务 Task。

## 4. 核心对象

| 对象 | 职责 |
| --- | --- |
| 项目环境 | 保存一个或多个 Git 仓库、准备命令和当前可用版本。 |
| 项目环境版本 | 一次完整构建的结果；发布后作为 Session Workspace 的快照来源。 |
| Agent | 绑定 Provider、项目环境、指令、Skills、执行器扩展、MCP、模型策略和并发策略。 |
| Session | 一个隔离 Workspace 和一段可续接的 Provider 对话。 |
| Run | Session 中的一次输入、执行状态、结果和 Token 用量。 |
| Event | Run 产生的消息、工具、状态与错误记录，按 `seq` 追加。 |
| 接入端点 | 外部系统的认证与参数映射入口，固定绑定一个 Agent。 |
| Conversation | 调用方提供的业务会话键，负责复用 Session 并串行多轮 Task。 |
| Task | 外部系统提交的一次异步请求，调度后关联一个 Run。 |
| Webhook 订阅 | 按事件类型投递签名消息，并记录每次 Delivery。 |

这些对象使用公开数字 ID。Endpoint `slug` 和调用方的 `requestId`、`conversationKey` 承担外部业务标识职责。

## 5. 系统结构

服务采用单个 Node.js 进程和一个部署单元：

- **Fastify API**：管理 API、外部 Integration API、Event 查询与 SSE。
- **React 管理台**：Agent、项目环境、Session、MCP、Skills、执行器扩展、接入端点和系统并发设置。
- **SQLite WAL**：配置、队列状态、执行记录、外部 Task、Webhook Delivery 和 Token 统计。
- **acpx/ACP Runtime**：统一驱动 Claude Code、Codex 和 Hermes，并把 Provider 事件归一化。
- **Workspace 层**：macOS 使用 APFS Clone，Linux 使用 Btrfs Snapshot。
- **进程内调度器**：分别调度 Run、项目环境构建和 Webhook Delivery。

主要代码边界：

- `src/agents/`：Agent 配置、复制和运行检查。
- `src/project-environments/`：仓库同步、依赖准备、版本发布和清理。
- `src/sessions/`：Session 创建、重置、删除和大体积数据保留策略。
- `src/runs/`：Run 入队、并发控制、执行、取消和事件落库。
- `src/runtime/`：acpx/ACP 适配、Provider Session 与配置投影。
- `src/mcp/`、`src/skills/`、`src/provider-extensions/`：Agent 能力发现、选择和运行时投影。
- `src/integrations/`：Endpoint、Conversation、Task、公开事件和 Webhook。

业务模块通过 Runtime 接口使用 acpx，Provider 或 ACP 适配变化集中在 `src/runtime/` 内。

## 6. Agent 运行流程

### 6.1 管理台直接运行

1. 管理员选择 Agent 创建 Session。
2. 服务固化 Agent 当前项目环境版本，并创建写时复制 Workspace。
3. 用户发送消息，服务创建 `queued` Run。
4. Run 调度器检查全局、Agent 和 Session 并发约束。
5. 服务准备 Agent Provider Home，投影 Skills、执行器扩展和 MCP，并按当前 UTC 时间解析模型策略。
6. Runtime 创建或恢复 ACP Session；需要切换时通过 ACP 更新 Core 暴露的 `model` 配置，再发送本轮输入。
7. Provider 事件归一化后写入 Event Store，并实时提供给页面。
8. Runtime 返回后，服务保存结果和 Token 用量，更新 Run 与 Session 状态。

同一 Session 的 Run 严格串行。不同 Session 可以在全局和 Agent 上限内并行。

可选模型完全以 Agent Core 通过 ACP 返回的目录为准。Core 没有暴露模型列表时，Agent 只能使用 Core 默认行为。时间策略不改变 Session 生命周期，也不会为了切换模型创建新的业务 Session；实际模型写入 Run 记录。

### 6.2 模型发现、策略与审计

模型路由建立在 Agent Core 的 ACP 配置能力上，不维护一份脱离 Core 的全局模型表：

1. `GET /api/agents/:id/models` 使用 Agent 当前 Provider、指令和可用项目环境启动一次短生命周期探测，通过 ACP 状态读取 `currentModel` 和 `availableModels`，读取完成后关闭探测进程。
2. 管理台只允许从 `availableModels` 中选择。`PATCH /api/agents/:id` 保存策略前会重新发现目录；Core 不支持模型目录或模型已经下线时，服务拒绝固定/定时策略。
3. Run 在队列中不预选模型。执行器获得并发槽位、把 Run 标为 `running` 后，才按当前 UTC 时刻解析策略。
4. Runtime 创建或恢复同一个 ACP Session，并在发送本轮输入前应用解析出的 `model` 配置。模型切换不会创建新的业务 Session、Workspace 或 Conversation。
5. 明确解析出的模型写入 Run 的 `resolvedModel`，供 Session 页面、管理 API 和 Integration Task 查询审计。完全委托给 Core 且 Core 未公开默认模型时，该字段为 `null`。

Agent 的 `modelPolicy` 有三种格式：

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

`days` 是必填字段，使用 `mon`、`tue`、`wed`、`thu`、`fri`、`sat`、`sun`；每个时间段至少选择一天且不能重复。API 接受 `00:00` 至 `23:59` 之间的 UTC 24 小时制 `HH:mm`，起止时间不能相同。开始时间包含、结束时间不包含；结束早于开始时跨到下一 UTC 日，`days` 表示时间段开始的星期。同一个模型可以出现在多个时间段中。`maxConcurrentRuns` 可省略或设为 `null` 以继承 Agent 默认并发，也可以设为 1–64 覆盖该时间段的 Agent 上限；系统全局上限始终优先。未同时命中星期和时间时使用 `defaultModel` 和 Agent 默认并发；多个时间段重叠时配置中排在前面的优先。策略最多包含 16 个时间段。

管理台把连续且 `days`、`model`、`maxConcurrentRuns` 相同的时间段合并为一个规则组编辑，星期、模型和并发只设置一次，组内可以维护多个起止时间。保存时仍展开为上述 `windows` 协议，避免界面分组影响运行时解析和外部 API。

运行中的 Run 使用启动时已经解析的模型和并发槽位，不响应中途配置修改。排队中的 Run 则使用真正开始时的最新 Agent 策略和 UTC 时间。时间段切换会在下一 UTC 分钟边界重新触发队列调度；提高并发会继续启动排队 Run，降低并发不会取消已运行的 Run。这样时间策略不会因排队延迟而提前切换，也不会破坏同一 Session 的多轮上下文。

### 6.3 外部 Task

1. 调用方使用 Endpoint Token 提交 `requestId`、可选 `conversationKey`、消息和声明过的参数。
2. 服务在 Endpoint 范围内执行幂等检查。
3. Conversation 存在时复用其 Session；首次调用创建新 Session。
4. Task 入队后立即返回 ID，Integration 调度器随后创建 Run。
5. Run Event 被投影为公开 Integration Event，敏感工具参数和 Provider 私有字段不会暴露。
6. 调用方通过 Task 查询、Event 查询、SSE 或 Webhook 获取进度与结果。
7. Conversation 结束后保留历史记录；以后使用相同 Key 会创建新 Session。

相同 Conversation 的 Task 严格串行，避免多个 Run 并发修改同一个 Workspace 或 Provider 上下文。

## 7. 项目环境与 Workspace

项目环境把 Git 仓库和依赖准备从每次 Agent 执行中移出：

1. 构建器同步一个或多个仓库。
2. 依赖发生变化时执行准备命令；依赖指纹未变化时只更新源码。
3. 所有仓库准备成功后发布新版本。
4. Session 从当前版本创建 APFS Clone 或 Btrfs Snapshot。

Session 创建不重复 clone、`git clean` 或依赖安装。Workspace 是可写副本，Session 内的修改不会回写项目环境。项目环境同步失败时继续保留上一可用版本。

Python `uv` 项目使用可迁移虚拟环境。服务器要求 uv `>= 0.10.8`，在项目包含 `uv.lock` 时准备 relocatable `.venv`。

Session 保留策略只清理占用空间较大的 Workspace、浏览器数据和 Provider 原生会话。Session、Run、Event、外部接入关联和 Token 统计继续保留。

## 8. Agent 能力投影

每个 Agent 使用独立 Provider Home。服务从运行用户的 Provider 配置中发现可复用能力，再由管理员明确选择：

```text
系统 Provider 配置 -> 发现 -> Agent 选择 -> 下一次 Run 投影
```

- **Skills**：发现本机 Skill 或上传 ZIP，按 Agent 启用。
- **执行器扩展**：发现 Codex、Claude Code 插件和 Hook，按 Agent 投影。
- **MCP**：管理 HTTP 和 stdio Server、固定值、Session 参数、运行时参数、密钥和工具过滤。

Provider 的历史会话、日志和缓存不会复制到 Agent Provider Home。敏感值使用 `DATA_DIR/secret.key` 加密，管理 API 不返回明文。

配置变化从下一次 Run 生效。已有 Session 会刷新 Runtime 连接；Provider 支持恢复时继续原有 Provider Session。

## 9. 可靠性与并发

- 全局 Run、Agent Run、Webhook Delivery 和项目环境构建并发可以在线调整。
- Session 和 Conversation 内部串行执行。
- 同一 Webhook 订阅按顺序投递。
- 同一项目环境的重复同步请求会被合并。
- Event 先持久化再提供查询，`seq` 支持断线续读。
- SSE 连接断开不会取消 Run。
- Webhook 使用至少一次投递，接收方按稳定 `eventId` 去重。
- 服务重启后，排队任务继续调度；中断的 Run 标记失败且不自动重放输入。
- Provider Session 恢复失败时保留 Workspace 和历史，等待用户明确重建执行器会话。

当前并发控制属于单进程范围。多个服务实例不会共享运行配额，也不能同时操作同一个 SQLite 和 Workspace 根目录。

## 10. 安全边界

管理 API 使用全局 `API_TOKEN`。每个接入端点使用独立 Endpoint Token，服务端只保存哈希。Webhook 使用独立签名密钥和 HMAC-SHA256。

Agent 运行在服务操作系统用户权限下，可以执行命令、修改 Workspace、调用 MCP 和访问该用户能够访问的网络与文件。`approve-all` 是 Provider 交互策略，不是安全沙箱。生产部署必须使用专用无特权用户、可信仓库和 MCP，并把服务放在可信网络或 TLS 反向代理后。

## 11. 部署边界

当前版本面向单机、单进程、自托管部署：

- macOS 使用登录用户、APFS 和 LaunchAgent；
- Linux 使用专用服务用户、Btrfs 和 systemd；
- SQLite、加密主密钥、项目环境与 Session 根目录需要持久化；
- 有头浏览器依赖真实桌面或 X display。

具体命令、文件系统预检、Provider 登录和 Smoke Test 见[部署与验收文档](deployment.md)。

## 12. 当前范围

Remote Agent Server 当前专注于单机 Agent 执行网关。以下能力留给调用方或后续独立系统：

- 业务 Workflow、工单状态机和审批规则；
- 多主机调度和跨实例分布式配额；
- 不受信任租户的强安全沙箱；
- Agent 推理框架、模型路由和自研工具循环；
- Git 托管平台的业务规则和部署编排。

保持这些边界可以让外部系统通过稳定 API 使用现有 Coding Agent，同时保留各自的业务模型。
