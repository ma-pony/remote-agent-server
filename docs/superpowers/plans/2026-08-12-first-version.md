# Remote Agent Server 第一版实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个部署在 Linux Agent 服务器上的单进程服务，通过 acpx/ACP 运行 Claude Code、Codex 和 Hermes，支持 Btrfs Session Workspace、多轮对话、运行记录、SSE 实时事件和最小管理界面。

**Architecture:** Fastify 同时提供 JSON API、SSE 和构建后的 React 页面；SQLite WAL 保存 Agent、Session、Run 和 Event。创建 Session 时从完整 Btrfs 模板创建可写快照；`RunExecutor` 是业务代码与固定版本 acpx Runtime 之间的唯一边界，同一 Session 只允许一个未结束 Run，不同 Session 由进程内调度器并行执行。

**Tech Stack:** Node.js 22.13+、TypeScript、pnpm、Fastify 5、React 19、Vite 8、SQLite WAL、better-sqlite3、Vitest、acpx 0.12.1、Btrfs。

## Global Constraints

- 第一版是一个仓库、一个 Node.js 服务进程和一个部署单元。
- Node.js 最低版本是 22.13.0；`acpx` 必须精确锁定为 `0.12.1`，升级必须单独验证 Runtime 契约。
- 只使用 `agents`、`sessions`、`runs`、`events` 四张业务表，不增加通用 JSON 配置列。
- `agents` 只保存 `name`、`provider`、`enabled`；Provider 只能是 `claude_code`、`codex`、`hermes`。
- 所有 `/api` 接口使用固定 Bearer Token 鉴权，`/api/health` 除外。
- 同一个 Session 同时只允许一个状态为 `queued` 或 `running` 的 Run；全局并发由 `MAX_CONCURRENT_RUNS` 控制，默认值为 `4`。
- Run 成功只表示 Agent Turn 正常结束，不表达任何工单、审核、部署或生产验证结果。
- Workspace 根目录必须位于 Btrfs；基础模板是单个 Subvolume，内部不能嵌套其他 Subvolume。
- Session 创建时生成模板的可写 Btrfs 快照；Agent 不负责克隆仓库、创建 worktree 或安装基础依赖。
- 第一版权限模式固定使用 acpx `approve-all`，服务必须运行在专用低权限系统用户下；这不是安全沙箱。
- 第一版不实现 Redis、Sidekiq、独立 Worker、Webhook、Outbox、多 Host、Workflow、向量 Memory、Skills UI 或服务重启后的在途 Run 接管。

---

## 文件结构

```text
package.json                         # 依赖和统一命令
pnpm-lock.yaml                       # 精确依赖锁
tsconfig.json                        # 公共 TypeScript 配置
tsconfig.server.json                 # 服务端构建配置
tsconfig.web.json                    # 前端类型检查配置
vite.config.ts                       # React 构建与开发代理
vitest.config.ts                     # Node/jsdom 测试项目
.env.example                         # 非敏感配置示例
.gitignore                           # 忽略 data、dist、env 和测试产物

src/config.ts                        # 读取和校验环境变量
src/main.ts                          # 组装依赖、恢复状态并启动 Fastify
src/app.ts                           # 创建 Fastify 应用并注册路由
src/auth.ts                          # Bearer Token hook
src/db.ts                            # SQLite 连接、迁移和事务入口
src/domain.ts                        # 四个实体、状态和 Provider 类型

src/agents/agent-manager.ts          # Agent CRUD、目录和 Provider 映射
src/agents/agent-routes.ts           # Agent HTTP API 和 doctor
src/workspaces/btrfs-workspace.ts    # Btrfs 检测和 Session 快照创建
src/sessions/session-manager.ts      # 创建、读取和重置 Session
src/sessions/session-routes.ts       # Session HTTP API
src/events/event-store.ts            # append-only Event 和进程内订阅
src/runtime/agent-runtime.ts         # 可替换 Runtime 接口
src/runtime/acpx-runtime.ts           # acpx 0.12.1 适配器
src/runtime/skill-projector.ts       # Agent Skills 和 MEMORY.md 投影
src/runs/run-repository.ts           # Run 持久化和启动恢复
src/runs/run-executor.ts             # 单轮执行、事件归一化和取消
src/runs/run-scheduler.ts            # 单进程全局并发调度
src/runs/run-routes.ts               # 创建、读取、取消 Run 和 SSE

src/web/main.tsx                     # React 入口
src/web/app.tsx                      # 路由和 Token 门页
src/web/api.ts                       # JSON API 和带 Authorization 的 SSE client
src/web/pages/agents-page.tsx        # Agent 列表、创建、启停和 doctor
src/web/pages/sessions-page.tsx      # Session 列表和创建
src/web/pages/session-page.tsx       # 多轮消息、事件、取消和继续输入
src/web/styles.css                   # 简单响应式界面

test/helpers.ts                      # 临时 DB、应用和 Fake Runtime 工厂
test/db.test.ts                      # Schema 和唯一约束
test/agents.test.ts                  # Agent API
test/workspaces.test.ts              # Btrfs 命令边界
test/sessions.test.ts                # Session API 和重置
test/runtime.test.ts                 # acpx 边界、Skills 和 Memory
test/run-executor.test.ts            # acpx 事件映射、结果和取消
test/runs.test.ts                    # Run API、并发和恢复
test/events.test.ts                  # 历史事件和 SSE
test/web.test.tsx                    # 三个页面的关键交互

scripts/smoke-providers.ts           # 三种真实 Agent 的人工验收脚本
docs/deployment.md                   # Btrfs 模板、Provider 登录和 systemd 部署
```

