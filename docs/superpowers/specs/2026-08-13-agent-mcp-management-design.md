# Agent MCP 管理设计

## 1. 目标

Remote Agent Server 为每个 Agent 提供独立的 MCP 配置能力，同时支持 Streamable HTTP 和 stdio 两种传输方式。管理员在管理台直接配置 URL、Header、命令、参数和环境变量；不同 Session 可以为同一个 Agent 提供不同的 MCP 参数；Claude Code、Codex、Hermes 在每次 Run 开始前通过 ACP `mcpServers` 获得当前 Session 的 MCP 配置。

本设计只覆盖 Agent MCP 管理。通用外部调用 API 和 Grab Manager 迁移分别作为后续任务，不在本次实现中混入。

## 2. 核心原则

1. MCP 属于 Agent，Session 只提供该 Agent 预先声明的参数值。
2. 外部 Task 不能新增、删除或覆盖 Agent 的 MCP 定义。
3. 同一个 Agent 的不同 Session 可以使用不同的认证、租户、项目等参数。
4. 一个 Session 内的所有 Run 默认复用相同 MCP 参数；参数只能在 Session 空闲时显式修改。
5. 每个 Session 使用自己的 Provider Runtime Home，避免并发 Session 相互覆盖配置。
6. 不使用通用 `config_json`；服务端保存经过校验的明确字段和有序子记录。
7. 敏感值由管理台直接录入，加密存储，不要求用户配置服务环境变量映射。
8. 每个启用的 MCP 都是 Agent 的必需能力；MCP 不可用时不启动模型 Turn。

## 3. 范围

### 3.1 第一版支持

- Agent 独立 MCP 列表。
- Streamable HTTP MCP。
- stdio MCP。
- 固定值、Session 参数和 Runtime 参数三种值来源。
- HTTP Header。
- stdio 有序 Arguments 和独立 Environment。
- 连接检查超时。
- 敏感固定值和敏感 Session 参数加密。
- MCP 新增、查看、修改、启停、删除和连接检查。
- Session 创建时填写 MCP 参数。
- Session 空闲时修改 MCP 参数。
- Claude Code、Codex、Hermes 的 ACP `mcpServers` 注入。
- Run 开始前 MCP `initialize` 和 `tools/list` 预检。
- Agent Doctor 汇总 MCP 配置和最近检查状态。

### 3.2 第一版不支持

- 全局 MCP Catalog。
- 多 Agent 共享一条 MCP 配置。
- 外部 Task 临时注入 MCP。
- 每个 Run 临时覆盖 Session MCP 参数。
- OAuth 登录流程。
- 旧版独立 SSE MCP Transport。
- MCP Gateway 或 Proxy。
- Provider 私有任意配置字段。
- MCP Tool 白名单和黑名单。
- MCP Tool 自动重试。
- MCP 连接池或预检缓存。
- 自定义 CA、单 MCP 代理和 mTLS。

## 4. 数据模型

### 4.1 `agent_mcp_servers`

```text
id                          TEXT PRIMARY KEY
agent_id                    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE
name                        TEXT NOT NULL
transport                   TEXT NOT NULL CHECK (transport IN ('http', 'stdio'))
enabled                     INTEGER NOT NULL CHECK (enabled IN (0, 1))
url                         TEXT
command                     TEXT
check_timeout_seconds       INTEGER NOT NULL DEFAULT 30
last_checked_at             TEXT
last_check_status           TEXT CHECK (last_check_status IN ('passed', 'failed'))
last_check_message          TEXT
last_tool_count             INTEGER
created_at                  TEXT NOT NULL
updated_at                  TEXT NOT NULL
UNIQUE(agent_id, name)
```

约束：

- `transport=http` 时 `url` 必填、`command` 必须为空。
- `transport=stdio` 时 `command` 必填、`url` 必须为空。
- `name` 使用 Provider 均能接受的稳定标识：`[A-Za-z0-9_-]`，长度 1 至 64。
- URL 只允许 `http` 和 `https`。
- `command` 是单个可执行文件名或绝对路径，不能包含 Shell 拼接。
- `check_timeout_seconds` 范围为 1 至 300 秒。
- 修改连接配置后清空最近检查结果。

### 4.2 `agent_session_parameters`

