# Agent MCP 管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Agent 增加可管理的 HTTP/stdio MCP，让不同 Session 提供不同参数，并在 Run 前检查后通过 ACP 注入模型。

**Architecture:** 使用四张 SQLite 表保存 MCP、值绑定、Session 参数定义和值，敏感值由 AES-256-GCM 加密。RunExecutor 解析并预检 enabled MCP；AcpxAgentRuntime 为每个 Session 建立独立 Runtime，每次 Run 刷新 Handle 并用 `providerSessionId` 续接。前端使用 Agent MCP 独立页面和 Session 设置页。

**Tech Stack:** Node.js 22、TypeScript 6、Fastify 5、SQLite/better-sqlite3、Zod 4、React 19、Vitest 4、acpx 0.12.1、ACP SDK 1.3.0、`@modelcontextprotocol/client` 2.0.0、`yaml` 2.9.0。

**Spec:** `docs/superpowers/specs/2026-08-13-agent-mcp-management-design.md`

## Global Constraints

- 只实现设计文档第一版范围，不增加 Catalog、Gateway、OAuth、Doctor、一次性测试参数或 MCP 专用 smoke。
- MCP 属于 Agent；Session 只保存已声明参数。
- 敏感值只允许用于 HTTP Header 或 stdio Environment，并使用 AES-256-GCM 加密。
- Runtime 参数只允许 `agent_id`、`session_id`、`run_id`、`workspace_path`、`browser_profile_path`。
- 所有 enabled MCP 每次 Run 都执行 `initialize + tools/list`；任一失败时不启动模型 Turn。
- 每个 Session 使用独立 acpx Runtime；每次 Run 刷新 Handle，不实现配置指纹或预检缓存。
- MCP 明文不能写入日志、Event、Run error、acpx Session Store 或 Provider MCP 配置。
- 保持现有单进程 Fastify + SQLite 架构。

## 文件结构

新增：

- `src/mcp/mcp-types.ts`：MCP 输入、返回、解析结果和稳定错误。
- `src/mcp/secret-store.ts`：主密钥及 AES-256-GCM。
- `src/mcp/mcp-manager.ts`：MCP、参数定义、Session 值和运行时解析。
- `src/mcp/mcp-checker.ts`：HTTP/stdio `initialize + tools/list`。
- `src/mcp/mcp-routes.ts`：MCP 和参数定义 API。
- `src/mcp/run-mcp-preparer.ts`：Run 前解析与预检。
- `src/web/pages/agent-mcp-pages.tsx`：MCP 列表、参数定义、创建和编辑。
- `src/web/pages/session-settings-page.tsx`：Session 参数设置。
- `test/mcp-manager.test.ts`、`test/mcp-api.test.ts`、`test/mcp-runtime.test.ts`。
- `test/web-mcp.test.tsx`、`test/web-session-settings.test.tsx`。

修改：

- `package.json`、`pnpm-lock.yaml`、`src/db.ts`、`src/domain.ts`。
- `src/app.ts`、`src/main.ts`。
- `src/sessions/session-manager.ts`、`src/sessions/session-routes.ts`。
- `src/runtime/agent-runtime.ts`、`src/runtime/acpx-runtime.ts`。
- `src/runs/run-executor.ts`。
- `src/web/api.ts`、`src/web/app.tsx`、现有 Agent/Session 页面。
- 对应现有测试和 `docs/deployment.md`。

---