### Task 1: 建立可运行的单体项目和 SQLite Schema

**Files:**
- Create: `package.json`
- Create: `pnpm-lock.yaml`
- Create: `tsconfig.json`
- Create: `tsconfig.server.json`
- Create: `tsconfig.web.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `src/config.ts`
- Create: `src/domain.ts`
- Create: `src/db.ts`
- Create: `test/helpers.ts`
- Create: `test/db.test.ts`

**Interfaces:**
- Produces: `loadConfig(env): AppConfig`、`openDatabase(path): Database.Database`、`migrate(db): void` 和四个领域实体类型。

- [ ] **Step 1: 创建依赖和 TypeScript/Vite/Vitest 配置**

使用下面的依赖边界；生成的 `pnpm-lock.yaml` 必须提交：

```bash
pnpm add fastify@5 @fastify/static@8 better-sqlite3@12 zod@4 acpx@0.12.1 react@19 react-dom@19 @microsoft/fetch-event-source@2
pnpm add -D typescript@6 tsx@4 vite@8 @vitejs/plugin-react@6 vitest@4 jsdom@27 @testing-library/react@16 @testing-library/jest-dom@6 @types/node@22 @types/react@19 @types/react-dom@19 @types/better-sqlite3@7
```

`package.json` 至少包含：

```json
{
  "type": "module",
  "engines": { "node": ">=22.13.0" },
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "dev:web": "vite",
    "build": "tsc -p tsconfig.server.json && vite build",
    "start": "node dist/server/main.js",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.server.json --noEmit && tsc -p tsconfig.web.json --noEmit"
  },
  "dependencies": { "acpx": "0.12.1" }
}
```

`.env.example` 固定展示下面这些服务级配置，不放 Provider 凭证：

```env
HOST=0.0.0.0
PORT=3000
API_TOKEN=replace-with-a-long-random-token
DATA_DIR=/srv/remote-agent/data
DATABASE_PATH=/srv/remote-agent/data/remote-agent.sqlite3
WORKSPACE_TEMPLATE=/srv/remote-agent/template/workspace
SESSIONS_ROOT=/srv/remote-agent/sessions
MAX_CONCURRENT_RUNS=4
```

- [ ] **Step 2: 先写配置和 Schema 的失败测试**

`test/db.test.ts` 覆盖：缺少 `API_TOKEN` 时失败、默认并发为 4、迁移后只有四张业务表、同一 Session 不能存在两个未结束 Run。

```ts
it("拒绝同一 Session 的第二个活动 Run", () => {
  const { db, seed } = createTestDatabase();
  const session = seed.session();
  seed.run(session.id, "queued");
  expect(() => seed.run(session.id, "running")).toThrow(/UNIQUE/);
});
```

- [ ] **Step 3: 运行测试并确认失败**

Run: `pnpm vitest run test/db.test.ts`

Expected: FAIL，原因是 `src/config.ts`、`src/db.ts` 和迁移尚不存在。

- [ ] **Step 4: 实现配置、领域类型和迁移**

`AppConfig` 使用明确字段：

```ts
export type AppConfig = {
  host: string;
  port: number;
  apiToken: string;
  dataDir: string;
  databasePath: string;
  workspaceTemplate: string;
  sessionsRoot: string;
  maxConcurrentRuns: number;
};
```

SQLite 初始化执行 `PRAGMA journal_mode = WAL`、`PRAGMA foreign_keys = ON` 和以下核心约束：

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude_code', 'codex', 'hermes')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running')),
  provider_session_id TEXT,
  workspace_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE UNIQUE INDEX one_active_run_per_session
ON runs(session_id) WHERE status IN ('queued', 'running');

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('message', 'tool', 'status', 'error')),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, seq)
);
```

- [ ] **Step 5: 验证并提交**

Run: `pnpm vitest run test/db.test.ts && pnpm typecheck`

