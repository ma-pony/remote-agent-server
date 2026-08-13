# Agent 修改与删除设计

## 范围

- Agent 可修改名称、项目环境和启用状态。
- Provider 创建后不可修改。
- 只有没有 Session 的 Agent 可以删除。
- 已有 Session 时删除返回 `agent_has_sessions`，用户可以停用 Agent。
- 不做软删除，不级联删除 Session、Run、Event 或 Agent 文件。

## 接口与界面

- 沿用 `PATCH /api/agents/:id` 修改名称、项目环境和启用状态。
- 新增 `DELETE /api/agents/:id`；成功返回 204，不存在返回 404，有 Session 返回 409。
- Agent 列表提供“修改”与“删除”。修改在当前卡片内展开，显示名称和可用项目环境；Provider 只读展示。
- 删除前使用浏览器原生确认框。409 时显示“该 Agent 已有 Session，不能删除，可将其停用”。

## 数据与安全

删除操作先查询 Session，再删除 Agent。SQLite 外键继续作为最后约束。删除成功后移除 `data/agents/<id>`；文件清理失败不恢复数据库记录，避免保留不可用 Agent。

## 验证

- API 覆盖修改成功、Provider 修改被拒绝、无 Session 删除、已有 Session 拒绝、未知 Agent。
- UI 覆盖修改名称和环境、删除成功、已有 Session 的错误提示。
