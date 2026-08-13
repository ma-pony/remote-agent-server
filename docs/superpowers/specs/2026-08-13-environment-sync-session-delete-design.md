# 项目环境同步与 Session 删除设计

## 目标

第一版补齐两个管理闭环：

1. 项目环境可以手动同步，并准确展示自动同步状态、时间与磁盘路径。
2. 空闲 Session 可以永久删除，同时清理 Provider 状态、Workspace 和全部对话历史。

保持现有单进程 Fastify、SQLite、APFS/Btrfs Workspace 和内存调度器结构，不新增任务表、软删除或同步历史系统。

## 项目环境同步

### 同步粒度

同步只允许以项目环境为单位执行。一个环境内的所有项目共同参与远程检查、指纹计算和不可变 Workspace 版本发布，不提供单项目同步，避免同一环境出现互不一致的项目版本。

### 后端接口

- `POST /api/project-environments/:id/sync` 请求立即同步，返回 `202`。重复请求由现有 Scheduler 合并。
- 项目环境列表和详情响应增加 `sync`：
  - `status`：`idle`、`queued` 或 `running`。
  - `automatic`：固定为 `true`。
  - `intervalMs`：来自 `PROJECT_ENVIRONMENT_CHECK_INTERVAL_HOURS`。
  - `nextScheduledAt`：Scheduler 当前计划的下一次全量自动同步时间。
- 环境响应增加 `workspacePath`，取当前可用 Revision 的 Workspace 路径；没有可用版本时为 `null`。
- 每个项目响应增加 `workspacePath`，由后端使用当前环境 Workspace 与安全的项目目录名拼接；没有可用版本时为 `null`。

Scheduler 在内存中记录下一次自动同步时间与当前正在执行的环境 ID。排队状态来自已有 pending 队列，不写入数据库。服务重启后按新的启动时间重新计算下次自动同步时间。

现有 `/check` 命名由 `/sync` 替代，不保留并行入口。

### 页面

项目环境概览页使用“同步”而不是“检查”语义：

- 展示当前版本、最近同步、下次自动同步和当前状态。
- 展示当前环境 Workspace 的完整路径，使用等宽字体并允许自然换行。
- 提供“立即同步”按钮；queued/running 时禁用并显示对应状态。
- queued/running 时每两秒重新读取环境详情，终态后停止轮询。

项目列表为每个项目展示 Git 地址、准备命令、实际 Workspace 路径和“随项目环境整体同步”。不增加单项目同步按钮。

同步失败继续使用最新失败 Revision 的 `failureStage` 与 `error` 展示；之前已发布的可用版本保持不变。

## Session 永久删除

### 业务规则

- 只有 `idle` 且不存在 `queued` 或 `running` Run 的 Session 可以删除。
- 删除会永久移除 Session、全部 Runs、全部 Events、ACP Provider Session、Workspace、runtime 目录和浏览器 Profile。
- 不提供软删除，不保留历史恢复入口。
- `running` Session 返回 `409 session_busy`；不存在返回 `404 not_found`；Runtime 或 Workspace 清理失败返回明确的 `500 session_delete_failed`。

### 后端流程

新增 `DELETE /api/sessions/:id`，由 `SessionManager.delete(id)` 协调：

1. 使用 `BEGIN IMMEDIATE` 将目标 Session 从 `idle` 原子 claim 为 `running`，同时确认不存在 active Run。该状态阻止新 Run 与 reset 进入。
2. 调用 Runtime reset，关闭当前 Handle 并丢弃 Provider 持久状态。
3. 调用 `WorkspaceManager.deleteSession(id)` 删除 Session 根目录。APFS 删除 clone 目录；Btrfs 先删除 Workspace subvolume，再删除根目录。
4. 使用一个 SQLite 事务按 Events、Runs、Session 的顺序删除记录。

Runtime 清理失败时释放 claim，保留原记录和 Workspace。Runtime 已清理但 Workspace 删除失败时，清空 `provider_session_id` 并释放 claim，保留数据库历史以便重试或人工处理。SQLite 最终删除只包含确定性的本地语句；若异常则返回删除失败。

`rollbackSession` 改为语义明确的 `deleteSession`，创建失败和永久删除共用同一个幂等清理能力。

### 页面

- Session 列表每项提供删除操作，不把整行操作继续堆到对话区域。
- Session 详情页也提供同一删除入口。
- 删除前使用二次确认，明确列出 Workspace 和全部对话历史不可恢复。
- running Session 的删除操作禁用并说明需要先结束当前 Run。
- 删除成功后，列表原地移除；详情页跳转回 Session 列表。

## 测试

后端集成测试覆盖：

- 同步接口鉴权、404、重复请求合并及 `idle/queued/running` 状态。
- 自动同步间隔和下一次执行时间。
- 环境与项目 Workspace 路径。
- Session 删除鉴权、404、busy 拒绝、Runtime/Workspace 清理失败。
- 成功删除 Events、Runs、Session 和磁盘目录。
- 删除 claim 与新 Run 创建互斥。

前端测试覆盖：

- 同步状态、最近/下次时间、环境路径和项目路径展示。
- 手动同步按钮、运行中轮询和重复点击禁用。
- Session 列表与详情删除确认、running 禁用、成功后的页面更新。

最后运行全量测试、类型检查、生产构建与本地 HTTP 验证，并重启 `127.0.0.1:3100` 的现有服务。