Expected: PASS。

```bash
git add package.json pnpm-lock.yaml tsconfig*.json vite.config.ts vitest.config.ts .env.example .gitignore src/config.ts src/domain.ts src/db.ts test/helpers.ts test/db.test.ts
git commit -m "chore: initialize remote agent server"
```

### Task 2: 实现 API 鉴权和 Agent 管理

**Files:**
- Create: `src/auth.ts`
- Create: `src/agents/agent-manager.ts`
- Create: `src/agents/agent-routes.ts`
- Create: `src/runtime/agent-runtime.ts`
- Create: `src/app.ts`
- Create: `test/agents.test.ts`

**Interfaces:**
- Consumes: `AppConfig`、SQLite `Database`、`Agent` 和 `Provider`。
- Produces: `AgentManager.create/list/update/get/doctor`、内部 `AgentRuntime` 接口和 `buildApp(deps): FastifyInstance`。

- [ ] **Step 1: 写 Agent API 的失败测试**

通过 `Fastify.inject()` 验证：

```ts
it("只接受经过鉴权的明确 Provider Agent", async () => {
  const app = await createTestApp();
  expect((await app.inject({ method: "GET", url: "/api/agents" })).statusCode).toBe(401);

  const response = await app.inject({
    method: "POST",
    url: "/api/agents",
    headers: authHeaders(),
    payload: { name: "Codex 开发", provider: "codex" }
  });
  expect(response.statusCode).toBe(201);
  expect(response.json()).toMatchObject({ name: "Codex 开发", provider: "codex", enabled: true });
});
```

补充非法 Provider、空名称、启停更新和 `/api/health` 无鉴权可访问测试。

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm vitest run test/agents.test.ts`

Expected: FAIL，原因是应用、鉴权和 Agent 路由不存在。

- [ ] **Step 3: 实现 Bearer Token hook 和 AgentManager**

鉴权只比较常量时间安全的 Token 字节；错误统一返回：

```json
{ "error": { "code": "unauthorized", "message": "Invalid API token" } }
```

`AgentManager` 使用同步 SQLite 语句并返回 camelCase 对象。创建 Agent 时同时确保以下目录存在：

```text
<DATA_DIR>/agents/<agent-id>/skills/
<DATA_DIR>/agents/<agent-id>/MEMORY.md
<DATA_DIR>/agents/<agent-id>/provider-home/hermes/
```

`MEMORY.md` 在创建 Agent 时写为空文件；如果目录已存在则不得覆盖已有内容。

`src/runtime/agent-runtime.ts` 在本任务固定以下业务接口，后续 acpx 只能在这个接口内部出现：

```ts
export type RuntimeSessionInput = {
  sessionId: string;
  agentId: string;
  provider: Provider;
  workspacePath: string;
  browserProfilePath: string;
  providerSessionId: string | null;
  memory: string;
};

export type RuntimeSession = { providerSessionId: string | null };
export type RuntimeTurnInput = { sessionId: string; requestId: string; text: string };
export type RuntimeEvent =
  | { type: "message"; stream: "output" | "thought"; text: string }
  | { type: "tool"; content: Record<string, unknown> }
  | { type: "status"; text: string }
  | { type: "error"; code?: string; message: string };
export type RuntimeTurnResult =
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "failed"; code?: string; message: string };
export type RuntimeDoctor = { ok: boolean; message: string; details: string[] };

export type RuntimeTurn = {
  events: AsyncIterable<RuntimeEvent>;
  result: Promise<RuntimeTurnResult>;
  cancel(): Promise<void>;
};

export interface AgentRuntime {
  ensureSession(input: RuntimeSessionInput): Promise<RuntimeSession>;
  startTurn(input: RuntimeTurnInput): RuntimeTurn;
  cancel(sessionId: string): Promise<void>;
  reset(input: RuntimeSessionInput): Promise<void>;
  doctor(provider: Provider, agentId: string): Promise<RuntimeDoctor>;
}
```

- [ ] **Step 4: 注册最小 Agent 路由**

实现：

```text
GET   /api/health
GET   /api/agents
POST  /api/agents
PATCH /api/agents/:id
GET   /api/agents/:id/doctor
```

`src/runtime/agent-runtime.ts` 先定义完整内部接口；`doctor` 通过注入的 `AgentRuntime.doctor(provider, agentId)` 返回 `{ ok, message, details }`。测试使用 Fake Runtime，不启动真实 Agent。

- [ ] **Step 5: 验证并提交**

Run: `pnpm vitest run test/agents.test.ts test/db.test.ts && pnpm typecheck`

Expected: PASS。

```bash
git add src/auth.ts src/agents src/runtime/agent-runtime.ts src/app.ts test/agents.test.ts test/helpers.ts
git commit -m "feat: add authenticated agent management"
```

### Task 3: 实现 Btrfs Workspace 和 Session API

**Files:**
- Create: `src/workspaces/btrfs-workspace.ts`
- Create: `src/sessions/session-manager.ts`
- Create: `src/sessions/session-routes.ts`
- Create: `test/workspaces.test.ts`
- Create: `test/sessions.test.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `AppConfig`、AgentManager、AgentRuntime 和 SQLite Database。
- Produces: `WorkspaceManager.check/create`、`SessionManager.create/list/get/resetProviderSession`。

