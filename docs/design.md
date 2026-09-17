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

acpx 0.16.0 负责 ACP 后代进程的身份校验、退出信号和有界清理。项目只保留一个补充补丁：在初始化、创建、加载和恢复 Session 的请求尚未结束时，每 100 ms 采集后代进程，避免桥接进程先崩溃后丢失父子关系；请求结束即停止采样。补丁复用上游 `ProcessDescendants`，不改变进程组或信号继承方式。维护及移除条件见 [acpx 补丁说明](../patches/README.md)。

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

Webhook 投递列表的 `latest` 摘要从当前端点的订阅出发，利用 `webhook_deliveries(subscription_id, created_at DESC, id DESC)` 覆盖索引为每个订阅定位一条记录，再按主键读取详情。无投递的订阅不返回摘要，列表筛选和分页不影响摘要。避免从历史投递逐行执行相关子查询和排序，防止同步 SQLite 查询长时间占用事件循环。启动迁移为新库和旧库幂等创建此索引。

### 6.4 原生 Webhook 入库

`WebhookIngress` 是 GitHub 和 GitLab 共用的接收组件。公开入口 `/integration/v1/endpoints/:slug/webhook` 在独立 Fastify 作用域内保留原始请求体，支持 JSON 和 GitHub 表单 `payload`；其他 API 的 JSON 解析不变。端点的接收器配置保存在 `integration_webhook_receivers`，一端点一条配置，Secret 通过现有 SecretStore 加密，删除端点时级联删除。

接收顺序是：查找端点和来源配置 → 使用原始请求体验证 GitHub HMAC-SHA256 或校验 GitLab 签名 / Token → 检查启用状态 → 校验事件类型、投递 ID 和 JSON 对象 → 查重 / 评估并保存筛选决定 → 命中时将载荷路径映射成已声明参数 → 调用 `IntegrationCoordinator.submit`。GitHub `ping` 只返回确认。正常事件使用带平台前缀的投递 ID 作为 `requestId`，以事件类型和默认载荷作为消息，复用现有事务入库、幂等锁、Session 创建、队列、事件投影及重启恢复。接收层不另建任务队列；返回 `202` 表示 Task 已持久化。

每个命中规则的新投递对应独立 Task/Session，不推断 PR/MR 会话。重复 ID 携带相同输入复用原 Task，不同输入返回幂等冲突。GitLab 优先使用 `webhook-id`，其次 `Idempotency-Key`，最后 `X-Gitlab-Webhook-UUID`。参数映射只读取载荷自身的点分路径，标量值转换为字符串；必填参数验证继续由现有 Endpoint Manager 负责。

GitLab 配置为 `authMode: signature` 时校验 Signing token（`whsec_` 前缀）：Base64 解码密钥，对 `webhook-id.webhook-timestamp.原始请求体` 计算 HMAC-SHA256，再与 `webhook-signature` 中的候选签名作常量时间比较，并限制时间偏差为 5 分钟。此模式不允许明文 Token 降级；`authMode: token` 明确使用 `X-Gitlab-Token` 校验，Secret 文本不决定认证策略。

管理 API 返回来源、验证方式、启用状态、`secretConfigured`、`filter` 和 `filterVersion`。省略 Secret 的更新保留原密文，切换平台或验证方式需要新 Secret。停用接收器只影响后续入站请求，已入库任务继续由现有调度器负责。原生载荷作为用户输入进入 Task 消息及其既有用户消息事件；鉴权头和接收 Secret 不进入消息或公开事件。

筛选配置存于接收器的 `filter_json` / `filter_version`，旧库启动迁移默认不筛选。每个有效投递在 `integration_webhook_receipts` 中以 `(endpoint_id, provider, delivery_id)` 唯一保存首次决定、事件类型、消息 SHA-256、规则版本和时间；不另存原始载荷或秘密。认证、启用检查、解析失败不创建记录。同一 ID 的内容指纹冲突返回 409；忽略结果返回 200，已入库结果返回 202。版本只在平台或规则改变时递增，新的规则只影响新的投递。

决定写入发生在 Session I/O 前，忽略事件至此结束。放行事件通过现有 Coordinator 入库；同进程的重复投递共享正在进行的入队 Promise。两阶段通过现有确定性 `requestId` 恢复：进程在创建 Task 前退出，平台重试沿用已保存决定再次尝试；Task 已提交时退出，重试直接返回该 Task，不重新解析参数或触发运行。接收记录通过该键关联 Task，无需额外回填事务。入库失败保留放行决定，管理页显示尚未入队并等待平台重试；不增加后台入站重试队列。升级前已存在的原生 Task 优先保留其放行事实。

决定元数据跟随端点删除级联清理，不跟随 Session 存储清理；查询最近 30 条，不返回指纹、原始载荷、规则比较值或认证信息。预览是受管理鉴权保护的纯操作，可检查未保存规则并返回条件路径、匹配状态及缺失 / 类型 / 值不符原因。接收 ID 去重不等于 MR 版本或评论去重，后者属于具体审核流程。

### 6.5 Webhook 扩展边界

