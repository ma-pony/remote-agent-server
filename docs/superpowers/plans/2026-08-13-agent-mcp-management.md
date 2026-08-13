# Agent MCP 管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每个 Agent 增加安全、可管理的 HTTP/stdio MCP，并允许不同 Session 提供不同参数，在每次 Run 前完成真实预检后通过 ACP 注入 Claude Code、Codex 或 Hermes。

**Architecture:** 新增一个 MCP 领域模块管理明确字段、Session 参数和 AES-256-GCM 密文。RunExecutor 通过 `RunMcpPreparer` 解析并预检所有启用 MCP，然后把不含持久化密文的 `RuntimeMcpServer[]` 交给 `AcpxAgentRuntime`；Runtime 为每个 Session 建立独立的 acpx Runtime，并利用 ACP `mcpServers` 统一传给 Provider。管理界面保持 Agent MCP、MCP 编辑和 Session 参数设置为独立页面。

**Tech Stack:** Node.js 22、TypeScript 6、Fastify 5、SQLite/better-sqlite3、Zod 4、React 19、React Router 8、Vitest 4、acpx 0.12.1、ACP SDK 1.3.0、`@modelcontextprotocol/client` 2.0.0、`yaml` 2.9.0。

## Global Constraints

- MCP 属于 Agent；Session 只保存 Agent 已声明的参数值。
- 第一版只支持 Streamable HTTP 与 stdio，不支持旧 SSE Transport、OAuth、全局 Catalog、Gateway、Tool allow/deny 和外部 Task 动态注入。
- 不新增 `config_json`；服务端保存明确字段及有序子记录。
- 值来源只允许 `fixed`、`session_parameter`、`runtime`；Runtime 白名单固定为 `agent_id`、`session_id`、`run_id`、`workspace_path`、`browser_profile_path`。
- 敏感固定值和敏感 Session 参数使用 AES-256-GCM 加密；API、日志、Event、Run error 不得返回明文。
- 敏感值不能进入 stdio Argument；只能进入 HTTP Header 或 stdio Environment。解密值可存在于当前 Session 的服务进程与 Provider 进程内存，但不得写入 acpx Session Store、Provider MCP 配置、Event、Run error 或日志。
- 所有 enabled MCP 都是必需能力；每次 Run 都执行 `initialize + tools/list`，任一失败时不启动模型 Turn。
- ACP 通用 `McpServer` 没有跨 Provider 工具超时字段；第一版只暴露 `checkTimeoutSeconds`，模型运行中的工具超时沿用 Provider 默认值。
- 同一 Agent 的并发 Session 必须使用独立 Provider Home、acpx Runtime、MCP 值和 Handle。
- Session 参数只允许在 Session `idle` 且没有 queued/running Run 时修改。
- 现有 Fastify Bearer Token 继续保护全部管理 API，不增加新的鉴权体系。
- 保持单机模块化服务，不增加 Redis、Sidekiq、独立 Worker 或工作流引擎。

## 文件结构

新增文件：

- `src/mcp/mcp-types.ts`：MCP API、持久化解析结果和错误类型。
- `src/mcp/secret-store.ts`：主密钥生命周期及 AES-256-GCM 加解密。
- `src/mcp/mcp-manager.ts`：MCP Server、Session 参数定义/值、解析和最近检查结果。
- `src/mcp/mcp-checker.ts`：官方 MCP Client 的 HTTP/stdio 预检及有界关闭。
- `src/mcp/mcp-routes.ts`：Agent MCP、参数定义和检查 API。
- `src/mcp/run-mcp-preparer.ts`：Run 前解析所有 enabled MCP 并并行预检。
- `src/runtime/provider-home.ts`：Session 级 Provider Home、登录复用及 Hermes 基础配置净化。
- `src/web/pages/agent-mcp-pages.tsx`：Agent MCP 列表、参数定义、创建和编辑页面。
- `src/web/pages/mcp-server-form.tsx`：HTTP/stdio MCP 动态表单。
- `src/web/pages/session-settings-page.tsx`：空闲 Session 的 MCP 参数设置页面。
- `test/mcp-secret.test.ts`：密钥和密文测试。
- `test/mcp-manager.test.ts`：领域校验、事务和解析测试。
- `test/mcp-api.test.ts`：鉴权管理 API 测试。
- `test/mcp-checker.test.ts`：HTTP/stdio 预检、超时、关闭和脱敏测试。
- `test/mcp-runtime.test.ts`：ACP 注入、Session Runtime 隔离和 Run 失败边界测试。
- `test/web-mcp.test.tsx`：Agent MCP 页面测试。
- `test/web-session-settings.test.tsx`：Session 参数页面测试。

修改文件：

- `package.json`、`pnpm-lock.yaml`：增加 MCP Client 与 YAML 依赖。
- `src/db.ts`、`src/domain.ts`：新增五张 MCP 表及公共领域类型。
- `src/app.ts`、`src/main.ts`：组装 SecretStore、McpManager、McpChecker 和 RunMcpPreparer。
- `src/agents/agent-manager.ts`、`src/agents/agent-routes.ts`：Doctor 汇总 MCP 状态，停止创建 Agent 共享 Provider Home。
- `src/sessions/session-manager.ts`、`src/sessions/session-routes.ts`：Session 创建/更新参数及详情状态。
- `src/runtime/agent-runtime.ts`、`src/runtime/acpx-runtime.ts`、`src/runtime/skill-projector.ts`：ACP MCP 契约和 Session 级 Provider Home。
- `src/runs/run-executor.ts`：模型启动前完成 MCP 预检。
- `src/web/api.ts`、`src/web/app.tsx`、`src/web/pages/agent-pages.tsx`、`src/web/pages/session-pages.tsx`、`src/web/pages/session-page.tsx`：前端类型、路由和入口。
- `test/db.test.ts`、`test/helpers.ts`、`test/agents.test.ts`、`test/sessions.test.ts`、`test/run-executor.test.ts`、`test/runtime.test.ts`：适配新依赖和回归契约。
- `docs/deployment.md`：增加 `secret.key` 权限、备份和恢复要求。

---

### Task 1: 数据表、领域类型与 SecretStore

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/db.ts`
- Modify: `src/domain.ts`
- Create: `src/mcp/mcp-types.ts`
- Create: `src/mcp/secret-store.ts`
- Modify: `test/db.test.ts`
- Create: `test/mcp-secret.test.ts`

**Interfaces:**
- Produces: `SecretStore.open({ dataDir, db }): SecretStore`
- Produces: `SecretStore.encrypt(value: string): string`
- Produces: `SecretStore.decrypt(payload: string): string`
- Produces: `McpTransport`、`McpSourceType`、`RuntimeMcpServer`、`McpManagerError`
- Consumes later: Task 2 的 `McpManager` 使用 `SecretStore`，Task 6 的 Runtime 使用 `RuntimeMcpServer[]`。

- [ ] **Step 1: 安装生产依赖并锁定官方 MCP Client 版本**

```bash
pnpm add -E @modelcontextprotocol/client@2.0.0 yaml@2.9.0
```

Expected: `package.json` 增加两个直接依赖，`pnpm-lock.yaml` 更新；不引入 MCP Server 运行时、HTTP 中间件或 OAuth 包。

- [ ] **Step 2: 先写数据库和主密钥失败测试**

```ts
it("创建五张 MCP 表并保持外键约束", () => {
  const { db } = createTestDatabase();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all().map((row) => (row as { name: string }).name);
  expect(tables).toEqual(expect.arrayContaining([
    "agent_mcp_servers",
    "agent_session_parameters",
    "agent_mcp_arguments",
    "agent_mcp_bindings",
    "session_mcp_parameter_values"
  ]));
});

