# Agent MCP 管理设计（第一版）

## 1. 目标

Remote Agent Server 为 Agent 提供 HTTP 和 stdio MCP 配置。不同 Session 可以为同一个 Agent 提供不同参数；每次 Run 开始前，服务解析当前 Session 的配置、检查所有启用 MCP，并通过 ACP `mcpServers` 传给 Claude Code、Codex 或 Hermes。

第一版只完成稳定主流程，不建设 MCP 平台、共享 Catalog、Gateway 或复杂恢复机制。

## 2. 第一版范围

支持：

- Agent 下创建、查看、修改、启停和删除 MCP。
- Streamable HTTP MCP：URL 和 Headers。
- stdio MCP：command、Arguments 和 Environment。
- `fixed`、`session_parameter`、`runtime` 三种值来源。
- Agent 声明 Session 参数；创建 Session 和 Session 设置页填写参数。
- 敏感 fixed 值和敏感 Session 参数加密保存。
- 手动连接检查。
- 每次 Run 对所有 enabled MCP 执行 `initialize + tools/list`。
- 每个 Session 使用独立 acpx Runtime，通过 ACP 注入当前 MCP。
- Agent MCP 页面和 Session 参数设置页面。

不支持：

- 全局 MCP Catalog 或多个 Agent 共享 MCP。
- 外部请求临时新增或覆盖 MCP 定义。
- 每个 Run 临时覆盖 Session 参数。
- OAuth、旧 SSE Transport、Gateway 和连接池。
- Tool allow/deny、Provider 私有字段和工具调用超时。
- MCP Doctor 汇总、专用 smoke 脚本和一次性测试参数。

## 3. 核心规则

1. MCP 属于 Agent；Session 只保存 Agent 已声明的参数值。
2. 敏感值只能进入 HTTP Header 或 stdio Environment，不能进入 Argument。
3. Runtime 参数白名单固定为：`agent_id`、`session_id`、`run_id`、`workspace_path`、`browser_profile_path`。
4. 所有 enabled MCP 都是必要能力；任一预检失败时 Run 失败，模型 Turn 不启动。
5. Session 参数只能在 Session `idle` 且没有 queued/running Run 时修改。
6. MCP 配置通过 ACP 传入 Provider，不写入 Provider MCP 配置、acpx Session Store、Event 或 Run error。
7. 同一个 Agent 的不同 Session 使用不同 acpx Runtime，不能共享 MCP 明文或 Handle。
8. 每次 Run 都刷新当前 Session 的 Provider Handle，并使用 `providerSessionId` 续接原对话，不做配置指纹和缓存判断。

## 4. 数据模型

第一版使用四张表。

### 4.1 `agent_mcp_servers`

```text
id                    TEXT PRIMARY KEY
agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE
name                  TEXT NOT NULL
transport             TEXT NOT NULL CHECK (transport IN ('http', 'stdio'))
enabled               INTEGER NOT NULL CHECK (enabled IN (0, 1))
url                   TEXT
command               TEXT
check_timeout_seconds INTEGER NOT NULL DEFAULT 30
last_checked_at       TEXT
last_check_status     TEXT CHECK (last_check_status IN ('passed', 'failed'))
last_check_message    TEXT
last_tool_count       INTEGER
created_at            TEXT NOT NULL
updated_at            TEXT NOT NULL
UNIQUE(agent_id, name)
```

约束：

- name 匹配 `[A-Za-z0-9_-]{1,64}`。
- HTTP 必须有 `http/https` URL，command 为空。
- stdio 必须有单个可执行文件名或绝对路径，URL 为空；不经过 shell。
- `check_timeout_seconds` 为 1 至 300 秒。
- transport 创建后不可修改。

### 4.2 `agent_session_parameters`

```text
id          TEXT PRIMARY KEY
agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE
key         TEXT NOT NULL
label       TEXT NOT NULL
description TEXT
required    INTEGER NOT NULL CHECK (required IN (0, 1))
secret      INTEGER NOT NULL CHECK (secret IN (0, 1))
created_at  TEXT NOT NULL
updated_at  TEXT NOT NULL
UNIQUE(agent_id, key)
```

`key` 和 `secret` 创建后不可修改。参数仍被 MCP 或 Session 使用时不能删除。

### 4.3 `agent_mcp_values`

```text
id                   TEXT PRIMARY KEY
mcp_server_id        TEXT NOT NULL REFERENCES agent_mcp_servers(id) ON DELETE CASCADE
kind                 TEXT NOT NULL CHECK (kind IN ('argument', 'header', 'environment'))
position             INTEGER NOT NULL
target_name          TEXT
source_type          TEXT NOT NULL CHECK (source_type IN ('fixed', 'session_parameter', 'runtime'))
plain_value          TEXT
encrypted_value      TEXT
secret               INTEGER NOT NULL DEFAULT 0 CHECK (secret IN (0, 1))
session_parameter_id TEXT REFERENCES agent_session_parameters(id)
runtime_key          TEXT
UNIQUE(mcp_server_id, kind, position)
```

- Argument 使用 position 排序，`target_name` 为空。
- Header 和 Environment 必须有 `target_name`。
- HTTP 只允许 Header；stdio 只允许 Argument 和 Environment。
- 一条记录只能使用一种来源。
- Argument 不能设置 `secret`，也不能引用敏感 Session 参数。

### 4.4 `session_mcp_parameter_values`

