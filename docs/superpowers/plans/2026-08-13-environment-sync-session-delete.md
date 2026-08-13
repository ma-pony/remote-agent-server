# 项目环境同步与 Session 删除实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐项目环境整体同步的状态、路径和操作界面，并安全永久删除空闲 Session 及其全部资源。

**Architecture:** 继续使用现有内存 `ProjectEnvironmentScheduler`，由它提供同步状态和下次执行时间，路由只负责将状态合并进环境详情。Session 删除由 `SessionManager` 原子 claim 后依次清理 Runtime、Workspace 和 SQLite 历史，确保新 Run 无法与删除并发进入。

**Tech Stack:** TypeScript、Fastify 5、SQLite/better-sqlite3、React 19、React Router、shadcn/Radix UI、Vitest、APFS/Btrfs。

## Global Constraints

- 项目环境同步粒度固定为整个环境，不提供单项目同步。
- 自动同步间隔继续读取 `PROJECT_ENVIRONMENT_CHECK_INTERVAL_HOURS`，默认 3 小时。
- 不新增数据库表、任务队列、软删除或同步历史系统。
- 不保留旧 `POST /project-environments/:id/check` 接口，只提供 `/sync`。
- 只有空闲且无 active Run 的 Session 可以永久删除。
- 删除必须清理 Provider Session、Workspace、浏览器 Profile、Runs 和 Events。

---

## 文件结构

- `src/project-environments/project-environment-scheduler.ts`：同步队列、运行状态和下次自动同步时间。
- `src/project-environments/project-environment-routes.ts`：同步接口与带状态/路径的环境响应。
- `src/web/api.ts`：同步状态与路径的前端类型。
- `src/web/pages/project-environment-pages.tsx`：同步概览、轮询、环境和项目路径展示。
- `src/workspaces/workspace-manager.ts`、`apfs-workspace.ts`、`btrfs-workspace.ts`：幂等删除 Session 文件系统资源。
- `src/sessions/session-manager.ts`：删除 claim、Runtime/Workspace 清理与历史事务删除。
- `src/sessions/session-routes.ts`：`DELETE /sessions/:id`。
- `src/web/pages/session-pages.tsx`、`session-page.tsx`：列表和详情删除确认。
- `test/project-environments.test.ts`、`test/web-project-environments.test.tsx`：同步后端和页面回归。
- `test/workspaces.test.ts`、`test/sessions.test.ts`、`test/web-sessions-navigation.test.tsx`、`test/web.test.tsx`：删除生命周期和页面回归。

### Task 1: 项目环境同步状态与路径 API

**Files:**
- Modify: `src/project-environments/project-environment-scheduler.ts`
- Modify: `src/project-environments/project-environment-routes.ts`
- Modify: `test/project-environments.test.ts`

**Interfaces:**
- Produces: `ProjectEnvironmentSyncState = { status: "idle" | "queued" | "running"; automatic: true; intervalMs: number; nextScheduledAt: string }`
- Produces: `ProjectEnvironmentCheckScheduler.getState(environmentId): ProjectEnvironmentSyncState`
- Produces: `POST /api/project-environments/:id/sync -> 202 { accepted: true }`

- [ ] **Step 1: 写 Scheduler 状态失败测试**

  用 deferred builder 构造一个 running 环境和一个 queued 环境，断言 `getState` 分别为 `running`、`queued`，完成后恢复 `idle`；使用 fake timers 断言 `nextScheduledAt` 等于启动时间加 `intervalMs`，自动轮次执行后再推进一个间隔。

- [ ] **Step 2: 运行测试确认 RED**

  Run: `pnpm test test/project-environments.test.ts`

  Expected: FAIL，接口没有 `getState` 且 `/sync` 尚不存在。

- [ ] **Step 3: 最小实现 Scheduler 状态**

  在 Scheduler 保存 `runningEnvironmentId` 与 `nextScheduledAtMs`。`start()` 设置下一次时间；interval callback 先推进下一次时间再调用 `runScheduledCheck()`；`drain()` 在调用 builder 前后设置/清除 running ID；`getState()` 根据 running ID 与 pending/queue 返回状态。

- [ ] **Step 4: 最小实现同步 API 与路径投影**

  路由用一个 `presentEnvironment(detail)` 将 `sync`、`workspacePath = currentRevision?.workspacePath ?? null` 和每个项目的 `workspacePath = currentWorkspace === null ? null : join(currentWorkspace, repository.name)` 合并进列表/详情响应；将 `/check` 替换为 `/sync`。

- [ ] **Step 5: 运行聚焦测试并提交**

  Run: `pnpm test test/project-environments.test.ts`

  Commit: `feat: expose project environment sync state`

### Task 2: 项目环境同步与路径页面

**Files:**
- Modify: `src/web/api.ts`
- Modify: `src/web/pages/project-environment-pages.tsx`
- Modify: `test/web-project-environments.test.tsx`

**Interfaces:**
- Consumes: Task 1 环境响应中的 `sync`、环境 `workspacePath`、项目 `workspacePath`。

- [ ] **Step 1: 写页面失败测试**

  构造带 `sync: { status: "idle", automatic: true, intervalMs: 10800000, nextScheduledAt }` 和 Workspace 路径的环境详情，断言概览显示“立即同步”“每 3 小时”“下次自动同步”和完整环境路径；项目页显示项目路径与“随项目环境整体同步”。点击同步断言请求 `POST /api/project-environments/:id/sync` 且没有旧 `/check` 请求。另用 queued fixture 断言按钮禁用。