- [ ] **Step 1: 写 Btrfs 命令边界的失败测试**

为命令执行注入下面接口，测试不要求开发机实际使用 Btrfs：

```ts
export interface CommandRunner {
  run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}
```

验证 `check()` 调用 `btrfs subvolume show <template>`；验证 `create(id)` 创建 Session 父目录、`runtime`、`browser` 并执行：

```text
btrfs subvolume snapshot <template> <sessionsRoot>/<id>/workspace
```

命令失败时必须删除尚未写入数据库的普通空目录，并返回 `workspace_create_failed`。

- [ ] **Step 2: 写 Session API 的失败测试**

覆盖：禁用 Agent 不能创建 Session、快照成功后保存 Session、快照失败不产生 Session、读取详情、重置成功后只清空 `provider_session_id` 而保留 Workspace、Runtime reset 失败时不清空数据库字段。

```ts
expect(response.json()).toMatchObject({
  agentId: agent.id,
  title: "修复工单 1332",
  status: "idle",
  providerSessionId: null
});
```

- [ ] **Step 3: 运行测试并确认失败**

Run: `pnpm vitest run test/workspaces.test.ts test/sessions.test.ts`

Expected: FAIL，原因是 WorkspaceManager 和 SessionManager 不存在。

- [ ] **Step 4: 实现快照创建和 Session 路由**

创建顺序固定为：生成 UUID → 创建父目录 → 创建 Btrfs Snapshot → 插入 Session。数据库插入失败时执行：

```text
btrfs subvolume delete <sessionsRoot>/<id>/workspace
```

路由实现：

```text
GET  /api/sessions
POST /api/sessions
GET  /api/sessions/:id
POST /api/sessions/:id/reset
```

运行中的 Session 拒绝 reset，返回 HTTP 409 和 `session_busy`。空闲 Session 必须先调用 `AgentRuntime.reset(RuntimeSessionInput)`，成功后才清空数据库中的 `provider_session_id`。

- [ ] **Step 5: 验证并提交**

Run: `pnpm vitest run test/workspaces.test.ts test/sessions.test.ts && pnpm typecheck`

Expected: PASS。

```bash
git add src/workspaces src/sessions src/app.ts test/workspaces.test.ts test/sessions.test.ts test/helpers.ts
git commit -m "feat: add btrfs session workspaces"
```

### Task 4: 实现 append-only EventStore 和 Run 持久化

**Files:**
- Create: `src/events/event-store.ts`
- Create: `src/runs/run-repository.ts`
- Create: `test/events.test.ts`
- Create: `test/runs.test.ts`

**Interfaces:**
- Produces: `EventStore.append/list/subscribe` 和 `RunRepository.create/get/listBySession/listQueued/markRunning/finish/cancelQueued/recoverAfterRestart`。

- [ ] **Step 1: 写事件顺序和 Run 原子状态测试**

```ts
it("并发追加时为单个 Run 生成连续 seq", async () => {
  const store = createEventStore();
  await Promise.all([
    store.append(run.id, "status", { text: "a" }),
    store.append(run.id, "message", { text: "b" })
  ]);
  expect(store.list(run.id, 0).map((event) => event.seq)).toEqual([1, 2]);
});
```

同时验证：创建 Run 会把 Session 设为 `running`；结束 Run 和恢复 Session 为 `idle` 在同一事务；启动恢复将旧 `running` Run 标记为 `failed`，但保留 `queued` Run。

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm vitest run test/events.test.ts test/runs.test.ts`

Expected: FAIL，原因是仓储不存在。

- [ ] **Step 3: 实现 EventStore**

`append()` 在 `BEGIN IMMEDIATE` 事务中读取 `MAX(seq) + 1` 并插入事件；提交成功后才通过 Node `EventEmitter` 通知订阅者。接口固定为：

```ts
append(runId: string, type: EventType, content: unknown): Event;
list(runId: string, afterSeq: number): Event[];
subscribe(runId: string, listener: (event: Event) => void): () => void;
```

- [ ] **Step 4: 实现 RunRepository 和恢复事务**

`recoverAfterRestart()` 执行：

```sql
UPDATE runs
SET status = 'failed', error = 'server_restarted', finished_at = :now
WHERE status = 'running';

