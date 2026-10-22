# Remote Agent Server 部署与验收

本指南介绍 Remote Agent Server 在 macOS 和 Linux 上的单机、单进程部署，以及首次任务、外部接入和升级验收。服务通过 ACP 调用 Provider，使用 SQLite 保存状态。产品边界与执行链路见[产品与架构](design.md)。

| 当前任务 | 从这里开始 |
| --- | --- |
| 首次部署到 macOS | [APFS 原生部署](#macosapfs-原生部署) |
| 首次部署到 Linux | [Btrfs 原生部署](#linuxbtrfs-原生部署) |
| 服务启动后验证可用性 | [完成首次任务](#6-完成首次任务与可选-provider-验收)，再验证[外部系统接入](#7-外部系统接入) |
| 更新已有安装 | [升级与存储恢复](#8-升级备份与恢复) |

生产验收需要分别确认 HTTP 接入、Provider 执行、项目环境与会话工作区、事件与 Webhook 返回。健康接口通过只代表服务可响应，还需用真实 Provider 和 Integration Task 验证执行与结果。[返回文档导航](README.md)。

服务支持两种原生写时复制 Workspace：macOS 使用 APFS Clone，Linux 使用 Btrfs Snapshot。运行时会根据操作系统自动选择，不提供普通目录复制回退。它以 acpx 的 `approve-all` 模式运行 Claude Code、Codex、Hermes 或 DeepSeek Harness。`approve-all` 只减少 Provider 的交互确认，**不是安全沙箱**；Workspace 中的代码、网络和该用户能访问的文件都应视为 Agent 可操作范围。

Codex ACP adapter 固定为 `2.2.2`，锁文件中的配套 Codex CLI 为 `0.160.1`；默认运行使用项目依赖中的 CLI，更新全局 `codex` 不会替换它。默认 `agent` 模式允许普通命令联网，继续采用 `workspace-write` 文件沙箱和原有临时目录规则。adapter 每轮显式下发网络策略，主机 `config.toml` 的 `sandbox_workspace_write.network_access` 不会覆盖该预设。保留上游默认 `auto_review` 审批；acpx 的 `approve-all` 只处理转交客户端的权限请求，不绕过 Codex 自动审批。

Codex 会话启动或恢复后，必须等待已选 MCP 全部连接就绪才能开始模型请求；启动失败、被禁用、需要认证或超过 30 秒仍未就绪都会阻断执行。修复 MCP 配置或认证后重新打开 Provider 会话会重新检查。

升级时按本指南完成 `pnpm install --frozen-lockfile`、构建和服务重启后生效，运行中的进程不会热更新依赖。已有业务 Session 可以恢复，无需清空 Workspace 或会话历史。生产验收还需检查真实 Provider 的会话恢复、MCP 工具调用及自动审批结果。

## macOS：APFS 原生部署

macOS 部署应使用实际登录桌面的普通用户，不使用 root，也不放入无图形会话的系统级 Daemon。这样 Claude Code、Codex、Hermes、DeepSeek Harness 的登录状态和有头浏览器都属于同一个用户会话。

以下示例假设项目位于 `~/Projects/remote-agent-server`，运行数据位于 `~/Library/Application Support/remote-agent-server`。

### 1. 安装并初始化

```bash
cd "$HOME/Projects/remote-agent-server"
nvm install
corepack enable
pnpm install --frozen-lockfile
pnpm run init
```

初始化自动使用 `~/Library/Application Support/remote-agent-server`，创建所需目录、随机管理 Token 和权限为 `0600` 的 `.env`，并验证 APFS 克隆、独立写入和临时目录清理。无需手工执行 `mkdir`、生成 Token 或分别填写存储路径。自定义位置可在首次运行时指定：

```bash
pnpm run init --root "/Volumes/AgentData/remote-agent-server"
```

项目环境和 Session 必须位于同一 APFS Volume。检查失败时不会写入新配置，修复后重试。重复执行初始化会保留原 `.env` 和 Token；更改已有安装的路径需要按数据迁移流程处理，不能靠再次传入 `--root` 搬迁数据。

### 2. 登录一个 Provider

以运行服务的同一个 macOS 用户安装并登录实际使用的 Provider。例如，选择 Codex 后执行 `codex login`；选择 Claude Code 后执行 `claude auth login`。不要求安装全部 Provider。安装入口见 [Claude Code](https://code.claude.com/docs/en/getting-started)、[Codex CLI](https://developers.openai.com/codex/cli)、[Hermes Agent](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart/) 和 [DeepSeek Harness](../README.md#deepseek-harness)。

### 3. 启动并打开管理台

```bash
pnpm build
pnpm start
```

安装或更新源码后先用 `pnpm build` 构建服务端和管理台；`pnpm start` 只运行已有产物，日常重启无需重新构建。程序自动读取工作目录的 `.env`，无需 `source`；已有进程环境变量优先。打开 `http://127.0.0.1:3000`，从 `.env` 复制 `API_TOKEN` 的值到登录页，按“项目环境 → 智能体 → 会话”完成首次任务。新配置仅监听本机。

以后排查安装环境可以执行 `pnpm run doctor`：它检查配置、Git、Provider 命令路径和工作区操作，可能创建缺少的基础目录，并在完成后清理探测目录；不修改 `.env`、创建业务记录或调用模型。检查通过不代表 Provider 已登录。

`DATA_DIR/secret.key` 是敏感值加密的主密钥，首次服务启动时生成。它必须与 SQLite 数据库一起持久化和备份；丢失后已有密文无法恢复。

### 4. 使用 LaunchAgent 随登录启动

服务入口会自动读取运行用户的登录 Shell PATH，并按“当前 Node 目录 → 登录 Shell PATH →
LaunchAgent 原始 PATH”的顺序合并去重。因此 LaunchAgent 不需要手工复制 NVM、Homebrew、pnpm
目录，也不会因为 macOS 默认只有 `/usr/bin:/bin:/usr/sbin:/sbin` 而在执行 Run 时才发现
`npx` 不存在。服务 Node 仍由 `pnpm start` 实际选中的 Node 决定；构建和启动必须使用同一主版本。

先确保日志目录存在：

```bash
mkdir -p "$HOME/Library/Logs/remote-agent-server"
```

创建 `~/Library/LaunchAgents/com.remote-agent-server.plist`，将其中的 `当前用户` 替换为真实用户名：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.remote-agent-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd "$HOME/Projects/remote-agent-server" &amp;&amp; exec pnpm start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/当前用户/Library/Logs/remote-agent-server/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/当前用户/Library/Logs/remote-agent-server/stderr.log</string>
</dict>
</plist>
```

加载并检查服务：

```bash
plutil -lint "$HOME/Library/LaunchAgents/com.remote-agent-server.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.remote-agent-server.plist"
launchctl print "gui/$(id -u)/com.remote-agent-server"
curl --fail http://127.0.0.1:3000/api/health
```

更新代码后先卸载服务，重新构建，再加载：

```bash
launchctl bootout "gui/$(id -u)/com.remote-agent-server"
cd "$HOME/Projects/remote-agent-server" && pnpm install --frozen-lockfile && pnpm build
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.remote-agent-server.plist"
```

## Linux：Btrfs 原生部署

以下示例使用发布目录 `/opt/remote-agent-server` 和 Btrfs 挂载点 `/srv/remote-agent`。请按实际发行版本替换项目路径，但不要让项目环境和 Session 根目录跨越不同的 Btrfs 文件系统。

## 1. 准备服务用户和一个 Btrfs 根目录

安装 `btrfs-progs`（Debian/Ubuntu 可使用 `sudo apt install btrfs-progs`），并由管理员确认 `/srv/remote-agent` 位于已挂载的 Btrfs 文件系统。尚无 Btrfs 的主机需要先准备专用 Btrfs 存储；初始化工具不负责格式化或挂载磁盘。

```bash
sudo useradd --create-home --shell /bin/bash remote-agent
sudo install -d -o remote-agent -g remote-agent -m 0750 /srv/remote-agent
```

已有 `remote-agent` 用户时跳过 `useradd`。只需准备根目录，后续 `pnpm run init` 会创建 `data`、`environments` 和 `sessions`，并以服务用户身份实际验证 `btrfs subvolume create/snapshot/delete`。如果使用其他 Btrfs 挂载点，把初始化命令的 `--root` 改成对应路径。

服务用户必须能够创建和删除快照，无需 sudo 权限。不要用 root 运行 Node、向整个 Node 进程授予 `CAP_SYS_ADMIN` 或配置 `NOPASSWD: btrfs`。若原生检查失败，应修正挂载点权限或换用服务用户可操作的 Btrfs 存储。项目环境和 Session 必须处于同一文件系统，内部不能嵌套额外的 subvolume。

## 2. 安装发布目录

以受控发布方式将完整项目放到服务用户可读取的目录，并在发布目录安装服务依赖：

```bash
sudo install -d -o remote-agent -g remote-agent -m 0750 /opt/remote-agent-server
sudo rsync -a --delete --exclude=.env --chown=remote-agent:remote-agent ./ /opt/remote-agent-server/
sudo -u remote-agent -H bash -lc 'cd /opt/remote-agent-server && corepack enable && pnpm install --frozen-lockfile'
```

服务启动后，在“项目环境”页面创建环境、添加一个或多个 Git 项目，并为需要安装依赖的项目填写一次准备命令。系统在环境版本中 clone/update 和安装依赖，全部成功后才发布；失败不会替换当前版本。已有 Session 不会自动升级。

发布命令排除了 `.env`，更新代码时会保留服务器已有配置，也不会复制开发机的凭证。

## 3. 配置服务环境

创建生产环境文件，只有 `remote-agent` 可读取：

```bash
sudo -u remote-agent -H bash -lc 'cd /opt/remote-agent-server && pnpm run init --root /srv/remote-agent'
```

命令自动生成 `.env`、随机 Token 和全部存储路径；已有配置不会被覆盖。只有需要改变端口、监听地址或显示环境时才手动编辑 `.env`，无需再次生成 Token。程序自动读取该文件，进程环境优先；使用绝对路径，不写 `$HOME`、`~` 或 Shell 表达式。不要提交 `.env`，不要在仓库或 systemd unit 中硬编码 Provider 凭证。Claude/Codex 的原生登录状态由该系统用户保存；Hermes 的原生状态使用后文每个 Session 的 `HERMES_HOME`；DeepSeek Harness 使用每个 Session 的 `DSH_HOME`。服务建议只监听内网；若需要跨网络访问，放在 TLS 反向代理后，并仅把 Bearer Token 分发给可信调用方。

如果项目环境使用 `uv sync`，需要安装 uv `>= 0.10.8`，并确认 `uv venv --help` 包含 `--relocatable`。服务检测到 `uv.lock` 后，会在项目准备命令前执行 `uv venv --relocatable .venv`，使后续 `uv sync` 安装的标准命令入口可以随 APFS Clone/Btrfs Snapshot 迁移。升级 uv 后需要在管理界面重新同步项目环境，已有 `.venv` 不会自动转换。

有头浏览器需要服务器上真实的桌面/X display，以及 `remote-agent` 对该 display 的访问权。先以该用户检查，再把实际 `DISPLAY` 和 `XAUTHORITY` 写入 `.env`：

```bash
sudo -u remote-agent -H env DISPLAY=:0 XAUTHORITY=/home/remote-agent/.Xauthority xdpyinfo >/dev/null
```

安装浏览器和其系统库时按发行版的 Chromium/桌面包清单执行；不要让 Provider 在首次 Run 时下载或配置浏览器。Provider 得到的 `REMOTE_AGENT_BROWSER_PROFILE` 每个 Session 都不同，Profile 应只写到该 Session 的 `browser/` 目录。

## 4. 使用同一服务用户登录 Provider

所有登录和检查都在 `remote-agent` 身份下进行，这样 systemd 进程能看到同一份 CLI 原生状态和 PATH。先确认 Node、pnpm 和 `acpx` 所需的 `npx` 可执行，再安装并登录一个实际使用的 Provider。以下以 Codex 为例；下一节会把登录 PATH 写入 systemd 配置。

```bash
sudo -u remote-agent -H bash -lc 'node --version && pnpm --version && npx --version'
sudo -u remote-agent -H bash -lc 'codex login'
```

选择 Claude Code 时，把最后一条命令换为 `claude auth login`。选择 Hermes 时，以服务用户执行 `hermes model`，按官方快速开始完成模型配置；服务随后会把静态配置复制到 Agent 的独立 Provider Home。不要使用管理员自己的 home，也不要把模型 token 写入 `.env.example` 或提交的文件。

Hermes 需使用原生 Python CLI 入口，且 `hermes` 命令可从服务 PATH 找到。服务按该入口的 shebang 使用同一 Python 环境，在 Session Home 内生成 ACP 适配文件；不修改全局安装，不额外安装 Python 包。升级后的新连接会正确将 Hermes 的明确执行失败标记为失败。

选择 DeepSeek Harness 时，先使用 Node **22.19+ 的 22.x**，然后以服务用户安装固定版本：

```bash
sudo -u remote-agent -H bash -lc 'npm install --global @deepseek-ai/dsh@0.2.1-rc.2'
sudo -u remote-agent -H bash -lc 'dsh --version'
```

按 [DSH 官方文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)配置该用户的凭据。默认 Home 为 `~/.dsh`，也可在服务环境中设置绝对路径 `DSH_HOME`；自定义模型配置放在 `profiles/acp/cordis.patch.yml`，Web profile 的模型路由不会自动继承。服务通过 `dsh --profile acp` 启动，给每个 Session 准备独立 Home，只复制凭据、基础配置与 ACP profile，不复制宿主会话或存储。旧版 `settings.yaml` 会在 ACP 启动前转换为会话内 Profile 补丁，无需先运行一次 DSH，宿主原文件保持不变。首次任务前，在新建 Agent 时选择 **DeepSeek Harness** 并执行管理台运行检查。`pnpm run doctor` 只检查 `dsh` 可执行文件，不能证明模型认证成功。

DSH 当前处于开发预览；固定版本避免默认 npm 标签与 ACP 源码接口不一致。升级 DSH 后重新验证真实双轮恢复、MCP 和取消；其 ACP 不提供累计输入 / 输出 token，管理台相应字段保留为未上报。

## 5. 构建并交给 systemd 管理

先以服务用户检查并构建：

```bash
sudo -u remote-agent -H bash -lc 'cd /opt/remote-agent-server && pnpm run doctor && pnpm build'
```

构建和运行都使用 Node.js 22。查出该用户的 Node 绝对路径和登录 PATH：

```bash
REMOTE_AGENT_NODE="$(sudo -u remote-agent -H bash -lc 'command -v node')"
REMOTE_AGENT_PATH="$(sudo -u remote-agent -H bash -lc 'printf %s "$PATH"')"
test -n "$REMOTE_AGENT_NODE" && test -x "$REMOTE_AGENT_NODE"
sudo -u remote-agent -H "$REMOTE_AGENT_NODE" --version
```

把这两个值写入服务配置。直接运行已构建的 Node 入口，重启时不会重新安装或编译，也不再依赖 systemd 查找 pnpm。服务会自动读取工作目录的 `.env` 并补齐登录 Shell PATH；只需要安装实际使用的 Provider。

```bash
sudo tee /etc/systemd/system/remote-agent.service >/dev/null <<EOF
[Unit]
Description=Remote Agent Server ACP execution gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=remote-agent
Group=remote-agent
WorkingDirectory=/opt/remote-agent-server
Environment=HOME=/home/remote-agent
Environment=NODE_ENV=production
Environment="PATH=$REMOTE_AGENT_PATH"
ExecStart=$REMOTE_AGENT_NODE /opt/remote-agent-server/dist/server/main.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now remote-agent
curl --fail http://127.0.0.1:3000/api/health
```

健康检查失败时使用 `sudo journalctl -u remote-agent -n 100 --no-pager` 查看原因。若默认本机监听需要从另一台电脑访问，可通过 `ssh -L 3000:127.0.0.1:3000 <服务用户>@<服务器>` 转发后打开本机管理台；直接对外提供服务时再配置 TLS 反向代理和监听地址。

升级时先停止服务、备份数据，再安装依赖和执行 `pnpm build`，最后重新启动。变更 Node 安装路径后同步更新 unit。不要使用 `DynamicUser=yes`：Provider 登录状态、Btrfs 权限和 Provider Home 都依赖稳定的 UID/HOME。已有 unit 的 `EnvironmentFile` 可以继续使用，其变量优先于程序读取的 `.env`。

普通重启直接复用构建产物；源码更新必须先构建成功，启动命令不会自动补建。

重启优化会首次为 Session／Run 用量快照、Run 状态及待升级的回补记录创建索引，这次升级仍需读取相关表并预留磁盘空间；后续启动复用索引。已完成的估算元数据迁移不再扫描历史归因表，旧用量导入只读取尚未导入的计数，不加载输入或结果正文。必要的 Session 维护与中断 Run 恢复仍在调度和监听前完成。首次建索引、未完成维护和异常终止后的 WAL 恢复仍可能延长启动；允许服务正常关闭，不删除 WAL 来缩短恢复。

升级到 Codex 插件共享投影后无需清库。下一次使用某个 Session 时，服务会为该 Agent 发布本地插件 marketplace，并将该 Session 旧的 `plugins/cache/` 替换为指向 Agent 级目录的链接；默认也会替换旧的 `.tmp/`。显式启用 `local_thread_store_compression` 的 Session 保留独立 `.tmp/`，避免跨 Session 的压缩锁冲突，但 Codex 可能为这些 Session 分别保存内置市场仓库。未再使用的 Session Home 按现有空闲保留策略清理。共享快照位于 `DATA_DIR/agents/<id>/provider-home/codex/shared-plugins/`，按内容版本划分的共享插件缓存位于同级 `plugin-caches/`，默认内置市场同步目录为同级 `.tmp/`。这些数据随 Agent 删除，不应在仍有 Session 使用时手动删除。

## 6. 完成首次任务与可选 Provider 验收

首次启用只需选择一个实际使用的 Provider，完成一条真实任务并核对结果。先打开管理页面的“项目环境”：

1. 创建一个项目环境。
2. 添加至少一个服务用户能够访问的 Git 项目；一个环境可以包含多个项目。
3. 按项目填写可选准备命令，例如 `bundle install` 或 `pnpm install --frozen-lockfile`。
4. 等待状态变成“可用”。失败时直接在页面查看失败项目、阶段和错误摘要。

只有存在 ready 项目环境时，smoke 才会创建 Agent。脚本按名称和 ID 稳定选择第一个 ready 环境，并让四种 Provider 共用它。

以下四 Provider smoke 是需要同时支持四种执行器时的扩展验收，不是首次启用的前置条件；它会调用真实模型。执行前，先在运行服务的系统用户下完成所有四种 Provider 的配置，包括上文的 DeepSeek Harness 安装与凭据准备，以及 Hermes 模型配置和 ACP 检查。服务启动 Provider 时会把这些静态配置复制到 Agent 的独立 Provider Home：

```bash
sudo -u remote-agent -H hermes model
sudo -u remote-agent -H hermes acp --check
```

然后用 `--prepare` 创建或复用四个固定名称的 Agent。该模式只确保并打印 Agent ID，**不会**创建 Session/Run，也不会调用 doctor。匹配 0 条时创建、1 条时复用或重新启用；同名同 Provider 多于 1 条时会以非零退出并打印所有冲突 ID，必须人工清理后再继续，不能任选一条。

两个 smoke 脚本都会自动读取当前目录的 `.env`，进程环境优先，无需在 Shell 中加载配置。若服务端口不同，显式设置 `SMOKE_BASE_URL`。

```bash
sudo -u remote-agent -H bash -lc '
  cd /opt/remote-agent-server
  pnpm --silent smoke:providers --prepare
'
```

`hermes model` 是交互式模型配置；按组织许可完成后再进行真实 smoke。

随后运行：

```bash
sudo -u remote-agent -H bash -lc '
  cd /opt/remote-agent-server
  pnpm smoke:providers
'
```

该脚本通过 HTTP API 按 Claude Code、Codex、Hermes、DeepSeek Harness 顺序执行：确保固定 smoke Agent 存在并通过应用 doctor、创建新 Session、发送“只回复当前工作目录的目录名”、等待成功、在同一 Session 发送“只回复你上一轮看到的目录名”、等待成功，并读取第二轮 Run 的事件历史。每一步都会打印 Provider、Agent ID、Session ID 和 Run ID。每次 HTTP 请求（包括 response body）都有 Abort deadline；Run 轮询的每次读取受该 Run 的剩余 `SMOKE_RUN_TIMEOUT_MS` 限制。任一 Provider 未安装/未登录、Session 续接失败、Run 失败、未知 Run 状态、超时或事件 `seq` 未从 1 严格连续递增，命令都会以非零退出。它不 mock Provider，也不会在 `pnpm test` 中联网。

Smoke 只覆盖四个 Provider 的顺序双轮真实连通性。仍须在目标服务器验收：两个不同 Session 并发、断开并重新连接 SSE 后 `seq` 不缺失/不重复、Session 修改不污染项目环境或另一个 Session、浏览器任务只在该 Session 的 `browser/` 产生 Profile、服务重启把在途 Run 标为 `failed/server_restarted` 且不重放输入。

### 6.1 验证模型目录与模型策略

需要固定模型或按 UTC 自动切换时，先确认目标 Agent Core 确实通过 ACP 暴露了模型目录。管理台打开 **Agent → 目标 Agent → 设置 → 模型策略** 时会执行同一项检查，也可以直接调用管理 API：

```bash
export REMOTE_AGENT_URL=http://127.0.0.1:3000
export API_TOKEN='<服务器 .env 中的 API_TOKEN>'
export AGENT_ID='<目标 Agent ID>'

curl --fail-with-body \
  -H "Authorization: Bearer $API_TOKEN" \
  "$REMOTE_AGENT_URL/api/agents/$AGENT_ID/models"
```

可用响应包含 `supported: true`、`currentModel` 和非空 `availableModels`。`supported: false` 表示该 Core 只能使用默认模型行为，不能通过 Remote Agent Server 配置固定或定时策略；不要手填模型 ID 绕过目录。

在页面保存固定策略，或保存带 UTC 星期、多个 24 小时时间段和可选并发上限的规则组后，创建真实 Run 并检查实际解析结果。同一规则组内的时间段应共用模型与并发；结束早于开始的时间段会跨到下一 UTC 日。并发切换还应通过同时提交多个 Session 的 Run 验证，确认命中时间段时使用窗口上限、未命中时回到 Agent 默认值，并始终受系统全局上限限制：

```bash
export RUN_ID='<刚完成的 Run ID>'

curl --fail-with-body \
  -H "Authorization: Bearer $API_TOKEN" \
  "$REMOTE_AGENT_URL/api/runs/$RUN_ID"
```

响应的 `resolvedModel` 应与 Run 真正开始时命中的策略一致。验收定时策略时，同时核对 UTC 星期、24 小时时间和 Run 的实际开始时间，不使用本地星期、提交时间或排队时间。第二个 Run 可以继续使用同一个 Session；模型变化不应创建新的 Session、Workspace 或 Conversation，也不应丢失上一轮 Provider 对话上下文。

## 7. 外部系统接入

### 用量采集与导入目录

用量账本和归因表保存在现有 SQLite 中，无需部署外部遥测服务。管理统计使用 `/api/usage/*`；单次 Run 的 `usage` 是该次执行的观测，不作为跨运行累计值。服务管理的 MCP 使用本地观察包装，Unix socket 位于私有临时目录，正常关闭会清理，无需开放观察端口。备份与迁移见[升级指南](#8-升级备份与恢复)。

托管的 Codex／Claude Code Session 日志在启动恢复、Run 收尾、维护前和 Runtime 关闭后尝试采集；未登记来源的日志也参加恢复，失败状态持久保留。不扫描服务用户的任意个人日志，也不启用 Claude Code 原生遥测。外部来源默认关闭。需要显式文件导入时，在 `.env` 增加绝对路径映射，例如：

```dotenv
USAGE_IMPORT_ROOTS='{"manual":"/srv/remote-agent/usage-imports"}'
```

目录由运维创建和授权，只放本次需要导入的数据。来源登记要求管理 Token、目录 ID、相对路径、来源 Session 到业务 Session／epoch 的映射；拒绝任意绝对文件路径、远端 URL 和越界符号链接。上下文快照使用本项目的 `context-snapshot-v1` 格式，不宣称兼容某第三方的原生导出。逐步操作、合成示例和查询命令见[用量分析指南](agent-usage.md)。

累计能力占用默认使用 Codex／Claude Code 原生会话日志，兼容现有登录方式，无需清库或增加配置。升级后未变化的已完成日志不会自动全量重放；追加记录时按新解析器重建，已结束 Codex 会话的旧估算可按[用量分析指南](agent-usage.md)对指定来源手动重建。重建保留已提交游标，失败后可继续采集；不恢复已删除的原文，也不重复计入上报总量。需要直接请求输入证据时，可配置 `USAGE_CAPTURE_UPSTREAMS`，例如 `{"codex":{"baseUrl":"https://api.openai.com/v1","protocol":"responses","apiKeyEnv":"USAGE_OPENAI_API_KEY"}}`，并由 Secret 管理方式向服务注入对应 key。配置明确切换到指定 API-key 上游，不沿用本机 OAuth／Bedrock／Vertex 凭据。采集入口仅监听 loopback，按 Session／epoch 隔离，无需开放防火墙端口；只在下一次服务启动生效。不要把 key 放入 JSON、命令参数或文档。未启用 HTTP 采集时自动使用日志重建估算。配置 HTTP 采集的 Provider 由请求采集负责归因，原生日志仍补充上报总量，避免两套输入重复相加。

转发过程中只使用有界内存解析正文，超限、缺失及中断显式显示采集不完整；不会将模型原文写入新账本。服务必须能访问配置的上游，并给受信任的托管 Provider 进程访问本地入口的权限。上线验收应使用专门测试 Session 核对一次真实请求的上报用量和具体 MCP 身份；仓库的受控协议测试不能替代该环境验收。

JSONL 日志采用 64 KiB 流式缓冲，整文件不设 16 MiB 上限，单行仍最多 16 MiB；上下文快照保持单文件 16 MiB 上限。单来源采集限时 30 秒，同来源串行；完成的请求上下文、上报计数及 checkpoint 在读取下一条记录前提交，超时保留已提交统计。可恢复来源在一轮采集结束、冷却 30 秒后重新入队，历史回填无需先完成；sources API 与界面显示采集状态。快照原位更新时递增 revision；文件轮换／替换需新 sourceKey。新的归因账本只保存计数和关联，不保存请求／工具正文；导入根目录的原文件由操作者管理，备份数据库不会自动备份它们。

工具内容估算默认启用，不需要 `USAGE_CAPTURE_UPSTREAMS`。MCP 包装进程就地估算文本，只发送计数元数据；Runtime 事件按 Run 模型配置估算，未知模型使用文本兜底。升级后后台从已完成 Run 的保留事件回补，优先处理较新的 Run，每批最多遍历 100 条事件、通常读取最多 4 MiB 工具正文，单事件最多 16 MiB；较大的单条事件独占一批。进度持久化，重启续做，页面自动刷新 `contentBackfill` 状态。损坏或超限事件记为明确缺口并继续处理其他记录；回补不复制原文，不把回补日期当使用日期。大型历史库会增加读 I/O 和少量计量元数据/WAL 写入，应观察处理进度；无须全库导出或执行 VACUUM。

Reset／存储清理先冻结来源并尝试提交尾部数据。Reset 采集超时返回 `usage_collection_pending`，保留源和维护占用，重试或重启续做；存储清理的采集失败或超时只记录缺口并继续删除，清理后缺口仍可查询。存储删除或数据库收尾失败通过既有维护状态恢复。清理保留已有统计，显式删除 Session 才撤销映射并清除其统计。停止服务会等待已接纳清理与采集收尾；部署工具需允许这一关闭阶段完成。

HTTP 采集收尾按 Session 隔离，每次传输结束后的计量最多等待 30 秒；清理前的来源发现等采集准备也限时 30 秒。HTTP 超时保留 `capture_processing_timeout`，已有用量仍可查询。存储清理后的缺口标为不可自动重试，不应以失败总数归零作为清理成功条件；可恢复数量查看 `retryableCollectionFailureTotal` 和 `sourceRecoveryCounts`。

### 7.1 创建接入端点并保存 Token

管理员在“外部接入”页面创建 Endpoint，选择一个已启用且项目环境可用的 Agent。Endpoint Token 只在创建或轮换成功后展示一次，服务端只保存哈希，离开提示页后不能找回。应立即把 Token 放进调用方的 Secret 管理系统；不要写入 Git、请求日志、Webhook Header 或 Remote Agent Server 的 `.env`。

管理端使用全局 `API_TOKEN`，外部调用方只使用所属 Endpoint Token。两者不能互换，Provider 进程和项目准备命令也不会继承这两个服务管理/验收 Token。Endpoint Token 虽然不能调用管理 API，但可以向 `approve-all` Agent 发送指令；它只适合受信任系统，不是不受信任租户的安全隔离。Provider 登录状态和服务用户可读取的文件仍属于 Agent 的信任边界。下面用占位符演示调用；生产环境应从 Secret 管理系统注入变量：

```bash
REMOTE_AGENT_URL=https://agent.example.com
ENDPOINT_SLUG=example-ticket
ENDPOINT_TOKEN='<创建 Endpoint 时只展示一次的 Token>'

curl --fail-with-body \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  -H 'Content-Type: application/json' \
  -X POST "$REMOTE_AGENT_URL/integration/v1/endpoints/$ENDPOINT_SLUG/tasks" \
  --data '{
    "requestId":"ticket-1332-event-1",
    "conversationKey":"ticket-1332",
    "message":"分析并处理这个工单",
    "parameters":{}
  }'
```

`requestId` 是调用方生成的幂等键。同一 Endpoint 下，用相同内容重试相同 `requestId` 会返回原 `taskId`、`sessionId` 和 `runId`，不会再次执行；相同 `requestId` 携带不同内容返回 `409 idempotency_conflict`。`conversationKey` 相同的多轮 Task 严格串行并复用同一个 Session；不需要续接时可以省略它。

提交返回 `202` 不表示 Agent 已完成。调用方必须保存 `taskId`，并以查询接口作为最终状态依据：

```bash
TASK_ID='<提交返回的 taskId>'
curl --fail-with-body \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  "$REMOTE_AGENT_URL/integration/v1/tasks/$TASK_ID"

curl --fail-with-body \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  "$REMOTE_AGENT_URL/integration/v1/tasks/$TASK_ID/events?afterSeq=0"
```

Task 状态为 `queued`、`running`、`succeeded`、`failed` 或 `cancelled`。查询和 Event 历史是可靠性基础；SSE 和 Webhook 不替代查询。

外部 Event 查询和 SSE 只返回公开投影：Agent 输出消息可见，工具仅包含 ID、标题、kind 和状态等白名单元数据，不包含原始输入输出、Provider 私有字段或内部错误。完整执行轨迹仅在内部 Session 和管理界面查看。

### 7.2 SSE 断线续读

实时页面可连接：

```text
GET /integration/v1/tasks/:taskId/events/stream?afterSeq=<最后已处理的 seq>
Authorization: Bearer <Endpoint Token>
Accept: text/event-stream
```

每处理并持久化一个 Event，就保存它的 `seq`。连接断开后先请求 `/events?afterSeq=<seq>` 补齐，再用同一个 `afterSeq` 重新连接 SSE；接收方按 Event `id` 去重。服务每 20 秒发送一次 `: heartbeat`。代理 idle timeout 必须大于 20 秒，并关闭响应缓冲；以 Nginx 为例：

```nginx
location /integration/v1/ {
    client_max_body_size 30m;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
}
```

客户端、负载均衡器或代理仍可能主动断开长连接，因此调用方必须设置重连和查询兜底。SSE 断开只影响实时显示，不会取消或暂停 Task。

### 7.3 Webhook 验签和重试

Webhook 创建成功时，签名密钥与 Endpoint Token 一样只展示一次。每次请求包含：

```text
X-Remote-Agent-Event: message.agent.reply
X-Remote-Agent-Event-Id: <稳定 eventId>
X-Remote-Agent-Timestamp: <Unix 秒>
X-Remote-Agent-Signature: v1=<hex HMAC-SHA256>
```

签名原文是 `timestamp + "." + 原始 HTTP Body 字节`，密钥是创建 Webhook 时得到的 signing secret。必须在 JSON 解析前读取原始 Body，并使用恒定时间比较；不要对 JSON 重新格式化后再验签。Node.js 最小示例：

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const expected = createHmac("sha256", signingSecret)
  .update(`${timestamp}.${rawBody}`)
  .digest("hex");
const actual = signature.startsWith("v1=") ? signature.slice(3) : "";
const valid = actual.length === expected.length
  && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
```

验签成功后用 `eventId` 幂等处理。服务采用至少一次投递：网络失败或非 2xx 会自动重试，所以同一事件可能收到多次。Webhook 投递失败不改变 Task 结果；调用方应在处理成功后返回 2xx，并在管理页面检查 Delivery 状态。

Webhook 只发送明确的 Task 状态、用户消息、Agent 最终回复、系统通知和脱敏工具状态，不发送 Agent thought、原始工具输入输出、MCP 密钥或 Provider 私有数据。

Integration Task 因持久化基础设施错误在单进程内完成首次尝试加 3 次延迟重试后，会保持 `queued` 并输出一条 `integration_retry_exhausted taskId=<id>`。该报告不包含请求内容、Token 或原始异常；排除基础设施问题后重启服务会重新获得该 Task 的重试预算。

### 7.4 结束 Conversation 和常见错误

确认该 Conversation 没有 `queued` 或 `running` Task 后，可以结束续接关系：

```bash
CONVERSATION_KEY=ticket-1332
curl --fail-with-body \
  -H "Authorization: Bearer $ENDPOINT_TOKEN" \
  -X POST \
  "$REMOTE_AGENT_URL/integration/v1/endpoints/$ENDPOINT_SLUG/conversations/$CONVERSATION_KEY/end"
```

历史 Session 和 Run 会保留。之后用相同 `conversationKey` 提交 Task 会创建新 Session。

- `401 invalid_endpoint_token`：Token 缺失、错误或已经轮换。检查调用方使用的是该 Endpoint 的 Token，不是管理 `API_TOKEN`。
- `409 idempotency_conflict`：同一 `requestId` 已用于不同请求。重试必须保持原请求不变；新业务请求应生成新的 `requestId`。
- `409 conversation_busy`：Conversation 仍有排队或执行中的 Task，暂时不能结束；继续查询 Task 终态后再试。

### 7.5 真实外部接入 smoke

先在管理页面选择一个已启用、项目环境可用、Provider doctor 通过且没有未映射必填 Session 参数的 Agent，记录 Agent ID。然后在 **Remote Agent Server 同一台主机**运行：

```bash
cd /opt/remote-agent-server
export SMOKE_BASE_URL=http://127.0.0.1:3000
export SMOKE_API_TOKEN='<目标服务器 .env 中的 API_TOKEN>'
export SMOKE_AGENT_ID='<待验收 Agent ID>'
pnpm smoke:integrations
```

脚本会创建临时 Endpoint、一次性 Token、Webhook Subscription 和本机临时 HTTP receiver；不会向第三方发送数据。receiver 对第一条 `message.agent.reply` 返回 500、第二次返回 204，以验证自动重试和 HMAC。脚本还会验证：

1. 第一轮 Task 成功，Event `seq` 连续，查询与 SSE 的 `afterSeq` 续读结果一致。
2. 重复 `requestId` 返回相同 Task/Run，没有第二次执行。
3. 同一 Conversation 第二轮复用 Session，但创建新的 Run。
4. Agent reply Delivery 自动重试成功、签名有效且 `dispatchOrder` 单调。
5. 结束 Conversation 后，相同 Key 的第三轮创建新 Session。

每个 HTTP 请求和响应 Body 读取都有 Abort deadline。失败时命令非零退出并打印已经取得的 Endpoint、Task、Session、Run 和 Delivery ID，不打印 Token 或 signing secret。脚本默认不删除记录，便于在管理界面审计；确认无用后由管理员手动停用 Endpoint。可用 `SMOKE_TASK_TIMEOUT_MS`、`SMOKE_REQUEST_TIMEOUT_MS` 和 `SMOKE_POLL_INTERVAL_MS` 调整等待时间。

## 8. 升级、备份与恢复

### 升级步骤

1. 记录当前代码版本和服务配置，在维护窗口正常停止服务。
2. 备份下表中的持久数据。使用停止后的完整数据副本或 SQLite 一致性备份；不要在服务写入时只复制主库，也不要单独删除 WAL。
3. 切换到目标版本，使用 Node.js 22，执行 `pnpm install --frozen-lockfile`、`pnpm build` 和 `pnpm run doctor`。
4. 启动服务。数据库迁移自动执行，后端与管理页面应使用同一版本；大库首次建立索引需要额外时间和磁盘空间。
5. 检查健康接口、管理台和历史记录，再完成一条实际 Provider 任务及需要的外部接入流程。健康检查通过只说明服务可访问。

| 备份对象 | 内容与恢复要求 |
| --- | --- |
| `.env` 与服务启动配置 | 存储路径、认证配置和服务用户；按敏感文件保管。 |
| `DATA_DIR` | SQLite 数据库及仍存在的 WAL、`secret.key`、Agent 配置、Skills 来源与版本、托管 Provider 数据和词表缓存。数据库与密钥必须配套恢复，丢失密钥无法解密已有敏感值。 |
| `PROJECT_ENVIRONMENTS_ROOT` | 已发布环境版本及其引用，使用对应文件系统的备份方式。 |
| `SESSIONS_ROOT` | Session 工作区、浏览器数据与 Session 运行目录；需要继续原会话时一并保留。 |
| 服务用户的 Provider 配置 | 按所用 CLI 的方式安全备份登录状态和宿主配置；Git／SSH 凭据同样由宿主管理。 |

回退时先停止新服务，恢复升级前匹配的代码、配置和一致数据备份，再启动检查。UTC 统计表结构及输入展示元数据清理与旧版本不兼容，不能只回退代码。备份文件应限制访问，避免将凭据或运行数据提交到仓库。

### Skills Git 来源与版本升级

Skills 来源复用服务用户的 Git／SSH 凭证。为该用户配置无交互 Git 访问、SSH 主机信任和只读仓库权限；URL 中不要嵌入 Token 或密码。支持 HTTPS、SSH 和 `git@host:group/repository.git`，不接受本机目录或 `file://` 来源。来源刷新不运行安装命令，Git Hook 被禁用。

刷新来源只发现版本，独立 Skills 仍需在 Agent 中明确应用或回退。备份整个 `DATA_DIR`，包括 `skill-sources/`、`skill-revisions/`、`skill-library/` 和 `agents/`；版本历史暂不自动回收，需预留完整包副本的空间。历史 Run 没有记录过的 `skillsRevision` 保持 `null`。

原生插件 Skills 在“扩展”页随所属插件启停，技能页标为“随插件更新”。宿主插件更新在后续 Run 生效，发现缓存默认最多 30 秒。升级前的独立插件 Skill 副本和版本历史保留：只有归属明确且已有启用的原生技能承接时，才在下一次 Run 交由插件接管；接管标记随 `agents/` 备份。其他副本（包括 Hermes）仍标为“旧插件独立副本”，可独立使用或停用。服务不会因旧副本启用而自动启用整个插件。

升级首次启动会自动扩展 Agent 表的 Provider 约束，以允许 `deepseek_harness`；该事务仅重建 Agent 表，保留原有 ID、关联记录和自增序列。升级前仍需按本节备份数据库与 `secret.key`。

旧版 Hermes 的 Agent Home 会在继续相应会话时迁移到 Session 独立 Home。升级前保留原 Home；状态缺失或不兼容会明确报恢复失败，并保留业务 Session、Workspace 和 Run 历史。核验备份后再恢复，或明确重建执行器会话后重试。

### Provider 验收与排查

来源刷新、Skill 投影和模型执行分别验证。应用或回退 Skill 后，用实际 Provider 检查读取结果和预期产物；`skillsRevision` 用于核对版本，Run 状态不能代替业务结果验收。

| 问题 | 优先检查 |
| --- | --- |
| CLI 不存在、版本或模型不兼容 | 服务进程的 PATH、ACP 适配器实际调用的 CLI 与模型目录；更新宿主 CLI 不一定改变适配器使用的版本。 |
| 认证失败或模型无权限 | 服务用户实际加载的登录状态、环境变量和账号模型权限。 |
| 上游不可用或无模型通道 | Provider 的网络和模型服务；恢复后再重试任务。 |
| Skill 已应用但结果不符合预期 | Run 的 `skillsRevision`、实际读取内容、最终回复及产物。 |

真实检查命令见[首次任务验收](#6-完成首次任务与可选-provider-验收)。历史验证记录只反映当时版本与环境。

### Session 存储清理与恢复

Session 存储清理删除 Workspace、浏览器数据、Provider 原生会话、附件内容，以及该 Session 下全部 Task 的 Webhook 投递记录；删除后的投递停止重试。Session／Run 元数据、Task／Conversation 关联、最终回复和 Token 统计保留。原始消息／工具正文按下方独立的事件保留策略处理。重建执行器会话保留工作区、附件和投递记录；永久删除 Session 则移除其历史与统计。

服务在启动时先恢复创建中断的目录清理和已登记的清理、删除或重置，再调度 Run。存储清理前会尝试采集尾部用量；采集失败或超时会保留已有统计和缺口，并继续清理。

出现 `session_maintenance_recovery_failed sessionId=<id> operation=<operation>` 时，Session 会保持占用，防止复用部分删除的目录。修复磁盘或权限后，自动清理会在后续轮次重试；手动删除和重置可重试原管理 API，也可在下次启动时恢复。关闭自动清理不取消已开始的维护。

创建失败且目录无法删除时，可能保留 `workspace_path` 为 `pending:` 的记录供启动恢复。不要手工改为空闲；已失去记录的孤立目录需依据备份核验。

### 图片与普通文件附件

消息端点接受最多 20 MiB 的解码附件，base64 会扩大请求体。反向代理应允许至少 30 MiB 请求体，覆盖 `/api/sessions/`、`/api/integration-endpoints/` 和 `/integration/v1/endpoints/` 的消息提交；Nginx 可设置 `client_max_body_size 30m;`。应用仅对 Run、外部 Task 和管理测试 Task 提交放宽到约 28 MiB，其余路由维持原限制。

附件内容存储在 SQLite BLOB 中，执行时还会在 Session 工作区保留副本；容量与备份应同时覆盖数据库和工作区。存储到期后清除内容，保留名称、类型、大小等元数据。重建执行器会话保留附件，永久删除 Session 删除附件记录。文字与参数的 JSON 内容（不含 `attachments`）仍限制为 1 MiB。

## 本地模型分词配置

已知模型首次计量时自动获取固定版本官方 JSON 词表，校验 SHA-256 后缓存到 `DATA_DIR/tokenizers`，后续可离线复用。服务需要能访问 Hugging Face 的公开 HTTPS 资产与重定向端点；失败后尝试 HF-Mirror，同样校验摘要。不发送计数正文、不下载模型权重。全部失败时保留等待状态并在 60 秒后重试，不给已知模型写入字符兜底值。

`USAGE_TOKENIZERS` 支持本地绝对路径与 SHA-256，优先于自动映射；手动资产在启动时校验，损坏或绑定冲突会使启动失败。默认 `[]` 使用内置映射，未知模型显示通用文本估算。自动模型列表、离线准备和配置示例见[词表指南](agent-usage.md#配置多模型词表)。

下载与大文本计量在后台进行，不阻塞模型执行，但会增加采集延迟和 Worker 内存占用。词表就绪后自动补算仍有原文的 Runtime 记录，并按持久游标续做；已经删除的正文无法重新分词。历史重算与手动来源重建见[用量指南](agent-usage.md#历史兜底估算与重算)。

## 用量数据保留与维护

### 原始事件保留

`USAGE_EVENT_RETENTION_DAYS=7` 默认启用原始 message／tool 正文清理，设为 `0` 关闭。它独立于 `SESSION_RETENTION_HOURS` 和工作区保留设置。Run 结束超过保留期、Session 空闲且该 Run 内容计量与词表补算完成后，后台分批清理正文。计数失败、缺失或补算落后会推迟清理；已知零和明确不支持计数的媒体不阻止清理，未知值不补零。

最终回复、输入、状态／错误、Token 统计和关联继续保留；过期正文接口返回 410。正文清理后不能用于历史回补或重新分词，升级前已删除的内容不会自动恢复。需要长期重算时，在升级启动前延长或关闭保留期。导入目录、公共 Task 事件及 Provider Home 不由这项规则删除。

### Usage 明细保留

`USAGE_DETAIL_RETENTION_DAYS=7` 默认启用，仅扫描 `storage_cleaned_at` 已写入、空闲且无维护或 queued/running Run 的 Session。整个 Session 的全部 Run 必须结束至少 7 天，最新上下文／对话明细时间也必须超过同一截止时间；尚未清理存储的 Session 不受影响。它不会修改数据库中的 Session 保留设置，也不会改变 `SESSION_RETENTION_HOURS` 或原始事件保留期。

处理前确认来源已停止采集、保留原文的 Run 已完成无错误回填，以及请求计数和每日排名均已准备完成；空对话计数、缺失／失败回填或脏汇总会推迟处理。然后事务性发布归档标记，以已有日汇总作为历史依据，再每批删除最多 250 行 exposure、context input 或 conversation content。重启继续未完成批次；已发布的明细立即标为过期，分批删除不会使统计逐步减少。

归档保留 Provider 账本、请求总量、调用及计量来源、跨日去重关联和每日汇总，保持原统计口径。归档后停止该 Session 的重新采集、词表重算及迟到写入，避免把不完整明细重新汇总。需要保留长期明细或重算能力时，应在升级启动前将此项设为 `0` 或延长天数；设为 `0` 也会暂停已发布归档的剩余删除，但不会撤销过期状态或恢复已删行。恢复明细需要一致的历史备份，不能仅删除归档标记或回退到不了解归档的旧程序。

这项处理不会自动 checkpoint、VACUUM、重启服务或缩小 Btrfs／根盘镜像。释放的 SQLite 页面供后续复用，磁盘文件是否缩小应按下文单独维护和核验。

### 升级与后台准备

重启时，遗留的来源 `collecting` 状态转为 `failed / usage_collection_interrupted`，已提交的采集游标、采集 ID 和用量保留。有 active 映射的来源自动续采；只有 retained 映射的来源不自动重试，但不会因遗留的采集状态永久卡住明细清理。当前进程真正进行中的采集仍阻止归档。

用量账本、统计投影和清理游标都在现有 SQLite 中，无需外部数据库或遥测服务。迁移自动建立所需表和索引，后台按批准备历史统计并回收重复 payload、展示 JSON、身份哈希和无引用估算。保留去重身份、计数及证据关联；重启从已提交进度继续。首次升级大库需预留索引、统计表和 WAL 空间。

未准备完成的统计范围使用现有明细计算，较大查询可能返回 `503 usage_query_timeout`。缩小日期范围，或等待后台准备后刷新。查询使用有界队列的只读 Worker；它们仍消耗 CPU、I/O 和内存，长读事务也可能延长 WAL 保留。

管理鉴权下读取 `/api/usage/status`，可检查：

| 字段 | 用途 |
| --- | --- |
| `recovery` 中的各项 `*ProjectionPending` | 账本、输入与每日排名的统计准备进度。待准备不等于原统计丢失。 |
| `recovery` 中的各项 `*CompactionPending` | 旧副本清理是否到达已登记范围。 |
| `eventRetention.skippedByReason` | 原始事件清理为何推迟，例如 `counting_incomplete` 或 `backfill_incomplete`。 |
| `detailRetention` | 明细保留天数、每步耗时、检查／删除行数、完成 Session 数、跳过原因及错误时间。`projection_pending` 需等待汇总；`backfill_incomplete` 需核对内容计量。 |
| `detailsExpired` | 当前筛选范围是否包含已过期明细；统计仍保留。 |
| 各 `compacted*`、`retiredEvents`、`retiredRows`、`retiredSessions` 与耗时 | 当前进程处理量和诊断信息；重启会清零，不代表数据库剩余数量。 |

不要为释放空间手动标记补算完成。完整字段及查询期限见[用量指南](agent-usage.md#如何读报表)。

管理统计统一按 UTC 自然日。API 的 `from` 向日初取整，非日界线的 `to` 向下一日取整，日初结束仍为排他上界；使用响应中的实际范围，不再传 `timezone`。统计 API 默认允许最多 30 秒旧快照，保留实际 `asOf`／`revision` 和 `stale`；人工核对可对 summary、timeseries 或 capabilities 传 `fresh=1`。

### 请求输入展示元数据去重

请求输入汇总不再逐行复制能力展示 JSON，查询从保留的曝光记录读取元数据；已归档 Session 从冻结的每日展示汇总读取。历史副本按批清理，不重算 Token 或删除证据；`recovery.rankingInputMetadataCompactionPending` 与 `compactedRankingInputMetadata` 显示进度。

旧代码依赖这些副本，清理后不能只回退代码；恢复升级前的一致备份，或先从保留的曝光明细重建汇总。UTC 每日排名表结构也应随匹配版本一起恢复。

### 数据库空间

逻辑清理释放的 SQLite 页可供后续写入复用，主库与 WAL 不保证立即缩小。服务不会自动执行全库 `VACUUM`、强制截断 WAL 或清空账本。需要物理压缩时，另行安排备份、足够磁盘空间和维护窗口；不要在活动服务中直接执行全库压缩。
