# Remote Agent Server 项目环境设计

## 1. 背景

Remote Agent Server 当前通过一个全局 `WORKSPACE_TEMPLATE` 为所有 Session 创建 APFS 或 Btrfs 写时复制 Workspace。该方式能够快速隔离 Session，但项目代码、依赖和基础配置仍需要管理员在服务外人工维护。

第一版需要将这部分变成系统能力：管理员只需要在页面中登记项目及一次性的环境准备命令，系统负责检查项目更新、构建可用环境版本，并在创建 Session 时自动生成独立 Workspace。

本文只设计项目环境管理，不扩展为通用 CI、环境池或容器平台。

## 2. 核心概念

### 2.1 项目环境

项目环境是一组可以共同用于 Agent 任务的 Git 项目及其已安装依赖和基础配置。一个项目环境可以包含多个项目，例如：

```text
示例研发环境
├── example-service
├── example-web
└── bid-spiders
```

项目环境由系统长期维护，不直接供 Agent 修改。

### 2.2 项目环境版本

项目环境版本是一次成功构建后的不可变版本。系统从当前可用版本创建 APFS/Btrfs 写时复制快照，在新快照中更新项目并准备环境，成功后再原子发布。

构建失败不能修改当前可用版本。

### 2.3 Workspace

Workspace 是某个 Session 从项目环境版本生成的独立 APFS/Btrfs 写时复制副本。同一 Session 的后续 Run 始终复用自己的 Workspace，不同 Session 的修改互不影响。

## 3. 绑定关系

Agent 绑定项目环境，Session 固化创建时实际使用的项目环境版本：

```text
Agent.project_environment_id
Session.project_environment_revision_id
Session.workspace_path
```

一个项目环境可以被多个 Agent 共用。创建 Session 时，用户只选择 Agent，系统自动使用该 Agent 所绑定项目环境的当前可用版本，不要求用户再次选择环境。

项目环境发布新版本后，Agent 自动使用新版本创建后续 Session。已有 Session 保持原版本和原 Workspace，不自动升级。

## 4. 数据模型

### 4.1 project_environments

```text
id
name
current_revision_id       # 当前可用于创建 Session 的版本，可为空
last_checked_at
created_at
updated_at
```

项目环境名称必填。同一服务内名称唯一。

### 4.2 environment_repositories

```text
id
project_environment_id
name                      # Workspace 中的安全目录名
git_url
prepare_command           # 可为空
created_at
updated_at
```

同一项目环境内的项目名称唯一。名称只允许安全目录字符，不能包含路径分隔符或路径跳转。

分支默认使用远程仓库的默认分支。管理员不需要配置分支或 commit hash。Git 地址和准备命令由受信任的管理员维护。

### 4.3 project_environment_revisions

```text
id
project_environment_id
status                    # preparing / ready / failed
workspace_path            # 物理 Workspace 已清理后可为空
input_fingerprint         # 系统内部判断构建输入是否变化
failure_stage             # 可为空
error                     # 可为空，保存失败摘要
created_at
finished_at
```

`input_fingerprint` 是项目名称、Git 地址、准备命令和所有远程默认分支最新提交的内部组合指纹，只用于避免无变化时重复构建，不作为管理员配置。

同一项目环境最多只能有一个 `preparing` 版本。`current_revision_id` 只能指向 `ready` 版本。

### 4.4 现有表扩展

```text
agents.project_environment_id
sessions.project_environment_revision_id
```

不使用通用 `config_json`，不增加构建任务表、队列表或环境池表。

## 5. 项目环境生命周期

### 5.1 首次构建

1. 管理员创建项目环境并添加一个或多个项目；空项目环境不能构建。
2. 系统自动触发第一次构建。
3. Workspace 后端创建空白 APFS/Btrfs 环境 Workspace。
4. 系统将各项目 clone 到以项目名称命名的固定目录。
5. 系统在每个项目目录中执行该项目的可选准备命令。
6. 所有步骤成功后，将版本标记为 `ready`，并原子设置为项目环境的当前版本。
7. 任一步骤失败时，将版本标记为 `failed`，删除失败 Workspace，项目环境仍然没有当前版本。

没有可用版本的项目环境不能绑定新 Agent，也不能用于创建 Session。

### 5.2 定时检查

服务进程内的 `ProjectEnvironmentScheduler` 每三小时检查一次所有项目环境，也接收页面发起的“立即检查”请求。

检查读取项目配置和 Git 远程默认分支，计算新的构建输入指纹：

- 指纹未变化：只更新 `last_checked_at`，不创建新版本。
- 指纹发生变化：请求 `ProjectEnvironmentBuilder` 构建新版本。
- 当前已有构建：跳过本次请求，不并发构建。

第一版不接入 GitLab Webhook，不引入 Sidekiq、Redis、独立 Worker 或 Runner daemon。

### 5.3 增量构建