### Task 1: MCP 存储、加密和领域 Manager

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/db.ts`
- Modify: `src/domain.ts`
- Create: `src/mcp/mcp-types.ts`
- Create: `src/mcp/secret-store.ts`
- Create: `src/mcp/mcp-manager.ts`
- Modify: `test/db.test.ts`
- Create: `test/mcp-manager.test.ts`
- Modify: `test/helpers.ts`

**Interfaces:**
- Produces: `SecretStore.open({ dataDir }): SecretStore`、`encrypt(value)`、`decrypt(payload)`。
- Produces: `McpManager` 的 MCP CRUD、参数定义 CRUD、Session 值和 Run 解析接口。
- Produces: `RuntimeMcpServer` 和 `ResolvedMcpServer`。

- [ ] **Step 1: 安装依赖**

```bash
pnpm add -E @modelcontextprotocol/client@2.0.0 yaml@2.9.0
```

- [ ] **Step 2: 写数据库、加密、CRUD 和解析 RED 测试**

```ts
it("创建四张 MCP 表", () => {
  const { db } = createTestDatabase();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all().map((row) => (row as { name: string }).name);
  expect(names).toEqual(expect.arrayContaining([
    "agent_mcp_servers",
    "agent_session_parameters",
    "agent_mcp_values",
    "session_mcp_parameter_values"
  ]));
});

it("加密敏感值并解析当前 Session 的 MCP", () => {
  const server = manager.createServer(agentId, {
    name: "grab-manager",
    transport: "http",
    enabled: true,
    url: "https://example.test/mcp",
    checkTimeoutSeconds: 30,
    headers: [
      { name: "Authorization", source: "fixed", value: "Bearer fixed-secret", secret: true },
      { name: "X-Tenant", source: "session_parameter", parameterKey: "tenant_id" },
      { name: "X-Run", source: "runtime", runtimeKey: "run_id" }
    ]
  });
  expect(JSON.stringify(server)).not.toContain("fixed-secret");
  const [resolved] = manager.resolveEnabledForRun(runContext);
  expect(resolved?.server).toMatchObject({
    type: "http",
    headers: expect.arrayContaining([{ name: "X-Tenant", value: "team-a" }])
  });
});

