# Project Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将多项目代码和依赖准备变成 Remote Agent Server 的“项目环境”能力，Agent 绑定项目环境，Session 从不可变环境版本自动创建 APFS/Btrfs Workspace。

**Architecture:** SQLite 保存项目环境、项目和不可变版本；单进程 `ProjectEnvironmentScheduler` 每三小时检查，`ProjectEnvironmentBuilder` 全局串行构建。构建从当前版本创建写时复制快照并原子发布，Session 只快照已发布版本，不在创建时 clone 或安装依赖。

**Tech Stack:** Node.js 22、TypeScript、Fastify、React/Vite、SQLite/better-sqlite3、Vitest、原生 Git CLI、APFS clone、Btrfs snapshot。

## Global Constraints

- UI 和文档统一使用中文“项目环境”，不再将该能力称为“模板”。
- 项目检查周期默认固定为 3 小时；页面保留“立即检查”。
- 单条准备命令默认最多执行 30 分钟。
- 同一项目环境最多一个 `preparing` 版本；所有项目环境构建全局串行。
- Agent 绑定项目环境；Session 固化 `projectEnvironmentRevisionId`，已有 Session 不升级。
- 项目使用远程默认分支；管理员不配置 branch 或 commit hash。
- 不使用 `config_json`，不引入 Sidekiq、Redis、独立 Worker、Runner daemon、Webhook 或 EnvironmentPool。
- 使用 TDD：每个行为先保存可解释的 RED，再写最小实现并跑 GREEN。
- 保留现有 Agent、Session、Run、Event 数据和已有 Session Workspace。

---

## File Structure

- `src/project-environments/project-environment-store.ts`：SQLite 映射、配置 CRUD、构建 claim、发布和恢复事务。
- `src/project-environments/project-environment-commands.ts`：Git 远程检查、clone/update 和有界准备命令的进程边界。
- `src/project-environments/project-environment-builder.ts`：计算输入指纹、创建版本 Workspace、执行项目更新并原子发布。
- `src/project-environments/project-environment-scheduler.ts`：三小时周期、立即检查、全局串行和关闭。
- `src/project-environments/project-environment-routes.ts`：项目环境和项目 REST API。
- `src/web/pages/project-environments-page.tsx`：项目环境管理页面。
- `src/workspaces/*`：将现有固定来源的 Session 复制扩展为任意已发布版本的环境和 Session 快照。
- `src/agents/*`、`src/sessions/*`：Agent 绑定、doctor 环境状态、Session 版本固化。
- `src/app.ts`、`src/main.ts`：组件装配、恢复和有界关闭。

### Task 1: 数据模型、配置和项目环境 Store

**Files:**
- Modify: `src/config.ts`
- Modify: `src/domain.ts`
- Modify: `src/db.ts`
- Create: `src/project-environments/project-environment-store.ts`
- Modify: `test/db.test.ts`
- Modify: `test/helpers.ts`
- Create: `test/project-environments.test.ts`

**Interfaces:**
- Produces `ProjectEnvironmentStore` with `list()`, `get(id)`, `create({name})`, `update(id,{name})`, repository CRUD, `beginRevision(input)`, `publishRevision(id)`, `failRevision(id,stage,error)`, `recoverPreparing()` and `getCurrentRevision(environmentId)`.
- Produces domain types `ProjectEnvironment`, `EnvironmentRepository`, `ProjectEnvironmentRevision`, `ProjectEnvironmentStatus`.
- Adds config fields `projectEnvironmentsRoot`, `projectEnvironmentCheckIntervalMs`, `projectPrepareTimeoutMs` with defaults `/srv/remote-agent/environments`, `10_800_000`, `1_800_000`.

- [ ] **Step 1: Write schema/config RED tests**

Add assertions that migration creates `project_environments`, `environment_repositories`, and `project_environment_revisions`; `agents` contains `project_environment_id`; `sessions` contains `project_environment_revision_id`; duplicate environment names, duplicate repository names per environment, and a second `preparing` revision are rejected. Assert configuration defaults are exactly three hours and thirty minutes.

- [ ] **Step 2: Run RED**

Run: `pnpm test test/db.test.ts test/project-environments.test.ts`

Expected: FAIL because the tables, fields, types and Store do not exist.

- [ ] **Step 3: Implement the schema and Store**

Use explicit SQLite columns and row mappers. `beginRevision` must run `BEGIN IMMEDIATE`, re-read the ordered repository configuration, compare its configuration fingerprint with the caller snapshot, enforce one `preparing` version, and insert the revision. `publishRevision` must mark the revision ready and update `current_revision_id` in one transaction. `recoverPreparing` marks interrupted revisions failed without selecting them as current.

- [ ] **Step 4: Run GREEN and regression**

