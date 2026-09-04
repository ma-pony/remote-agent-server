# Agent Core 运行路由

[English](agent-core-routing.en.md)

Remote Agent Server 允许一个 Agent 配置多个 Agent Core，并在 Run 真正开始时统一选择 Core、模型和并发。业务 Session、Workspace 和外部 Conversation 保持不变；每个 Core 单独维护自己的 Provider 原生会话。

## 1. 设计目标

这套设计解决三个问题：

- 一个业务 Agent 可以使用 Codex、Claude Code 或 Hermes 等不同执行器；
- 白天、夜间或不同工作日可以选择不同 Core、模型和并发上限；
- Core 切换后仍能继续同一个任务，但不会错误复用另一个 Core 的隐藏上下文。

系统不尝试迁移 Provider 的内部状态。可共享的内容只有 Workspace、服务端持久化状态和显式 Handoff。

## 2. 四个核心概念

### Agent Core Profile

Core Profile 是 Agent 可选择的执行身份，包含：

- 名称；
- Provider：`codex`、`claude_code` 或 `hermes`；
- 是否启用；
- 可选的并发上限。

Provider 在 Profile 创建后不可修改。需要更换 Provider 时创建新 Profile，避免把旧 Provider 会话静默解释成另一种执行器状态。

### Core 路由模式

Agent 支持两种模式：

| 模式 | 行为 | 适用场景 |
| --- | --- | --- |
| `session_sticky` | Session 第一个 Run 绑定默认 Core，后续 Turn 始终复用该 Core。 | 默认模式；最稳定、上下文连续性最好。 |
| `scheduled_handoff` | 每个 Run 开始时按 UTC 规则选择 Core；切换时注入增量 Handoff。 | 需要按成本、能力或时间切换执行器。 |

同一业务 Session 仍然串行执行，不会让两个 Core 同时操作同一个 Workspace。

### Session Core Binding

一个业务 Session 对每个使用过的 Core 保存一条独立绑定：

- Provider Session ID；
- 已同步的 Run 游标；
- 最近模型和使用时间；
- 该 Core 返回的累计 Token 用量。

默认 Core 沿用 `remote-agent:<sessionId>` 持久化键，保证升级前已有会话可以继续恢复；非默认 Core 使用 `remote-agent:<sessionId>:core:<coreProfileId>`。不同 Core 不会共享 Provider Session ID。

### Resolved Run Route

调度器在 Run 获得执行槽位时解析一次路由，并把结果写入 Run：

- Core Profile 与 Provider；
- 模型；
- 命中的规则序号；
- 策略摘要；
- 实际并发上限。

Executor 使用这份不可变快照启动运行，不会在时间边界再次解析配置。

## 3. 路由规则

模型策略继续使用现有协议，并在需要跨 Core 时增加 Core ID：

```json
{
  "mode": "schedule",
  "defaultCoreProfileId": 1,
  "defaultModel": "glm-5.3-flash",
  "windows": [
    {
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "start": "08:00",
      "end": "20:00",
      "coreProfileId": 1,
      "model": "glm-5.3-flash",
      "maxConcurrentRuns": 4
    },
    {
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "start": "20:00",
      "end": "08:00",
      "coreProfileId": 2,
      "model": "deepseek-v4",
      "maxConcurrentRuns": 2
    }
  ]
}
```

规则语义：

- 时间统一使用 UTC 和 24 小时制；
- 开始时间包含，结束时间不包含；
- 结束时间早于开始时间表示跨 UTC 日；
- 多条规则重叠时，配置靠前的规则优先；
- 未命中规则时使用默认 Core 和默认模型；
- 排队 Run 在真正获得槽位时读取最新策略，运行中的 Run 不受配置修改影响。

调度器分别检查 Agent 总量和当前 Core 的容量：

```text
Agent 容量 = min(系统全局上限, 命中时间段上限 ?? Agent 默认上限)
Core 容量  = min(系统全局上限, Core Profile 上限)
```

时间段上限覆盖 Agent 默认上限，Core Profile 上限只限制自身，不会压低同一 Agent 下其他 Core 的容量。Run 中记录的有效并发是两者的最小值。

## 4. 一次 Run 的执行流程