it("首次启动生成 0600 主密钥且密文可往返", () => {
  const { db } = createTestDatabase();
  const dataDir = makeTempDir();
  const secrets = SecretStore.open({ dataDir, db });
  const encrypted = secrets.encrypt("token-123");
  expect(encrypted).not.toContain("token-123");
  expect(secrets.decrypt(encrypted)).toBe("token-123");
  expect(statSync(join(dataDir, "secret.key")).mode & 0o077).toBe(0);
});

it("已有密文但密钥缺失时拒绝启动", () => {
  seedEncryptedBinding(db, "v1.invalid");
  expect(() => SecretStore.open({ dataDir, db })).toThrowError(
    expect.objectContaining({ code: "secret_key_unavailable" })
  );
});
```

- [ ] **Step 3: 运行 RED 测试并保存失败证据**

Run:

```bash
pnpm test -- test/db.test.ts test/mcp-secret.test.ts
```

Expected: FAIL，原因是 MCP 表、`mcp-types.ts` 和 `SecretStore` 尚不存在。

- [ ] **Step 4: 创建明确领域类型和五张表**

在 `src/mcp/mcp-types.ts` 定义后续任务共同使用的稳定契约：

```ts
export type McpTransport = "http" | "stdio";
export type McpSourceType = "fixed" | "session_parameter" | "runtime";
export type RuntimeMcpKey =
  | "agent_id" | "session_id" | "run_id"
  | "workspace_path" | "browser_profile_path";

