# Agent Core 与模型运行路由设计提案

[English](agent-core-routing.en.md)

> 状态：设计提案，尚未实现。本文记录目标架构、关键约束和分阶段实施边界；当前生产行为仍以[产品与架构](design.md)中的单 Core 模型策略为准。

## 1. 目标

允许一个 Agent 选择多个 Agent Core，并按 UTC 星期和时间段统一选择：

- 本次 Run 使用的 Agent Core；
- 该 Core 实际暴露的模型；
- 当前时间段的 Run 并发上限。

切换不创建新的业务 Session、Conversation 或 Workspace，也不打断已经运行的 Run。系统必须保留可审计的路由结果，并避免把一个 Core 的 Provider Session ID 传给另一个 Core。

## 2. 术语与边界

- **Agent**：业务身份，拥有项目环境、指令、Skills、MCP 和执行策略。
- **Agent Core Profile**：一个可运行的 ACP 执行器实例，例如某个 Codex、Claude Code 或 Hermes 配置。
- **Provider**：Core 使用的适配器家族，例如 `codex`、`claude_code`、`hermes`。
- **Model**：由指定 Core 通过 ACP 暴露并选择的模型。
- **业务 Session**：Remote Agent Server 的长期工作上下文和 Workspace。
- **Provider Session**：某个 Core 自己的原生对话上下文。

一个业务 Session 可以拥有多个 Provider Session，但不同 Core 不能共享同一个 Provider Session。跨 Core 只能共享 Workspace、持久化业务事实和显式 Handoff，不能迁移 Provider 的隐藏上下文。

## 3. 核心决策

### 3.1 Core、模型和并发使用同一份路由策略

不分别维护 Core 策略和模型策略。模型目录属于具体 Core，拆开配置可能产生“选择了 Claude Core，却选择 Codex 模型”的无效组合。

建议的策略协议：

```json
{
  "mode": "schedule",
  "defaultTarget": {
    "coreProfileId": 1,
    "model": { "mode": "core_default" }
  },
  "rules": [
    {
      "id": "weekday-daytime",
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "periods": [
        { "start": "08:00", "end": "12:00" },
        { "start": "13:00", "end": "20:00" }
      ],
      "target": {
        "coreProfileId": 1,
        "model": { "mode": "fixed", "id": "glm-5.3-flash" }
      },
      "maxConcurrentRuns": 4
    },
    {
      "id": "weekday-night",
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "periods": [{ "start": "20:00", "end": "08:00" }],
      "target": {
        "coreProfileId": 2,
        "model": { "mode": "fixed", "id": "deepseek-v4" }
      },
      "maxConcurrentRuns": 2
    }
  ]
}
```

规则继续使用 UTC：开始时间包含、结束时间不包含，结束早于开始表示跨到下一 UTC 日，重叠时配置在前的规则优先。`defaultTarget` 必填，保证任意时间都有明确目标。

### 3.2 路由在 Run 获得槽位时只解析一次

调度器在 Run 真正获得执行槽位时生成不可变的 `ResolvedRunRoute`：

```ts
type ResolvedRunRoute = {
  resolvedAt: string;
  policyRevision: string;
  ruleId: string | null;
  coreProfileId: number;
  coreGeneration: number;
  provider: Provider;
  model: string | null;
  effectiveConcurrency: number;
};
```

同一个结果同时用于并发准入、Run 持久化和 Runtime 启动，Executor 不重新读取时间或再次解析策略。这样不会在 UTC 分钟边界出现“按一条规则放行，却按另一条规则执行”。

有效并发上限为：

```text
min(系统全局上限, Agent 上限, Core Profile 上限, 时间规则上限)
```

调度器除 `activeByAgent` 外还要维护 `activeByCoreProfile`。降低配置不会取消正在运行的 Run；排队 Run 在下一次准入时使用最新策略。

### 3.3 每个业务 Session 为每个 Core 保存独立绑定

移除“一个 Session 只有一个 `provider_session_id`”的假设，新增：

```sql
CREATE TABLE session_core_bindings (
  session_id INTEGER NOT NULL,
  core_profile_id INTEGER NOT NULL,
  core_generation INTEGER NOT NULL,
  provider_session_id TEXT,
  context_cursor_run_id INTEGER,
  last_model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_read_tokens INTEGER,
  cached_write_tokens INTEGER,
  thought_tokens INTEGER,
  total_tokens INTEGER,
  last_used_at TEXT,
  storage_cleaned_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, core_profile_id, core_generation)
);
```