```text
Run 获得执行槽位
  -> 解析并持久化 Runtime Route
  -> 选择或创建 Session Core Binding
  -> 准备 Workspace、Skills、扩展和 MCP
  -> 恢复目标 Core 的 Provider Session
  -> 必要时注入增量 Handoff
  -> startTurn
  -> 保存结果、用量和 Handoff 游标
```

运行时按目标 Provider 投影能力：

- Skills 和 MCP 属于 Agent，每次投影到当前 Core；
- 插件和 Hook 按 Provider 选择，同一种 Provider 的多个 Core 共用选择；
- Provider 会话和 acpx 会话键按 Core 隔离；同 Provider 的静态配置仍按 Agent 统一投影；
- 同一业务 Session 同时只保留一个活跃 Runtime Handle。切换 Core 会关闭旧 Handle，但保留其持久化会话。

## 5. Handoff

目标 Core 的游标落后于 Session 历史时，服务端把尚未见过的终态 Run 组成确定性 Handoff，并与当前用户请求一起发送。

第一版 Handoff 包含：

- Run ID、状态、Core、Provider 和模型；
- 用户请求；
- 最终结果或错误。

Handoff 不包含 thought 和完整事件流。常见 Authorization、API Key、Token、Password、Secret 会脱敏；单字段最多 4 KiB，总体最多 24 KiB，超限优先保留最近记录。

只有 `startTurn` 成功创建后，目标 Core 的游标才会在 Run 结束时推进。Workspace、MCP 或 Runtime 准备阶段失败不会误标记为“Core 已看过”。

Handoff 提供可恢复的业务语境，不承诺复制 Provider 的隐式记忆、压缩状态或内部缓存。因此 `session_sticky` 仍是默认和推荐模式。

## 6. 配置与安全约束

- 固定模型必须来自目标 Core 通过 ACP 返回的模型目录；不允许手填未知模型。
- 默认 Core、策略引用的 Core 和固定 Session 使用的 Core 不能直接停用。
- 已被 Session Binding 引用的 Core 不能删除；先删除相应 Session 或调整使用关系。
- 不在 Run 中途切换 Core，也不做静默自动降级。启动失败时当前 Run 明确失败。
- Profile 只选择服务内已支持的 Provider，不允许通过普通 Agent API 注入任意 shell 命令。

## 7. 重置、清理与用量

“重建执行器会话”会：

- 关闭当前活跃 Runtime；
- 清理该业务 Session 的全部 Core Provider 会话和 acpx 持久化状态；
- 清空 Handoff 游标，使后续 Core 从保留的 Run 历史重新衔接；
- 保留业务 Session、Workspace、Run、事件和 Token 统计。

会话存储过期清理也会遍历所有 Core Binding。永久删除 Session 时，Binding 随 Session 删除。

Provider 返回的累计用量按 Binding 保存，Session 展示所有 Binding 的汇总，避免 Core 切换时互相覆盖。

## 8. 管理 API

```text
GET    /api/agents/:id/core-profiles
POST   /api/agents/:id/core-profiles
PATCH  /api/agents/:id/core-profiles/:profileId
DELETE /api/agents/:id/core-profiles/:profileId
GET    /api/agents/:id/core-profiles/:profileId/models
```

Agent 更新接口接受：

- `coreRoutingMode`；
- `defaultCoreProfileId`；
- 带可选 Core ID 的 `modelPolicy`。

扩展目录使用 `GET /api/agents/:id/extensions?provider=codex|claude_code`，启停扩展时在请求体传递同一个 `provider`。

## 9. 验收标准

1. Sticky Session 首次运行后固定 Core，后续 Run 不受默认 Core 修改影响。
2. Scheduled Session 可完成 Codex -> Claude -> Codex 切换，并分别恢复两个 Provider 会话。
3. Core、模型和并发来自同一个 UTC 时间快照，并写入 Run 审计字段。
4. 切回 Core 时只注入它尚未见过的终态 Run；准备阶段失败不推进游标。
5. Core 切换后同一业务 Session 只有一个活跃 Runtime 进程树。
6. Token 汇总、重置和存储清理覆盖 Session 的全部 Core Binding。
7. Core 或模型不可用时明确失败，不在执行中自动换目标。

这套实现刻意保持边界简单：没有 Core generation、分布式状态复制、模型生成摘要、执行中途切换和自动 fallback。后续只有在真实需求出现时才扩展这些能力。
