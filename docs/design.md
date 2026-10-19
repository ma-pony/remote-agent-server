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
   |                         |                 +-> Claude Code / Codex / Hermes / DeepSeek Harness
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
- **acpx/ACP Runtime**：统一驱动 Claude Code、Codex、Hermes 和 DeepSeek Harness，并把 Provider 事件归一化。
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

acpx 0.16.0 负责 ACP 后代进程的身份校验、退出信号和有界清理。项目只保留一个补充补丁：在初始化、创建、加载和恢复 Session 的请求尚未结束时，每 100 ms 采集后代进程，降低桥接进程先崩溃后丢失父子关系的风险。采样生命周期由上游 `ProcessDescendants` 的本地扩展管理，请求结束或进程清理完成即停止；`AcpClient` 只提供操作边界，不改变进程组或信号继承方式。维护及移除条件见 [acpx 补丁说明](../patches/README.md)。

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

在 Runtime 初始化或附件准备期间收到取消时，执行器在准备返回后释放 Runtime Session，再将 Run 标记为取消，不启动模型轮次；业务 Session、Workspace 和已保存的 Provider 会话标识保留。管理台按 Session ID 创建页面状态，切换会话后旧操作的响应不能追加历史、清空新草稿或改变新会话的发送状态。

可选模型完全以 Agent Core 通过 ACP 返回的目录为准。Core 没有暴露模型列表时，Agent 只能使用 Core 默认行为。时间策略不改变 Session 生命周期，也不会为了切换模型创建新的业务 Session；实际模型写入 Run 记录。

### 6.2 模型发现、策略与审计

当前实现固定一个 Agent Core，仅在该 Core 内选择模型。允许同一 Agent 按时间切换 Core、模型和并发的后续架构已记录在 [Agent Core 与模型运行路由设计提案](agent-core-routing.md)；该提案尚未实现，不代表当前 API 行为。

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

Webhook 投递列表的 `latest` 摘要从当前端点的当前订阅页出发，利用 `webhook_deliveries(subscription_id, created_at DESC, id DESC)` 覆盖索引为每个订阅定位一条记录，再按主键读取详情。无投递的订阅不返回摘要，列表筛选和分页不影响摘要。避免从历史投递逐行执行相关子查询和排序，防止同步 SQLite 查询长时间占用事件循环。启动迁移为新库和旧库幂等创建此索引。

### 6.4 原生 Webhook 入库

`WebhookIngress` 是 GitHub 和 GitLab 共用的接收组件。公开入口 `/integration/v1/endpoints/:slug/webhook` 在独立 Fastify 作用域内保留原始请求体，支持 JSON 和 GitHub 表单 `payload`；其他 API 的 JSON 解析不变。端点的接收器配置保存在 `integration_webhook_receivers`，一端点一条配置，Secret 通过现有 SecretStore 加密，删除端点时级联删除。

接收顺序是：查找端点和来源配置 → 使用原始请求体验证 GitHub HMAC-SHA256 或校验 GitLab 签名 / Token → 检查启用状态 → 校验事件类型、投递 ID 和 JSON 对象 → 查重 / 评估并保存筛选决定 → 命中时将载荷路径映射成已声明参数 → 调用 `IntegrationCoordinator.submit`。GitHub `ping` 只返回确认。正常事件使用带平台前缀的投递 ID 作为 `requestId`，以事件类型和默认载荷作为消息，复用现有事务入库、幂等锁、Session 创建、队列、事件投影及重启恢复。可合并的 MR / PR 默认先持久化待派发批次，其他事件或关闭合并时直接创建 Task。`202` 的 `status: pending` 表示事件已保存、尚未创建 Task，其余响应沿用 Task 契约。

MR / PR 默认合并，每批对应一个 Task/Session；关闭合并或其他事件类型逐次创建，不推断 PR/MR 会话。重复 ID 携带相同输入复用原 Task，不同输入返回幂等冲突。GitLab 优先使用 `webhook-id`，其次 `Idempotency-Key`，最后 `X-Gitlab-Webhook-UUID`。旧版 GitLab Token 请求在三个头全部缺失时，适配器允许缺省投递 ID；接收层复用已有消息指纹，生成 `sha256:<指纹>`，统一用于接收记录和带平台前缀的 `requestId`。指纹是平台、事件类型和 `JSON.stringify` 完整载荷组成的消息的 SHA-256；忽略 JSON 缩进，但不排序对象字段或数组元素。提供了 ID 头却没有任何有效值时仍拒绝请求，GitHub 和 GitLab 签名模式仍强制要求各自的 ID 头。

生成 ID 的事件重投、并发投递和重启恢复沿用现有持久化筛选决定及 Task 幂等流程。内容变化产生新 ID 并重新筛选；同一端点内容完全相同的独立事件无法与重投区分，会复用原决定或 Task。参数映射只读取载荷自身的点分路径，标量值转换为字符串；必填参数验证继续由现有 Endpoint Manager 负责。

GitLab 配置为 `authMode: signature` 时校验 Signing token（`whsec_` 前缀）：Base64 解码密钥，对 `webhook-id.webhook-timestamp.原始请求体` 计算 HMAC-SHA256，再与 `webhook-signature` 中的候选签名作常量时间比较，并限制时间偏差为 5 分钟。此模式不允许明文 Token 降级；`authMode: token` 明确使用 `X-Gitlab-Token` 校验，Secret 文本不决定认证策略。

管理 API 返回来源、验证方式、启用状态、`secretConfigured`、`filter`、`filterVersion` 和 `debounceSeconds`。省略 Secret 的更新保留原密文，切换平台或验证方式需要新 Secret。停用接收器会拒绝后续入站请求并暂停待派发批次，已入库任务继续由现有调度器负责。原生载荷作为用户输入进入 Task 消息及其既有用户消息事件；鉴权头和接收 Secret 不进入消息或公开事件。

筛选配置存于接收器的 `filter_json` / `filter_version`，旧库启动迁移默认不筛选。每个有效投递在 `integration_webhook_receipts` 中以 `(endpoint_id, provider, delivery_id)` 唯一保存首次决定、事件类型、消息 SHA-256、规则版本和时间；不另存原始载荷或秘密。认证、启用检查、解析失败不创建记录。同一 ID 的内容指纹冲突返回 409；忽略结果返回 200，已入库结果返回 202。版本只在平台或规则改变时递增，新的规则只影响新的投递。

决定写入发生在 Session I/O 前，忽略事件至此结束。未合并事件通过现有 Coordinator 入库；同进程的重复投递共享正在进行的入队 Promise。两阶段通过现有确定性 `requestId` 恢复：进程在创建 Task 前退出，平台重试沿用已保存决定再次尝试；Task 已提交时退出，重试直接返回该 Task，不重新解析参数或触发运行。接收记录通过该键关联 Task，无需额外回填事务。入库失败保留放行决定，管理页显示尚未入队并等待平台重试。启用合并的批次则由后台自动重试。升级前已存在的原生 Task 优先保留其放行事实。

决定元数据跟随端点删除级联清理，不跟随 Session 存储清理；查询最近 30 条，不返回指纹、原始载荷、规则比较值或认证信息。预览是受管理鉴权保护的纯操作，可检查未保存规则并返回条件路径、匹配状态及缺失 / 类型 / 值不符原因。接收 ID 去重不等于 MR 版本或评论去重，后者属于具体审核流程。