```text
id              TEXT PRIMARY KEY
agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE
key             TEXT NOT NULL
label           TEXT NOT NULL
description     TEXT
required        INTEGER NOT NULL CHECK (required IN (0, 1))
secret          INTEGER NOT NULL CHECK (secret IN (0, 1))
created_at      TEXT NOT NULL
updated_at      TEXT NOT NULL
UNIQUE(agent_id, key)
```

规则：

- `key` 和 `secret` 创建后不可修改。
- `label`、`description` 和 `required` 可以修改。
- 被 MCP Header、Argument、Environment 引用，或已有 Session 保存参数值时不能删除。
- 参数定义属于 Agent，不属于某个 MCP Server，因此一个参数可以被该 Agent 的多个 MCP 引用。

### 4.3 `agent_mcp_arguments`

```text
id                      TEXT PRIMARY KEY
mcp_server_id           TEXT NOT NULL REFERENCES agent_mcp_servers(id) ON DELETE CASCADE
position                INTEGER NOT NULL
source_type             TEXT NOT NULL CHECK (source_type IN ('fixed', 'session_parameter', 'runtime'))
plain_value             TEXT
session_parameter_id    TEXT REFERENCES agent_session_parameters(id)
runtime_key             TEXT
UNIQUE(mcp_server_id, position)
```

Argument 按 `position` 排序后以数组形式传给可执行程序，不经过 `sh -c`。

固定 Argument 只允许普通明文值。敏感值禁止作为 Argument，包括敏感固定值和敏感 Session 参数，避免凭证出现在进程列表或错误信息中；服务端在保存配置时拒绝 Argument 引用 `secret=true` 的 Session 参数。

### 4.4 `agent_mcp_bindings`

```text
id                      TEXT PRIMARY KEY
mcp_server_id           TEXT NOT NULL REFERENCES agent_mcp_servers(id) ON DELETE CASCADE
kind                    TEXT NOT NULL CHECK (kind IN ('header', 'environment'))
target_name             TEXT NOT NULL
source_type             TEXT NOT NULL CHECK (source_type IN ('fixed', 'session_parameter', 'runtime'))
plain_value             TEXT
encrypted_value         TEXT
secret                  INTEGER NOT NULL DEFAULT 0 CHECK (secret IN (0, 1))
session_parameter_id    TEXT REFERENCES agent_session_parameters(id)
runtime_key             TEXT
UNIQUE(mcp_server_id, kind, target_name)
```

HTTP MCP 只允许 `header`；stdio MCP 只允许 `environment`。禁止手工配置 `Host`、`Content-Length`、`Connection` 和 `Transfer-Encoding` 等由 HTTP 客户端管理的 Header。

### 4.5 `session_mcp_parameter_values`

```text
session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
parameter_id     TEXT NOT NULL REFERENCES agent_session_parameters(id) ON DELETE RESTRICT
plain_value      TEXT
encrypted_value  TEXT
created_at       TEXT NOT NULL
updated_at       TEXT NOT NULL
PRIMARY KEY(session_id, parameter_id)
```

普通参数只写 `plain_value`，敏感参数只写 `encrypted_value`。服务端根据参数定义决定存储位置，调用方不能自行指定。

## 5. 值来源

### 5.1 固定值 `fixed`

固定值属于 Agent MCP 定义，所有 Session 共用。普通值直接保存；标记为敏感的 Header 或 Environment 使用加密值。

示例：

```text
X-API-Version = 2026-08
X-Api-Key = gm_xxxxx（敏感）
```

### 5.2 Session 参数 `session_parameter`

Agent 先声明参数，创建 Session 时再填值。

示例：

```text
X-Tenant   <- tenant_id
X-Api-Key  <- grab_manager_api_key
```

同一个 Agent 的 Session A 和 Session B 可以保存不同值。后续 Run 复用所属 Session 的值。

### 5.3 Runtime 参数 `runtime`

第一版只开放以下白名单：

```text
agent_id
session_id
run_id
workspace_path
browser_profile_path
```

Runtime 参数由服务端生成，不能引用 prompt、Event、任意模板表达式或外部请求字段。

## 6. SecretStore

服务使用 AES-256-GCM 加密敏感固定值和敏感 Session 参数。每个密文使用独立随机 nonce，编码中包含版本、nonce、ciphertext 和 authentication tag。

