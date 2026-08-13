# Remote Agent Server 管理台 UX 重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Agent、项目环境和 Session 从“单页堆叠”重构为统一的列表、新建、详情页面，并使用对 Coding Agent 友好的 shadcn/ui 组件体系。

**Architecture:** SQLite 数据和业务语义不变，Fastify 补充缺失的 Agent 单资源读取接口。React SPA 使用 React Router 声明式路由，shadcn/ui 提供项目内可编辑组件，页面按资源拆分为小型 feature 文件；列表和详情各自请求 API，不增加全局状态仓库。

**Tech Stack:** React 19、TypeScript 6、Vite 8、React Router 8、shadcn/ui（Radix）、Tailwind CSS 4、Vitest、Testing Library。

## Global Constraints

- SQLite 数据、Provider 和 Workspace 业务语义不变；只新增详情页需要的只读 API。
- 直接替换旧页面，不保留旧结构兼容层。
- 只安装当前页面实际使用的 shadcn 组件。
- 桌面端使用固定侧栏，移动端折叠；每个页面最多一个主要动作。
- 列表页不展开编辑表单、检查详情、仓库表单或 Skill 列表。
- 不新增 Dashboard、统计、全局搜索、权限系统或前端全局状态库。

---

### Task 1: shadcn 基础设施、路由和应用壳层

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `vite.config.ts`
- Modify: `tsconfig.web.json`
- Modify: `src/web/main.tsx`
- Modify: `src/web/app.tsx`
- Modify: `src/web/styles.css`
- Create: `components.json`
- Create: `src/web/lib/utils.ts`
- Create: `src/web/components/ui/*.tsx`（仅 CLI 安装的组件）
- Create: `src/web/components/app-shell.tsx`
- Create: `src/web/components/page-header.tsx`
- Create: `src/web/components/load-state.tsx`
- Test: `test/web-navigation.test.tsx`

**Interfaces:**
- Produces: `AppShellLayout`, `PageHeader`, `LoadError`, `EmptyState`，以及可供后续页面使用的 shadcn 组件。
- Produces: `/agents`、`/project-environments`、`/sessions` 和深层路由的 React Router 骨架。

- [ ] **Step 1: 写失败路由测试**

```tsx
it("使用侧栏在三个资源列表间导航，并支持深层 URL", async () => {
  sessionStorage.setItem("apiToken", "secret-token");
  window.history.replaceState({}, "", "/agents");
  render(<App />);
  expect(await screen.findByRole("navigation", { name: "主导航" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "项目环境" }));
  expect(window.location.pathname).toBe("/project-environments");
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm test -- test/web-navigation.test.tsx`
Expected: FAIL，因为当前导航仍是按钮和手写 `pushState`，不存在链接路由壳层。

- [ ] **Step 3: 安装并初始化最小 UI 依赖**

```bash
pnpm add react-router tailwindcss @tailwindcss/vite lucide-react class-variance-authority clsx tailwind-merge
pnpm dlx shadcn@latest init
pnpm dlx shadcn@latest add sidebar button tabs card badge input label native-select dialog alert-dialog table skeleton empty collapsible textarea tooltip alert separator
```

初始化选择 Vite、Tailwind CSS 4、Radix、CSS variables，并设置别名 `@/* -> ./src/web/*`。将官方 shadcn Skill 安装到项目作用域，提交它生成的项目文件；不写用户级 MCP 凭证。

- [ ] **Step 4: 实现声明式路由和响应式侧栏**

```tsx
<BrowserRouter>
  <Routes>
    <Route element={<AppShellLayout onDisconnect={disconnect} />}>
      <Route path="/agents/*" element={<AgentRoutes />} />
      <Route path="/project-environments/*" element={<ProjectEnvironmentRoutes />} />
      <Route path="/sessions/*" element={<SessionRoutes />} />
      <Route path="*" element={<Navigate to="/agents" replace />} />
    </Route>
  </Routes>
</BrowserRouter>
```

