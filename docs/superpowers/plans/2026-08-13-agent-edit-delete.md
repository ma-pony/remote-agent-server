# Agent Edit and Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持安全修改和删除 Agent，同时完整保留已有 Session 历史。

**Architecture:** 沿用 AgentManager 和现有 Fastify Agent 路由；删除约束在 AgentManager 中执行，API 映射为 409。React Agent 卡片内提供最小编辑表单和删除按钮。

**Tech Stack:** TypeScript、Fastify、SQLite、React、Vitest、Testing Library

## Global Constraints

- Provider 创建后不可修改。
- 有 Session 的 Agent 不可删除。
- 不做软删除或级联删除。

---

### Task 1: 后端修改和删除约束

**Files:**
- Modify: `test/agents.test.ts`
- Modify: `src/agents/agent-manager.ts`
- Modify: `src/agents/agent-routes.ts`

**Interfaces:**
- Produces: `AgentManager.delete(id): "deleted" | "not_found"`;有 Session 时抛出 `AgentManagerError("agent_has_sessions")`。
- Produces: `DELETE /api/agents/:id`，成功 204，已有 Session 409。

- [ ] 写 API RED：PATCH 名称/环境成功、Provider 字段返回 400、DELETE 无 Session 成功、有 Session 返回 409、未知 Agent 404。
- [ ] 运行 `pnpm exec vitest run test/agents.test.ts`，确认 DELETE 用例失败。
- [ ] 实现 AgentManager 删除约束、Agent 文件清理和 DELETE 路由。
- [ ] 重跑聚焦测试并确认通过。

### Task 2: Agent 页面修改与删除

**Files:**
- Modify: `test/web.test.tsx`
- Modify: `src/web/pages/agents-page.tsx`
- Modify: `src/web/styles.css`

**Interfaces:**
- Consumes: `PATCH /agents/:id` 和 `DELETE /agents/:id`。
- Produces: 卡片内编辑名称/项目环境，删除成功移除卡片，409 显示后端提示。

- [ ] 写 UI RED：展开修改、保存名称/环境、确认删除并移除卡片、删除冲突显示提示。
- [ ] 运行 `pnpm exec vitest run test/web.test.tsx`，确认交互用例失败。
- [ ] 实现最小卡片内编辑表单和删除动作。
- [ ] 重跑 UI 聚焦测试并确认通过。

### Task 3: 完整验证与提交

**Files:**
- Verify all changed files.

- [ ] 运行 `pnpm test`。
- [ ] 运行 `pnpm typecheck` 和 `pnpm build`。
- [ ] 运行 `node --check dist/server/main.js`、`git diff --check`。
- [ ] 提交 `feat: edit and safely delete agents`。
- [ ] 重启 3100 本地服务并用浏览器验证修改、删除入口。