主密钥位于：

```text
DATA_DIR/secret.key
```

规则：

- 第一次启动且没有密文数据时自动生成原始 32 字节密钥文件，不做文本或 base64 编码，文件权限设为 `0600`。
- 已有密文但密钥缺失、长度错误或权限不安全时，服务启动失败。
- 不会生成新密钥覆盖旧密钥。
- API、日志、Run result 和 Event 不返回解密值。
- 敏感 API 字段只返回 `secret: true` 和 `configured: true/false`。
- 修改敏感值时不传 `value` 表示保留；传新值表示替换；显式 `clear: true` 表示清除。
- 备份和恢复敏感配置时必须安全保存数据库及 `secret.key`。

解密后的 MCP 值只存在于当前 Session 的服务进程与 Provider 进程内存中，并通过 ACP 传入 Agent；它们不写入 acpx Session Store、Event、Run error 或 Remote Agent Server 生成的 Provider 配置。Session Runtime 目录仍设为 `0700`，其中的 Provider 基础配置文件权限为 `0600`，Session 删除时一并清理。

## 7. Session Runtime 隔离

现有 Session 已有以下目录：

```text
sessions/<session-id>/
  workspace/
  runtime/
  browser/
```

Provider Home 改为 Session 级：

```text
sessions/<session-id>/runtime/
  claude/
  codex/
  hermes/
```

`data/agents/<agent-id>/` 只保留 Agent 定义、Skills 和 Memory。不能继续把带 Session 参数的 Provider 配置写进 Agent 共享 Home，否则同一 Agent 的并发 Session 会互相覆盖。

Provider 处理：

- Remote Agent Server 将解析后的 HTTP 或 stdio 配置转换成 ACP `McpServer[]`，由 Agent 适配器接入 Claude Code、Codex 或 Hermes。
- 每个 Session 持有独立的 acpx Runtime；同一 Agent 的不同 Session 不共享 `mcpServers` 或 Provider Handle。
- Claude Code：使用当前 Session 的 Claude Home，不写主机 MCP 配置。
- Codex：使用当前 Session 的 Codex Home，同时保留 Remote Agent Server 管理的 Skills 禁用规则。
- Hermes：读取主机 Hermes 基础模型配置，移除 `mcp_servers`，写入 Session Hermes Home；Agent Skills 投影到该 Session Home，主机 Skills 不被继承。
- Provider 登录凭证不复制到数据库。Codex 和 Hermes 继续只读链接各自登录文件；Claude 在 Linux 存在 `~/.claude/.credentials.json` 时只读链接，在 macOS 从系统 Keychain 的 `Claude Code-credentials` 项读取并以 `0600` 写入 Session Claude Home，Session 删除时清理。
- 不修改主机用户的 Claude Code、Codex 或 Hermes 配置。

ACP 当前的通用 `McpServer` 结构只包含连接字段，不包含可移植的 Provider 工具调用超时。因此第一版只配置 Remote Agent Server 自己执行检查和 Run 前预检时使用的 `check_timeout_seconds`；模型运行中的工具超时继续使用各 Provider 默认值，避免提供名义存在但实际不能跨 Provider 生效的选项。

已有 Session 已具备 `runtime/` 目录。第一次执行新版本 Run 时直接准备 Session 级 Provider Home，并通过 ACP 注入 MCP，不读取旧 Agent 共享 MCP 配置。

## 8. Run 准备流程

```text
Run 标记 running
  -> 读取 Agent、Session、MCP 和参数定义
  -> 解密固定值和 Session 参数
  -> 解析 Runtime 参数
  -> 对所有 enabled MCP 执行 initialize + tools/list 预检
  -> 投影 Agent Skills
  -> 转换为当前 Session 的 ACP mcpServers
  -> ensure/resume ACP Session
  -> 启动模型 Turn
```

每个启用的 MCP 都必须预检成功。HTTP MCP 建立临时连接；stdio MCP 启动临时子进程并在检查完成后关闭。第一版不做预检缓存，也不区分 required/optional。

Session Provider 基础配置通过“临时文件 -> 权限校验 -> 原子 rename”写入。生成失败时保留上一份完整文件，不留下半写配置。MCP 本身只通过 ACP `mcpServers` 注入，不写入这些文件。