export type RuntimeMcpServer =
  | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { type: "stdio"; name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

export class McpManagerError extends Error {
  constructor(readonly code:
    | "agent_not_found" | "mcp_server_not_found" | "mcp_parameter_not_found"
    | "invalid_mcp_server" | "invalid_mcp_value" | "duplicate_mcp_name"
    | "mcp_parameter_in_use" | "missing_session_mcp_parameters"
    | "unknown_session_mcp_parameter" | "secret_decryption_failed"
  ) { super(code); }
}
```

在 `src/db.ts` 一次创建设计文档中的五张表。`agent_mcp_servers` 使用 `check_timeout_seconds`，不创建 `tool_timeout_seconds`；Arguments 不含密文列；Session 参数值对参数定义使用 `ON DELETE RESTRICT`。

- [ ] **Step 5: 实现 AES-256-GCM SecretStore**

```ts
export class SecretStore {
  static open({ dataDir, db }: { dataDir: string; db: Database.Database }): SecretStore;
  encrypt(value: string): string;
  decrypt(payload: string): string;
}
```

实现规则：

```text
密文格式: v1.<base64url nonce>.<base64url authTag>.<base64url ciphertext>
算法: aes-256-gcm
nonce: randomBytes(12)
key: randomBytes(32)，文件内容就是原始 32 字节，不做文本或 base64 编码
key path: DATA_DIR/secret.key
key mode: 0600
```

`open` 必须先统计 `agent_mcp_bindings.encrypted_value` 和 `session_mcp_parameter_values.encrypted_value`。只有“密钥不存在且密文数量为 0”时才生成；密钥长度错误、权限包含 group/other 位、已有密文却缺密钥时抛出明确启动错误。解密失败统一抛 `secret_decryption_failed`，不得把 payload 或原始 crypto message 放进公开错误。

- [ ] **Step 6: 运行 GREEN 测试与类型检查**

Run:

```bash
pnpm test -- test/db.test.ts test/mcp-secret.test.ts
pnpm typecheck
```

Expected: PASS；密钥缺失、错误权限、损坏密文和正常往返均有测试。

- [ ] **Step 7: 提交 Task 1**

```bash
git add package.json pnpm-lock.yaml src/db.ts src/domain.ts src/mcp/mcp-types.ts src/mcp/secret-store.ts test/db.test.ts test/mcp-secret.test.ts
git commit -m "feat: add MCP storage and secret encryption"
```

---

### Task 2: MCP Manager、参数定义与值解析

**Files:**
- Create: `src/mcp/mcp-manager.ts`
- Create: `test/mcp-manager.test.ts`
- Modify: `test/helpers.ts`

**Interfaces:**
- Consumes: `SecretStore`、Task 1 的 MCP 类型和五张表。
- Produces: `McpManager.listServers(agentId)`、`getServer(agentId, id)`、`createServer`、`updateServer`、`deleteServer`。
- Produces: `listParameterDefinitions`、`createParameterDefinition`、`updateParameterDefinition`、`deleteParameterDefinition`。
- Produces: `normalizeSessionValues(agentId, values, options)`、`insertSessionValuesInTransaction(sessionId, normalized)` 和 `applySessionValuePatchInTransaction(sessionId, normalized)`。
- Produces: `resolveEnabledForRun(context): ResolvedMcpServer[]`、`resolveOneForCheck(input)`、`recordCheckResult`、`summarizeAgentMcp`。

- [ ] **Step 1: 写 MCP CRUD、约束和解析的失败测试**

```ts
it("原子保存 HTTP MCP 及三种 Header 来源并从不返回敏感值", () => {
  const created = manager.createServer(agentId, {
    name: "grab-manager",
    transport: "http",
    enabled: true,
    url: "https://example.test/mcp",
    checkTimeoutSeconds: 30,
    headers: [
      { name: "Authorization", source: "fixed", value: "Bearer secret", secret: true },
      { name: "X-Tenant", source: "session_parameter", parameterKey: "tenant_id" },
      { name: "X-Run", source: "runtime", runtimeKey: "run_id" }
    ]
  });
  expect(JSON.stringify(created)).not.toContain("Bearer secret");
  expect(created.bindings[0]).toMatchObject({ secret: true, configured: true });
});

it("拒绝 shell command、敏感 Argument、受管 Header 和跨 Agent 参数引用", () => {
  expect(() => manager.createServer(agentId, stdioInput({ command: "npx && touch /tmp/x" })))
    .toThrowError(expect.objectContaining({ code: "invalid_mcp_server" }));
  expect(() => manager.createServer(agentId, stdioInput({
    arguments: [{ source: "session_parameter", parameterKey: "secret_token" }]
  }))).toThrowError(expect.objectContaining({ code: "invalid_mcp_value" }));
});

it("按 Session 和 Runtime 上下文解析两个并发 Session 的不同值", () => {
  const a = manager.resolveEnabledForRun(context({ sessionId: sessionA, runId: runA }));
  const b = manager.resolveEnabledForRun(context({ sessionId: sessionB, runId: runB }));
  expect(a).not.toEqual(b);
  expect(a[0]?.server).toMatchObject({
    headers: expect.arrayContaining([{ name: "X-Run", value: runA }])
  });
});
```

在 `test/helpers.ts` 同步增加本测试直接使用的 `stdioInput` 和 `context` 工厂；工厂只填合法默认值，覆盖值由调用方显式传入。

- [ ] **Step 2: 运行 RED 测试**

Run:

```bash
pnpm test -- test/mcp-manager.test.ts
```

Expected: FAIL，原因是 `McpManager` 尚不存在。

- [ ] **Step 3: 实现写入输入和返回类型**

在 `mcp-types.ts` 增加明确联合类型：

```ts
export type McpValueInput =
  | { source: "fixed"; value?: string; secret?: boolean; clear?: boolean; id?: string }
  | { source: "session_parameter"; parameterKey: string; id?: string }
  | { source: "runtime"; runtimeKey: RuntimeMcpKey; id?: string };

export type McpServerWriteInput = {
  name: string;
  transport: McpTransport;
  enabled: boolean;
  url?: string;
  command?: string;
  checkTimeoutSeconds: number;
  arguments?: McpValueInput[];
  headers?: Array<McpValueInput & { name: string }>;
  environment?: Array<McpValueInput & { name: string }>;
};

export type ResolveMcpContext = {
  agentId: string;
  sessionId: string;
  runId: string;
  workspacePath: string;
  browserProfilePath: string;
};

export type ResolvedMcpServer = {
  id: string;
  checkTimeoutMs: number;
  server: RuntimeMcpServer;
};
```

返回对象中普通 fixed 值可以返回，敏感 fixed 只返回 `secret: true`、`configured`。Session 参数值永不随 MCP Server 详情返回。

- [ ] **Step 4: 实现同步事务内的 CRUD 和引用约束**

```ts
export class McpManager {
  constructor({ db, secrets }: { db: Database.Database; secrets: SecretStore });
  listServers(agentId: string): AgentMcpServerSummary[];
  getServer(agentId: string, id: string): AgentMcpServerDetail | undefined;
  createServer(agentId: string, input: McpServerWriteInput): AgentMcpServerDetail;
  updateServer(agentId: string, id: string, input: McpServerWriteInput): AgentMcpServerDetail | undefined;
  deleteServer(agentId: string, id: string): "deleted" | "not_found";
}
```

创建和更新规则：

- `name` 匹配 `[A-Za-z0-9_-]{1,64}`，并拒绝 Claude 内置保留名 `workspace`、`claude-in-chrome`、`computer-use`。
- HTTP 只接受 `url + headers`；stdio 只接受 `command + arguments + environment`。
- URL 只允许 `http:`、`https:`。
- command 只能是 basename 或绝对路径，拒绝相对路径和 shell 元字符；最终解析绝对可执行文件放在 Task 4/6 的运行边界完成。
- Header 名称按小写比较，拒绝 `host`、`content-length`、`connection`、`transfer-encoding`、`mcp-session-id`、`mcp-protocol-version`。
- Argument 的 `fixed` 不允许 `secret`，也不允许引用 `secret=true` 的 Session 参数。
- Header 只属于 HTTP；Environment 只属于 stdio。
- 更新采用一次 `BEGIN IMMEDIATE` 全量替换子记录；传入已有敏感 binding `id` 且省略 value 时保留旧密文，`clear:true` 清空密文并令配置处于未完成状态。
- 修改任何连接字段后清空 `last_checked_*`。

- [ ] **Step 5: 实现参数定义、Session 值规范化和删除保护**

```ts
listParameterDefinitions(agentId: string): AgentSessionParameter[];
createParameterDefinition(agentId: string, input: CreateSessionParameterInput): AgentSessionParameter;
updateParameterDefinition(agentId: string, id: string, input: UpdateSessionParameterInput): AgentSessionParameter | undefined;
deleteParameterDefinition(agentId: string, id: string): "deleted" | "not_found";
normalizeSessionValues(
  agentId: string,
  values: Record<string, string | null>,
  options: { requireAll: boolean; currentSessionId?: string }
): NormalizedSessionMcpValue[];
insertSessionValuesInTransaction(sessionId: string, values: NormalizedSessionMcpValue[]): void;
applySessionValuePatchInTransaction(sessionId: string, values: NormalizedSessionMcpValue[]): void;
```

`key` 与 `secret` 创建后不可修改。删除参数前同时检查三类 MCP 引用和 `session_mcp_parameter_values`；任一存在时抛 `mcp_parameter_in_use`。普通和敏感值只允许非空字符串；`null` 只能清除非 required 参数。创建 Session 时插入完整集合；PATCH 只 upsert 请求中出现的 key，`null` 删除对应可选值，未出现的 key 保持不变。

- [ ] **Step 6: 实现 Run/检查解析和可执行文件解析**

```ts
resolveEnabledForRun(context: ResolveMcpContext): ResolvedMcpServer[];
resolveOneForCheck(input: {
  agentId: string;
  serverId: string;
  sessionId?: string;
  parameters?: Record<string, string>;
}): ResolvedMcpServer | undefined;
```

stdio command 若为 basename，使用 `PATH.split(path.delimiter)` 和 `accessSync(candidate, X_OK)` 解析为绝对路径；输入为绝对路径时也必须用 `accessSync(command, X_OK)` 验证。找不到或不可执行时抛脱敏的 `mcp_process_failed`。ACP 接收到的 command 必须为绝对路径。解析结果只存在内存，不写数据库和 Event。

- [ ] **Step 7: 运行聚焦回归并提交**

Run:

```bash
pnpm test -- test/mcp-secret.test.ts test/mcp-manager.test.ts test/db.test.ts
pnpm typecheck
```

Expected: PASS。

```bash
git add src/mcp/mcp-types.ts src/mcp/mcp-manager.ts test/mcp-manager.test.ts test/helpers.ts
git commit -m "feat: manage Agent MCP definitions"
```

---

### Task 3: MCP 管理 API

**Files:**
- Create: `src/mcp/mcp-routes.ts`
- Modify: `src/app.ts`
- Modify: `src/main.ts`
- Create: `test/mcp-api.test.ts`

**Interfaces:**
- Consumes: Task 2 `McpManager`。
- Produces: 设计文档第 9、10 节的 MCP Server 和 Agent Session Parameter REST API；连接检查路由在 Task 4 接入。

- [ ] **Step 1: 先写鉴权和业务错误的 API RED 测试**

```ts
it("鉴权后完成 MCP 与参数定义 CRUD", async () => {
  const parameter = await app.inject({
    method: "POST", url: `/api/agents/${agentId}/session-parameters`,
    headers: authHeaders(),
    payload: { key: "tenant_id", label: "租户", required: true, secret: false }
  });
  expect(parameter.statusCode).toBe(201);

  const server = await app.inject({
    method: "POST", url: `/api/agents/${agentId}/mcp-servers`,
    headers: authHeaders(), payload: validHttpServer("tenant_id")
  });
  expect(server.statusCode).toBe(201);
  expect(JSON.stringify(server.json())).not.toContain("secret-token");
});

it("未知 Agent、重复名称、在用参数和非法传输字段返回稳定错误", async () => {
  expect(missingAgent.statusCode).toBe(404);
  expect(duplicate.json()).toMatchObject({ error: { code: "duplicate_mcp_name" } });
  expect(inUse.statusCode).toBe(409);
  expect(invalidTransport.statusCode).toBe(400);
});
```

- [ ] **Step 2: 运行 RED 测试**

Run:

```bash
pnpm test -- test/mcp-api.test.ts
```

Expected: FAIL，路由不存在。

- [ ] **Step 3: 用 Zod discriminated union 实现请求校验**

```ts
const httpMcpSchema = baseMcpSchema.extend({
  transport: z.literal("http"),
  url: z.url(),
  headers: z.array(bindingSchema),
  arguments: z.never().optional(),
  environment: z.never().optional()
}).strict();

const stdioMcpSchema = baseMcpSchema.extend({
  transport: z.literal("stdio"),
  command: z.string().trim().min(1),
  arguments: z.array(valueSchema),
  environment: z.array(bindingSchema),
  url: z.never().optional(),
  headers: z.never().optional()
}).strict();
```

PATCH 使用完整编辑器 payload，`transport` 必须与已有记录一致；数组存在时替换全部子记录。所有错误统一为 `{ error: { code, message } }`。

- [ ] **Step 4: 注册 MCP 和参数定义路由**

```ts
export const registerMcpRoutes = (
  app: FastifyInstance,
  dependencies: { mcpManager: McpManager; mcpChecker?: McpChecker }
): void;
```

Task 3 先实现：

```text
GET/POST   /agents/:agentId/mcp-servers
GET/PATCH/DELETE /agents/:agentId/mcp-servers/:id
GET/POST   /agents/:agentId/session-parameters
PATCH/DELETE /agents/:agentId/session-parameters/:id
```

`DELETE` 成功返回 204，不能附 JSON Content-Type。尚未接入的 `/check` 不创建占位接口。

组装顺序固定为：`migrate(db)` 后立即 `SecretStore.open({ dataDir, db })`，再创建 `McpManager`。`startServer` 将已打开的 SecretStore 传给 `buildApp`，保证密钥异常发生在 Workspace 检查、后台调度和监听端口之前；测试直接调用 `buildApp` 时允许由它创建默认 SecretStore。`AppDependencies` 增加可注入的 `secretStore` 和 `mcpManager`，避免测试触碰真实 DATA_DIR。

- [ ] **Step 5: 运行 API、鉴权和 Agent 回归**

Run:

```bash
pnpm test -- test/mcp-api.test.ts test/agents.test.ts test/db.test.ts
pnpm typecheck
```

Expected: PASS。

- [ ] **Step 6: 提交 Task 3**

```bash
git add src/mcp/mcp-routes.ts src/app.ts src/main.ts test/mcp-api.test.ts
git commit -m "feat: expose Agent MCP management API"
```

---

### Task 4: HTTP/stdio 连接检查与 Agent Doctor 汇总

**Files:**
- Create: `src/mcp/mcp-checker.ts`
- Modify: `src/mcp/mcp-routes.ts`
- Modify: `src/mcp/mcp-manager.ts`
- Modify: `src/app.ts`
- Modify: `src/agents/agent-manager.ts`
- Modify: `src/web/api.ts`
- Modify: `src/web/pages/agent-pages.tsx`
- Create: `test/mcp-checker.test.ts`
- Modify: `test/mcp-api.test.ts`
- Modify: `test/agents.test.ts`
- Modify: `test/web-agents.test.tsx`

**Interfaces:**
- Consumes: `RuntimeMcpServer` 和 `checkTimeoutSeconds`。
- Produces: `McpChecker.check(server, timeoutMs): Promise<McpCheckResult>`。
- Produces: `POST /api/agents/:agentId/mcp-servers/:id/check`。
- Extends: Agent Doctor 增加 `mcp` 汇总，不自动连接全部 MCP。

- [ ] **Step 1: 写预检生命周期和脱敏 RED 测试**

```ts
it.each(["http", "stdio"] as const)("%s 检查执行 initialize、tools/list 和关闭", async (transport) => {
  const probe = createProbeHarness(transport);
  const result = await checker.check(probe.server, 3000);
  expect(probe.connect).toHaveBeenCalledOnce();
  expect(probe.listTools).toHaveBeenCalledOnce();
  expect(probe.close).toHaveBeenCalledOnce();
  expect(result).toEqual({ status: "passed", toolCount: 2, message: "2 tools available" });
});

it("超时和 401 错误有界关闭且不泄漏 Header、Environment 或 URL query", async () => {
  const result = await checker.check(secretServer, 10);
  expect(result).toMatchObject({ status: "failed", code: "mcp_authentication_failed" });
  expect(JSON.stringify(result)).not.toMatch(/secret|token=|Authorization/i);
  expect(close).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: 运行 RED 测试**

Run:

```bash
pnpm test -- test/mcp-checker.test.ts test/mcp-api.test.ts test/agents.test.ts
```

Expected: FAIL，Checker 和 `/check` 尚不存在。

- [ ] **Step 3: 实现官方 MCP Client 预检**

```ts
export type McpCheckResult =
  | { status: "passed"; toolCount: number; message: string }
  | { status: "failed"; code: McpCheckFailureCode; message: string };

export interface McpChecker {
  check(server: RuntimeMcpServer, timeoutMs: number): Promise<McpCheckResult>;
}

export class SdkMcpChecker implements McpChecker {
  async check(server: RuntimeMcpServer, timeoutMs: number): Promise<McpCheckResult>;
}
```

生产实现使用：

```ts
const client = new Client({ name: "remote-agent-server", version: "1.0.0" });
const transport = server.type === "http"
  ? new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) }
    })
  : new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
      stderr: "pipe"
    });
await client.connect(transport, { timeout: timeoutMs });
const { tools } = await client.listTools(undefined, { timeout: timeoutMs, cacheMode: "bypass" });
```

`finally` 中对 HTTP 先 best-effort `terminateSession()`，再对 `client.close()` 使用现有 `settleBestEffort`。对外只返回稳定分类：401/403 为 `mcp_authentication_failed`，stdio spawn/exit 为 `mcp_process_failed`，握手/Schema 为 `mcp_protocol_failed`，其他为 `mcp_connection_failed`。不回传原始异常字符串。

- [ ] **Step 4: 接入检查 API 并保存最近结果**

```ts
const checkBodySchema = z.object({
  sessionId: z.string().uuid().optional(),
  parameters: z.record(z.string(), z.string().min(1)).optional()
}).strict().refine((value) => !(value.sessionId && value.parameters));
```

路由通过 `McpManager.resolveOneForCheck` 解析。若引用 `session_id`、`workspace_path` 或 `browser_profile_path`，必须给属于该 Agent 的 `sessionId`；一次性 `parameters` 不保存。检查完成后写 `last_checked_at/status/message/tool_count`，返回脱敏结果。

- [ ] **Step 5: 扩展 Doctor 为廉价汇总**

```ts
type AgentDoctorResult = {
  provider: RuntimeDoctor;
  projectEnvironment: { ok: boolean; message: string; revisionId: string | null };
  mcp: {
    ok: boolean;
    enabledCount: number;
    passedCount: number;
    failedCount: number;
    uncheckedCount: number;
    message: string;
  };
};
```

Doctor 只读数据库中的完整性和最近检查结果，不重新启动 MCP。没有 enabled MCP 时 `ok=true`，message 为 `No enabled MCP servers`。

Agent 概览页在现有 Doctor 结果中增加一个 MCP 摘要块，显示 enabled/passed/failed/unchecked 数量和 message；这里只显示汇总，编辑与逐项检查仍留在 MCP 独立页面。

- [ ] **Step 6: 运行聚焦回归并提交**

Run:

```bash
pnpm test -- test/mcp-checker.test.ts test/mcp-api.test.ts test/agents.test.ts test/web-agents.test.tsx
pnpm typecheck
```

Expected: PASS；错误消息中不存在测试密钥、Header 值、Environment 值和带 query 的 URL。

```bash
git add src/mcp/mcp-checker.ts src/mcp/mcp-routes.ts src/mcp/mcp-manager.ts src/app.ts src/agents/agent-manager.ts src/web/api.ts src/web/pages/agent-pages.tsx test/mcp-checker.test.ts test/mcp-api.test.ts test/agents.test.ts test/web-agents.test.tsx
git commit -m "feat: check MCP connections safely"
```

---

### Task 5: Session 参数创建、修改与详情状态

**Files:**
- Modify: `src/sessions/session-manager.ts`
- Modify: `src/sessions/session-routes.ts`
- Modify: `src/app.ts`
- Modify: `src/domain.ts`
- Modify: `test/sessions.test.ts`
- Modify: `test/helpers.ts`

**Interfaces:**
- Consumes: `McpManager.normalizeSessionValues`、`insertSessionValuesInTransaction` 和 `applySessionValuePatchInTransaction`。
- Changes: `CreateSessionInput` 增加 `mcpParameters: Record<string, string>`。
- Produces: `SessionManager.updateMcpParameters(id, values)`。
- Produces: Session detail 的 `mcpParametersValid`、`missingMcpParameters`、`mcpParameters`。

- [ ] **Step 1: 写 Session 参数原子性 RED 测试**

```ts
it("创建 Session 前校验必填参数并与 Session 原子保存", async () => {
  await createRequiredParameter(app, agentId, { key: "tenant", secret: false });
  const missing = await postSession(app, { agentId, title: "A", mcpParameters: {} });
  expect(missing.statusCode).toBe(400);
  expect(missing.json()).toMatchObject({ error: { code: "missing_session_mcp_parameters" } });
  expect(workspaceCreate).not.toHaveBeenCalled();

  const created = await postSession(app, {
    agentId, title: "A", mcpParameters: { tenant: "team-a" }
  });
  expect(created.statusCode).toBe(201);
  expect(db.prepare("SELECT count(*) AS count FROM session_mcp_parameter_values").get())
    .toEqual({ count: 1 });
});

it("运行中 Session 拒绝修改，空闲时可替换和清除可选值", async () => {
  const busy = await patchParameters(runningSessionId, { tenant: "team-b" });
  expect(busy.statusCode).toBe(409);
  const updated = await patchParameters(idleSessionId, { tenant: "team-b", optional: null });
  expect(updated.statusCode).toBe(200);
});
```

- [ ] **Step 2: 运行 RED 测试**

Run:

```bash
pnpm test -- test/sessions.test.ts
```

Expected: 新增测试 FAIL，现有 Session 创建/reset/delete 测试保持原有失败边界。

- [ ] **Step 3: 扩展 Session 创建并保持 Workspace 补偿顺序**

```ts
export type CreateSessionInput = {
  agentId: string;
  title: string;
  mcpParameters: Record<string, string>;
};
```

Session POST 的 Zod schema 将 `mcpParameters` 设为 `z.record(z.string(), z.string()).default({})`；没有参数定义的 Agent 仍可直接创建，有 required 定义时由 Manager 拒绝缺失值。顺序必须为：Agent/环境检查 → 参数规范化及加密 → 创建 Workspace → 单个 `BEGIN IMMEDIATE` 插入 Session 和参数值。数据库失败时仍调用 `workspaceManager.deleteSession`，并保持 `session_create_failed` 为主错误。

- [ ] **Step 4: 实现空闲更新和详情脱敏**

```ts
async updateMcpParameters(id: string, values: Record<string, string | null>): Promise<SessionMcpStatus> {
  return this.inImmediateTransaction(() => {
    const session = this.get(id);
    if (session === undefined) throw new SessionManagerError("session_not_found");
    const active = this.db.prepare(
      "SELECT 1 FROM runs WHERE session_id = ? AND status IN ('queued', 'running') LIMIT 1"
    ).get(id);
    if (session.status !== "idle" || active !== undefined) throw new SessionManagerError("session_busy");
    const normalized = this.mcpManager.normalizeSessionValues(session.agentId, values, {
      requireAll: false,
      currentSessionId: id
    });
    this.mcpManager.applySessionValuePatchInTransaction(id, normalized);
    return this.mcpManager.getSessionStatus(id);
  });
}
```

详情返回示例：

```json
{
  "mcpParametersValid": false,
  "missingMcpParameters": ["access_token"],
  "mcpParameters": [
    { "key": "tenant", "label": "租户", "secret": false, "configured": true, "value": "team-a" },
    { "key": "access_token", "label": "Token", "secret": true, "configured": false }
  ]
}
```

- [ ] **Step 5: 注册 Session 参数 PATCH 路由**

```text
PATCH /api/sessions/:id/mcp-parameters
body: { "values": { "tenant": "team-b", "optional": null } }
```

空对象、未知 key、清除 required、错误类型返回 400；Session 不存在返回 404；busy 返回 409。

- [ ] **Step 6: 运行 Session 全回归并提交**

Run:

```bash
pnpm test -- test/sessions.test.ts test/runs.test.ts test/db.test.ts
pnpm typecheck
```

Expected: PASS，reset/delete claim 与 MCP 参数事务互斥测试全部通过。

```bash
git add src/sessions/session-manager.ts src/sessions/session-routes.ts src/app.ts src/domain.ts test/sessions.test.ts test/helpers.ts
git commit -m "feat: bind MCP parameters to Sessions"
```

---

### Task 6: Run 预检、ACP 注入与 Session Provider Home

**Files:**
- Create: `src/mcp/run-mcp-preparer.ts`
- Create: `src/runtime/provider-home.ts`
- Modify: `src/runtime/agent-runtime.ts`
- Modify: `src/runtime/acpx-runtime.ts`
- Modify: `src/runtime/skill-projector.ts`
- Modify: `src/runs/run-executor.ts`
- Modify: `src/app.ts`
- Modify: `src/agents/agent-manager.ts`
- Create: `test/mcp-runtime.test.ts`
- Modify: `test/run-executor.test.ts`
- Modify: `test/runtime.test.ts`
- Modify: `test/agents.test.ts`
- Modify: `test/helpers.ts`

**Interfaces:**
- Produces: `RunMcpPreparer.prepare(context): Promise<RuntimeMcpServer[]>`。
- Changes: `RuntimeSessionInput` 增加 `mcpServers: RuntimeMcpServer[]`。
- Changes: 每个 `ManagedSession` 保存自己的 `runtime: AcpRuntime`、`registry: RemoteAgentRegistry` 和仅存在内存的 `mcpFingerprint`。
- Produces: `ProviderHomeManager.prepare(target): ProviderProcessEnvironment`。

- [ ] **Step 1: 写“预检失败绝不启动模型”的 RED 测试**

```ts
it("任一 enabled MCP 失败时 Run failed、Session idle 且不 ensure/startTurn", async () => {
  mcpChecker.check.mockResolvedValueOnce({
    status: "failed", code: "mcp_authentication_failed", message: "MCP authentication failed"
  });
  const run = await executor.execute(runId);
  expect(run).toMatchObject({ status: "failed", error: "MCP grab-manager authentication failed" });
  expect(runtime.ensureSession).not.toHaveBeenCalled();
  expect(runtime.startTurn).not.toHaveBeenCalled();
  expect(sessionStatus()).toBe("idle");
  expect(events()).toContainEqual(expect.objectContaining({ type: "error" }));
});

it("成功时把解析后的 MCP 传给 Runtime 且不持久化明文", async () => {
  await executor.execute(runId);
  expect(runtime.ensureSession).toHaveBeenCalledWith(expect.objectContaining({
    mcpServers: [{ type: "http", name: "grab-manager", url: expect.any(String), headers: expect.any(Array) }]
  }));
  expect(JSON.stringify(db.prepare("SELECT * FROM events").all())).not.toContain("secret-token");
  expect(readAllTextFiles(join(config.dataDir, "acpx"))).not.toContain("secret-token");
  expect(readAllTextFiles(dirname(session.workspacePath))).not.toContain("secret-token");
});
```

`readAllTextFiles` 是本测试文件内的递归只读 helper，只读取常规文本文件并跳过 symlink；它必须覆盖 acpx Session Store 与 Session runtime 配置，证明 ACP 注入没有落盘密文。

- [ ] **Step 2: 写 Session Runtime 隔离与 ACP 参数 RED 测试**

```ts
it("两个 Session 创建两个 acpx Runtime 并携带各自 mcpServers", async () => {
  await runtime.ensureSession(sessionInput(root, { sessionId: SESSION_A, mcpServers: serversA }));
  await runtime.ensureSession(sessionInput(root, { sessionId: SESSION_B, mcpServers: serversB }));
  expect(acpxMocks.createAcpRuntime).toHaveBeenNthCalledWith(1, expect.objectContaining({ mcpServers: serversA }));
  expect(acpxMocks.createAcpRuntime).toHaveBeenNthCalledWith(2, expect.objectContaining({ mcpServers: serversB }));
});

it("Hermes Home 位于 Session runtime 且主机 mcp_servers 和 Skills 不被继承", async () => {
  await runtime.ensureSession(sessionInput(root, { provider: "hermes" }));
  const home = join(dirname(input.workspacePath), "runtime", "hermes");
  expect(readFileSync(join(home, "config.yaml"), "utf8")).not.toContain("mcp_servers");
  expect(existsSync(join(home, "skills", "host-skill"))).toBe(false);
});
```

- [ ] **Step 3: 运行 RED 测试**

Run:

```bash
pnpm test -- test/mcp-runtime.test.ts test/run-executor.test.ts test/runtime.test.ts
```

Expected: FAIL，Runtime 尚未接受 MCP，Hermes Skill 仍写 Agent 共享 Home。

- [ ] **Step 4: 实现 RunMcpPreparer 和稳定错误**

```ts
export class RunMcpPreparer {
  constructor(private readonly manager: McpManager, private readonly checker: McpChecker) {}

  async prepare(context: ResolveMcpContext): Promise<RuntimeMcpServer[]> {
    let resolved: ResolvedMcpServer[];
    try {
      resolved = this.manager.resolveEnabledForRun(context);
    } catch {
      throw new McpPreparationError(
        "mcp_resolution_failed",
        null,
        "MCP configuration could not be resolved"
      );
    }
    const results = await Promise.all(resolved.map(async (item) => ({
      item,
      result: await this.checker.check(item.server, item.checkTimeoutMs)
    })));
    const failure = results.find(({ result }) => result.status === "failed");
    if (failure !== undefined) {
      throw McpPreparationError.from(failure.item.server.name, failure.result);
    }
    return resolved.map(({ server }) => server);
  }
}
```

`SdkMcpChecker.check` 必须把所有 transport/SDK 异常转换成 failed result，不能向这里抛原始异常。`McpPreparationError` 只含 MCP name（解析阶段允许为 `null`）、稳定 code 和固定 message。RunExecutor 捕获时在 error Event 写 `{ code, mcpServer, message }`，其他异常沿用原处理。

- [ ] **Step 5: 在 RunExecutor 中把预检放在模型边界之前**

```ts
const { agent, session } = this.sessionManager.getRuntimeContext(run.sessionId);
const browserProfilePath = join(dirname(session.workspacePath), "browser");
const mcpServers = await this.mcpPreparer.prepare({
  agentId: agent.id,
  sessionId: session.id,
  runId: run.id,
  workspacePath: session.workspacePath,
  browserProfilePath
});
const memory = this.skillProjector.prepare(agent, session);
const runtimeSession = await this.runtime.ensureSession({
  sessionId: session.id,
  agentId: agent.id,
  provider: agent.provider,
  workspacePath: session.workspacePath,
  browserProfilePath,
  providerSessionId: session.providerSessionId,
  memory,
  mcpServers
});
```

保留 cancellation intent 检查紧邻 `startTurn`；MCP 失败仍通过现有 `finishRun` 原子释放 Session。

- [ ] **Step 6: 拆出 Session 级 ProviderHomeManager**

```ts
export type ProviderHomeTarget = {
  provider: Provider;
  agentId: string;
  sessionId: string;
  workspacePath: string;
  browserProfilePath: string;
};

export class ProviderHomeManager {
  prepare(target: ProviderHomeTarget): Record<string, string>;
}
```

实现：

- Home 固定为 `dirname(workspacePath)/runtime/{claude|codex|hermes}`，目录强制 `0700`。
- Codex 只链接 host `auth.json`，原子写 `config.toml`，保留 host Skills disabled 规则，不继承 host MCP/plugins。
- Claude 不复制 host MCP/settings。在 Linux，若 host `~/.claude/.credentials.json` 存在则只读链接；在 macOS，用 `execFile("security", ["find-generic-password", "-w", "-s", "Claude Code-credentials"])` 读取系统 Keychain，并原子写入 Session Home 的 `.credentials.json`，权限 `0600`。命令不经过 shell，stderr 和凭证明文不得进入日志或公开错误；凭证不可用时由 Provider Doctor/启动明确失败。
- Hermes 链接 `auth.json`、`.env`；使用 `yaml.parseDocument` 读取 host `config.yaml`，删除顶层 `mcp_servers` 后原子写入 Session Home，权限 `0600`；不链接 host `skills/`。
- Agent 创建只保留 `skills/` 和 `MEMORY.md`，不再创建 `agents/<id>/provider-home/*`。
- SkillProjector 将 Hermes Skills 改到 `dirname(session.workspacePath)/runtime/hermes/skills`。

- [ ] **Step 7: 将 AcpxAgentRuntime 改为每 Session 一个 Runtime**

```ts
type ManagedSession = {
  runtime: AcpRuntime;
  registry: RemoteAgentRegistry;
  handle: AcpRuntimeHandle;
  providerSessionId: string | null;
  provider: Provider;
  agentId: string;
  workspacePath: string;
  browserProfilePath: string;
  mcpFingerprint: string;
  target: string;
};
```

`ensureSession` 第一次准备时创建该 Session 专属的 `RemoteAgentRegistry` 和 `AcpRuntime`，只注册当前 target。刷新或关闭时先关闭旧 Runtime Handle，再清理同一个 Session 的 Registry；不得调用或清理其他 Session 的 Registry。`mcpFingerprint` 只在进程内比较连接配置是否变化，不写数据库、Session Store、日志或 Event。

`createRuntime(registry, mcpServers, probeAgent?)` 在 `AcpRuntimeOptions` 传入 ACP 结构：

```ts
const options: AcpRuntimeOptions = {
  cwd: this.config.workspaceTemplate,
  sessionStore: createRuntimeStore({ stateDir: join(this.config.dataDir, "acpx") }),
  agentRegistry,
  mcpServers,
  permissionMode: "approve-all",
  nonInteractivePermissions: "fail",
  ...(probeAgent === undefined ? {} : { probeAgent })
};
```

刷新、cancel、reset、shutdown 全部调用 `ManagedSession.runtime`，不能再引用全局 Runtime。`canReuse` 加入 MCP fingerprint；配置变化先关闭旧 Handle，再用原 `providerSessionId` 和新 MCP 列表恢复。Doctor 创建无 MCP 的临时 Runtime。

- [ ] **Step 8: 运行 Runtime、Run 和关闭回归**

Run:

```bash
pnpm test -- test/mcp-runtime.test.ts test/run-executor.test.ts test/runtime.test.ts test/runs.test.ts test/sessions.test.ts test/skills.test.ts
pnpm typecheck
```

Expected: PASS；重点确认 shutdown timeout、late handle、双信号、Session reset/delete 既有测试未回归。

- [ ] **Step 9: 提交 Task 6**

```bash
git add src/mcp/run-mcp-preparer.ts src/runtime/provider-home.ts src/runtime/agent-runtime.ts src/runtime/acpx-runtime.ts src/runtime/skill-projector.ts src/runs/run-executor.ts src/app.ts src/agents/agent-manager.ts test/mcp-runtime.test.ts test/run-executor.test.ts test/runtime.test.ts test/agents.test.ts test/helpers.ts
git commit -m "feat: inject Session MCP through ACP"
```

---

### Task 7: Agent MCP 管理页面

**Files:**
- Create: `src/web/pages/agent-mcp-pages.tsx`
- Create: `src/web/pages/mcp-server-form.tsx`
- Modify: `src/web/app.tsx`
- Modify: `src/web/pages/agent-pages.tsx`
- Modify: `src/web/api.ts`
- Create: `test/web-mcp.test.tsx`
- Modify: `test/web-navigation.test.tsx`

**Interfaces:**
- Consumes: Task 3/4 MCP API。
- Produces routes: `/agents/:id/mcp`、`/agents/:id/mcp/new`、`/agents/:id/mcp/:mcpServerId`。
- Produces UI: MCP 列表、Session 参数定义、HTTP/stdio 独立编辑器、连接检查。

- [ ] **Step 1: 写路由和核心操作 RED 测试**

```tsx
it("Agent MCP Tab 只展示摘要并从独立页面创建 HTTP MCP", async () => {
  renderAppAt(`/agents/${agentId}/mcp`);
  expect(await screen.findByRole("heading", { name: "MCP" })).toBeVisible();
  expect(screen.getByText("grab-manager")).toBeVisible();
  expect(screen.queryByLabelText("Authorization 值")).not.toBeInTheDocument();

  await user.click(screen.getByRole("link", { name: "新建 MCP" }));
  expect(location.pathname).toBe(`/agents/${agentId}/mcp/new`);
});

it("连接检查只显示脱敏结果，删除使用无 body DELETE", async () => {
  await user.click(screen.getByRole("button", { name: "检查连接" }));
  expect(await screen.findByText("发现 3 个工具")).toBeVisible();
  await confirmDelete();
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("mcp-servers"),
    expect.objectContaining({ method: "DELETE" }));
});
```

- [ ] **Step 2: 运行 RED 测试**

Run:

```bash
pnpm test -- test/web-mcp.test.tsx test/web-navigation.test.tsx
```

Expected: FAIL，新页面和路由尚不存在。

- [ ] **Step 3: 增加前端 API 类型**

```ts
export type AgentMcpServerSummary = {
  id: string; name: string; transport: "http" | "stdio"; enabled: boolean;
  lastCheckedAt: string | null; lastCheckStatus: "passed" | "failed" | null;
  lastCheckMessage: string | null; lastToolCount: number | null;
};

export type AgentSessionParameter = {
  id: string; key: string; label: string; description: string | null;
  required: boolean; secret: boolean;
};
```

为 MCP Detail 定义 discriminated union，使 HTTP 表单在类型上没有 command/arguments，stdio 表单没有 url/headers。Detail 同时返回 `requiredParameterKeys: string[]` 和 `requiresSessionContext: boolean`，供连接检查界面决定是否需要 Session 或一次性参数；这两个字段只来自 binding/runtime 引用，不包含值。

- [ ] **Step 4: 实现 MCP 列表和参数定义区**

页面结构：

```text
PageHeader: MCP
  action: 新建 MCP
Card: MCP Server 列表
  名称 / HTTP或stdio / 已启用 / 最近检查 / 编辑 / 检查
Card: Session 参数
  key / label / 必填 / 敏感 / 编辑 / 删除
  action: 新建参数
```

参数新增/编辑使用 Dialog，`key`、`secret` 编辑时禁用。删除 409 时直接展示服务端明确提示。

“检查连接”采用一个小 Dialog：纯 fixed MCP 直接检查；引用 Session 参数时优先选择该 Agent 的已有 Session，也可填写一次性测试参数；引用 `session_id`、`workspace_path` 或 `browser_profile_path` 时必须选择已有 Session。一次性参数只进入本次 POST，不写入页面缓存或数据库。没有可用 Session 且必须依赖路径时提示先创建 Session。

- [ ] **Step 5: 实现独立 MCP 编辑器**

`McpServerForm` 接收：

```ts
type McpServerFormProps = {
  mode: "create" | "edit";
  initial?: AgentMcpServerDetail;
  parameters: AgentSessionParameter[];
  onSubmit(input: McpServerWriteInput): Promise<void>;
};
```

HTTP 只显示 URL 与 Header 行；stdio 只显示 command、Arguments 和 Environment。每行先选 source，再展示 fixed value、Session 参数或 Runtime key。敏感开关只在 Header/Environment 的 fixed 来源显示；Argument 不显示敏感开关，也不列出 secret Session 参数。已有敏感值显示“已配置”，空输入保持，显式“清除”发送 `clear:true`。

- [ ] **Step 6: 把 MCP 加入 Agent Tab 导航**

```tsx
<TabsTrigger value="overview">概览</TabsTrigger>
<TabsTrigger value="skills">Skills</TabsTrigger>
<TabsTrigger value="mcp">MCP</TabsTrigger>
<TabsTrigger value="settings">设置</TabsTrigger>
```

`AgentDetailLayout` 的 section 判断必须识别 `/mcp`、`/mcp/new` 和 `/mcp/:id`；编辑子页面可以在 Agent layout 内渲染，但不能把表单塞回概览页。

- [ ] **Step 7: 运行前端回归并提交**

Run:

```bash
pnpm test -- test/web-mcp.test.tsx test/web-agents.test.tsx test/web-navigation.test.tsx test/web-api.test.ts
pnpm typecheck
pnpm build
```

Expected: PASS，生产构建无浏览器 bundle 引入 Node MCP SDK。

```bash
git add src/web/pages/agent-mcp-pages.tsx src/web/pages/mcp-server-form.tsx src/web/app.tsx src/web/pages/agent-pages.tsx src/web/api.ts test/web-mcp.test.tsx test/web-navigation.test.tsx
git commit -m "feat: add Agent MCP management pages"
```

---

### Task 8: Session 创建参数和独立设置页面

**Files:**
- Create: `src/web/pages/session-settings-page.tsx`
- Modify: `src/web/pages/session-pages.tsx`
- Modify: `src/web/pages/session-page.tsx`
- Modify: `src/web/app.tsx`
- Modify: `src/web/api.ts`
- Create: `test/web-session-settings.test.tsx`
- Modify: `test/web-sessions-navigation.test.tsx`
- Modify: `test/web.test.tsx`

**Interfaces:**
- Consumes: Agent 参数定义 API、扩展后的 Session create/detail API 和 Session 参数 PATCH。
- Produces route: `/sessions/:id/settings`。

- [ ] **Step 1: 写动态 Session 表单和 busy 禁用 RED 测试**

```tsx
it("选择 Agent 后加载参数定义并随 Session 一次提交", async () => {
  renderAppAt("/sessions/new");
  await user.selectOptions(screen.getByLabelText("选择 Agent"), agentId);
  await user.type(await screen.findByLabelText("租户"), "team-a");
  await user.type(screen.getByLabelText("Access Token"), "secret-token");
  await user.click(screen.getByRole("button", { name: "创建 Session" }));
  expect(lastJsonBody()).toMatchObject({
    agentId,
    mcpParameters: { tenant_id: "team-a", access_token: "secret-token" }
  });
});

it("运行中 Session 设置只读，空闲 Session 可以保存且敏感值不回显", async () => {
  renderAppAt(`/sessions/${runningId}/settings`);
  expect(await screen.findByRole("button", { name: "保存参数" })).toBeDisabled();
  expect(screen.getByText(/结束或取消当前 Run/)).toBeVisible();
  expect(screen.queryByDisplayValue("secret-token")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 运行 RED 测试**

Run:

```bash
pnpm test -- test/web-session-settings.test.tsx test/web-sessions-navigation.test.tsx test/web.test.tsx
```

Expected: FAIL，页面和动态字段不存在。

- [ ] **Step 3: 扩展 Session 创建页**

Agent 变化时 abort 旧的参数定义请求，清空旧 Agent 值并加载新定义。required 参数缺失时在客户端阻止提交；服务端仍是最终校验。secret 字段使用 `type=password`、`autoComplete=off`。

```tsx
const payload = {
  title: title.trim(),
  agentId,
  mcpParameters: Object.fromEntries(parameterDefinitions.map(({ key }) => [key, values[key] ?? ""]))
};
```

- [ ] **Step 4: 实现 Session Settings 独立页面和入口**

页面通过 `GET /sessions/:id` 获取状态与脱敏参数。普通值可回显；敏感值只显示“已配置”，留空保持，输入新值替换，可选敏感参数提供清除操作。busy 时所有字段和保存按钮禁用。

在 Session 对话页标题区增加一个“设置”链接，不改变消息/Run/SSE 结构：

```tsx
<Button variant="outline" asChild>
  <Link to={`/sessions/${session.id}/settings`}><Settings2 />设置</Link>
</Button>
```

- [ ] **Step 5: 显示已有 Session 缺少新增必填参数的阻断状态**

Session detail 的 `mcpParametersValid=false` 时：

- 对话页 composer 禁用。
- 显示缺少参数名称和“前往设置”链接。
- 不发送 Run 请求。
- 历史消息、Run、删除和 Provider reset 仍可查看/操作。

- [ ] **Step 6: 运行前端全回归并提交**

Run:

```bash
pnpm test -- test/web-session-settings.test.tsx test/web-sessions-navigation.test.tsx test/web.test.tsx test/web-api.test.ts
pnpm typecheck
pnpm build
```

Expected: PASS。

```bash
git add src/web/pages/session-settings-page.tsx src/web/pages/session-pages.tsx src/web/pages/session-page.tsx src/web/app.tsx src/web/api.ts test/web-session-settings.test.tsx test/web-sessions-navigation.test.tsx test/web.test.tsx
git commit -m "feat: manage Session MCP parameters"
```

---

### Task 9: 部署说明、全量回归与真实验收边界

**Files:**
- Modify: `docs/deployment.md`
- Modify: `scripts/smoke-providers.ts`
- Modify: `test/smoke-providers.test.ts`

**Interfaces:**
- Consumes: 完整 MCP API、Session 参数和三 Provider Run 流程。
- Produces: 可在目标机器执行的 MCP prepare/smoke 入口及密钥运维说明。

- [ ] **Step 1: 写 smoke 参数解析 RED 测试**

```ts
it("--mcp-smoke 要求 Agent MCP 已检查通过并为 Session 提供参数", async () => {
  const output = await runSmoke(["--mcp-smoke"], fakeApi({ mcpStatus: "failed" }));
  expect(output.exitCode).toBe(1);
  expect(output.stderr).toContain("MCP preflight failed");
});
```

不要在仓库写真实 token。Smoke 只复用管理台中已保存的 Agent MCP 和通过环境变量传入脚本的一次性 Session 参数 JSON：

```text
SMOKE_MCP_PARAMETERS_JSON='{"tenant_id":"smoke-team","access_token":"..."}'
```

该变量只属于 smoke 调用输入，不是服务端 MCP 配置映射功能。

- [ ] **Step 2: 更新部署文档的密钥和恢复要求**

明确写入：

```text
DATA_DIR/secret.key owner = remote-agent service user
mode = 0600
backup = SQLite database + secret.key as one recovery unit
restore = restore both before starting service
failure = encrypted rows exist but key missing/wrong permissions -> service refuses startup
```

同时说明 Session runtime 目录必须位于服务用户可控的 APFS/Btrfs Session 根目录，不能为 Node 授予 root、CAP_SYS_ADMIN 或宽泛 sudo。

- [ ] **Step 3: 扩展 Provider smoke 为同一 Session 两轮 + MCP**

执行顺序：

```text
GET Agent MCP summaries -> require at least one enabled MCP and every enabled MCP last check passed
POST Session with mcpParameters
POST Run 1 -> wait succeeded
POST Run 2 on same Session -> wait succeeded
GET events -> require strict seq and at least one terminal status
DELETE Session -> require 204
```

Smoke 输出 Provider、Agent ID、Session ID、Run IDs 和 MCP names，绝不输出参数值、Header、Environment 或完整 URL。

- [ ] **Step 4: 运行完整自动门禁**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
node --check dist/server/main.js
git diff --check
```

Expected: 所有测试通过；server emit 和 web build 成功；diff 无空白错误。

- [ ] **Step 5: 在目标机器执行真实验收并明确未执行项**

Run:

```bash
pnpm smoke:providers -- --mcp-smoke
```

Expected: Claude Code、Codex、Hermes 各完成同 Session 两轮，所有 enabled MCP 预检成功。若当前机器没有三个 Provider 的登录、目标 MCP 或 Btrfs，只在报告中标记“未执行真实门禁”，不能把自动单测描述成真实 Provider 验收。

- [ ] **Step 6: 提交 Task 9**

```bash
git add docs/deployment.md scripts/smoke-providers.ts test/smoke-providers.test.ts
git commit -m "docs: add MCP deployment and smoke checks"
```

---

## 协议依据

- acpx 0.12.1 的 `AcpRuntimeOptions.mcpServers` 会在 `newSession`、`loadSession` 和 `resumeSession` 时传入 ACP，不需要 Remote Agent Server 分别写三套 MCP 原生配置。
- ACP 1.3.0 的 MCP HTTP 结构为 `{ type, name, url, headers[] }`，stdio 结构为 `{ name, command, args[], env[] }`；stdio command 传入 ACP 前解析为绝对路径。
- MCP TypeScript SDK 2.0.0 使用 `Client.connect()` 完成 initialize，使用 `listTools()` 获取工具列表，使用 `close()` 关闭；Streamable HTTP 使用 `StreamableHTTPClientTransport`，stdio 使用 `StdioClientTransport`。
- Codex MCP 官方配置虽支持 Provider 私有 timeout 等字段，但这些字段不属于 ACP 通用 `McpServer`；第一版不提供无法保证对 Claude Code、Codex、Hermes 一致生效的假配置。

## 最终验收清单

- [ ] Agent 可以独立管理 HTTP 和 stdio MCP，列表页不堆叠编辑表单。
- [ ] Agent 可以声明普通/敏感 Session 参数，Session 创建和空闲设置页可以填写。
- [ ] 数据库和 API 中的敏感值不可见，主密钥丢失时 fail closed。
- [ ] 所有 enabled MCP 每 Run 真实 initialize + tools/list；失败时模型 Turn 从未启动。
- [ ] ACP 收到当前 Session 的 MCP，不把密文写进 acpx Session Store、Event 或 Run error。
- [ ] 同 Agent 两个 Session 使用不同参数并发执行时互不串值。
- [ ] MCP 更新后下一 Run 刷新 Handle，并用原 providerSessionId 续接对话。
- [ ] Hermes 不继承主机 `mcp_servers` 或 Skills；Codex/Claude 不修改主机配置。
- [ ] Agent Doctor 只汇总最近状态，连接检查由 MCP 页面显式执行。
- [ ] Session 删除清理参数值、Workspace、Browser 和 Runtime；Agent 删除规则保持“有 Session 不可删除”。
- [ ] 全量测试、类型检查、构建、Node 语法和 diff check 通过。