#### MR / PR 静默合并

接收器的 `debounce_seconds` 默认 60，管理接口允许 0–300 秒，设为 0 可关闭。旧库首次增加该列时默认开启 60 秒；重复迁移和同平台省略字段的更新保留已保存值（包括 0），新建或切换平台时省略字段使用 60。适配器为有效 MR / PR 输出可选的 `coalescingKey`：仓库 URL 的 origin、仓库 ID 和 MR / PR 编号；GitLab 读取 `project` / `object_attributes.iid`，GitHub 读取 `repository` / 顶层 `number`。缺少可靠身份时沿用立即入库流程。分组另包含端点和来源，避免跨项目、平台实例或端点混入。

`IntegrationStore.enqueueWebhookBatch` 在同一 SQLite 事务中保存 receipt 的 `batch_id` 和 `integration_webhook_batches` 中加密的消息/映射参数快照。只有新的命中投递可以覆盖 pending 批次的载荷，并把 `due_at` 更新为最后接收时间加静默期，最大不超过首次接收后 5 分钟。重复投递先读取原 receipt，不改变窗口；未命中事件不覆盖、不延期、不取消既有决定。已经到期的批次冻结为 dispatching，后续事件创建新批次；按接收顺序选最后载荷，不推断 SHA 新旧或拉取平台当前状态。

`WebhookBatchDispatcher` 随应用启动和关闭，订阅事务提交后的接收与配置变更通知，只为最近到期的可派发批次设置定时器；空闲或全部暂停时不轮询。每轮按到期索引读取最多 10 个批次，一次只执行一个 drain。派发前重新读取状态、期限和启用配置，先冻结载荷，再复用 Coordinator 创建 Task。批次持久化的随机 `webhook-batch:<UUID>` 请求键保证崩溃后重试幂等；Task 已提交但完成标记失败时，恢复先查找原 Task。成功后置 completed 并清除加密快照；入库失败保留冻结载荷、记录固定错误码并在 30 秒后自动重试。不会自动重跑已经入库但运行失败的 Task。关闭时停止定时器并等待当前 drain 完成。

端点/接收器停用，或当前来源与批次不同时暂停派发，恢复相应配置后自动继续。关闭合并只影响新事件，已接收批次继续处理。批次和 receipt 元数据随端点删除级联清理；完成后的关联元数据不随 Session 存储清理删除，防止旧投递再次创建任务。管理接收记录通过批次请求键关联同一个 Task，返回等待状态、计划时间和固定错误码，不返回加密载荷；预览仍只求值筛选规则。

字段间比较使用 `{field, op: "eq" | "neq", valueField}`，与原有 `{field, op, value}` 严格互斥；两侧共用受限路径解析器，仅访问 `eventType` / `payload` 自有属性。仅同类型标量（含 `null`）参与比较，任一侧缺失、类型不符或解析为数组/对象时均不匹配，包括 `neq`。不做字符串路径插值、类型转换或深比较。规则沿用接收器 JSON 配置和版本机制，不增加数据库迁移；管理保存、预览和入站共用 schema / 求值器。预览条件只增加可选的 `valueField` 路径，不返回解析出的值；已有固定值条件和投递首次决定保持原语义。

### 6.5 Webhook 扩展边界

- 路由只负责 HTTP 传输、原始字节、管理鉴权、输入校验和错误映射。
- `webhook-adapters/` 中的 `WebhookAdapter` 负责来源协议：声明支持的验证方式、校验 Secret、验证请求、输出统一的事件类型、投递 ID 和载荷；仅来源协议允许时可缺省 ID，由接收层根据内容生成。连接测试可返回忽略原因。适配器不访问数据库、不创建 Session、不启动 Agent。
- `webhook-filter.ts` 定义受限规则契约和纯函数求值器，前后端共用验证；`all/any` 组合标量比较、存在判断及数组包含 / 不包含判断，缺失和类型错误不会通过负向比较。`not_contains` 要求数组每个元素存在且与比较值同类型，空数组匹配；通配提取中任一元素字段缺失或类型不符时不放行。字段路径只读事件与载荷自有属性，允许一次数组通配。预览与入站使用同一求值器。
- 适配器目录同时声明字段提示与审核预设，UI 不硬编码平台规则。
- `review-presets.ts` 复用平台的开启、草稿和代码变化条件，提供普通审核预设与显式标签审核预设。后者要求当前有 `CodeReview` 且无 `Done-Pass`，并接收从不满足标签条件到满足条件的更新：GitLab 比较 `changes.labels.previous` 与当前标签，GitHub 检查变动动作和标签名。未知历史标签不视作新增标签。预设仅生成现有 DSL，不扩展接收器持久化或任务调度；已有规则需显式重新选择并保存，当前仍不满足标签条件的事件不会放行。
- `WebhookIngress` 负责接收配置、筛选决定、已声明参数提取和调用现有 Coordinator。Task 的事务、幂等、Session、并发、取消和恢复由原有组件统一管理。

新增来源时实现适配器、加入静态注册表和来源类型，并添加原生请求测试。管理平台目录从注册表生成，前后端共用接收配置类型；数据库的来源与验证方式列保存字符串，具体支持范围由适配器校验，因此新增来源不需要新增业务表或修改 Task 调度。这里不提供运行时加载插件、自定义脚本或通用工作流引擎。

## 7. 项目环境与 Workspace

项目环境把 Git 仓库和依赖准备从每次 Agent 执行中移出：

1. 构建器同步一个或多个仓库。
2. 依赖发生变化时执行准备命令；依赖指纹未变化时只更新源码。
3. 所有仓库准备成功后发布新版本。
4. Session 从当前版本创建 APFS Clone 或 Btrfs Snapshot。

Session 创建不重复 clone、`git clean` 或依赖安装。Workspace 是可写副本，Session 内的修改不会回写项目环境。项目环境同步失败时继续保留上一可用版本。

Python `uv` 项目使用可迁移虚拟环境。服务器要求 uv `>= 0.10.8`，在项目包含 `uv.lock` 时准备 relocatable `.venv`。

Session 保留策略清理占用空间较大的 Workspace、浏览器数据、Provider 原生会话，以及通过 Task 关联的全部 Webhook 投递记录。投递删除与 `storage_cleaned_at` 写入在同一个收尾事务中完成，失败回滚，重启后可幂等恢复。已清理的投递停止重试；晚到的投递结果不会重建记录，显式投影修复跳过已清理 Session。启动恢复仍可补齐 Task 状态和公开事件，但不会为已清理 Session 新建投递。Session、Run、Task/Conversation 关联、公开事件和 Token 统计继续保留；Run 原始消息／工具事件遵循独立保留策略。无 Task 的测试投递不受影响，重置上下文保留投递记录。

清理资格依据空闲 Session 的 `updated_at`，并排除仍有 queued/running Run 的 Session。清理器取出候选列表后，在取得占用的同一事务中再次检查截止时间，防止等待其他目录删除期间发生的新活动被忽略。重启恢复只为被中断的 running Run 更新所属 Session 的活动时间；已空闲或已清理的 Session 不因重启延长保留期。Run 终态、错误事件和 Session 恢复在同一事务内写入，重复恢复不会再次刷新活动时间。