Run 失败时：

- Run 进入 `failed`。
- Session 恢复 `idle`。
- 模型 Turn 不启动。
- Workspace、Browser 和 Provider Session ID 保留。
- 用户修复 MCP 或 Session 参数后提交新 Run。

## 9. MCP 配置 API

```text
GET    /api/agents/:agentId/mcp-servers
POST   /api/agents/:agentId/mcp-servers
GET    /api/agents/:agentId/mcp-servers/:id
PATCH  /api/agents/:agentId/mcp-servers/:id
DELETE /api/agents/:agentId/mcp-servers/:id
POST   /api/agents/:agentId/mcp-servers/:id/check
```

HTTP MCP 创建示例：

```json
{
  "name": "grab-manager",
  "transport": "http",
  "url": "https://grab-manager.example.com/api/mcp/v1/rpc",
  "checkTimeoutSeconds": 30,
  "headers": [
    {
      "name": "X-Api-Key",
      "source": "fixed",
      "value": "gm_xxxxx",
      "secret": true
    },
    {
      "name": "X-Tenant",
      "source": "session_parameter",
      "parameterKey": "tenant_id"
    },
    {
      "name": "X-Remote-Run-Id",
      "source": "runtime",
      "runtimeKey": "run_id"
    }
  ]
}
```

stdio MCP 创建示例：

```json
{
  "name": "filesystem",
  "transport": "stdio",
  "command": "npx",
  "checkTimeoutSeconds": 30,
  "arguments": [
    { "source": "fixed", "value": "-y" },
    { "source": "fixed", "value": "@modelcontextprotocol/server-filesystem" },
    { "source": "runtime", "runtimeKey": "workspace_path" }
  ],
  "environment": [
    {
      "name": "ACCESS_TOKEN",
      "source": "session_parameter",
      "parameterKey": "access_token"
    }
  ]
}
```

所有路由继续使用现有管理 API Bearer Token。传输方式创建后不可修改；需要切换时删除并新建，避免残留另一种传输的字段。

## 10. Session 参数 API

Agent 参数定义：

```text
GET    /api/agents/:agentId/session-parameters
POST   /api/agents/:agentId/session-parameters
PATCH  /api/agents/:agentId/session-parameters/:id
DELETE /api/agents/:agentId/session-parameters/:id
```

Session 创建扩展：

```json
{
  "agentId": "agent-id",
  "title": "处理工单 1332",
  "mcpParameters": {
    "tenant_id": "crawler-team",
    "access_token": "token-xxx"
  }
}
```

Session 参数修改：

```text
PATCH /api/sessions/:id/mcp-parameters
```

```json
{
  "values": {
    "tenant_id": "crawler-team-b",
    "access_token": "new-token"
  }
}
```

Session 参数修改必须在同一个 `BEGIN IMMEDIATE` 事务内重新确认 Session 为 `idle` 且不存在 queued/running Run。否则返回 `409 session_busy`。

PATCH 采用字段级合并：只替换请求中出现的参数，`null` 清除可选参数，未出现的参数保持原值。这样可以单独轮换一个敏感参数而不覆盖其他 Session 配置。

Session 详情增加：

```text
mcpParametersValid
missingMcpParameters
mcpParameters
```

敏感参数只返回是否已配置。Agent 新增必填参数后，已有 Session 可以继续查看历史，但创建新 Run 前必须补齐参数。

## 11. 连接检查

```text
POST /api/agents/:agentId/mcp-servers/:id/check
```

固定值 MCP 可以使用空请求体。引用 Session 参数或 Session 路径时传入一个属于该 Agent 的 Session：

```json
{ "sessionId": "session-id" }
```

还没有 Session 时，可以传一次性测试参数：

```json
{
  "parameters": {
    "tenant_id": "test-team",
    "access_token": "test-token"
  }
}
```

一次性参数不保存。若 MCP 引用了 `workspace_path`、`browser_profile_path` 或 `session_id`，检查必须选择现有 Session；`run_id` 使用本次检查生成的临时 UUID。

检查执行 `initialize`、`tools/list` 和有界关闭。结果保存最近检查时间、状态、脱敏消息和工具数量，不保存测试参数或工具返回内容。