Run: `pnpm test test/db.test.ts test/project-environments.test.ts test/events.test.ts test/runs.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/domain.ts src/db.ts src/project-environments/project-environment-store.ts test/db.test.ts test/helpers.ts test/project-environments.test.ts
git commit -m "feat: persist project environments"
```

### Task 2: 通用 APFS/Btrfs 环境快照能力

**Files:**
- Modify: `src/workspaces/workspace-manager.ts`
- Modify: `src/workspaces/apfs-workspace.ts`
- Modify: `src/workspaces/btrfs-workspace.ts`
- Modify: `src/workspaces/create-workspace-manager.ts`
- Modify: `test/workspaces.test.ts`
- Modify: `test/sessions.test.ts`

**Interfaces:**
- Adds `WorkspaceManager.createSession(id: string, sourcePath: string): Promise<Workspace>` and `rollbackSession(id: string): Promise<void>` for the final Session path.
- `WorkspaceManager.createRevision(targetPath: string, sourcePath: string | null): Promise<void>`
- `WorkspaceManager.removeRevision(path: string): Promise<void>`
- `WorkspaceManager.check(): Promise<void>` verifies legacy template, environment root and Session root are on the supported filesystem/volume.
- Keep the existing `create(id)`/`rollback(id)` methods only through this task so current Session code still compiles; Task 5 switches SessionManager to the explicit-source methods and removes the transitional methods before final verification.

- [ ] **Step 1: Write backend RED tests**

For APFS assert `createRevision(target,null)` creates an empty directory, `createRevision(target,source)` invokes `cp -cR source target`, and `createSession` clones the supplied revision rather than constructor configuration. For Btrfs assert empty revision uses `btrfs subvolume create`, copied revision uses `btrfs subvolume snapshot`, and removal uses `btrfs subvolume delete`. Retain rollback compensation assertions.

- [ ] **Step 2: Run RED**

Run: `pnpm test test/workspaces.test.ts test/sessions.test.ts`

Expected: FAIL because the generic revision and explicit source APIs are missing.

- [ ] **Step 3: Implement minimal filesystem operations**

Keep all path construction outside shell strings. APFS uses argument arrays for `cp -cR` and recursive removal. Btrfs uses `subvolume create/snapshot/delete`. A failed operation removes only the exact newly-created target. Do not add a full-copy fallback.

- [ ] **Step 4: Run GREEN**

Run: `pnpm test test/workspaces.test.ts test/sessions.test.ts`

Expected: selected tests PASS on injected filesystem/command boundaries.

- [ ] **Step 5: Commit**

```bash
git add src/workspaces test/workspaces.test.ts test/sessions.test.ts
git commit -m "refactor: support versioned workspace sources"
```

### Task 3: Git 命令边界和原子项目环境构建

**Files:**
- Create: `src/project-environments/project-environment-commands.ts`
- Create: `src/project-environments/project-environment-builder.ts`
- Modify: `src/project-environments/project-environment-store.ts`
- Modify: `test/project-environments.test.ts`

**Interfaces:**
- `ProjectEnvironmentCommands.inspect(repository, signal): Promise<{ defaultBranch: string; commit: string }>`
- `clone(repository, destination, signal): Promise<void>`
- `update(repository, destination, defaultBranch, signal): Promise<void>`
- `prepare(repository, destination, timeoutMs, signal): Promise<void>`
- `ProjectEnvironmentBuilder.checkAndBuild(environmentId): Promise<{ outcome: "unchanged" | "published"; revisionId?: string }>`
- `ProjectEnvironmentBuilder.stop(): Promise<void>` terminates active Git/prepare child processes within a bounded shutdown.

- [ ] **Step 1: Write builder RED tests**

Cover two-project first build, no-change check, one changed project executing only its preparation command, repository add/remove, prepare-command-only change, Git failure, command failure, timeout, stale configuration during remote inspection, atomic current revision switch, failed Workspace cleanup, and retention of only the current/previous physical revision Workspace.

- [ ] **Step 2: Run RED**

Run: `pnpm test test/project-environments.test.ts`

Expected: FAIL because command and builder modules do not exist.

- [ ] **Step 3: Implement command execution and builder**

Use `execFile`/`spawn` argument arrays for Git. Parse `git ls-remote --symref <url> HEAD` to obtain default branch and commit. Build `inputFingerprint` from ordered `{name,gitUrl,prepareCommand,defaultBranch,commit}` values using SHA-256. Execute administrator preparation commands through `/bin/sh -lc` with fixed `cwd`, timeout and abort signal. Truncate persisted output and never serialize process environment values.

- [ ] **Step 4: Implement atomic publish and cleanup**

Create revision path `<projectEnvironmentsRoot>/<environmentId>/revisions/<revisionId>/workspace`. Publish only after all project operations succeed. On error call `failRevision` and remove the exact failed revision Workspace. After publish retain current and previous physical Workspaces and set older revision `workspace_path` to null after deletion.