1. 从当前 `ready` 版本创建 APFS/Btrfs 写时复制快照。
2. 已有项目执行 `git fetch`，并将工作树重置到远程默认分支最新提交。
3. 新增项目执行首次 clone。
4. 已从项目环境配置中移除的项目只从新快照删除。
5. 仅对源码、Git 地址或准备命令发生变化，以及首次加入的项目执行准备命令。
6. 所有项目完成后，将新版本标记为 `ready`。
7. 在同一数据库事务中切换 `current_revision_id`。
8. 发布失败时删除新快照，当前版本保持不变。

当前可用项目环境和已有 Session 在整个构建过程中保持可用。

### 5.4 存储清理

系统保留当前版本和前一个成功版本的实际项目环境 Workspace。更早版本的 Workspace 自动删除，但版本元数据保留，因此 Session 仍能显示创建时使用的版本。

Session Workspace 是独立快照，删除旧项目环境 Workspace 不影响已有 Session。

失败构建的 Workspace 自动删除，只保留失败阶段和错误摘要。

## 6. 环境准备命令

每个项目可以配置一条可选准备命令，例如：

```text
pnpm install --frozen-lockfile
bundle install
poetry install
make install
```

准备命令只在项目首次加入，或该项目源码、Git 地址、准备命令发生变化后的项目环境构建中执行，不在创建 Session 时执行。

系统不根据项目文件自动猜测并直接执行命令。页面以后可以提供命令建议，但首次配置必须由管理员确认。

准备命令的规则：

- 工作目录固定为对应项目目录。
- 使用服务用户的环境执行。
- 默认最多执行 30 分钟。
- 超时、非零退出或服务关闭都会终止命令并使本次构建失败。
- 错误摘要记录项目名称、执行阶段和命令输出，不能泄露环境变量或凭证。

Git、npm、Bundler 等凭证继续由服务用户环境或 `.env` 提供，不保存到 SQLite。

## 7. Session 创建流程

创建 Session 时：

1. 读取 Agent 绑定的项目环境。
2. 读取项目环境的 `current_revision_id`。
3. 校验当前版本为 `ready` 且物理 Workspace 存在。
4. 从该版本创建独立 APFS/Btrfs Session Workspace。
5. 在一个事务中保存 Session、`project_environment_revision_id` 和 `workspace_path`。

Workspace 创建失败时不插入 Session。Session 创建完成后不再依赖项目环境 Workspace 的生命周期。

Agent 在 Run 中自行判断需要操作哪些项目，但只能使用当前 Workspace 已有的项目。第一版不向 Agent 提供新增仓库接口，也不允许 Agent 修改共享项目环境。

## 8. 后台组件

第一版只增加两个组件：

### 8.1 ProjectEnvironmentScheduler

- 服务启动后按三小时周期发起项目检查。
- 接收 API 的立即检查请求。
- 同一时刻只允许一个项目环境构建，避免依赖安装占满机器。
- 服务关闭时停止接受新检查，并等待或有界终止正在运行的构建。

### 8.2 ProjectEnvironmentBuilder

- 创建和删除项目环境版本 Workspace。
- 获取 Git 远程状态并更新项目。
- 执行准备命令。
- 发布成功版本或记录失败。
- 不负责 Agent、Session、Run 或业务 Workflow。

Workspace 的实际复制和删除继续通过现有 `WorkspaceManager` 抽象完成，由 APFS 和 Btrfs 后端分别实现。

## 9. API

新增以下接口：

```text
GET    /api/project-environments
POST   /api/project-environments
GET    /api/project-environments/:id
PATCH  /api/project-environments/:id

POST   /api/project-environments/:id/repositories
PATCH  /api/project-environments/:id/repositories/:repositoryId
DELETE /api/project-environments/:id/repositories/:repositoryId

POST   /api/project-environments/:id/check
```

项目环境详情返回项目列表、当前版本、最近检查时间和最近一次构建结果。

构建状态通过详情接口轮询。第一版不为项目环境增加另一套 SSE。

构建期间修改项目列表或准备命令时返回明确的“项目环境正在更新”错误，不能同时变更构建输入。

项目新增、修改或移除成功后，系统立即请求一次新版本构建，不要求管理员再点击“立即检查”。如果没有可用版本，第一次添加项目也自动触发首次构建。

现有 Agent 创建和修改接口增加 `projectEnvironmentId`。现有 Session 创建接口仍只需要 `agentId` 和标题。

## 10. 管理界面

新增“项目环境”页面：

- 查看项目环境名称、当前版本、状态和最后检查时间。
- 创建和修改项目环境。
- 添加、修改和移除项目。
- 配置项目 Git 地址和可选准备命令。
- 立即检查项目更新。
- 查看最近一次构建的结果、失败项目、失败阶段和错误摘要。

Agent 页面增加“项目环境”选择项。只能选择具有当前可用版本的项目环境。

Agent 运行检查分别显示：