Agent Doctor 不自动重新启动所有 MCP，只汇总配置完整性和最近检查结果。真实检查由 MCP 页面逐项触发。

## 12. 管理界面

Agent 详情导航：

```text
概览 | Skills | MCP | 设置
```

路由：

```text
/agents/:id/mcp
/agents/:id/mcp/new
/agents/:id/mcp/:mcpServerId
```

MCP 列表只展示名称、传输方式、启用状态、最近检查结果和操作。HTTP 与 stdio 编辑使用独立表单结构，不把全部字段堆在列表页。

Agent MCP 页面同时提供 Session 参数定义入口。选择 `session_parameter` 来源时只能引用已经声明的参数。

Session 创建页面根据选中的 Agent 动态加载参数定义。Session 参数修改使用独立页面：

```text
/sessions/:id/settings
```

运行中的 Session 禁用参数修改，并说明需要结束或取消当前 Run。

## 13. 错误语义

配置 API：

```text
invalid_mcp_server
invalid_mcp_value
duplicate_mcp_name
mcp_parameter_in_use
```

Session 参数：

```text
missing_session_mcp_parameters
unknown_session_mcp_parameter
session_busy
secret_decryption_failed
```

Run 准备：

```text
mcp_connection_failed
mcp_authentication_failed
mcp_protocol_failed
mcp_process_failed
mcp_resolution_failed
```

错误 Event 可以包含 MCP 名称、错误分类和脱敏消息，不能包含 Header 值、Session 敏感参数、stdio 敏感 Environment 或完整敏感命令行。

## 14. 删除和更新语义

- Agent MCP 可以在其他 Session 运行时修改；只影响各 Session 的下一次 Run。
- Session 参数只能在本 Session 空闲时修改。
- MCP 参数变化后下一次 Run 刷新 Provider Handle，并使用原 `providerSessionId` 恢复 ACP Session。
- 删除 Session 时级联删除参数值，并由 WorkspaceManager 删除 Workspace、Browser 和 Runtime。
- 删除 Agent 仍要求没有 Session；删除后级联删除 MCP、参数定义和固定密文。

## 15. 测试要求

后端：

- HTTP 和 stdio MCP CRUD、校验和唯一约束。
- 固定值、Session 参数和 Runtime 参数解析。
- 敏感值加密、解密、替换、清除和 API 脱敏。
- 主密钥生成、权限检查及密钥丢失启动失败。
- Session 创建参数校验和原子保存。
- 运行中 Session 拒绝修改参数。
- HTTP MCP `initialize`、`tools/list` 和关闭。
- stdio MCP 启动、握手、关闭及子进程回收。
- MCP 失败时模型 Turn 从未启动。
- Claude Code、Codex、Hermes 的 ACP `mcpServers` 注入。
- Hermes 主机 MCP 和 Skills 不被继承。
- 同一 Agent 的两个 Session 使用不同 MCP 参数并发投影时互不覆盖。
- 配置更新在下一次 Run 生效，ACP Session 仍然续接。
- Agent 和 Session 删除后的数据、密文和文件清理。

前端：

- Agent MCP 独立 Tab 和路由。
- HTTP/stdio 表单切换。
- Header、Argument、Environment 动态行。
- 固定值、Session 参数、Runtime 参数选择。
- 敏感值遮罩、保留、替换和清除。
- MCP 连接检查及脱敏错误。
- Session 创建动态参数表单。
- Session 空闲时修改参数、运行中禁用修改。
- 已有 Session 缺少新增必填参数时的提示和 Run 禁用。

## 16. 验收标准

1. 可以为 Claude Code、Codex、Hermes Agent 分别创建 HTTP 和 stdio MCP。
2. HTTP Header、stdio Argument 和 Environment 可以使用固定值、Session 参数或 Runtime 参数。
3. 管理 API 和页面从不返回敏感明文。
4. 同一个 Agent 的两个 Session 可以使用不同认证或租户参数并发执行，互不串值。
5. 修改 Agent MCP 或空闲 Session 参数后，下一次 Run 使用新值并续接原 ACP Session。
6. 任一启用 MCP 预检失败时，Run 明确失败且模型 Turn 不启动。
7. MCP 配置通过 ACP 注入，不修改或继承主机用户的 MCP 和 Skills。
8. 全量自动化测试、类型检查和生产构建通过。