UPDATE sessions
SET status = 'idle', updated_at = :now
WHERE id NOT IN (SELECT session_id FROM runs WHERE status = 'queued');
```

`create()` 遇到部分唯一索引冲突时转换为领域错误 `session_busy`。

- [ ] **Step 5: 验证并提交**

Run: `pnpm vitest run test/events.test.ts test/runs.test.ts test/db.test.ts && pnpm typecheck`

Expected: PASS。

```bash
git add src/events src/runs/run-repository.ts test/events.test.ts test/runs.test.ts
git commit -m "feat: persist runs and append-only events"
```

### Task 5: 封装 acpx Runtime、Skills 和 Memory

**Files:**
- Modify: `src/runtime/agent-runtime.ts`
- Create: `src/runtime/skill-projector.ts`
- Create: `src/runtime/acpx-runtime.ts`
- Create: `test/runtime.test.ts`
- Modify: `test/helpers.ts`

**Interfaces:**
- Produces: `AgentRuntime.ensureSession/startTurn/cancel/reset/doctor`、`SkillProjector.prepare(agent, session)` 和 `AcpxAgentRuntime`。

- [ ] **Step 1: 定义内部 Runtime 契约和 Fake Runtime 测试**

业务层只依赖以下内部类型，不导出 acpx 类型：

```ts
export type RuntimeEvent =
  | { type: "message"; stream: "output" | "thought"; text: string }
  | { type: "tool"; content: Record<string, unknown> }
  | { type: "status"; text: string }
  | { type: "error"; code?: string; message: string };

export type RuntimeSessionInput = {
  sessionId: string;
  agentId: string;
  provider: Provider;
  workspacePath: string;
  browserProfilePath: string;
  providerSessionId: string | null;
  memory: string;
};

export type RuntimeSession = { providerSessionId: string | null };
export type RuntimeTurnInput = { sessionId: string; requestId: string; text: string };
export type RuntimeTurnResult =
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "failed"; code?: string; message: string };
export type RuntimeDoctor = { ok: boolean; message: string; details: string[] };

export type RuntimeTurn = {
  events: AsyncIterable<RuntimeEvent>;
  result: Promise<RuntimeTurnResult>;
  cancel(): Promise<void>;
};