- 路由只负责 HTTP 传输、原始字节、管理鉴权、输入校验和错误映射。
- `webhook-adapters/` 中的 `WebhookAdapter` 负责来源协议：声明支持的验证方式、校验 Secret、验证请求、输出统一的事件类型、投递 ID 和载荷；连接测试可返回忽略原因。适配器不访问数据库、不创建 Session、不启动 Agent。
- `webhook-filter.ts` 定义受限规则契约和纯函数求值器，前后端共用验证；`all/any` 组合标量比较、存在判断及数组包含 / 不包含判断，缺失和类型错误不会通过负向比较。`not_contains` 要求数组每个元素存在且与比较值同类型，空数组匹配；通配提取中任一元素字段缺失或类型不符时不放行。字段路径只读事件与载荷自有属性，允许一次数组通配。预览与入站使用同一求值器。
- 适配器目录同时声明字段提示与审核预设，UI 不硬编码平台规则。
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

Session 保留策略清理占用空间较大的 Workspace、浏览器数据、Provider 原生会话，以及通过 Task 关联的全部 Webhook 投递记录。投递删除与 `storage_cleaned_at` 写入在同一个收尾事务中完成，失败回滚，重启后可幂等恢复。已清理的投递停止重试；晚到的投递结果不会重建记录，显式投影修复跳过已清理 Session。启动恢复仍可补齐 Task 状态和公开事件，但不会为已清理 Session 新建投递。Session、Run、Event、Task/Conversation 关联、公开事件和 Token 统计继续保留；无 Task 的测试投递不受影响，重置上下文保留投递记录。

清理资格依据空闲 Session 的 `updated_at`，并排除仍有 queued/running Run 的 Session。清理器取出候选列表后，在取得占用的同一事务中再次检查截止时间，防止等待其他目录删除期间发生的新活动被忽略。重启恢复只为被中断的 running Run 更新所属 Session 的活动时间；已空闲或已清理的 Session 不因重启延长保留期。Run 终态、错误事件和 Session 恢复在同一事务内写入，重复恢复不会再次刷新活动时间。

Session 使用可空的内部字段 `pending_operation` 持久化 `cleanup`、`delete` 或 `reset`。标记与 `running` 占用状态一起提交后才执行外部操作；进程内还会拒绝同一 Session 的并发维护。正常完成与重启恢复复用事务性收尾逻辑，验证操作类型、占用状态和无活动 Run 后，才清除标记或删除记录。一般 Run 恢复不会释放带维护标记的 Session。

启动时先重试创建中断的目录清理，再恢复维护操作，最后恢复和调度 Run。清理或删除未完成时保留标记与占用；已开始的存储清理在后续清理轮次重试，不受新的保留期或关闭自动清理影响，删除可由原删除接口重试。创建失败的补偿与启动恢复都在目录删除成功后才移除 pending Session 记录。重置恢复清除旧 Provider/ACP 本地会话和当前上下文累计值，保留 Workspace 与 Run 历史；随后新 Run 创建新的 Provider 上下文。

## 8. Agent 能力投影

每个 Agent 使用独立 Provider Home。服务从运行用户的 Provider 配置中发现可复用能力，再由管理员明确选择：

```text
系统 Provider 配置 -> 发现 -> Agent 选择 -> 下一次 Run 投影
```

- **Skills**：发现本机 Skill、上传 ZIP 或刷新 Git/marketplace 来源，按 Agent 选择内容版本。
- **执行器扩展**：发现 Codex、Claude Code 插件和 Hook，按 Agent 投影。
- **MCP**：管理 HTTP 和 stdio Server、固定值、Session 参数、运行时参数、密钥和工具过滤。

初始化 Provider Home 时排除宿主的历史会话、日志和缓存。升级旧业务会话时，Hermes 仅迁移目标会话及其父链，见下文。服务通过管理接口保存的敏感配置使用 `DATA_DIR/secret.key` 加密，管理 API 不返回明文；原生 Provider 的认证文件继续使用其自身格式。

配置变化从下一次 Run 生效。已有 Session 会刷新 Runtime 连接；Provider 支持恢复时继续原有 Provider Session。

Git 来源的稳定身份来自配置的 URL、ref 和子目录；Skill 身份还包含插件标识和包内路径。刷新操作在进程内串行，使用有截止时间、可取消并回收进程树的 Git 命令。发布前验证路径、文件类型和内容大小，来源索引原子替换，失败保留上一可用版本。来源仓库与 marketplace 引用的插件仓库分别记录实际 commit，外部插件未指定 ref 时跟随自身 HEAD。

Claude marketplace 的默认严格模式合并插件 manifest 与 marketplace 条目的 Skills 声明，并包含默认 `skills/`；当条目指向 marketplace 根目录且明确选择子路径时，仅导入所选路径。`strict: false` 与插件自身 Skills 声明冲突时提示并保留该插件的上一可用版本。Codex 插件按显式声明选择目录，没有声明时才使用默认目录。普通仓库递归发现 Skills；不支持的源类型会显示提示。