acpx 持久化 Key 使用：

```text
remote-agent:<sessionId>:core:<coreProfileId>:generation:<generation>
```

Core 的 Provider、命令、Provider Home 或凭证身份发生变化时发布新 generation，不能让旧 Provider Session 静默进入不同执行身份。

### 3.4 同一业务 Session 同时只保留一个活跃 Core Handle

同一 Session 的 Run 继续严格串行。切换 Core 时：

1. 关闭旧 Core 的活跃 Handle，但不丢弃持久化状态；
2. 保存旧 Core 的 Provider Session ID 和累计用量；
3. 创建或恢复目标 Core 的 Handle；
4. 空闲超时继续释放当前 Handle。

不同时驻留多个 Core 进程，避免 MCP、浏览器和 Provider 进程按 Core 数量成倍占用内存。

## 4. 跨 Core 上下文同步

Workspace 修改会自然共享，但 Provider 原生对话不会共享。每个 Binding 使用 `context_cursor_run_id` 记录该 Core 已经了解的业务历史位置。

目标 Core 在执行前：

1. 读取 cursor 之后已经结束、且由其他 Core 执行的 Run；
2. 生成确定性、脱敏的增量 Handoff；
3. 把 Handoff 与本轮用户输入一起发送；
4. 本轮被目标 Core 成功处理后推进 cursor。

Handoff 可以包含 Run ID、状态、Core、模型、用户输入、最终回复、Workspace 变更摘要、未完成事项以及公开的外部任务状态。不得包含 thought、密钥、未经脱敏的工具参数或完整事件流。

Handoff 不是只在首次使用某个 Core 时发送。一个 Core 离开期间如果其他 Core 完成了工作，切回来时也必须补齐增量。同一 Core 连续执行时不重复注入。

第一版使用确定性 Handoff，不额外调用模型总结。对每个 Run 和整体 Handoff 设置字节上限；超限时保留最近结果和结构化状态，并明确指出省略范围。

## 5. Core Catalog 与能力

系统级 Core Catalog 保存可信的可执行配置：

```yaml
agentCores:
  - key: codex-primary
    name: Codex
    adapter: codex
    enabled: true
    maxConcurrentRuns: 6
  - key: claude-primary
    name: Claude Code
    adapter: claude_code
    enabled: true
    maxConcurrentRuns: 3
```

普通 Agent 配置只选择已注册 Core。任意 shell 命令、Provider Home 来源和凭证引用属于可信系统配置，不通过普通 Agent API 开放。

能力由两部分组成：

- 平台静态能力：指令、Skills、插件、Hook 和 Provider Home 如何投影；
- ACP 动态能力：模型目录、配置选项、Session resume/load 等。

模型目录按 `(agentId, coreProfileId, coreGeneration)` 发现和缓存，因为不同 Agent 的账号、Provider Home 和权限可能不同。固定模型只能从目标 Core 实际返回的 `availableModels` 中选择；Core 不支持模型选择时只允许 `core_default`。

保存策略前校验每个目标 Core 是否已启用、已分配给 Agent、模型仍可用，并支持 Agent 所需的指令、MCP、Skills 和扩展能力。模型探测在配置保存、手动检测和低频刷新时执行，不在每个 Run 前重复拉起短生命周期 Core/MCP 进程。

## 6. 运行时能力投影

路由解析必须发生在运行准备之前。目标流程为：

```text
解析并持久化 Runtime Route
  -> 按目标 Core 准备 Provider Home
  -> 投影目标 Core 的 Skills、插件和 Hook
  -> 准备并注入 MCP
  -> 恢复目标 Core 的 Provider Session
  -> 应用模型
  -> 注入增量 Handoff
  -> startTurn
```

Skills 可以继续属于 Agent，由 Projector 根据本次 Core 写入相应目录。插件和 Hook 是 Provider 原生能力，应按 `(agent_id, core_profile_id, extension_id)` 保存。MCP 默认属于 Agent，但只有支持 MCP 注入的 Core 才能进入该 Agent 的路由。

不同 Core Profile 的 Provider Home 路径必须隔离。即使两个 Profile 都使用 Codex，也不能共享会话目录、运行缓存或认证身份不明确的状态。

## 7. 用量、审计、重置与清理

Run 增加以下不可变审计字段：

- `resolved_core_profile_id`；
- `resolved_core_generation`；
- `resolved_provider`；
- `resolved_model`；
- `resolved_rule_id`；
- `routing_policy_revision`；
- `fallback_reason`，第一版固定为空。