- [ ] **Step 5: Run GREEN**

Run: `pnpm test test/project-environments.test.ts test/workspaces.test.ts`

Expected: all selected tests PASS with no unhandled rejection or leaked timer.

- [ ] **Step 6: Commit**

```bash
git add src/project-environments src/workspaces test/project-environments.test.ts test/workspaces.test.ts
git commit -m "feat: build immutable project environments"
```

### Task 4: 三小时调度、REST API、恢复和关闭

**Files:**
- Create: `src/project-environments/project-environment-scheduler.ts`
- Create: `src/project-environments/project-environment-routes.ts`
- Modify: `src/app.ts`
- Modify: `src/main.ts`
- Modify: `test/project-environments.test.ts`
- Modify: `test/runs.test.ts`

**Interfaces:**
- `ProjectEnvironmentScheduler.start(): void`
- `requestCheck(environmentId: string): Promise<void>` queues one global serial check and coalesces duplicate environment IDs.
- `stop(): Promise<void>` rejects new work, clears the three-hour timer, drains queued requests and aborts active builder work within the existing application shutdown.
- REST paths exactly match `/api/project-environments`, nested `/repositories`, and `/:id/check` from the design.

- [ ] **Step 1: Write scheduler/API RED tests**

Use fake timers to assert one three-hour timer, all environments checked at the interval, duplicate immediate checks coalesced, global serialization, timer cleanup, and no new work after stop. API tests cover auth, strict request validation, safe unique repository names, busy configuration rejection, repository changes automatically requesting a build, explicit check, list/detail output, and useful 404/409 errors.

- [ ] **Step 2: Run RED**

Run: `pnpm test test/project-environments.test.ts`

Expected: FAIL because routes and scheduler do not exist.

- [ ] **Step 3: Implement and wire lifecycle**

Register routes under the existing authenticated `/api` scope. Start the environment scheduler once after recovery. During `preClose`, stop Run scheduling and project-environment scheduling, then shut down Runtime; preserve all failures until Fastify has closed and propagate one error or an `AggregateError` from `onClose`.

- [ ] **Step 4: Implement startup migration/recovery**

On startup create/import “默认项目环境” only when no project environment exists, import current `WORKSPACE_TEMPLATE` as its first ready revision, bind existing Agents, preserve existing Session paths, and import direct child Git repositories using directory name plus `remote.origin.url` with blank preparation commands. Mark interrupted preparing revisions failed before accepting HTTP traffic.

- [ ] **Step 5: Run GREEN and shutdown regression**

Run: `pnpm test test/project-environments.test.ts test/runs.test.ts`