Session 使用可空的内部字段 `pending_operation` 持久化 `cleanup`、`delete` 或 `reset`。标记与 `running` 占用状态一起提交后才执行外部操作；进程内还会拒绝同一 Session 的并发维护。正常完成与重启恢复复用事务性收尾逻辑，验证操作类型、占用状态和无活动 Run 后，才清除标记或删除记录。一般 Run 恢复不会释放带维护标记的 Session。

启动时先重试创建中断的目录清理，再恢复维护操作，最后恢复和调度 Run。清理或删除未完成时保留标记与占用；已开始的存储清理在后续清理轮次重试，不受新的保留期或关闭自动清理影响，删除可由原删除接口重试。创建失败的补偿与启动恢复都在目录删除成功后才移除 pending Session 记录。重置恢复清除旧 Provider/ACP 本地会话，保留 Workspace、Run 历史与独立用量账本；随后新 Run 创建新的 Provider 上下文。

构建与启动分离，`pnpm start` 只运行已构建产物。Run 恢复和队列按状态索引读取，Integration 恢复从 queued/running Task 查找需要补齐状态的 Run；必要恢复完成后才开放监听。

旧用量导入使用仅含计数与关联字段的覆盖索引，通过原有事件去重键过滤已导入快照，不读取 Session 指令或 Run 输入／结果。晚到的非空计数仍可导入，零值、未知语义和历史证据保留原口径。估算字典的 `estimate_id` 列与历史转换在同一事务内提交，列存在即表示迁移完成，不再每次扫描归因表验证空值。回补版本升级从待升级记录的稀疏索引出发，按主键检查对应 Run，保留已清理事件的排除条件与词表重算规则。

## 8. Agent 能力投影

每个 Agent 使用独立 Provider Home。服务从运行用户的 Provider 配置中发现可复用能力，再由管理员明确选择：

```text
系统 Provider 配置 -> 发现 -> Agent 选择 -> 下一次 Run 投影
```

- **Skills**：发现本机 Skill、上传 ZIP 或刷新 Git/marketplace 来源，按 Agent 选择内容版本。
- **执行器扩展**：发现 Codex、Claude Code 插件和 Hook，按 Agent 投影。
- **MCP**：管理 HTTP 和 stdio Server、固定值、Session 参数、运行时参数、密钥和工具过滤。

原生插件提供的 Skills 归所属插件管理，启用状态来自当前 Agent 的执行器扩展选择，版本跟随宿主当前发现的插件包。技能目录列表与运行时投影共用有界的 manifest/Skills 读取逻辑，身份为 `plugin-skill:<provider>:<plugin-id>:<package-relative-path>`，不依赖缓存版本目录。技能页返回 `managedByPlugin: true`、所属插件的 `sourceId` / `packageName` 与 `pluginVersion`；独立启停、删除、版本预览、应用或 ZIP 替换接口返回 `409 skill_managed_by_plugin`，统一通过执行器扩展管理。插件来源缓存默认最多 30 秒，Codex 和 Claude Code 均将所选插件文件树纳入扩展指纹；同版本内容或技能清单变化也会在下一次 Run 刷新 Runtime Handle，并保留 Provider Session 上下文，运行中的 Session 投影保持原内容。

旧 `source: plugin` 副本通过已记录的插件标识和 Skill 名称匹配当前 Agent 已启用、可用且唯一的原生技能，确认后在下一次 Run 接管并清理该 Session 的旧托管入口。接管以原子、幂等的目录标记保存在 `agents/<id>/skills/.plugin-managed/<legacy-skill-id>/`，随 Agent 克隆及备份保留；插件之后停用或移除也不恢复该旧选择。缺少归属、匹配不明确、没有可用或已选替代，以及 Hermes 场景，继续展示和投影旧副本，返回 `legacyPluginCopy: true` 并允许独立管理。运行前只读取已选插件的技能，不由未选插件触发接管。Agent 副本和不可变版本历史保留，既有插件选择不自动启用或变更，不删除 Session/Run 元数据与用量统计。Git 来源导入的插件 Skills 仍是 `source: git`，继续由独立版本选择流程管理。

Codex 的原生插件投影将当前 Agent 选中的包发布到 `agents/<id>/provider-home/codex/shared-plugins/` 下的本地 marketplace 快照；快照先在临时目录生成，再原子发布。它同时预先生成真实插件版本目录，避免 Codex 启动时的本地 marketplace 缓存刷新忽略仅在配置中声明的来源。Session 的 `config.toml` 只声明这些本地 marketplace，`plugins/cache` 链接到 Agent 级、按所选插件内容版本划分的 `plugin-caches/<revision>/`。默认情况下 `.tmp` 链接到 Agent 级内置市场同步目录，Session 共用市场仓库、版本标记和同步锁；显式启用 rollout 压缩时，该 Session 保留独立 `.tmp`。插件文件树元数据指纹会改变快照及内部缓存版本，同版本内容更新可在发现缓存刷新后的下一次 Run 生效。旧 Session 的独立插件缓存在重新准备时移除；未启用压缩的 Session 也会移除旧临时克隆。不再被 Session 引用的旧快照、缓存及中断发布留下的临时目录延迟清理。

Codex 也在 `.tmp` 中保存 rollout 压缩锁。启用压缩的 Session 使用独立 `.tmp`，避免其他 Session 的锁跳过本会话的压缩；代价是 Codex 内置市场仓库可能在这些 Session 各保留一份。各 Session 的 rollout 文件仍保存在自己的 Home 中。

DeepSeek Harness（`deepseek_harness`）通过同一 acpx Runtime 调用已安装的 `dsh --profile acp`。每个 Session 独占 `agents/<id>/provider-home/deepseek-harness/sessions/<sessionId>` 作为 `DSH_HOME`。准备阶段只复制 `.credentials.yaml`、`.env`、Home 级补丁和宿主 ACP profile，不复制其他会话与 `storages/`。旧版 `settings.yaml` 在 ACP 启动前转换为会话内 ACP Profile 的配置补丁，避免原生异步迁移晚于首次模型校验；保留宿主文件和 Profile 中的 YAML 表达式，Home 级补丁仍优先于 Profile。最后一层 CLI 补丁通过原生 system-prompt section 原样注入 Agent 指令、Workspace 路径与 Memory，保留原生提示词；关闭默认 Skill 根目录，只提供 Workspace 的 `.dsh/skills` 和 `.agents/skills`。服务选中的 Skills 投影至 `.agents/skills`。

acpx 通过 ACP `session/resume` 续接已持久化的 DSH 会话。模型选择与 HTTP / stdio MCP 沿用现有 ACP 合同；队列、取消、超时和进程树归属不变。重置或闲置存储清理只删除目标 Session Home，后续准备重新恢复凭据和配置。DSH 原生扩展选择与全局 MCP 导入暂不支持。ACP 上下文占用与累计 token 独立保存，DSH 未上报的累计用量保持未知。旧数字 ID 数据库通过事务仅重建 Agent 表的 Provider CHECK 约束，保留 ID、外键引用和自增序列。