export interface AgentRuntime {
  ensureSession(input: RuntimeSessionInput): Promise<RuntimeSession>;
  startTurn(input: RuntimeTurnInput): RuntimeTurn;
  cancel(sessionId: string): Promise<void>;
  reset(input: RuntimeSessionInput): Promise<void>;
  doctor(provider: Provider, agentId: string): Promise<RuntimeDoctor>;
}
```

Fake Runtime 必须能按测试传入的事件序列和终态运行，后续 API 测试不启动真实 CLI。

- [ ] **Step 2: 写 Skill 和 Memory 投影失败测试**

验证：

- Claude Code Skills 复制到 `<workspace>/.claude/skills`。
- Codex Skills 复制到 `<workspace>/.agents/skills`。
- Hermes Skills 复制到 `<DATA_DIR>/agents/<agent-id>/provider-home/hermes/skills`。
- `MEMORY.md` 不存在时返回空文本，存在时作为追加 System Prompt 返回。
- 只同步 Remote Agent Server 管理目录，不删除项目中已有的非托管 Skill。

- [ ] **Step 3: 实现 SkillProjector**

在目标 Skills 目录下使用固定子目录 `_remote-agent-managed`，每次 Run 前只替换该目录：

```text
.claude/skills/_remote-agent-managed/
.agents/skills/_remote-agent-managed/
<HERMES_HOME>/skills/_remote-agent-managed/
```

这样清理时不会覆盖模板项目自身的 Skills。

- [ ] **Step 4: 实现 acpx 0.12.1 适配器**

使用官方嵌入式 API：

```ts
import {
  createAcpRuntime,
  createRuntimeStore,
  type AcpAgentRegistry
} from "acpx/runtime";
```

实现一个很薄的 `AcpAgentRegistry`，输入目标名格式固定为 `remote:<provider>:<agent-id>:<session-id>`。它根据目标名返回下面三条 ACP 命令，并在命令前通过 `env` 传入当前 Session 的 `REMOTE_AGENT_BROWSER_PROFILE`；Hermes 额外传入当前 Agent 的 `HERMES_HOME`：

```text
claude_code -> npx -y @agentclientprotocol/claude-agent-acp@^0.60.0
codex       -> npx -y @agentclientprotocol/codex-acp@^1.1.5
hermes      -> hermes acp
```

命令中的路径必须经过单引号 POSIX shell escaping，Provider、Agent ID 和 Session ID 必须先按枚举/UUID 校验，不能拼接任意用户输入。

创建 Runtime 时固定：

```ts
createAcpRuntime({
  cwd: config.workspaceTemplate,
  sessionStore: createRuntimeStore({ stateDir: join(config.dataDir, "acpx") }),
  agentRegistry,
  permissionMode: "approve-all",
  nonInteractivePermissions: "fail"
});
```

Provider 映射固定为：

```ts
const ACP_AGENT = {
  claude_code: "claude",
  codex: "codex",
  hermes: "hermes"
} as const;
```

`ensureSession()` 使用稳定的 `sessionKey: remote-agent:<session-id>`、`mode: "persistent"`、当前 Workspace `cwd` 和数据库中的 `provider_session_id`。传给 Registry 的 Agent 目标包含 Provider、Agent ID 和 Session ID。首次新建时通过 `sessionOptions.systemPrompt = { append: memoryAndWorkspaceInstructions }` 注入非空 Memory、Workspace 根目录和浏览器 Profile 路径。保存的 `providerSessionId` 取 `handle.agentSessionId ?? handle.backendSessionId ?? null`。当数据库已有 `provider_session_id`，但 acpx 返回了不同的非空 Provider ID 时，立即关闭新 Handle 并返回 `session_resume_failed`，不能静默改成新上下文。

`startTurn().events` 只产生实时事件，最终状态只读取 `startTurn().result`；不得将事件流自然结束当作成功。

`doctor(provider, agentId)` 使用相同 Registry 创建一个短生命周期 acpx Runtime，并设置 `probeAgent` 为该 Provider 的目标；它必须实际探测 Claude、Codex 或 Hermes，不能只检查默认 Codex。`reset(input)` 先确保拿到当前 Handle，再调用 `close({ discardPersistentState: true })`，随后由 SessionManager 清空数据库中的 `provider_session_id`。

- [ ] **Step 5: 验证并提交**

Run: `pnpm vitest run test/runtime.test.ts && pnpm typecheck`

Expected: PASS；测试必须 mock acpx 边界，不下载或登录 Provider。

```bash
git add src/runtime test/runtime.test.ts test/helpers.ts
git commit -m "feat: add acpx runtime adapter"
```

### Task 6: 实现 RunExecutor、调度、取消和 SSE API

**Files:**
- Create: `src/runs/run-executor.ts`
- Create: `src/runs/run-scheduler.ts`
- Create: `src/runs/run-routes.ts`
- Modify: `src/app.ts`
- Modify: `src/main.ts`
- Modify: `src/sessions/session-manager.ts`
- Modify: `src/sessions/session-routes.ts`
- Create: `test/run-executor.test.ts`
- Modify: `test/runs.test.ts`
- Modify: `test/events.test.ts`

**Interfaces:**
- Consumes: AgentRuntime、SkillProjector、RunRepository、EventStore、SessionManager。
- Produces: `RunExecutor.execute/cancel`、`RunScheduler.enqueue/start/stop` 和全部 Run/Event API。

- [ ] **Step 1: 写一轮执行的失败测试**

使用 Fake Runtime 产生 output、thought、tool 和 status，最终返回 completed：

```ts
expect(events.map((event) => event.type)).toEqual([
  "status", "message", "message", "tool", "status"
]);
expect(run.status).toBe("succeeded");
expect(run.result).toBe("最终回复");
expect(session.providerSessionId).toBe("provider-session-1");
expect(session.status).toBe("idle");
```

再覆盖 Runtime `failed`、`cancelled`、事件迭代抛错和取消运行中的 Turn。任何异常路径都必须释放全局并发名额并让 Session 回到 `idle`。

- [ ] **Step 2: 写调度和 API 的失败测试**

覆盖：

- `MAX_CONCURRENT_RUNS=2` 时最多同时执行两个不同 Session。
- 同一 Session 提交第二个未结束 Run 返回 HTTP 409 `session_busy`。
- queued Run 可取消，running Run 调用 Runtime cancel。
- `GET /api/runs/:id/events?afterSeq=2` 只返回后续事件。
- SSE 先回放已有事件，再推送新事件，并在客户端关闭时退订。
- `GET /api/sessions/:id` 返回 Session 及按创建时间升序排列的 `runs`，供页面恢复完整多轮历史。

- [ ] **Step 3: 实现 RunExecutor 和 RunScheduler**

`RunExecutor.execute(runId)` 的固定顺序：原子标记 Run running → 加载记录 → 投影 Skills/Memory → ensure ACP Session → 保存 Provider Session ID → 消费并保存事件 → await canonical result → 原子结束 Run/Session。标记 running 必须发生在任何外部命令或 Agent 操作之前，保证进程中断后不会把已经产生副作用的 Run 当成 queued 重放。

调度器只维护：

```ts
private readonly pending: string[] = [];
private readonly active = new Set<string>();
```

不轮询数据库；新 Run 调用 `enqueue()`，启动时只加载一次已有 queued Run。每个执行 Promise 的 `finally` 都调用 `drain()`。

- [ ] **Step 4: 实现 Run、Cancel、历史和 SSE 路由**

```text
POST /api/sessions/:id/runs
GET  /api/runs/:id
POST /api/runs/:id/cancel
GET  /api/runs/:id/events?afterSeq=0
GET  /api/runs/:id/events/stream?afterSeq=0
```

SSE 每条消息使用：

```text
id: <seq>
event: <type>
data: <event-json>