- Provider/ACP 是否可以启动并完成初始化。
- Agent 绑定的项目环境是否具有可用版本。

运行检查不能把“项目环境可用”描述为“模型调用成功”。

创建 Session 的页面不增加项目环境选择，避免重复配置和误选。

## 11. 并发和故障处理

- 同一项目环境同时最多存在一个 `preparing` 版本，由数据库约束保证。
- 第一版所有项目环境构建全局串行。
- Git 无法访问、准备命令失败或超时：新版本失败，当前版本不变。
- 构建期间：现有 Session、Run 和新 Session 均继续使用当前已发布版本。
- 服务启动时：遗留的 `preparing` 版本标记为 `failed`，对应临时 Workspace 删除。
- 项目环境没有可用版本：Agent 不能绑定，Session 不能创建。
- 发布新版本：只影响之后创建的 Session。
- 删除项目：只影响下一次成功发布的版本。
- 检查或构建失败不自动修改项目配置。

## 12. 现有数据迁移

迁移必须保留已有 Agent、Session、Run 和 Event：

1. 新建一个“默认项目环境”。
2. 将当前 `WORKSPACE_TEMPLATE` 导入为默认项目环境的第一个 `ready` 版本。
3. 将现有 Agent 绑定到默认项目环境。
4. 现有 Session 保留原 `workspace_path`，不重新复制或修改 Workspace。
5. 现有 Session 的 `project_environment_revision_id` 可以为空；新 Session 必须记录具体版本。
6. 系统读取当前 Workspace 直接子目录中 Git 项目的目录名和 `origin` 地址，并导入为环境项目；准备命令默认留空，由管理员按需补充。
7. 完成迁移后，新 Session 不再直接读取全局 `WORKSPACE_TEMPLATE`。

迁移不移动或删除现有 Session 目录。

## 13. 验证策略

### 13.1 数据和 API

- 项目环境、项目及版本的创建、修改、查询和约束。
- 构建期间禁止修改项目配置。
- Agent 只能绑定具有可用版本的项目环境。
- Session 自动记录 Agent 当前项目环境版本。
- 现有数据迁移后仍可查询和继续使用。

### 13.2 构建行为

使用本地 Git 仓库 fixture 验证：

- 首次 clone 两个项目并发布版本。
- 无远程变化时不创建新版本。
- 一个项目变化时创建新版本，并只执行对应准备命令。
- 新增和移除项目只影响新版本。
- Git 失败、准备命令失败和超时均不切换当前版本。
- 同一项目环境和全局构建串行化。
- 服务关闭可以有界终止构建子进程。

### 13.3 文件系统

- macOS 使用 APFS 写时复制副本。
- Linux 使用 Btrfs 快照。
- 新版本修改不污染当前版本。
- Session 修改不污染项目环境或其他 Session。
- 删除旧项目环境 Workspace 不影响 Session Workspace。

### 13.4 定时检查

- 服务启动后建立唯一的三小时检查周期。
- 到达周期时检查全部项目环境。
- 页面立即检查与周期检查不会重复构建。
- 服务关闭后清理定时器，不再发起检查。

### 13.5 现有执行链回归

- Claude Code、Codex、Hermes 均可创建 Session 并完成两轮对话。
- 同一 Session 串行，不同 Session 按全局 Run 并发限制执行。
- Run Event、SSE、取消、重置和关闭行为不变。
- 有头浏览器继续使用 Session 独立的浏览器目录。

## 14. 第一版完成条件

1. 管理员可以在页面创建一个包含至少两个 Git 项目的项目环境。
2. 系统能够自动 clone 项目、执行准备命令并发布第一个可用版本。
3. Agent 能够绑定项目环境，创建 Session 时不需要再次选择环境。
4. 新 Session 的 Workspace 已经包含所有项目和准备完成的依赖。
5. Agent 能在一个 Run 中自行选择并操作一个或多个项目。
6. 上游项目变化后，系统能够在三小时检查周期内发布新版本。
7. 更新前创建的 Session 保持旧代码，更新后创建的 Session 使用新代码。
8. 构建失败时当前可用版本不变。
9. 两个 Session 的修改互不影响，也不污染项目环境。
10. Claude Code、Codex、Hermes 的两轮 Session 接续保持正常。
11. 有头浏览器继续使用每个 Session 的独立目录。
12. 服务重启不会误发布未完成的项目环境版本。

## 15. 明确不做

第一版不实现：

- 容器、虚拟机或通用沙箱。
- EnvironmentPool 或预热 Session 池。
- 每个 Session 重新 clone 项目或重新安装基础依赖。
- Agent 动态添加任意远程仓库。
- GitLab Webhook。
- 独立 Runner、Sidekiq、Redis 或分布式构建。
- 任意分支和 commit hash 的页面选择。
- 构建日志 SSE、CI Pipeline 或复杂审批。
- 自动猜测并执行项目安装命令。
- 已有 Session 自动升级项目环境版本。
