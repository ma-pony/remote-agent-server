# APFS/Btrfs 双工作区设计

## 目标

Remote Agent Server 在 macOS 和 Linux 上为每个 Session 快速创建独立、可写的 Workspace，同时避免完整复制模板。macOS 使用 APFS Clone，Linux 使用 Btrfs Snapshot。上层 Session、Run、Agent 和 API 不感知底层文件系统差异。

## 范围

- macOS 仅支持 APFS 工作目录。
- Linux 仅支持 Btrfs 工作目录。
- 不支持的操作系统或文件系统直接拒绝启动。
- 不回退为普通完整复制。
- 不新增数据库字段、环境变量或第三方文件系统依赖。

## 结构

定义统一的 `WorkspaceManager` 接口，保留现有三个操作：

- `check()`：启动时验证运行环境。
- `create(sessionId)`：创建 Session 目录、Workspace、Runtime 目录和浏览器 Profile 目录。
- `rollback(sessionId)`：Session 持久化失败时清理已创建内容。

两个实现分别为：

- `BtrfsWorkspaceManager`：继续使用 `btrfs subvolume show/snapshot/delete`。
- `ApfsWorkspaceManager`：使用 macOS 原生 APFS 检查和 `cp -cR` Clone。

应用启动时由工厂根据 `process.platform` 自动选择：`darwin` 选择 APFS，`linux` 选择 Btrfs，其他平台报错。测试可以显式传入平台和命令执行器，不依赖测试机文件系统。

## APFS 行为

`check()` 必须验证：

1. 模板目录存在。
2. 模板目录和 Sessions 根目录都位于 APFS。
3. 两者位于同一个 APFS Volume，保证 Clone 能使用同一底层存储。

`create()` 先创建 Session、`runtime/` 和 `browser/` 目录，再执行：

```bash
cp -cR <workspace-template> <session>/workspace
```

`-c` 请求 macOS 使用 `clonefile(2)`。启动检查将运行环境限制为同一 APFS Volume；本服务不实现普通递归复制后端。macOS 的 `cp` 仍可能按系统语义复制个别无法 Clone 的特殊文件。命令失败时删除整个 Session 目录，并抛出统一的 `workspace_create_failed`。

`rollback()` 直接删除整个 Session 目录。APFS Clone 是普通目录树，不需要额外的 Snapshot 删除命令。

## Btrfs 行为

保持当前实现：模板必须是 Btrfs Subvolume；创建时生成可写 Snapshot；回滚时先删除 Snapshot，再删除 Session 目录。Linux 工作目录不是 Btrfs 时，启动检查失败，不进行完整复制。

## 错误与一致性

- 文件系统检查必须在 HTTP 监听和 Run 恢复之前完成。
- 创建 Workspace 失败时不得写入 Session 记录。
- Session 数据库写入失败时必须调用对应实现的 `rollback()`。
- 对 API 保持现有 `workspace_create_failed` 和 `session_create_failed` 语义。
- 不吞掉启动检查错误，错误信息应指出期望的操作系统文件系统。

## 测试与验收

自动测试覆盖：

- macOS/Linux 自动选择正确实现，其他平台失败。
- APFS 同卷检查、创建命令、失败清理和回滚。
- Btrfs 现有检查、创建和回滚不回归。
- SessionManager 只依赖统一接口。
- 应用装配和启动使用自动选择工厂。

macOS 本机验收：

1. 在 APFS Volume 中创建模板与 Sessions 根目录。
2. 构建并启动服务。
3. 验证 `GET /api/health`。
4. 创建 Session，确认 Workspace 存在且修改它不会影响模板。

Linux/Btrfs 的真实 Snapshot 和 Provider 验收仍在目标 Linux 服务器执行。