- [ ] **Step 2: 运行测试确认 RED**

  Run: `pnpm test test/web-project-environments.test.tsx`

- [ ] **Step 3: 实现类型与页面**

  更新 API 类型。概览由四张信息卡展示项目数、当前版本、最近同步、下次同步；独立卡片展示路径和同步操作。`sync.status !== "idle"` 时每 2 秒 reload；同步按钮只触发 `/sync` 后 reload。项目卡展示实际路径，不增加单项目按钮。

- [ ] **Step 4: 运行聚焦测试并提交**

  Run: `pnpm test test/web-project-environments.test.tsx test/project-environments.test.ts`

  Commit: `feat: manage project environment synchronization`

### Task 3: Session 永久删除生命周期与 API

**Files:**
- Modify: `src/workspaces/workspace-manager.ts`
- Modify: `src/workspaces/apfs-workspace.ts`
- Modify: `src/workspaces/btrfs-workspace.ts`
- Modify: `src/sessions/session-manager.ts`
- Modify: `src/sessions/session-routes.ts`
- Modify: `test/workspaces.test.ts`
- Modify: `test/sessions.test.ts`
- Modify: `test/helpers.ts` and local `WorkspaceManager` fakes where required by typecheck

**Interfaces:**
- Produces: `WorkspaceManager.deleteSession(id: string): Promise<void>`，替代 `rollbackSession`。
- Produces: `SessionManager.delete(id: string): Promise<void>`。
- Produces: `DELETE /api/sessions/:id -> 204`。
- Produces: `SessionManagerError` 新增 `session_delete_failed`。

- [ ] **Step 1: 写 Workspace 删除失败测试**

  APFS 断言删除精确的 `<sessionsRoot>/<id>`；Btrfs 断言先执行 `btrfs subvolume delete <session>/workspace`，再删除 Session 根目录。重复清理不存在 APFS 目录成功；Btrfs 命令失败向上抛出。

- [ ] **Step 2: 写 Session API 删除失败测试**

  创建带 Run/Event 的空闲 Session，Runtime reset spy 与真实临时 Workspace fake 成功后，DELETE 返回 204，三张表记录和目录均不存在。补充未鉴权 401、未知 404、running/queued 409、Runtime reset 失败后 Session 保持 idle/历史与目录保留、Workspace 删除失败后 provider ID 清空且历史保留。

- [ ] **Step 3: 运行测试确认 RED**

  Run: `pnpm test test/workspaces.test.ts test/sessions.test.ts`

- [ ] **Step 4: 实现幂等 Workspace 删除**

  将 `rollbackSession` 全部改为 `deleteSession`；创建落库失败继续调用该接口。APFS 递归删除 Session 根目录；Btrfs 对 Workspace subvolume 执行 delete 后递归删除根目录。

- [ ] **Step 5: 实现 Session 删除协调**

  `claimForDelete` 使用 `BEGIN IMMEDIATE` 执行 `idle -> running`，并用 `NOT EXISTS` 排除 active Run。构造现有 `RuntimeSessionInput` 调 `runtime.reset`。Runtime 失败释放 claim；Workspace 失败以事务清 provider ID 并释放 claim；成功后事务执行：

  ```sql
  DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?);
  DELETE FROM runs WHERE session_id = ?;
  DELETE FROM sessions WHERE id = ? AND status = 'running';
  ```

  最后一句 changes 必须为 1，否则 rollback 并抛 `session_delete_failed`。

- [ ] **Step 6: 实现 DELETE 路由并运行测试**

  `session_busy` 返回 409；`session_delete_failed` 返回 500；成功返回 204。

  Run: `pnpm test test/workspaces.test.ts test/sessions.test.ts test/runs.test.ts`

- [ ] **Step 7: 提交**

  Commit: `feat: safely delete sessions`

### Task 4: Session 删除交互与最终验证

**Files:**
- Modify: `src/web/pages/session-pages.tsx`
- Modify: `src/web/pages/session-page.tsx`
- Modify: `test/web-sessions-navigation.test.tsx`
- Modify: `test/web.test.tsx`

**Interfaces:**
- Consumes: Task 3 `DELETE /api/sessions/:id`。

- [ ] **Step 1: 写前端删除失败测试**

  列表测试点击独立删除按钮后先出现不可恢复确认，确认后发送 DELETE 并原地移除；点击删除不能触发行导航。running 项按钮禁用。详情测试确认删除后发送 DELETE 并导航到 `/sessions`；active Run 时删除按钮禁用。

- [ ] **Step 2: 运行测试确认 RED**

  Run: `pnpm test test/web-sessions-navigation.test.tsx test/web.test.tsx`

- [ ] **Step 3: 实现共享删除确认组件**

  在 `session-pages.tsx` 导出小型 `SessionDeleteDialog`，接收 `session`、`onDeleted` 和错误回调。列表项改为容器内独立标题链接和操作区域，避免嵌套交互元素；详情页复用组件并在成功后 navigate。

- [ ] **Step 4: 运行聚焦与全量验证**

  Run:

  ```bash
  pnpm test test/web-sessions-navigation.test.tsx test/web.test.tsx
  pnpm test
  pnpm typecheck
  pnpm build
  node --check dist/server/main.js
  git diff --check
  ```

- [ ] **Step 5: 提交、重启与 HTTP 验证**

  Commit: `feat: add session deletion controls`

  使用当前 `.env` 等价配置重启 `127.0.0.1:3100`。只读验证环境详情含同步状态/路径；对不存在 Session ID 发 DELETE，确认返回业务 404 而非请求解析错误。不得删除用户现有 Session。