```

响应头至少包含 `Content-Type: text/event-stream`、`Cache-Control: no-cache` 和 `Connection: keep-alive`。

- [ ] **Step 5: 实现启动恢复并提交**

`src/main.ts` 启动顺序：读取配置 → 打开/迁移 DB → Btrfs check → `recoverAfterRestart()` → 创建依赖 → 启动调度器恢复 queued Run → listen。关闭时先停止接收新请求，再请求 Runtime 取消活动 Turn，最后关闭 Fastify 和 SQLite；未完成 Run 的最终权威状态仍由下次启动的 `recoverAfterRestart()` 修正。

Run: `pnpm vitest run test/run-executor.test.ts test/runs.test.ts test/events.test.ts && pnpm typecheck`

Expected: PASS。

```bash
git add src/runs src/events src/sessions src/app.ts src/main.ts test/run-executor.test.ts test/runs.test.ts test/events.test.ts
git commit -m "feat: execute and stream agent runs"
```

### Task 7: 实现最小 React 管理界面

**Files:**
- Create: `src/web/main.tsx`
- Create: `src/web/app.tsx`
- Create: `src/web/api.ts`
- Create: `src/web/pages/agents-page.tsx`
- Create: `src/web/pages/sessions-page.tsx`
- Create: `src/web/pages/session-page.tsx`
- Create: `src/web/styles.css`
- Create: `test/web.test.tsx`
- Modify: `src/app.ts`
- Modify: `vite.config.ts`

**Interfaces:**
- Consumes: Task 2、3、6 的 HTTP API。
- Produces: `/agents`、`/sessions`、`/sessions/:id` 三个浏览器页面。

- [ ] **Step 1: 写 Token、Agent 和 Session 页面失败测试**

使用 Testing Library 验证：未保存 Token 时显示 Token 输入页；保存后加载 Agent；可创建三种 Provider Agent；doctor 结果显示为“可用”或具体错误；Session 列表可创建 Session 并进入详情。

- [ ] **Step 2: 写 Session 多轮和实时事件失败测试**

Mock `fetchEventSource`，验证：发送消息后立即显示用户输入和 Run 状态；message delta 合并显示；tool 事件显示标题和状态；失败显示错误；运行中显示取消按钮；Run 结束后可继续发送下一条消息。

- [ ] **Step 3: 运行测试并确认失败**

Run: `pnpm vitest run test/web.test.tsx`

Expected: FAIL，原因是 React 应用不存在。

- [ ] **Step 4: 实现三个页面并由 Fastify 提供静态文件**

Token 只保存到浏览器 `sessionStorage`，不写 URL。`api.ts` 为所有 JSON 请求设置 `Authorization: Bearer <token>`，SSE 使用 `@microsoft/fetch-event-source`，确保同样能够发送 Authorization Header。

`api.ts` 固定提供这一层调用，页面组件不直接调用 `fetch`：

```ts
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = sessionStorage.getItem("apiToken");
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`/api${path}`, {
    ...init,
    headers
  });
  if (!response.ok) throw await response.json();
  return response.json() as Promise<T>;
}