```text
session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
parameter_id    TEXT NOT NULL REFERENCES agent_session_parameters(id) ON DELETE RESTRICT
plain_value     TEXT
encrypted_value TEXT
created_at      TEXT NOT NULL
updated_at      TEXT NOT NULL
PRIMARY KEY(session_id, parameter_id)
```

普通值写 `plain_value`，敏感值写 `encrypted_value`。

## 5. 敏感值

服务使用 AES-256-GCM 加密敏感 fixed 值和敏感 Session 参数。主密钥保存在 `DATA_DIR/secret.key`，首次需要时自动生成，权限为 `0600`。

API 对敏感字段只返回：

```json
{ "secret": true, "configured": true }
```

编辑时留空表示保留旧值，填写新值表示替换。第一版不提供单独清除敏感 fixed 值操作；需要移除时删除对应 Header 或 Environment。

密钥和解密值不得进入日志、Event、Run error、acpx Session Store 或 Provider MCP 配置。

## 6. MCP 解析

### 6.1 fixed

值保存在 MCP 定义中，所有 Session 共用。

### 6.2 session_parameter

Agent 先声明参数，Session 创建或设置时保存值。同 Agent 的不同 Session 可以保存不同租户和认证。

### 6.3 runtime

服务在 Run 时生成白名单值。无模板语言，不读取 prompt 或任意外部字段。

stdio command 如果是 basename，服务按当前 PATH 解析为绝对可执行路径；如果是绝对路径则直接验证可执行。ACP 只接收绝对 command。

## 7. Runtime 流程

```text
Run 标记 running
  -> 读取 Agent、Session 和 enabled MCP
  -> 解析 fixed / Session / Runtime 值
  -> 并行执行 initialize + tools/list
  -> 投影 Agent Skills
  -> 关闭当前 Session 的旧 Handle（若存在）
  -> 创建该 Session 的新 acpx Runtime，并传入 ACP mcpServers
  -> 使用 providerSessionId resume，或首次创建 ACP Session
  -> 启动模型 Turn
```

每个 Session 的 `ManagedSession` 保存自己的 Runtime、Registry 和 Handle。不同 Session 可以并发，同一 Session 仍由现有 Run 状态约束串行执行。

现有 Agent Provider Home 继续用于登录和 Agent Skills，不在其中写 MCP。Hermes 的 Agent Home 基础配置需要移除主机 `mcp_servers`，避免同时加载主机 MCP；其余 Provider Home 行为保持现状。

MCP 解析或预检失败统一为：

```text
mcp_check_failed
```

公开错误只包含 MCP 名称和固定消息，例如 `MCP example-mcp check failed`。Run 进入 failed，Session 回到 idle，模型 Turn 不启动。

## 8. API

MCP：

```text
GET    /api/agents/:agentId/mcp-servers
POST   /api/agents/:agentId/mcp-servers
GET    /api/agents/:agentId/mcp-servers/:id
PATCH  /api/agents/:agentId/mcp-servers/:id
DELETE /api/agents/:agentId/mcp-servers/:id
POST   /api/agents/:agentId/mcp-servers/:id/check
```

Session 参数定义：

```text
GET    /api/agents/:agentId/session-parameters
POST   /api/agents/:agentId/session-parameters
PATCH  /api/agents/:agentId/session-parameters/:id
DELETE /api/agents/:agentId/session-parameters/:id
```

Session 创建增加：

```json
{
  "agentId": "agent-id",
  "title": "处理工单",
  "mcpParameters": {
    "tenant_id": "crawler-team",
    "access_token": "token"
  }
}
```

Session 修改：

```text
PATCH /api/sessions/:id/mcp-parameters
body: { "values": { "tenant_id": "team-b", "access_token": "new-token" } }
```

PATCH 只修改请求中出现的 key，未出现的值保持不变。普通可选参数可传 `null` 删除；required 参数不能删除。

手动检查：纯 fixed MCP 使用空请求；引用 Session 参数或 Runtime 路径时必须传属于该 Agent 的 `sessionId`。检查中的 `run_id` 使用服务端生成的临时 UUID。不支持一次性测试参数。

## 9. 页面

Agent 详情增加独立 MCP Tab：

```text
概览 | Skills | MCP | 设置
```

```text
/agents/:id/mcp
/agents/:id/mcp/new
/agents/:id/mcp/:mcpServerId
```

MCP 列表只展示名称、transport、enabled、最近检查结果和操作。创建与编辑使用独立页面；HTTP 与 stdio 显示各自字段。Session 参数定义放在 MCP 列表页的独立卡片中。

Session 创建页根据 Agent 加载参数定义。Session 参数修改使用：

```text
/sessions/:id/settings
```

Session 运行中禁用保存。缺少 required 参数时禁用发送消息，并链接到设置页。

## 10. 测试与验收

必须覆盖：

- HTTP/stdio MCP CRUD 和字段校验。
- fixed、Session、Runtime 三种值解析。
- 敏感值加密和 API 脱敏。
- Session 创建/空闲修改参数，运行中拒绝修改。
- HTTP/stdio `initialize + tools/list` 成功与失败。
- 预检失败时模型 Turn 未启动。
- 两个 Session 获得各自 MCP 值和 acpx Runtime。
- MCP 更新后下一 Run 使用新配置并续接 provider Session。
- Agent MCP 与 Session 设置页面核心流程。
- 全量测试、类型检查和生产构建通过。

第一版验收结果：管理员能够配置 Agent MCP，Session 能提供不同参数，Run 能安全地检查并注入 MCP；失败时明确停止在模型调用之前。