侧栏底部显示“已连接”和“断开”；移动端通过 `SidebarTrigger` 打开。TokenGate 保持凭证只进入 `sessionStorage`。

- [ ] **Step 5: 验证 GREEN 并提交**

Run: `pnpm test -- test/web-navigation.test.tsx && pnpm typecheck`
Expected: PASS。

```bash
git add package.json pnpm-lock.yaml vite.config.ts tsconfig.web.json components.json src/web test/web-navigation.test.tsx
git commit -m "feat: add routed management shell"
```

---

### Task 2: Agent 列表、新建和详情页面

**Files:**
- Modify: `src/agents/agent-routes.ts`
- Test: `test/agents.test.ts`
- Delete: `src/web/pages/agents-page.tsx`
- Create: `src/web/features/agents/agent-routes.tsx`
- Create: `src/web/features/agents/agents-list-page.tsx`
- Create: `src/web/features/agents/agent-create-page.tsx`
- Create: `src/web/features/agents/agent-detail-layout.tsx`
- Create: `src/web/features/agents/agent-overview-page.tsx`
- Create: `src/web/features/agents/agent-skills-page.tsx`
- Create: `src/web/features/agents/agent-settings-page.tsx`
- Create: `src/web/features/agents/agent-data.ts`
- Test: `test/web-agents.test.tsx`

**Interfaces:**
- Consumes: `PageHeader`, `LoadError`, shadcn Card/Table/Tabs/Dialog/AlertDialog 表单组件。
- Produces: Agent 路由 `/agents`、`/agents/new`、`/agents/:id`、`/agents/:id/skills`、`/agents/:id/settings`。
- `GET /api/agents/:id` 返回单个 Agent；不存在时复用 `{ error: { code: "not_found", message: "Agent not found" } }` 和 HTTP 404。
- `loadAgent(id, signal): Promise<Agent>` 调用 `GET /agents/:id`，不读取全量列表。

- [ ] **Step 1: 写失败 API 测试覆盖单 Agent 读取**

```ts
it("GET /api/agents/:id 返回单个 Agent，不存在时返回 404", async () => {
  const found = await app.inject({ method: "GET", url: `/api/agents/${agent.id}`, headers: auth });
  expect(found.statusCode).toBe(200);
  expect(found.json()).toMatchObject({ id: agent.id, name: agent.name });
  const missing = await app.inject({ method: "GET", url: "/api/agents/00000000-0000-4000-8000-000000000000", headers: auth });
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toEqual({ error: { code: "not_found", message: "Agent not found" } });
});
```

- [ ] **Step 2: 运行 API 测试并确认 RED**

Run: `pnpm test -- test/agents.test.ts`
Expected: FAIL，因为 `GET /api/agents/:id` 尚未注册。

- [ ] **Step 3: 实现最小单 Agent 路由并验证 GREEN**

```ts
app.get<{ Params: { id: string } }>("/agents/:id", (request, reply) => {
  const agent = agentManager.get(request.params.id);
  return agent === undefined ? notFound(reply) : agent;
});
```

Run: `pnpm test -- test/agents.test.ts`
Expected: PASS。

- [ ] **Step 4: 写失败前端测试覆盖页面分离**

```tsx
it("Agent 列表不展开操作，详情页分别管理概览、Skills 和设置", async () => {
  renderAt("/agents");
  expect(await screen.findByText("主力 Codex")).toBeInTheDocument();
  expect(screen.queryByLabelText("搜索 Skills")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "主力 Codex" }));
  expect(await screen.findByRole("tab", { name: "Skills" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
  expect(window.location.pathname).toBe("/agents/agent-1/skills");
  expect(await screen.findByLabelText("搜索 Skills")).toBeInTheDocument();
});
```

同时覆盖 `/agents/new` 创建后跳转详情、概览检查与启停、设置保存、无 Session 删除成功、有 Session 删除显示停用建议、ZIP 上传。

- [ ] **Step 5: 运行前端测试并确认 RED**