初始化 Provider Home 时排除宿主的历史会话、日志和缓存，以及 Codex 的 `app-server-daemon` 和 `app-server-control` 运行态目录，避免复制 daemon 的 socket 和元数据。升级旧业务会话时，Hermes 仅迁移目标会话及其父链，见下文。服务通过管理接口保存的敏感配置使用 `DATA_DIR/secret.key` 加密，管理 API 不返回明文；原生 Provider 的认证文件继续使用其自身格式。

配置变化从下一次 Run 生效。已有 Session 会刷新 Runtime 连接；Provider 支持恢复时继续原有 Provider Session。

模型目录探测使用独立临时 Provider Home 和 acpx 存储，不创建业务 Session。探测结束后释放 ACP 连接并删除临时目录，不要求 Provider 实现 `session/close`，也不触碰业务会话历史。

Codex ACP `2.2.2` 复用上游的 MCP 启动任务、会话关闭清理和线程级分页查询，仅保留平台的就绪阻断策略。新建、加载和恢复 Provider Session 时，对已选 MCP（包括 Codex 配置提供的同名项）查询当前线程的 `runtimeStatus`，全部为 `connected` 才允许 prompt 启动模型请求；缓存的 `serverInfo` 或提前到达的启动通知不代表连接就绪。明确的 `failed`、`disabled`、`authenticationRequired` 立即失败；暂态 `cancelled` 等未就绪状态继续等待。即使状态查询无响应，启动等待也在 30 秒内结束并阻断 prompt；底层未决 RPC 随 Runtime 关闭 ACP/app-server 进程释放。结果在 Provider Session 关闭前保留，后续 prompt 不能绕过失败；重新打开或 app-server 自动重启恢复后重新检查。取消中的 prompt 不启动模型请求，关闭会话会中止等待并清理定时器。未选择 MCP 时不等待。

Git 来源的稳定身份来自配置的 URL、ref 和子目录；Skill 身份还包含插件标识和包内路径。刷新操作在进程内串行，使用有截止时间、可取消并回收进程树的 Git 命令。发布前验证路径、文件类型和内容大小，来源索引原子替换，失败保留上一可用版本。来源仓库与 marketplace 引用的插件仓库分别记录实际 commit，外部插件未指定 ref 时跟随自身 HEAD。

Claude marketplace 的默认严格模式合并插件 manifest 与 marketplace 条目的 Skills 声明，并包含默认 `skills/`；当条目指向 marketplace 根目录且明确选择子路径时，仅导入所选路径。`strict: false` 与插件自身 Skills 声明冲突时提示并保留该插件的上一可用版本。Codex 插件按显式声明选择目录，没有声明时才使用默认目录。普通仓库递归发现 Skills；不支持的源类型会显示提示。

完整包限制为 50 MiB、10,000 个目录项和 32 层深度；不分发包内符号链接或特殊文件。来源 manifest 限制为 1 MiB，marketplace 最多 1,000 个插件条目。

差异列表只返回文件状态、`beforeBytes` / `afterBytes`（缺失一侧为 `null`）、权限、`preview` 类型及 `previewLimitBytes`，不内嵌文本。文本通过单文件接口按需加载：每侧最多 1 MiB，使用 Git 在私有临时目录中比较固定名称的内容副本，禁用外部 diff、textconv 和继承的 Git 配置，命令最多执行 5 秒，完成、失败或取消时回收进程树和临时文件。返回带 3 行上下文的差异片段，最多 64 KiB，并以 `truncated` 标记截断；没有跨文件总额度。无法预览的类型分别为 `binary`（含 NUL）、`unsupported_encoding`（非 UTF-8）和 `too_large`。单文件请求必须携带列表返回的 `baseRevision`（实际安装内容摘要）；基线变动返回 `409 skill_revision_conflict`，包内不存在的路径返回 `404 skill_file_not_found`，Git 预览失败返回 `503 skill_preview_failed`。路径只能从经过验证的包内文件集合查找。读取期间目标内容摘要必须仍等于请求的 `revision`。

`DATA_DIR/skill-sources/` 保存来源索引和不可变完整包快照；`skill-revisions/` 保存被选用的内容版本。Agent 的 `skills/<id>/` 是私有包副本，内含版本记录及包内 Skill 路径；旧式直接目录继续可读。更新先保留旧版本，再用临时目录与备份交换安装目录；启动恢复中断的交换。内容摘要包含全部文件、路径和可执行权限。版本预览限制文本体积，二进制、大文件仍返回变化状态。应用要求 `expectedRevision` 匹配且没有本地修改，防止旧页面覆盖新配置。

运行前将包复制到 Session 专属目录，嵌套 Skill 的托管入口链接到同一次完整包投影，保留对同包其他资源的相对路径。配置指纹使用实际投影内容，而非仅使用 Skill 名称，并写入 `runs.skills_revision`。Codex/Claude/DeepSeek Harness 使用 Workspace 内目录；Hermes 使用 `agents/<id>/provider-home/hermes/sessions/<sessionId>/skills`，避免不同 Session 相互覆盖。Hermes 首次迁移使用完成标记保护可重试初始化，并从旧共享 `state.db` 的一致性快照保留目标会话及父链；状态缺失时明确拒绝恢复。清理只移除目标 Session Home 及旧共享状态中的对应会话记录。

| 管理接口（前缀 `/api`） | 行为 |
| --- | --- |
| `GET/POST /skill-sources` | 列出来源；添加并首次刷新 |
| `POST /skill-sources/:id/refresh` | 手动发现新版本，不改变 Agent 选择 |
| `DELETE /skill-sources/:id` | 移除发现来源，保留安装副本和历史 |
| `GET /agents/:id/skills/:skillId/revisions` | 当前、最新版本及历史 |
| `GET /agents/:id/skills/:skillId/diff?revision=<sha256>` | 与当前安装内容比较，返回元数据、`expectedRevision` 和 `baseRevision` |
| `GET /agents/:id/skills/:skillId/diff/file?revision=<sha256>&baseRevision=<sha256>&path=<encoded-path>` | 单文件预览：`{path, kind, patch, truncated}`；无法预览时返回对应 `kind`，超限时附 `limitBytes` |
| `POST /agents/:id/skills/:skillId/revision` | 用 `{revision, expectedRevision}` 明确应用或回退 |
| `POST /agents/:id/skills/:skillId/upload` | 用原 ZIP 请求格式发布同名新版，不自动应用 |

版本检查和应用是不同操作；来源删除、刷新失败、版本不变均不会改动运行中的投影。独立 Skill 版本流程不提供自动更新、仓库写回、包管理器安装或版本垃圾回收；原生插件 Skills 按上述插件生命周期自动跟随。