Provider 返回的累计 Token 用量保存到对应 `session_core_bindings`，Session 总用量为所有 Binding 的累计值之和。不能用当前 Core 的累计值覆盖整个业务 Session。

重置入口区分：

- 重置当前 Core 上下文；
- 重置指定 Core 上下文；
- 重置全部 Core 上下文。

Session 存储过期时遍历全部 Binding，清理各自的 acpx 记录和 Provider 原生历史，保留 Run、路由审计和 Token 统计。永久删除 Session 时再删除 Binding 与统计。

## 8. 失败语义

第一版不做静默自动降级：

- `core_unavailable`：目标 Core 无法启动或连接；
- `model_unavailable`：模型已下线或 Core 拒绝选择；
- `core_capability_mismatch`：Core 不支持 Agent 的必需能力；
- `session_resume_failed`：目标 Core 的 Provider Session 无法安全恢复。

不允许在一个 Run 已经开始或产生工具副作用后切换 Core。以后若增加 fallback，也只能在 `startTurn` 之前显式配置和执行，并持久化原目标、备用目标和降级原因。

被现有 Agent 路由引用的 Core 不允许直接禁用。管理员需要先为受影响 Agent 设置替代目标，再禁用 Core。

## 9. 管理 API 与界面

建议增加：

- Core 管理页：启用状态、适配器、健康状态、模型目录、并发上限和 generation；
- Agent Core 页签：选择允许使用的 Core，并管理各 Core 的原生插件和 Hook；
- Agent 运行路由：默认目标，以及按星期和多个时间段统一设置的 Core、模型和并发；
- 路由预览：当前 UTC 命中目标、下一次切换时间和配置冲突提示；
- Session Run：展示实际 Core、模型、命中规则和策略版本；
- Session 重置：选择当前、指定或全部 Core 上下文。

外部 Endpoint 和 Task API 不需要感知路由细节，仍绑定 Agent。调用方可从 Task/Run 查询结果中读取最终解析出的 Core 和模型用于审计。

## 10. 分阶段实施

### 阶段一：Core 数据模型与路由快照

- 增加 Core Profile、Agent Core 分配和统一运行策略；
- 调度器一次解析 Core、模型和并发；
- Run 持久化完整路由快照；
- 仍只允许每个 Agent 实际使用一个 Core，先验证无行为回归。

### 阶段二：多 Core Session

- 增加 `session_core_bindings`；
- acpx Key、Provider Home、Token 统计、重置和清理改为按 Core；
- 验证 Core A -> Core B -> Core A 能恢复各自的 Provider Session；
- 切换时只保留一个活跃 Handle。

### 阶段三：上下文与能力投影

- 增量 Handoff 和 cursor；
- Skills、插件、Hook、MCP 按目标 Core 投影；
- 能力矩阵、模型目录缓存和保存校验；
- 完成管理界面和运行记录展示。

第一版不包含任意 ACP 命令在线编辑、跨 Core 并发执行、执行中途切换、自动 fallback 和额外模型总结。

## 11. 必须通过的验收场景

1. Codex 内切换模型不会创建新的 Provider Session。
2. Codex -> Claude -> Codex 分别维护两个 Provider Session，切回后恢复原 Codex 上下文。
3. 切回 Core 时只补齐它离开期间的 Run，Handoff 不重复注入。
4. Run 排队跨越 UTC 时间边界时，Core、模型和并发使用同一份解析结果。
5. 配置修改不影响运行中的 Run，排队 Run 使用实际准入时的最新策略。
6. Core 切换后只有一个活跃 Core/MCP 进程树，空闲超时可以完整释放。
7. 服务重启后，各 Core Binding 仍能分别恢复。
8. Core 的 Token 累计不会互相覆盖，Session 总量正确。
9. Session 存储清理会清除全部 Core 原生历史，但保留统计和 Run 审计。
10. Core、模型或能力不可用时明确失败，不静默换目标。

## 12. 可行性结论

acpx 已经提供独立 Session Key、不同 Agent 命令、Provider Session 恢复和动态配置模型所需的基础能力，不需要修改 acpx。主要工作位于 Remote Agent Server 的持久化和业务编排层。

该功能不是在现有模型时间段中增加一个 `provider` 字段。可安全交付的最小闭环必须同时包含：统一路由快照、每 Core Session Binding、增量 Handoff、按 Core 能力投影，以及多 Core Token/清理语义。