it("拒绝 shell command 和敏感 Argument", () => {
  expect(() => manager.createServer(agentId, stdioInput({ command: "npx && bad" })))
    .toThrowError(expect.objectContaining({ code: "invalid_mcp_server" }));
  expect(() => manager.createServer(agentId, stdioInput({
    arguments: [{ source: "session_parameter", parameterKey: "access_token" }]
  }))).toThrowError(expect.objectContaining({ code: "invalid_mcp_value" }));
});
```

- [ ] **Step 3: 运行 RED**

```bash
pnpm test -- test/db.test.ts test/mcp-manager.test.ts
```

Expected: FAIL，MCP 表和模块尚不存在。

- [ ] **Step 4: 实现四张表和稳定类型**

```ts
export type RuntimeMcpServer =
  | { type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { type: "stdio"; name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };

export type ResolvedMcpServer = {
  id: string;
  checkTimeoutMs: number;
  server: RuntimeMcpServer;
};

export type ResolveMcpContext = {
  agentId: string;
  sessionId: string;
  runId: string;
  workspacePath: string;
  browserProfilePath: string;
};
```

按设计文档创建 `agent_mcp_servers`、`agent_session_parameters`、`agent_mcp_values`、`session_mcp_parameter_values`，保持外键和唯一约束。

- [ ] **Step 5: 实现 SecretStore 和 McpManager**

```ts
export class SecretStore {
  static open({ dataDir }: { dataDir: string }): SecretStore;
  encrypt(value: string): string;
  decrypt(payload: string): string;
}

export class McpManager {
  listServers(agentId: string): AgentMcpServerSummary[];
  getServer(agentId: string, id: string): AgentMcpServerDetail | undefined;
  createServer(agentId: string, input: McpServerWriteInput): AgentMcpServerDetail;
  updateServer(agentId: string, id: string, input: McpServerWriteInput): AgentMcpServerDetail | undefined;
  deleteServer(agentId: string, id: string): boolean;
  listParameterDefinitions(agentId: string): AgentSessionParameter[];
  createParameterDefinition(agentId: string, input: CreateSessionParameterInput): AgentSessionParameter;
  updateParameterDefinition(agentId: string, id: string, input: UpdateSessionParameterInput): AgentSessionParameter | undefined;
  deleteParameterDefinition(agentId: string, id: string): boolean;
  normalizeSessionValues(agentId: string, values: Record<string, string | null>, requireAll: boolean): NormalizedSessionMcpValue[];
  insertSessionValuesInTransaction(sessionId: string, values: NormalizedSessionMcpValue[]): void;
  applySessionValuePatchInTransaction(sessionId: string, values: NormalizedSessionMcpValue[]): void;
  getSessionStatus(sessionId: string): SessionMcpStatus;
  resolveEnabledForRun(context: ResolveMcpContext): ResolvedMcpServer[];
  resolveOneForCheck(agentId: string, serverId: string, sessionId?: string): ResolvedMcpServer | undefined;
  recordCheckResult(serverId: string, result: McpCheckResult): void;
}
```

Manager 使用同步 `BEGIN IMMEDIATE` 保存 Server 与有序 values。敏感编辑值省略时保留已有密文。Header 拒绝 `Host`、`Content-Length`、`Connection` 和 `Transfer-Encoding`。stdio basename 按 PATH 解析为绝对可执行路径；command 不经过 shell。

- [ ] **Step 6: 运行 GREEN 并提交**

```bash
pnpm test -- test/db.test.ts test/mcp-manager.test.ts
pnpm typecheck
git add package.json pnpm-lock.yaml src/db.ts src/domain.ts src/mcp test/db.test.ts test/mcp-manager.test.ts test/helpers.ts
git commit -m "feat: add Agent MCP domain"
```

---

### Task 2: MCP 管理 API 和连接检查

**Files:**
- Create: `src/mcp/mcp-checker.ts`
- Create: `src/mcp/mcp-routes.ts`
- Modify: `src/app.ts`
- Modify: `src/main.ts`
- Create: `test/mcp-api.test.ts`

**Interfaces:**
- Consumes: Task 1 `McpManager`、`RuntimeMcpServer`。
- Produces: MCP/参数定义 REST API 和 `McpChecker.check(server, timeoutMs)`。

- [ ] **Step 1: 写 API 和 Checker RED 测试**

```ts
it("鉴权后完成 MCP CRUD 且敏感值不出现在响应", async () => {
  const response = await app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/mcp-servers`,
    headers: authHeaders(),
    payload: validHttpServer()
  });
  expect(response.statusCode).toBe(201);
  expect(JSON.stringify(response.json())).not.toContain("secret-token");
});

it.each(["http", "stdio"] as const)("%s 检查 initialize、tools/list 并关闭", async (transport) => {
  const probe = createProbeHarness(transport);
  const result = await checker.check(probe.server, 3000);
  expect(probe.connect).toHaveBeenCalledOnce();
  expect(probe.listTools).toHaveBeenCalledOnce();
  expect(probe.close).toHaveBeenCalledOnce();
  expect(result).toEqual({ status: "passed", toolCount: 2, message: "2 tools available" });
});

it("检查失败统一返回脱敏 mcp_check_failed", async () => {
  const result = await checker.check(secretServer, 10);
  expect(result).toMatchObject({ status: "failed", code: "mcp_check_failed" });
  expect(JSON.stringify(result)).not.toMatch(/secret-token|Authorization/i);
});
```

- [ ] **Step 2: 运行 RED**

```bash
pnpm test -- test/mcp-api.test.ts
```

- [ ] **Step 3: 实现官方 MCP Client 检查**

```ts
export type McpCheckResult =
  | { status: "passed"; toolCount: number; message: string }
  | { status: "failed"; code: "mcp_check_failed"; message: string };

export class SdkMcpChecker {
  async check(server: RuntimeMcpServer, timeoutMs: number): Promise<McpCheckResult>;
}
```

HTTP 使用 `StreamableHTTPClientTransport`，stdio 使用 `StdioClientTransport`。创建 `Client` 后执行 `connect` 和 `listTools`，finally 关闭。所有原始错误统一转换为固定失败结果，不返回 URL query、Header、Environment 或命令参数。

- [ ] **Step 4: 实现路由并组装依赖**

```text
GET/POST          /api/agents/:agentId/mcp-servers
GET/PATCH/DELETE  /api/agents/:agentId/mcp-servers/:id
POST              /api/agents/:agentId/mcp-servers/:id/check
GET/POST          /api/agents/:agentId/session-parameters
PATCH/DELETE      /api/agents/:agentId/session-parameters/:id
```

使用 Zod discriminated union 分开 HTTP 与 stdio payload。固定 MCP 检查不需要 body；引用 Session 参数或路径时 body 必须有 `sessionId`；`run_id` 使用服务端生成的临时 UUID。DELETE 成功返回无 body 的 204。

`startServer` 在 `migrate(db)` 后创建 SecretStore 和 McpManager，再传入 `buildApp`。测试可以注入 Manager 和 Checker。

- [ ] **Step 5: 运行 GREEN 并提交**

```bash
pnpm test -- test/mcp-api.test.ts test/agents.test.ts test/db.test.ts
pnpm typecheck
git add src/mcp/mcp-checker.ts src/mcp/mcp-routes.ts src/app.ts src/main.ts test/mcp-api.test.ts
git commit -m "feat: expose Agent MCP API"
```

---

### Task 3: Session 参数创建、修改和状态

**Files:**
- Modify: `src/sessions/session-manager.ts`
- Modify: `src/sessions/session-routes.ts`
- Modify: `src/domain.ts`
- Modify: `src/app.ts`
- Modify: `test/sessions.test.ts`
- Modify: `test/helpers.ts`

**Interfaces:**
- Consumes: Task 1 `McpManager`。
- Changes: `CreateSessionInput` 增加 `mcpParameters`。
- Produces: `PATCH /api/sessions/:id/mcp-parameters` 和 Session MCP 状态。

- [ ] **Step 1: 写 Session 参数 RED 测试**

```ts
it("创建 Session 时保存必填参数", async () => {
  await createParameter(agentId, { key: "tenant", required: true, secret: false });
  const missing = await postSession({ agentId, title: "A", mcpParameters: {} });
  expect(missing.statusCode).toBe(400);

  const created = await postSession({
    agentId,
    title: "A",
    mcpParameters: { tenant: "team-a" }
  });
  expect(created.statusCode).toBe(201);
});

it("空闲 Session 可以局部修改，运行中拒绝", async () => {
  expect((await patchParameters(runningId, { tenant: "team-b" })).statusCode).toBe(409);
  expect((await patchParameters(idleId, { tenant: "team-b" })).statusCode).toBe(200);
});
```

- [ ] **Step 2: 运行 RED**

```bash
pnpm test -- test/sessions.test.ts
```

- [ ] **Step 3: 实现创建和局部更新事务**

```ts
export type CreateSessionInput = {
  agentId: string;
  title: string;
  mcpParameters: Record<string, string>;
};
```

POST schema 将 `mcpParameters` 默认设为 `{}`。创建顺序：校验 Agent/环境和参数 → 创建 Workspace → 一个事务插入 Session 与参数值。保持现有 Workspace 创建失败处理。

PATCH 在同一个 `BEGIN IMMEDIATE` 内确认 Session idle 且没有 queued/running Run，然后只更新请求出现的 key。普通可选值可用 `null` 删除，敏感值留空不提交即可保留。

- [ ] **Step 4: 扩展 Session detail 和路由**

```json
{
  "mcpParametersValid": false,
  "missingMcpParameters": ["access_token"],
  "mcpParameters": [
    { "key": "tenant", "secret": false, "configured": true, "value": "team-a" },
    { "key": "access_token", "secret": true, "configured": false }
  ]
}
```

新增：

```text
PATCH /api/sessions/:id/mcp-parameters
body: { "values": { "tenant": "team-b" } }
```

- [ ] **Step 5: 运行 GREEN 并提交**

```bash
pnpm test -- test/sessions.test.ts test/runs.test.ts test/db.test.ts
pnpm typecheck
git add src/sessions/session-manager.ts src/sessions/session-routes.ts src/domain.ts src/app.ts test/sessions.test.ts test/helpers.ts
git commit -m "feat: bind MCP parameters to Sessions"
```

---

### Task 4: Run 预检和 Session 独立 ACP Runtime

**Files:**
- Create: `src/mcp/run-mcp-preparer.ts`
- Modify: `src/runtime/agent-runtime.ts`
- Modify: `src/runtime/acpx-runtime.ts`
- Modify: `src/runs/run-executor.ts`
- Modify: `src/app.ts`
- Create: `test/mcp-runtime.test.ts`
- Modify: `test/run-executor.test.ts`
- Modify: `test/runtime.test.ts`
- Modify: `test/helpers.ts`

**Interfaces:**
- Produces: `RunMcpPreparer.prepare(context): Promise<RuntimeMcpServer[]>`。
- Changes: `RuntimeSessionInput` 增加 `mcpServers: RuntimeMcpServer[]`。
- Changes: `ManagedSession` 保存自己的 `runtime`、`registry` 和 `handle`。

- [ ] **Step 1: 写预检和隔离 RED 测试**

```ts
it("MCP 失败时不 ensure Session 或启动 Turn", async () => {
  checker.check.mockResolvedValue({
    status: "failed",
    code: "mcp_check_failed",
    message: "MCP check failed"
  });
  await executor.execute(runId);
  expect(runtime.ensureSession).not.toHaveBeenCalled();
  expect(runtime.startTurn).not.toHaveBeenCalled();
  expect(getRun(runId)).toMatchObject({ status: "failed", error: "MCP grab-manager check failed" });
  expect(getSession(sessionId)?.status).toBe("idle");
});

it("两个 Session 使用不同 Runtime 和 MCP", async () => {
  await runtime.ensureSession(sessionInput({ sessionId: sessionA, mcpServers: serversA }));
  await runtime.ensureSession(sessionInput({ sessionId: sessionB, mcpServers: serversB }));
  expect(createAcpRuntime).toHaveBeenNthCalledWith(1, expect.objectContaining({ mcpServers: serversA }));
  expect(createAcpRuntime).toHaveBeenNthCalledWith(2, expect.objectContaining({ mcpServers: serversB }));
});

it("同一 Session 下一 Run 刷新 Handle 并续接 providerSessionId", async () => {
  await runtime.ensureSession(sessionInput({ providerSessionId: null, mcpServers: first }));
  await runtime.ensureSession(sessionInput({ providerSessionId: PROVIDER_SESSION_ID, mcpServers: changed }));
  expect(firstRuntime.close).toHaveBeenCalledOnce();
  expect(secondRuntime.ensureSession).toHaveBeenCalledWith(
    expect.objectContaining({ resumeSessionId: PROVIDER_SESSION_ID })
  );
});
```

- [ ] **Step 2: 运行 RED**

```bash
pnpm test -- test/mcp-runtime.test.ts test/run-executor.test.ts test/runtime.test.ts
```

- [ ] **Step 3: 实现 RunMcpPreparer**

```ts
export class RunMcpPreparer {
  constructor(private readonly manager: McpManager, private readonly checker: McpChecker) {}

  async prepare(context: ResolveMcpContext): Promise<RuntimeMcpServer[]> {
    const resolved = this.manager.resolveEnabledForRun(context);
    const checked = await Promise.all(resolved.map(async (item) => ({
      item,
      result: await this.checker.check(item.server, item.checkTimeoutMs)
    })));
    const failed = checked.find(({ result }) => result.status === "failed");
    if (failed !== undefined) throw new McpPreparationError(failed.item.server.name);
    return resolved.map(({ server }) => server);
  }
}
```

Manager 解析异常也统一转成 `McpPreparationError`。该错误只公开 MCP 名称和固定 `mcp_check_failed` 消息。

- [ ] **Step 4: 把预检接到 RunExecutor**

在现有 `markRunning` 后、`skillProjector.prepare` 和 `runtime.ensureSession` 前准备 MCP：

```ts
const browserProfilePath = join(dirname(session.workspacePath), "browser");
const mcpServers = await this.mcpPreparer.prepare({
  agentId: agent.id,
  sessionId: session.id,
  runId: run.id,
  workspacePath: session.workspacePath,
  browserProfilePath
});
```

把 `mcpServers` 加入 `runtime.ensureSession` 输入。保留现有 cancellation intent 和 `finishRun` 语义。

- [ ] **Step 5: 将 AcpxAgentRuntime 改为 Session 独立 Runtime**

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
  target: string;
};
```

每次 `ensureSession`：

1. 在该 Session 的串行锁内关闭旧 Handle，并清理旧 Registry。
2. 创建只注册当前 target 的 Registry。
3. 调用 `createAcpRuntime({ ..., mcpServers })`。
4. 使用输入的 `providerSessionId` resume，或首次创建。
5. 保存新的 ManagedSession。

`startTurn`、cancel、reset 和 shutdown 都从对应 ManagedSession 取 Runtime，不再使用全局 Runtime。Hermes Agent Home 的 `config.yaml` 不能继续链接主机文件：先移除已有目标 symlink，再读取主机配置、删除顶层 `mcp_servers`，最后原子写入 Agent Home；不得修改主机配置。不改动现有其他 Provider Home 和 Skills 规则。

- [ ] **Step 6: 运行 GREEN 并提交**

```bash
pnpm test -- test/mcp-runtime.test.ts test/run-executor.test.ts test/runtime.test.ts test/runs.test.ts test/sessions.test.ts
pnpm typecheck
git add src/mcp/run-mcp-preparer.ts src/runtime/agent-runtime.ts src/runtime/acpx-runtime.ts src/runs/run-executor.ts src/app.ts test/mcp-runtime.test.ts test/run-executor.test.ts test/runtime.test.ts test/helpers.ts
git commit -m "feat: inject Session MCP through ACP"
```

---

### Task 5: Agent MCP 和 Session 参数页面

**Files:**
- Create: `src/web/pages/agent-mcp-pages.tsx`
- Create: `src/web/pages/session-settings-page.tsx`
- Modify: `src/web/app.tsx`
- Modify: `src/web/api.ts`
- Modify: `src/web/pages/agent-pages.tsx`
- Modify: `src/web/pages/session-pages.tsx`
- Modify: `src/web/pages/session-page.tsx`
- Create: `test/web-mcp.test.tsx`
- Create: `test/web-session-settings.test.tsx`
- Modify: existing navigation/session tests

**Interfaces:**
- Consumes: Tasks 2/3 API。
- Produces: Agent MCP Tab、MCP 创建/编辑页、Session 参数创建/设置流程。

- [ ] **Step 1: 写核心页面 RED 测试**

```tsx
it("从 Agent MCP Tab 进入独立创建页", async () => {
  renderAppAt(`/agents/${agentId}/mcp`);
  expect(await screen.findByRole("heading", { name: "MCP" })).toBeVisible();
  await user.click(screen.getByRole("link", { name: "新建 MCP" }));
  expect(location.pathname).toBe(`/agents/${agentId}/mcp/new`);
});

it("Session 创建提交 Agent 参数", async () => {
  renderAppAt("/sessions/new");
  await user.selectOptions(screen.getByLabelText("选择 Agent"), agentId);
  await user.type(await screen.findByLabelText("租户"), "team-a");
  await user.click(screen.getByRole("button", { name: "创建 Session" }));
  expect(lastJsonBody()).toMatchObject({
    agentId,
    mcpParameters: { tenant_id: "team-a" }
  });
});

it("运行中 Session 设置页禁用保存", async () => {
  renderAppAt(`/sessions/${runningId}/settings`);
  expect(await screen.findByRole("button", { name: "保存参数" })).toBeDisabled();
});
```

- [ ] **Step 2: 运行 RED**

```bash
pnpm test -- test/web-mcp.test.tsx test/web-session-settings.test.tsx
```

- [ ] **Step 3: 实现 Agent MCP 页面**

路由：

```text
/agents/:id/mcp
/agents/:id/mcp/new
/agents/:id/mcp/:mcpServerId
```

MCP 列表显示名称、HTTP/stdio、enabled、最近检查状态和操作。参数定义使用列表页独立卡片和小 Dialog。创建/编辑放在独立页面：HTTP 显示 URL/Headers，stdio 显示 command/Arguments/Environment。每行选择 fixed、Session 参数或 Runtime 参数。

手动检查：纯 fixed 直接检查；需要 Session 值或路径时选择该 Agent 的已有 Session。没有可用 Session 时提示先创建 Session。

- [ ] **Step 4: 实现 Session 创建和设置页**

选择 Agent 后加载参数定义。required 字段必须填写；secret 使用 password 输入。设置页只回显普通值，敏感值显示“已配置”，新输入替换旧值。

Session 对话页增加“设置”链接。`mcpParametersValid=false` 时禁用 composer，显示缺少参数和设置入口。

- [ ] **Step 5: 运行 GREEN 并提交**

```bash
pnpm test -- test/web-mcp.test.tsx test/web-session-settings.test.tsx test/web-agents.test.tsx test/web.test.tsx test/web-navigation.test.tsx
pnpm typecheck
pnpm build
git add src/web test/web-mcp.test.tsx test/web-session-settings.test.tsx test/web-agents.test.tsx test/web.test.tsx test/web-navigation.test.tsx
git commit -m "feat: add MCP management pages"
```

---

### Task 6: 部署说明和完整验证

**Files:**
- Modify: `docs/deployment.md`

**Interfaces:**
- Consumes: 完整功能。
- Produces: 密钥部署说明和最终自动门禁结果。

- [ ] **Step 1: 更新部署说明**

记录：

```text
DATA_DIR/secret.key 由服务用户拥有
权限 0600
备份数据库时同时备份 secret.key
恢复时两者一起恢复
```

不增加 MCP 专用脚本、运维服务或额外环境变量映射。

- [ ] **Step 2: 执行完整自动门禁**

```bash
pnpm test
pnpm typecheck
pnpm build
node --check dist/server/main.js
git diff --check
```

Expected: 所有测试、类型检查、生产构建和 Node 语法检查通过。

- [ ] **Step 3: 本机手动验证一个主流程**

```text
创建一个 HTTP 或 stdio MCP
执行手动连接检查
创建带 Session 参数的 Session
发送一条消息
确认 Run succeeded 或在 MCP 不可用时明确 failed 且模型未启动
```

只记录实际执行结果，不要求三 Provider MCP 专用 smoke。

- [ ] **Step 4: 提交**

```bash
git add docs/deployment.md
git commit -m "docs: add MCP secret deployment notes"
```

## 最终验收清单

- [ ] Agent 可以管理 HTTP 和 stdio MCP。
- [ ] Session 可以填写 Agent 声明的普通/敏感参数。
- [ ] API、Event、Run error 和 acpx Store 不出现敏感明文。
- [ ] 每个 enabled MCP 在 Run 前完成 `initialize + tools/list`。
- [ ] 预检失败时模型 Turn 不启动，Session 回到 idle。
- [ ] 同 Agent 的两个 Session 使用独立 Runtime 和各自参数。
- [ ] 下一 Run 使用更新后的 MCP 并续接 provider Session。
- [ ] Agent MCP 和 Session 设置页面可完成主流程。
- [ ] 全量测试、类型检查和生产构建通过。