Run: `pnpm test -- test/web-agents.test.tsx`
Expected: FAIL，因为 Agent 功能仍全部位于 `/agents`。

- [ ] **Step 6: 实现 Agent feature 页面**

列表只渲染名称、Provider、项目环境名称、状态和进入详情链接。详情布局负责 Agent 页头与三个 URL Tabs；各子页面独立请求并只处理自己的操作。Skills 页面保留 10 MB ZIP 前端限制和现有 API；设置页 Provider 使用只读字段，删除使用 AlertDialog。

- [ ] **Step 7: 验证 GREEN 并提交**

Run: `pnpm test -- test/web-agents.test.tsx test/skills.test.ts test/agents.test.ts && pnpm typecheck`
Expected: PASS。

```bash
git add src/agents/agent-routes.ts src/web/features/agents src/web/pages/agents-page.tsx test/agents.test.ts test/web-agents.test.tsx
git commit -m "feat: split agent management pages"
```

---

### Task 3: 项目环境列表、新建和详情页面

**Files:**
- Delete: `src/web/pages/project-environments-page.tsx`
- Create: `src/web/features/project-environments/project-environment-routes.tsx`
- Create: `src/web/features/project-environments/project-environments-list-page.tsx`
- Create: `src/web/features/project-environments/project-environment-create-page.tsx`
- Create: `src/web/features/project-environments/project-environment-detail-layout.tsx`
- Create: `src/web/features/project-environments/project-environment-overview-page.tsx`
- Create: `src/web/features/project-environments/project-environment-repositories-page.tsx`
- Create: `src/web/features/project-environments/repository-dialog.tsx`
- Create: `src/web/features/project-environments/project-environment-data.ts`
- Test: `test/web-project-environments.test.tsx`

**Interfaces:**
- Consumes: Task 1 壳层和通用状态组件。
- Produces: `/project-environments`、`/project-environments/new`、`/project-environments/:id`、`/project-environments/:id/repositories`。
- `useProjectEnvironment(id)` 请求现有 `GET /project-environments/:id`；轮询周期准备中 2 秒，否则 5 秒。

- [ ] **Step 1: 写失败测试覆盖环境页面分离和单一仓库弹窗**

```tsx
it("项目环境列表不渲染仓库输入框，项目页一次只编辑一个仓库", async () => {
  renderAt("/project-environments");
  expect(await screen.findByText("Grab Manager 研发环境")).toBeInTheDocument();
  expect(screen.queryByLabelText("Git 地址")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "Grab Manager 研发环境" }));
  fireEvent.click(screen.getByRole("tab", { name: "项目" }));
  fireEvent.click(screen.getByRole("button", { name: "添加项目" }));
  expect(screen.getAllByLabelText("Git 地址")).toHaveLength(1);
});
```