`skillsRevision` 标识该 Run 使用的投影内容，不证明模型成功读取或执行了 Skill。业务验收须核对实际回复或产物，步骤见[部署指南](deployment.md#provider-验收与排查)。

## 9. 可靠性与并发

- 全局 Run、Agent Run、Webhook Delivery 和项目环境构建并发可以在线调整。
- Session 和 Conversation 内部串行执行。
- 同一 Webhook 订阅内，同一 Task 的事件按顺序投递；不同 Task 可以并行，重试只阻塞该 Task。
- 同一项目环境的重复同步请求会被合并。
- Event 先持久化再提供查询，`seq` 支持断线续读。
- SSE 连接断开不会取消 Run。
- Webhook 使用至少一次投递，接收方按稳定 `eventId` 去重。
- 服务重启后，排队任务继续调度；中断的 Run 标记失败且不自动重放输入。
- Provider Session 恢复失败时保留 Workspace 和历史，等待用户明确重建执行器会话。

当前并发控制属于单进程范围。多个服务实例不会共享运行配额，也不能同时操作同一个 SQLite 和 Workspace 根目录。

## 用量账本与能力归因

管理台资源列表采用统一的 `Page<T>`（items、page、pageSize、total、totalPages）或显式事件游标。数据库资源先过滤和计数再 `LIMIT/OFFSET`；用量来源列表始终分页，只读取展示字段，不加载恢复用的 checkpoint。Runtime／文件系统目录分页读取有限生命周期的发现快照，MCP 工具翻页复用检查快照，避免再次建立子进程。仅用于名称的引用查询读取详情摘要，不携带全部子资源。分页编辑保留页外状态，原子配置的完整提交与资源浏览分页分开处理。管理 Run 事件接口默认 100 条、最大 500 条，按 `afterSeq` 继续；SSE 使用既有有界历史回放和背压机制。

运行对话内容以 Run 和事件序号作幂等键，只保存计数和估算来源；实时路径与历史回补共享同一投影。`user_prompt`、`configured_instructions`、`system_prompt`、`assistant_output`、`assistant_thought` 作为五个独立能力维度，与工具统一筛选、排序和分页。配置指令每 Run 计一次，消息按已持久化片段计量，使用 `contentObservations` 而非工具 `calls`。模型请求保留 system/developer、user、assistant 角色，分别归入系统提示词、用户提示词和模型回复；同一能力行同时承载内容观测及真实模型输入证据，两套数值独立于彼此及 Provider 上报账本。运行内容证据按时间和稳定身份游标分页，详情不返回正文。

`src/agent-usage/core` 和 SQLite 投影使用通用字符串身份；`HostUsageCollector` 负责转换业务 Agent／Session／Run、维护 epoch 和校验宿主映射。Agent／Session 详情与会话列表的累计展示均读取同一账本；列表按当前页 Session ID 一次批量读取，查询在只读 Worker 中完成。来源观察、去重及选定的账本投影保存在现有数据库中，采集记录按最多 100 条分批，事件、上下文派生数据和批次末 checkpoint 在一个事务中提交；读取失败可提交此前已验证的批次，取消后不继续提交。Provider 的缓存字段作为输入子集；未知 scope／semantics 和旧 Session／Run 快照保留证据，不进入可累加总量。父范围汇总与明细按指标选择非重叠会计基础；明细超过滞后的父范围时选明细并报告冲突。

MCP 包装器就地提取可见文本并估算参数／结果，通过私有 Unix socket 仅发送计数、字节、部分计量标记与缺口原因，由宿主统一写库；调用开始时冻结 Run 归属，缺少显式执行身份时标为推断。Runtime 工具事件按 Run 模型匹配本地词表，补充 CLI、Skill 读取／脚本及插件归属，目录投影不计为调用。默认排名对照一次性调用内容和按每个已采集模型请求累计的定义、参数、首次／重复结果输入；两者分别保存在 invocation payload 与 context exposure 投影，不能混同，也不能加进 Provider 账单。Skill、插件等维度是重叠视角，不构成可相加账单。

后台恢复从已终止 Run，以及显式申请词表补算的运行中 Run 的保留 events 回补内容估算，按最新 Run 优先、每批最多 100 条事件和 4 MiB 正文（最多 16 MiB 的单事件可独占一批）。正文计量在事务外完成，一批投影与游标原子提交，各内容接收器的内部事务隔离单条失败；重启从已提交游标继续，稳定身份保证幂等；坏记录记为脱敏缺口，后续记录继续。Run 的 epoch 固定，原始事件时间用于日期归属；未知开始时间的完成事件可按结束时间筛选，不伪造耗时。历史 MCP 只向同 Run、明确 Server/Tool 且时间唯一匹配的包装器调用补充估算，含糊匹配不双计。原事件和 Skill 投影不存在时不能重建正文或归属。回补只写无正文元数据；首次获得词表的模型可覆盖仍保留原文的 Runtime 兜底计数，按 Run 保存已补算模型、游标和重试时间，不增加调用次数。Session 删除同时清除进度并阻止重放。

默认累计归因从 Codex／Claude Code 原生会话日志增量重建。Codex 累计用量增加形成估算边界，重复限流快照不增加次数；Claude 使用稳定 message.id 替换同一请求的分片。请求自身输出从该次输入中排除，在后续请求才累计；已记录的压缩替换历史。Codex 推理条目的可见正文优先于摘要；空摘要不得遮盖正文，正文作为后续请求的思考内容累计。MCP 运行时快照保存允许工具的定义配置，参数／结果继承具体工具及 Skill／插件归属。正文逐段计量后，仅保存按能力、内容类型、词表来源和首次／重复分类聚合的计数状态及游标；默认不再依赖 API-key 转发才能得到累计估算。重建证据标为 inferred、partial；原生日志未暴露的请求包装、内部工具定义及媒体内容留在同口径输入差额中，标签去重后再计算差额。已知词表等待时游标保留，后台重试。解析器升级时，未变化的已完成原生日志不立即重放；日志增加后从头重建无正文计数状态并以更高修订号替换旧上下文。针对已结束的 Codex 来源，管理采集接口可显式请求重建；重建仍验证旧文件前缀，并通过已有身份与更高上下文修订号替换估算，不重复写入模型用量。

自动模型请求采集使用独立于业务表的 loopback HTTP/SSE 转发层，由宿主适配器绑定 Session generation、epoch 和请求开始时的 Run。它与手动快照共用规范化和归因逻辑，识别 Responses、Chat Completions、Anthropic Messages。`USAGE_CAPTURE_UPSTREAMS` 显式选择 API-key 上游；子进程只拿本地凭据，服务端注入指定环境变量的上游 key。原始正文只在有界内存中解析，数据库保存采集意图／状态与无正文投影。实际请求中逐次命中已投影 Skill 路径的调用才增加 Skill／插件标签。

原生插件投影返回实际 Skill 名称、版本及路径别名，由 Runtime Session 保留，复用 Handle 时仍返回同一映射；Run 在启动 Turn 前将其与托管 Skill 一并登记。Claude 会话重建使用 `sourceToolUseID` 将单独注入的指令消息关联到 `Skill` 调用。关联保留到下一模型请求边界，支持 checkpoint 恢复，之后释放；正文只计量一次并按后续请求累计，输入对照按内容位置去重。

托管启动适配当前支持 Codex Responses 和 Claude Messages；Hermes 和 DeepSeek Harness 自动接入配置明确拒绝，通用 Chat Completions 解析器不代表已接通 Hermes。OAuth／Bedrock／Vertex 路由继续使用原有日志和执行来源。实际模型请求的日期依据优先于同 epoch／指标的原生累计差额，不能将两者相加；累计父范围仍用于补全不限日期总量，未覆盖部分保留为未定位用量。

原生日志与 HTTP 记录使用共同 Provider 身份对账；Claude 采用原生 message ID。Codex 累计量保留父范围，已验证的累计差额作为 interval，不能伪装成模型请求或直接按导入日期分摊。`calls` 只包含执行证据，`contextOnlyCalls` 单列模型输入中的工具证据，MCP 的 ACP 镜像不会再次进入 CLI。发现和采集失败持久保留，启动补采也覆盖首次来源登记前退出的 Session。

输入证据按能力与模型请求直接从暴露投影查询，不要求存在工具执行或主要工具调用行；Skill／插件标签、未使用的 MCP 定义及未知输入都可下钻。数据库聚合排名并下推日期筛选；首次结果索引按 Session／epoch／内容身份保存最早位置，同时维护全运行时与指定运行时视角。上下文修订在同一事务中修复旧首项、加入新首项，迟到记录不会被误判为首次。输入证据先按持久化排序键选取有匹配暴露的有界上下文候选，再分组和生成游标；调用列表也在 SQL 中分页，MCP 完成事件仅按主键读取执行记录。

Reset／cleanup 在停止生产者后排空已接纳的请求采集，再冻结文件来源并提交尾部数据。Reset 仍要求采集完成；cleanup 的采集、旧统计导入或发现失败只保留脱敏缺口和告警，采集超时后也继续清理。cleanup 的 ready 表示采集尝试已结束，不代表统计完整；恢复维护时复用该状态，避免读取已部分删除的文件。清理收尾后旧映射转为 retained，退出自动重试，已有统计与失败原因保留；Reset 同事务切换 epoch。显式 Session 删除先撤销主体／映射，再清除账本与归因；所有迟到写入和重放校验 generation 与 epoch。关闭时等待已接纳清理，停止 Runtime，排空请求采集并补采最终日志，然后关闭采集器和数据库。

HTTP relay 分别跟踪各通道的计量任务，撤销只等待自身任务。传输完成后的处理期限为 30 秒，包含同 Session 的串行等待；超时取消分词、保留 `capture_processing_timeout` 并释放等待，迟到结果在任何持久化前复查取消信号。维护前采集准备也受 30 秒期限约束，取消信号传入托管目录发现及来源登记，在路径 I/O 后复查。维护开始会取消旧 harvest 的写入权限，防止旧任务完成或失败时覆盖清理结果。查询同时保留全部失败与可恢复失败计数，并为每条失败返回 retryable；页面仅为仍可恢复的失败继续轮询，分页不影响判断。

管理查询统一支持 Agent／Session／日期／Runtime，UTC 保存和日期分组、`[from,to)` 筛选；无时间的范围汇总单列，调用开始时间与输入请求时间分开。首版不自动推断 Provider 内部子 Agent 树，也不计算无证据的工具内部模型账单。原业务 `usage` 字段保持语义，新查询位于 `/api/usage/*`，沿用管理鉴权，不进入公共事件投影。新账本仅保存计数、身份、哈希和来源元数据；未提供诊断正文保留开关。

用量看板通过管理接口 `/api/usage/dashboard` 和 `/api/usage/session-trend` 查询。宿主查询层将 Session 创建记录、Run 开始记录与既有对账事实组合，不把业务表耦合进可复用的账本模块。每日平均值先按 Session 合并所有 epoch，再按 UTC 日计算已知总 token／有总量上报的 Session 数；缺失不补零，跨日和未归位量不分摊。新建数按 Session 创建日；活跃数按 Run 开始日对 Session 去重，区间总数独立去重。逐会话图只选择范围内创建的 Session，按创建时间／ID 稳定分页，批量读取当页完整历史总量。

两个看板接口要求 `from/to`，取整后最多 366 个 UTC 日，逐会话分页最多 100 项。文件数据库使用既有只读查询 Worker 和一致快照、队列／期限／退出机制；均返回实际 `asOf`。由于 Session 新建、改名及 Run 状态变化不推进账本修订号，看板每次请求重新读取快照，不复用账本修订号缓存，也不新增宿主表统计触发器。每日区块与会话区块独立加载和显示各自统计时间，旧筛选请求取消后不覆盖新结果；接口不返回提示词、回复、Workspace 或 Provider 私有状态。

路由负责校验、调用和响应投影。`UsageAnalysis` 统一对账、范围包含关系、未知计数、冲突及日期分配，并导出无正文的计量事实；按 namespace／Session／epoch 和 Runtime 视角压缩持久化。首次建表、历史任务登记及触发器安装在同一事务完成，中断后可重新初始化。账本变更与 epoch 修订号在同一事务登记，后台只读 Worker 核对脏 epoch，宿主仅在修订号仍匹配时提交投影；持续变化的 epoch 不阻塞其他 epoch 的回填。查询组合已完成投影与尚未回填的脏 epoch，累计父范围、跨日期区间和未归位口径保持一致。会话列表仍批量读取当前页。能力输入按上下文、能力、块类型、证据、词表及全／单 Runtime 首次分类合并，保留数值、已知／缺失计数和工具关联；上下文提交及首项变动在同一事务修复受影响投影。后台每批最多回填 5 个旧上下文，最新优先；未完成的查询范围使用明细路径。

能力排名按固定 UTC 自然日和 Session 维护唯一一份增量汇总，包含输入计数、去重 coverage 及对话内容计数。已完成的日期直接读取可索引的汇总列；排序先读取所需指标并分页，再读取当页能力的完整指标与估算来源。迟到数据、修订或删除仅使受影响分区失效，后台重建期间实时读取这些分区，避免使用旧聚合。跨天调用去重及 P50/P95 继续按原始调用计算，不相加每日去重数或百分位数。管理查询的 `from` 向 UTC 日初取整，非日界线的 `to` 向下一日开始取整，已对齐的 `to` 保持排他上界；响应返回实际范围。管理页面不再提供时区筛选，API 不再接受或返回 `timezone`。

每日排名使用 `agent_usage_ranking_days` 登记 `(namespace, agent_id, session_id, day)` 分区，数值、coverage、最新展示元数据及内容分类分别保存在按分区和能力／分类聚簇的汇总表中。历史发现进度保存在单行 `agent_usage_ranking_discovery` 中；历史发现每批最多读取 500 个上下文及 500 条内容元数据，游标可跨重启继续。后台复用对账 Worker，每轮处理一个脏分区；就绪检查与源计数聚合在只读快照中完成，写入端仅在分区修订号未变化时原子替换各汇总表。来源触发器在同一写事务标记新旧日期失效；首项分类变化通过既有上下文投影刷新传播。普通来源变更产生的空分区及汇总行在重建时回收；显式 Session 删除在自身事务内立即删除对应分区和汇总，迟到的旧结果不能重新发布。查询组合已完成分区与脏分区的实时聚合，首次历史发现未完成时沿用原查询。无时间记录只参与不限日期查询；内部未按日对齐的精确时间调用仍使用原路径。日期连接分离有时间与 NULL 时间分支，使时间范围可走索引。`recovery.dailyRankingProjectionPending` 检查持久化发现／分区任务，不扫描计数明细。它不参与原始事件清理资格判断。升级在同一事务中保留旧 UTC 分区 ID、修订号、汇总和发现游标，移除其他时区的重复汇总与登记表，并替换来源触发器；不会重置已有 UTC 回填进度或重新采集原文。分区 ID 序列继续递增，已删除分区的旧 Worker 结果不能命中新分区。

文件数据库的汇总／趋势与能力排名分别在只读查询 Worker 中执行，使用同一 WAL 数据库的一致快照；另一个按需 Worker 负责 epoch 对账与每日排名回填。只读构造不迁移，每个 Worker 最多 16 个排队任务、8 MiB 页缓存，空闲 60 秒释放。30 秒查询期限包含 Worker 队列等待；排队过期移除任务，执行过期返回脱敏 `503 usage_query_timeout` 并请求终止 Worker。原生 SQLite 调用可能延迟线程退出和快照释放；退出期间后续任务仍受原排队期限约束，确认退出前不启动替代线程。关闭时清理所有等待期限并等待执行中或已请求终止的线程退出。`UsageQueryCache` 最多 32 项／4 MiB，单项最多 512 KiB，统计修订号由相关表触发器维护；普通 events、checkpoint 与冗余副本清理不清空统计。相同查询跨普通修订仍共享正在执行的任务，完成结果保留原快照身份；变化后最多复用 30 秒。`fresh=1` 跳过已完成快照，但共享相同的在途请求。Session 删除递增独立 generation，立即清除旧快照且不缓存删除前的在途结果。轻量元数据独立检测本连接和外部连接写入，不受统计快照 TTL 限制。

Runtime 原始事件与统计共用 SQLite，生命周期分别管理。新对话计数引用共享词表元数据，旧行在清理批次内尽力去重，去重失败不阻止删除原文。`USAGE_EVENT_RETENTION_DAYS` 默认 7 天，以 Run 结束时间为起点，0 关闭；仅清理空闲且无维护／活动 Run 的 Session。清理事务必须确认本 namespace 的内容回填任务已完成、无错误、包含对话计量且游标覆盖保留的 message/tool 事件；缺失、待处理、失败或落后的任务以 `backfill_incomplete` 跳过。对话空计数或同 Run 工具 payload 的空计数以 `counting_incomplete` 跳过；只有明确标记为不支持计数的媒体 payload 可保留 NULL 并清理，已知零正常参与。清理使用独立调度，每步按主键定位一个 Run，以索引检查该 Run 的进度和计数，不等待其他 Run 或统计投影；删除范围仍使用自身清理游标。同一 Run 的后续批次直接复查，扫到末尾后休息 5 分钟，再检查到期、恢复空闲或完成补算的 Run。每批删除最多 100 条／4 MiB 的 message/tool 事件（单条大事件可独占），并原子更新 Run 过期标记与最高清理序号，不改写已完成的补算状态。最终回复、输入、状态／错误、计数与归因仍保留。过期游标请求返回 `410 run_events_expired`；事件序号继续单调增长。已清理 Run 不再登记、调度或提交依赖原文的补算；提交前的过期检查继续拒收旧版本已清理任务的迟到结果。已有计数、缺失原因和未知值保留，不填零。没有全库重写、物理分库或自动 VACUUM，释放页用于复用。

存储压缩拥有独立的有界调度，与统计回填一同启停。升级时登记旧行的主键上界：每批最多 100 个旧计量事件和 250 条旧 exposure，持久化游标后继续；新写入不再复制 event payload 或重复身份哈希，读取仍恢复原哈希并保留不同的历史值。全部排名输入已就绪后，每批检查最多 100 个估算 profile，仅删除没有输入、调用 payload 或对话引用的项。完全 revoked 且没有进行中采集的来源移除大 checkpoint 与输入／配置副本，保留来源／映射身份；retained 来源保留重建能力。所有这些清理不删除历史用量或证据、不在线 VACUUM。

请求输入汇总只保留数值、分组身份和代表曝光位置，不复制能力展示 JSON。排名选定代表行后按 `(context_id, position, capability_key)` 主键读取原曝光元数据；每日汇总仍保留每个能力的最新展示记录。历史请求输入中的 JSON 副本以升级时主键上界为界，每批最多 250 行清空，数据更新和游标提交共用事务，重启后继续；不推进统计修订号、不重算计数或失效已完成每日汇总。原始曝光、token 账本和证据均保留。

`/api/usage/status` 返回版本、来源／采集／失败计数和补算进度，以及不受筛选影响的进程内恢复阶段与原始事件清理次数、耗时、跳过原因和失败时间；后者重启后重新计数，不扫描数据库计算待清理总量。它不执行账本汇总或能力排名。界面各区域独立加载；恢复期间轮询轻量状态，采集过程中不因 checkpoint 写入重复查询重统计，完成后立即刷新。隐藏页面暂停轮询，重新可见后继续；各查询保留原有分页和取消机制。管理来源接口使用 `UsageError.code` 区分业务错误与未预期内部错误，后者返回脱敏的 500。

HTTP 中已知 Provider 工具名通过显式适配映射到与 Runtime 事件相同的内置工具／CLI 身份；MCP 映射优先，任意未知名称不猜测。共享的有界 Shell 解析器只识别单条字面命令、参数数组与常见包装，不执行命令、不展开变量、不拆分管道或组合语句。明确的 cat／head／tail／sed 文件操作和解释器脚本路径可关联已投影 Skill。逐调用缓存固定首次确认的 Skill／插件归属及版本，包括无归属状态；后续 Run 的配置只影响新的调用。

来源注册、快照合同、限制及用户操作见[用量分析指南](agent-usage.md)。核心与宿主分层支持将来提取，但当前仍在单进程内运行。

来源查询统一由 coordinator 按主体／来源身份筛选，一次读取来源、一次批量读取映射，调用方不再全量加载后逐条查库。恢复队列也在 SQL 中排除已完成会话。单会话维护只导入该会话及其 Run 的旧计数；已完成的采集屏障直接复用，避免重新读取可能已部分清理的文件。前端证据抽屉按主体与能力身份管理生命周期，分页游标由历史栈派生，关闭或切换后取消旧详情请求。

手动分词 profile 由 `USAGE_TOKENIZERS` 配置，精确匹配模型及可选 Provider 身份，启动时验证本地文件大小与 SHA-256。未手动覆盖的内置模型在首次计数时获取固定官方 JSON 词表，验证 SHA-256 后原子写入 `DATA_DIR/tokenizers`，合并并发下载；官方源失败后切换 HF-Mirror，仍验证固定哈希，全部失败后 60 秒重试。已知词表在准备期间返回 `tokenizer_pending` 和未知计数，不保存兜底；Runtime 使用持久化游标补算，模型执行不等待词表下载。自动词表加载及大文本计数在单个 Worker 顺序执行，空闲 60 秒释放，关闭时终止。未知模型自动使用带版本的 Unicode 字符加权兜底估算；上报用量独立计量。每次暴露保存引擎、词表内容指纹、模型与缺口原因，相同词表指纹复用一个引擎和纯计数缓存；profile／Provider 身份仍分别投影。估算元数据字典去重，暴露保存字典引用，读取仍返回完整来源元数据。旧估算迁移为 `legacy_reference`，多个模型／词表及兜底估算可汇成近似 token 小计用于排名，同时保留各口径分项。估算覆盖完整只表示每项有数值，不表示准确度一致。模型缺失和分词失败不等于未采集输入，前端同时提供字节排名。

托管 JSONL 使用字节游标、行号、行内观测序号与无正文解析状态恢复，包括 Codex 累计基线。固定 64 KiB 缓冲区校验完整旧前缀，随后流式解析新增行；整文件不受 16 MiB 限制，最多保留一行（16 MiB），快照仍有整文件上限。没有换行但完整的 JSON 可处理，半行或半个 UTF-8 字符不会跨过 checkpoint，采集保持失败待重试。已采集文本完整计数，不设单块或每上下文的分词字节额度；64K UTF-16 单元阈值只将计数移到 Worker，不采样、不改变计量方法，图片等二进制不按 base64 文本计量。上下文计量先于数据库事务，提交时重新校验来源与 Session 权限；每个完成的请求上下文与其 checkpoint 立即提交，同一日志行的剩余计数在读取下一行前通过 checkpoint 标记提交，避免下一条记录超时丢失已完成进度。纯计数记录仍按最多 100 条批量提交，取消后不提交未完成工作；HTTP 先持久化 Provider 用量，独立等待词表与上下文计数；同一主体的完成处理串行，关闭或撤销会取消未完成计数，调用缓存只增量写入变化及淘汰项，内存状态在事务成功后更新；MCP ticket 按会话索引，在维护收尾／删除或下一 Run 移除服务器时释放。

后台内容恢复按最新 Run 优先处理已结束的 Run，以及明确安排补算的运行中 Run。每批最多遍历 100 个事件、正文预算 4 MiB；单条最多 16 MiB 的事件可独占一批，逐条检查 25 毫秒软时间预算。计量在事务外完成，一批准备好的计数与游标通过同一个短事务提交，内部事务隔离单条失败。后台循环按本轮耗时的 3 倍安排休息，最少 50 毫秒、最多 1 秒；回填发现无待办时至少间隔 5 秒复查，来源队列结束一轮后冷却 30 秒，在后续恢复批次重新发现可重试来源，不再受历史回填或统计投影是否完成限制；整个恢复队列空闲时等待同一重试期限；原事件清理由独立清理调度推进，只检查目标 Run 已提交的补算与计数，不在清理步骤执行分词或统计查询。单条记录、来源采集和 SQLite 提交仍可能超过预算，不构成 CPU 硬配额。停止恢复会取消未完成计量，下次沿用已提交游标。Worker 重建先校验并加载磁盘词表，避免空闲回收后反复返回下载等待。词表升级只为新获得词表的模型安排一次历史重算，普通重启不重置进度；失败记录保留脱敏缺口，删除 Session 后不得恢复其计数。

## 10. 安全边界

管理 API 使用全局 `API_TOKEN`。通用 Task API 使用独立 Endpoint Token，服务端只保存哈希。原生 Webhook 入口使用每端点加密保存的独立 Secret，校验 GitHub HMAC-SHA256，或 GitLab 的 `whsec_` 签名 Token / 旧式 `X-Gitlab-Token`。出站 Webhook 订阅另有独立签名密钥和 HMAC-SHA256。

Agent 运行在服务操作系统用户权限下，可以执行命令、修改 Workspace、调用 MCP 和访问该用户能够访问的网络与文件。`approve-all` 是 Provider 交互策略，不是安全沙箱。生产部署必须使用专用无特权用户、可信仓库和 MCP，并把服务放在可信网络或 TLS 反向代理后。

打包的 Codex ACP adapter 将默认 `agent` 模式设为 `workspaceWrite`、`networkAccess: true`，保留原有可写目录和临时目录规则。新建、加载或恢复 Provider Session 都采用同一预设，后续普通 Run 每轮显式发送该策略，不依赖模型申请联网提权，也不依赖主机 `sandbox_workspace_write.network_access` 默认值。`read-only`、`workspace-write` 和 `agent-full-access` 预设保持上游策略。`2.2.2` 默认模式使用上游 `auto_review` 审批，acpx 的 `approve-all` 只处理转交客户端的请求，不绕过自动审批；默认文件沙箱仍不构成不可提权的隔离保证。

## 11. 部署边界

当前版本面向单机、单进程、自托管部署：

首次部署通过 `pnpm run init` 生成权限为 `0600` 的 `.env`，默认绑定本机地址，并把一个数据根目录展开为数据库、环境和 Session 路径。初始化复用 WorkspaceManager 验证原生创建、克隆／快照、独立写入和清理；成功后才以独占创建方式写入配置。已有配置和 Token 保持不变。`pnpm run doctor` 复用这些检查，不写配置、不创建业务记录、不调用 Provider。两者可能创建缺少的基础目录，临时探测目录在检查后清理。

服务入口从当前工作目录读取 `.env`，进程环境优先；文件通过 Node 的 dotenv 解析器读取，不执行 Shell 或变量展开。配置快照保留管理 Token 用于鉴权，实际进程环境在读取登录 Shell PATH 和启动任何工作进程前移除管理与 Smoke 凭证。Vite 只用同样的加载规则解析开发代理端口，不向浏览器公开服务配置。

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
- Agent 推理框架、跨 Core 的模型路由、模型网关和自研工具循环；
- Git 托管平台的业务规则和部署编排。

保持这些边界可以让外部系统通过稳定 API 使用现有 Coding Agent，同时保留各自的业务模型。

## 消息附件

消息保持原有文本字段，并携带可选的结构化 `attachments`。统一边界校验限制数量、解码大小、规范 base64、文件名和 MIME；原生图片检查 PNG/JPEG/GIF/WebP 文件头。只对消息提交路由提高 JSON 请求体限制，其他路由维持现有限制。

`message_attachments` 将 BLOB 与历史元数据分离，关联 Session 和 Task/Run。Task 接收与附件插入使用同一个事务；调度器在创建 Run 和关联 Task 的事务中绑定附件，避免重试复制或丢失。列表和历史仅查询元数据，执行和鉴权下载才加载字节。附件摘要参与请求指纹；无附件请求保持原有指纹。

Run 开始后，在其 Session 工作区创建随机、独占的附件目录，以附件 ID 加文件名写入，禁止复用已有路径或覆盖文件。实际交给 Provider 的文本附带 JSON 文件引用；支持的图片同时进入 acpx 原生图片附件。原始用户输入不含内部路径。文件在后续轮次仍可读取，直到 Session 存储清理或删除；准备阶段失败或中止会删除本次未完成目录。

Session 清理在已有维护事务中将附件 BLOB 置空并保留元数据，工作区文件沿用原有清理机制。重置上下文不删除附件，删除 Session 通过外键级联删除记录。附件下载始终需要管理鉴权，响应强制下载并禁止缓存和 MIME 猜测；前端仅对允许的位图类型使用 Blob 预览。公共事件投影不添加附件字节或内部路径。

文字与参数的 JSON 内容（不含 `attachments`）仍限制为 1 MiB，附件不会扩大纯文本的持久化上限。