Expected: scheduler/API/recovery tests and existing shutdown tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/project-environments src/app.ts src/main.ts test/project-environments.test.ts test/runs.test.ts
git commit -m "feat: manage project environment updates"
```

### Task 5: Agent 绑定和 Session 版本固化

**Files:**
- Modify: `src/agents/agent-manager.ts`
- Modify: `src/agents/agent-routes.ts`
- Modify: `src/sessions/session-manager.ts`
- Modify: `src/domain.ts`
- Modify: `test/agents.test.ts`
- Modify: `test/sessions.test.ts`
- Modify: `test/helpers.ts`

**Interfaces:**
- Agent create input requires `projectEnvironmentId`; update accepts `projectEnvironmentId`.
- Agent response includes `projectEnvironmentId`.
- Doctor response becomes `{ provider: RuntimeDoctor; projectEnvironment: { ok: boolean; message: string; revisionId: string | null } }`.
- Session response includes `projectEnvironmentRevisionId`.
- `SessionManager` resolves the Agent environment current revision and calls `workspaceManager.createSession(id, revision.workspacePath)`.

- [ ] **Step 1: Write Agent/Session RED API tests**

Cover missing/unknown/unready project environment, successful Agent create/update binding, doctor independently reporting Provider and environment status, Session snapshot from the bound current revision, revision ID persistence, current version switch affecting only new Sessions, and database failure rolling back only the new Session Workspace.

- [ ] **Step 2: Run RED**

Run: `pnpm test test/agents.test.ts test/sessions.test.ts`

Expected: FAIL because Agent and Session do not expose or enforce environment binding.

- [ ] **Step 3: Implement minimal binding**

Validate the environment in `AgentManager`, retain the existing Provider directory side effects, and update explicit SQL columns. Resolve the current revision immediately before Session Workspace creation; call `createSession(id, revision.workspacePath)`, then persist Session and revision ID together. Replace rollback with `rollbackSession` and remove the transitional `create(id)`/`rollback(id)` interface and implementations. Existing Session runtime/reset behavior continues to use its own stored Workspace.

- [ ] **Step 4: Run GREEN and execution regression**

Run: `pnpm test test/agents.test.ts test/sessions.test.ts test/run-executor.test.ts test/runtime.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents src/sessions src/domain.ts test/agents.test.ts test/sessions.test.ts test/helpers.ts
git commit -m "feat: bind agents to project environments"
```

### Task 6: 项目环境管理页面

**Files:**
- Modify: `src/web/api.ts`
- Modify: `src/web/app.tsx`
- Create: `src/web/pages/project-environments-page.tsx`
- Modify: `src/web/pages/agents-page.tsx`
- Modify: `src/web/pages/sessions-page.tsx`
- Modify: `src/web/styles.css`
- Modify: `test/web.test.tsx`

**Interfaces:**
- New route `/project-environments` and main navigation item “项目环境”.
- UI types mirror API fields without `configJson`.
- Environment page creates environments, manages project rows, requests immediate check, and polls detail only while a revision is preparing.

- [ ] **Step 1: Write UI RED tests**

Cover navigation, empty state, environment creation, adding two projects with optional commands, automatic build status, explicit immediate check, failed build details, edit/remove disabled while preparing, Agent form requiring a ready environment, combined doctor display, and Session form still selecting only Agent.

- [ ] **Step 2: Run RED**

Run: `pnpm test test/web.test.tsx`

Expected: FAIL because the route, types, page and Agent environment selector do not exist.

- [ ] **Step 3: Implement the focused UI**

Preserve the current industrial/editorial visual language. Add one navigation item and one page; use semantic forms, explicit labels, status badges and inline errors. Do not add a dashboard, workflow canvas, modal framework, data-grid dependency or live build SSE.

- [ ] **Step 4: Run GREEN and accessibility-focused assertions**

Run: `pnpm test test/web.test.tsx`

Expected: all web tests PASS; controls remain discoverable by role and label.

- [ ] **Step 5: Commit**

```bash
git add src/web test/web.test.tsx
git commit -m "feat: add project environment management UI"
```

### Task 7: 部署配置、文档和完整验证

**Files:**
- Modify: `.env.example`
- Modify: `docs/design.md`
- Modify: `docs/deployment.md`
- Modify: `scripts/smoke-providers.ts`
- Modify: `test/smoke-providers.test.ts`

**Interfaces:**
- `.env.example` documents `PROJECT_ENVIRONMENTS_ROOT` while keeping `WORKSPACE_TEMPLATE` only as legacy import input.
- Provider smoke creates or selects a ready project environment before creating an Agent and Session.

- [ ] **Step 1: Write smoke RED tests**

Assert prepare mode discovers a ready project environment, Agent creation sends `projectEnvironmentId`, and a missing ready environment fails before Session creation with a clear message.

- [ ] **Step 2: Run RED**

Run: `pnpm test test/smoke-providers.test.ts`

Expected: FAIL because smoke requests do not include project environment binding.

- [ ] **Step 3: Update smoke and Chinese documentation**

Document the project-environment root on APFS/Btrfs, the three-hour check, trusted preparation commands, server Git/SSH credentials, legacy import, failure rollback and the exact page workflow. Remove statements that administrators must manually maintain a global Workspace template.

- [ ] **Step 4: Run complete verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
node --check dist/server/main.js
git diff --check
```

Expected: every command exits 0; Vitest reports no failed tests, TypeScript reports no errors, and both server/web builds are present.

- [ ] **Step 5: Commit**

```bash
git add .env.example docs/design.md docs/deployment.md scripts/smoke-providers.ts test/smoke-providers.test.ts
git commit -m "docs: deploy managed project environments"
```

### Task 8: 真实本机验收

**Files:**
- No source changes expected.

- [ ] **Step 1: Start with persistent macOS APFS paths**

Start the service with `PROJECT_ENVIRONMENTS_ROOT`, `SESSIONS_ROOT`, `DATA_DIR`, and `WORKSPACE_TEMPLATE` on the same APFS volume and a non-production local token.

- [ ] **Step 2: Exercise the complete browser flow**

Create one project environment with two accessible repositories, wait for ready, bind a Codex Agent, create a Session, and ask it to list both project directories. Verify the UI shows build state, Provider/environment doctor results, Run events and final output.

- [ ] **Step 3: Prove version isolation**

Advance one local test remote, request immediate check, create a second Session and verify only the second Session sees the new commit. Modify files in both Sessions and verify neither change appears in the project environment or the other Session.

- [ ] **Step 4: Prove failure rollback**

Temporarily configure a preparation command that exits nonzero, trigger a check, and verify the current revision ID does not change and new Sessions still use the previous ready version. Restore the valid command through the page and verify the next build succeeds.

- [ ] **Step 5: Record evidence**

Report the environment, revision, Agent, Session and Run IDs plus exact automated verification totals. Do not claim Linux Btrfs or real Claude/Hermes acceptance unless run on those hosts/providers.