完整包限制为 50 MiB、10,000 个目录项和 32 层深度；不分发包内符号链接或特殊文件。来源 manifest 限制为 1 MiB，marketplace 最多 1,000 个插件条目。文本差异预览单文件最多 8 KiB、合计最多 64 KiB，超限内容仍返回文件变化和权限信息。

`DATA_DIR/skill-sources/` 保存来源索引和不可变完整包快照；`skill-revisions/` 保存被选用的内容版本。Agent 的 `skills/<id>/` 是私有包副本，内含版本记录及包内 Skill 路径；旧式直接目录继续可读。更新先保留旧版本，再用临时目录与备份交换安装目录；启动恢复中断的交换。内容摘要包含全部文件、路径和可执行权限。版本预览限制文本体积，二进制、大文件仍返回变化状态。应用要求 `expectedRevision` 匹配且没有本地修改，防止旧页面覆盖新配置。

运行前将包复制到 Session 专属目录，嵌套 Skill 的托管入口链接到同一次完整包投影，保留对同包其他资源的相对路径。配置指纹使用实际投影内容，而非仅使用 Skill 名称，并写入 `runs.skills_revision`。Codex/Claude 使用 Workspace 内目录；Hermes 使用 `agents/<id>/provider-home/hermes/sessions/<sessionId>/skills`，避免不同 Session 相互覆盖。Hermes 首次迁移使用完成标记保护可重试初始化，并从旧共享 `state.db` 的一致性快照保留目标会话及父链；状态缺失时明确拒绝恢复。清理只移除目标 Session Home 及旧共享状态中的对应会话记录。

| 管理接口（前缀 `/api`） | 行为 |
| --- | --- |
| `GET/POST /skill-sources` | 列出来源；添加并首次刷新 |
| `POST /skill-sources/:id/refresh` | 手动发现新版本，不改变 Agent 选择 |
| `DELETE /skill-sources/:id` | 移除发现来源，保留安装副本和历史 |
| `GET /agents/:id/skills/:skillId/revisions` | 当前、最新版本及历史 |
| `GET /agents/:id/skills/:skillId/diff?revision=<sha256>` | 与当前安装内容比较 |
| `POST /agents/:id/skills/:skillId/revision` | 用 `{revision, expectedRevision}` 明确应用或回退 |
| `POST /agents/:id/skills/:skillId/upload` | 用原 ZIP 请求格式发布同名新版，不自动应用 |

版本检查和应用是不同操作；来源删除、刷新失败、版本不变均不会改动运行中的投影。本期不提供自动更新、仓库写回、包管理器安装或版本垃圾回收。

`skillsRevision` 证明该 Run 使用的投影内容，不证明模型成功读取或执行了 Skill。已观察到部分上游模型错误作为普通输出返回且 Runtime 报告 `completed`；当前服务未修复这一状态传递问题。业务验收须核对实际回复或产物。[实测记录](superpowers/validation/2026-09-14-skill-source-updates.md)分别列出通过项与 Provider 环境阻塞。

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

管理 API 使用全局 `API_TOKEN`。通用 Task API 使用独立 Endpoint Token，服务端只保存哈希。原生 Webhook 入口使用每端点加密保存的独立 Secret，校验 GitHub HMAC-SHA256，或 GitLab 的 `whsec_` 签名 Token / 旧式 `X-Gitlab-Token`。出站 Webhook 订阅另有独立签名密钥和 HMAC-SHA256。

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

## 消息附件

消息保持原有文本字段，并携带可选的结构化 `attachments`。统一边界校验限制数量、解码大小、规范 base64、文件名和 MIME；原生图片检查 PNG/JPEG/GIF/WebP 文件头。只对消息提交路由提高 JSON 请求体限制，其他路由维持现有限制。

`message_attachments` 将 BLOB 与历史元数据分离，关联 Session 和 Task/Run。Task 接收与附件插入使用同一个事务；调度器在创建 Run 和关联 Task 的事务中绑定附件，避免重试复制或丢失。列表和历史仅查询元数据，执行和鉴权下载才加载字节。附件摘要参与请求指纹；无附件请求保持原有指纹。

Run 开始后，在其 Session 工作区创建随机、独占的附件目录，以附件 ID 加文件名写入，禁止复用已有路径或覆盖文件。实际交给 Provider 的文本附带 JSON 文件引用；支持的图片同时进入 acpx 原生图片附件。原始用户输入不含内部路径。文件在后续轮次仍可读取，直到 Session 存储清理或删除；准备阶段失败或中止会删除本次未完成目录。

Session 清理在已有维护事务中将附件 BLOB 置空并保留元数据，工作区文件沿用原有清理机制。重置上下文不删除附件，删除 Session 通过外键级联删除记录。附件下载始终需要管理鉴权，响应强制下载并禁止缓存和 MIME 猜测；前端仅对允许的位图类型使用 Blob 预览。公共事件投影不添加附件字节或内部路径。

文字与参数的 JSON 内容（不含 `attachments`）仍限制为 1 MiB，附件不会扩大纯文本的持久化上限。