export function streamRunEvents(
  runId: string,
  afterSeq: number,
  onEvent: (event: RunEvent) => void,
  signal: AbortSignal
): Promise<void> {
  return fetchEventSource(`/api/runs/${runId}/events/stream?afterSeq=${afterSeq}`, {
    headers: { authorization: `Bearer ${sessionStorage.getItem("apiToken")}` },
    signal,
    onmessage(message) { onEvent(JSON.parse(message.data) as RunEvent); }
  });
}
```

界面只显示业务必要内容：

- Agent：名称、Provider、启用状态、运行环境检查。
- Session 列表：标题、Agent、idle/running、更新时间。
- Session 详情：用户消息、Agent 回复、工具调用、状态、错误、取消和继续输入。

生产环境 Fastify 从 `dist/web` 提供静态文件，非 `/api` 路径回退到 `index.html`。

- [ ] **Step 5: 验证并提交**

Run: `pnpm vitest run test/web.test.tsx && pnpm build && pnpm typecheck`

Expected: PASS，`dist/server/main.js` 和 `dist/web/index.html` 均存在。

```bash
git add src/web src/app.ts vite.config.ts test/web.test.tsx
git commit -m "feat: add remote agent management UI"
```

### Task 8: 部署说明和三 Provider 真实验收

**Files:**
- Create: `scripts/smoke-providers.ts`
- Create: `docs/deployment.md`
- Modify: `.env.example`
- Modify: `package.json`

**Interfaces:**
- Consumes: 完整 HTTP API 和实际 Claude Code、Codex、Hermes ACP 环境。
- Produces: 可重复执行的服务器安装步骤和 `pnpm smoke:providers` 验收命令。

- [ ] **Step 1: 编写 Btrfs 和 Provider 部署文档**

`docs/deployment.md` 必须给出可直接执行的步骤：

```bash
sudo btrfs subvolume create /srv/remote-agent/template/workspace
sudo mkdir -p /srv/remote-agent/sessions /srv/remote-agent/data
sudo chown -R remote-agent:remote-agent /srv/remote-agent
sudo -u remote-agent btrfs subvolume show /srv/remote-agent/template/workspace
```

随后说明管理员如何在模板内放置全部项目、安装依赖和本地配置；如何完成 `claude`、`codex` 登录；如何使用 `HERMES_HOME=/srv/remote-agent/data/agents/<id>/provider-home/hermes hermes model` 配置 Hermes；如何执行 `hermes acp --check` 和浏览器依赖安装。

- [ ] **Step 2: 编写真实 Smoke 脚本**

脚本通过 HTTP API 为每种 Provider：创建 Agent → doctor → 创建 Session → 发送第一轮“回复当前工作目录名称” → 等待 Run 终态 → 发送第二轮“回复上一轮目录名称” → 验证第二轮成功并存在事件。

脚本入口保持线性，不引入测试框架：

```ts
async function main() {
  for (const provider of ["claude_code", "codex", "hermes"] as const) {
    const agent = await ensureAgent(provider);
    await assertDoctor(agent.id);
    const session = await createSession(agent.id, `smoke-${provider}`);
    await assertSucceeded(await run(session.id, "只回复当前工作目录的目录名"));
    await assertSucceeded(await run(session.id, "只回复你上一轮看到的目录名"));
    await assertEventHistory(session.id);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

当任何 Provider 未安装、未登录、无法续接或 Run 失败时退出码必须非零，并打印 Agent、Session、Run ID 和错误。

- [ ] **Step 3: 增加 systemd 示例和启动检查**

文档中的服务使用专用 `remote-agent` 用户，`WorkingDirectory` 指向发布目录，`EnvironmentFile` 指向 `.env`，`ExecStart` 使用 `pnpm start`。启动前要求 `pnpm build`、Btrfs doctor 和三个 Provider 各自 doctor 通过。

- [ ] **Step 4: 运行自动化验证**

Run: `pnpm test && pnpm typecheck && pnpm build`

Expected: 全部 PASS。

- [ ] **Step 5: 在真实 Btrfs Agent 服务器执行验收并提交**

Run: `pnpm smoke:providers`

Expected: Claude Code、Codex、Hermes 各有两个成功 Run；两个不同 Session 并发测试通过；断开并重连 SSE 后没有缺失或重复 `seq`；Btrfs Session 快照内的代码修改不会污染模板和其他 Session。

在至少一个已配置浏览器工具的 Agent Session 中发送“使用有头浏览器打开 example.com 后关闭浏览器”，确认 Run 成功且只在该 Session 的 `browser/` 下产生 Profile 文件。

```bash
git add scripts/smoke-providers.ts docs/deployment.md .env.example package.json pnpm-lock.yaml
git commit -m "docs: add deployment and provider smoke checks"
```

## 最终验收

- [ ] Run: `pnpm test`；Expected: PASS。
- [ ] Run: `pnpm typecheck`；Expected: PASS。
- [ ] Run: `pnpm build`；Expected: PASS。
- [ ] Run: `git diff --check`；Expected: 无输出。
- [ ] 在 Btrfs 服务器运行 `pnpm smoke:providers`；Expected: 三种 Provider 的两轮 Session 均成功。
- [ ] 手动关闭浏览器后重新进入运行中的 Session；Expected: Run 继续，历史 Event 按 `seq` 完整回放。
- [ ] 使用一个真实 Agent 执行有头浏览器任务；Expected: 浏览器 Profile 只写入当前 Session 的 `browser/`。
- [ ] 重启服务模拟在途 Run 中断；Expected: 原 Run 为 `failed/server_restarted`，输入未自动重放，Workspace 和 Session 历史保留。