同时覆盖创建环境、立即检查、失败原因、编辑/移除仓库以及准备中禁用。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm test -- test/web-project-environments.test.tsx`
Expected: FAIL，因为当前列表同时渲染每个仓库和新建仓库表单。

- [ ] **Step 3: 实现环境 feature 页面**

列表显示环境名称、仓库数量、版本和状态。概览显示检查动作与失败详情。项目页使用 Table/Card 显示仓库，新增和编辑共用一个 `RepositoryDialog`；删除使用 AlertDialog。准备中时禁用所有变更并显示说明。

- [ ] **Step 4: 验证 GREEN 并提交**

Run: `pnpm test -- test/web-project-environments.test.tsx test/project-environments.test.ts test/workspaces.test.ts && pnpm typecheck`
Expected: PASS。

```bash
git add src/web/features/project-environments src/web/pages/project-environments-page.tsx test/web-project-environments.test.tsx
git commit -m "feat: split project environment pages"
```

---

### Task 4: Session 列表、新建和对话运行轨迹

**Files:**
- Delete: `src/web/pages/sessions-page.tsx`
- Move/Modify: `src/web/pages/session-page.tsx` -> `src/web/features/sessions/session-page.tsx`
- Create: `src/web/features/sessions/session-routes.tsx`
- Create: `src/web/features/sessions/sessions-list-page.tsx`
- Create: `src/web/features/sessions/session-create-page.tsx`
- Create: `src/web/features/sessions/run-block.tsx`
- Test: `test/web-sessions.test.tsx`

**Interfaces:**
- Produces: `/sessions`、`/sessions/new`、`/sessions/:id`。
- `RunBlock` 默认显示输入、输出和终态；非消息事件统一放入 Collapsible“执行轨迹（N）”。
- 保留现有 SSE 重连、5 秒 canonical poll、取消竞态和 Abort 清理语义。

- [ ] **Step 1: 写失败测试覆盖创建页与折叠轨迹**

```tsx
it("Session 列表独立创建，对话默认折叠运行轨迹", async () => {
  renderAt("/sessions");
  expect(screen.queryByLabelText("Session 标题")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "新建 Session" }));
  expect(screen.getByLabelText("Session 标题")).toBeInTheDocument();
  renderAt("/sessions/session-1");
  expect(await screen.findByText("Agent 回复")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /执行轨迹/ })).toHaveAttribute("aria-expanded", "false");
});
```

移植既有 Session SSE、重试、轮询、取消和加载失败测试，确保只是信息层级变化。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm test -- test/web-sessions.test.tsx`
Expected: FAIL，因为创建表单仍在列表页且状态事件默认展开。

- [ ] **Step 3: 实现 Session feature 页面**

列表仅负责进入详情；新建成功 `navigate(/sessions/:id)`。对话页复用原数据逻辑，`RunBlock` 将 tool/status/error 事件放入 Collapsible，失败摘要在折叠按钮旁可见。Composer 保持 sticky 和单一主要动作。

- [ ] **Step 4: 验证 GREEN 并提交**

Run: `pnpm test -- test/web-sessions.test.tsx test/runs.test.ts test/run-executor.test.ts && pnpm typecheck`
Expected: PASS，fake timer 测试结束时无遗留 timer。

```bash
git add src/web/features/sessions src/web/pages/session-page.tsx src/web/pages/sessions-page.tsx test/web-sessions.test.tsx
git commit -m "feat: simplify session workflows"
```

---

### Task 5: 迁移旧测试、响应式验收和本地服务切换

**Files:**
- Modify: `test/web.test.tsx`
- Modify: `src/web/styles.css`
- Modify: `docs/superpowers/plans/2026-08-13-management-console-ux.md`

**Interfaces:**
- Consumes: Tasks 1–4 的最终页面。
- Produces: 完整回归、桌面和窄屏可用的本地服务。

- [ ] **Step 1: 删除已被 feature 测试取代的旧页面断言并保留公共回归**

保留 Token、SPA fallback、Session SSE 边界和 API 404 测试；不保留断言旧单页结构的兼容测试。

- [ ] **Step 2: 运行全部自动门禁**

```bash
pnpm test
pnpm typecheck
pnpm build
node --check dist/server/main.js
git diff --check
```

Expected: 所有命令 exit 0，无未处理 Promise rejection、React warning 或 fake timer 泄漏。

- [ ] **Step 3: 重启本地 3100 服务并做浏览器验收**

复用现有 API_TOKEN、数据库和 APFS Workspace 环境变量，停止旧 PID 后启动新构建。验证：

1. 侧栏桌面可见，窄屏可折叠。
2. 三个列表页没有内嵌创建或编辑表单。
3. Agent 的概览、Skills、设置直达 URL 可刷新。
4. 项目环境项目弹窗一次只编辑一个仓库。
5. Session 创建后进入对话，执行轨迹默认折叠。
6. 现有 Agent、环境、Session 数据未改变。

- [ ] **Step 4: 更新计划勾选、提交最终验收修正**

```bash
git add test/web.test.tsx src/web/styles.css docs/superpowers/plans/2026-08-13-management-console-ux.md
git commit -m "test: verify management console ux"
```
