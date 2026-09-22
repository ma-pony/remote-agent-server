# Remote Agent Server 部署与验收

Remote Agent Server 是面向业务系统的自托管 ACP Agent 执行网关。生产部署需要同时保证四条链路可用：外部 HTTP 接入、Provider/ACP 执行、项目环境与 Session Workspace、Event/Webhook 返回。本指南覆盖 macOS 和 Linux 的单机、单进程部署，并使用真实 Provider 和 Integration Task 完成验收。产品边界与执行链路见[产品与架构](design.md)。

服务支持两种原生写时复制 Workspace：macOS 使用 APFS Clone，Linux 使用 Btrfs Snapshot。运行时会根据操作系统自动选择，不提供普通目录复制回退。它以 acpx 的 `approve-all` 模式运行 Claude Code、Codex 或 Hermes。`approve-all` 只减少 Provider 的交互确认，**不是安全沙箱**；Workspace 中的代码、网络和该用户能访问的文件都应视为 Agent 可操作范围。

## macOS：APFS 原生部署

macOS 部署应使用实际登录桌面的普通用户，不使用 root，也不放入无图形会话的系统级 Daemon。这样 Claude Code、Codex、Hermes 的登录状态和有头浏览器都属于同一个用户会话。

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

以运行服务的同一个 macOS 用户安装并登录实际使用的 Provider。例如，选择 Codex 后执行 `codex login`；选择 Claude Code 后执行 `claude auth login`。不要求安装全部 Provider。安装入口见 [Claude Code](https://code.claude.com/docs/en/getting-started)、[Codex CLI](https://developers.openai.com/codex/cli) 和 [Hermes Agent](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart/)。

### 3. 启动并打开管理台

```bash
pnpm start
```

`pnpm start` 先构建服务端和管理台，再启动服务。程序自动读取工作目录的 `.env`，无需 `source`；已有进程环境变量优先。打开 `http://127.0.0.1:3000`，从 `.env` 复制 `API_TOKEN` 的值到登录页，按“项目环境 → 智能体 → 会话”完成首次任务。新配置仅监听本机。

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

命令自动生成 `.env`、随机 Token 和全部存储路径；已有配置不会被覆盖。只有需要改变端口、监听地址或显示环境时才手动编辑 `.env`，无需再次生成 Token。程序自动读取该文件，进程环境优先；使用绝对路径，不写 `$HOME`、`~` 或 Shell 表达式。不要提交 `.env`，不要在仓库或 systemd unit 中硬编码 Provider 凭证。Claude/Codex 的原生登录状态由该系统用户保存；Hermes 的原生状态使用后文每个 Agent 的 `HERMES_HOME`。服务建议只监听内网；若需要跨网络访问，放在 TLS 反向代理后，并仅把 Bearer Token 分发给可信调用方。

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

## 6. 完成首次任务与可选 Provider 验收

首次启用只需选择一个实际使用的 Provider，完成一条真实任务并核对结果。先打开管理页面的“项目环境”：

1. 创建一个项目环境。
2. 添加至少一个服务用户能够访问的 Git 项目；一个环境可以包含多个项目。
3. 按项目填写可选准备命令，例如 `bundle install` 或 `pnpm install --frozen-lockfile`。
4. 等待状态变成“可用”。失败时直接在页面查看失败项目、阶段和错误摘要。

只有存在 ready 项目环境时，smoke 才会创建 Agent。脚本按名称和 ID 稳定选择第一个 ready 环境，并让三种 Provider 共用它。

以下三 Provider smoke 是需要同时支持三种执行器时的扩展验收，不是首次启用的前置条件；它会调用真实模型。执行前，先在运行服务的系统用户下完成 Hermes 模型配置和 ACP 检查。服务启动 Provider 时会把这些静态配置复制到 Agent 的独立 Provider Home：

```bash
sudo -u remote-agent -H hermes model
sudo -u remote-agent -H hermes acp --check
```

然后用 `--prepare` 创建或复用三个固定名称的 Agent。该模式只确保并打印 Agent ID，**不会**创建 Session/Run，也不会调用 doctor。匹配 0 条时创建、1 条时复用或重新启用；同名同 Provider 多于 1 条时会以非零退出并打印所有冲突 ID，必须人工清理后再继续，不能任选一条。

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

该脚本通过 HTTP API 按 Claude Code、Codex、Hermes 顺序执行：确保固定 smoke Agent 存在并通过应用 doctor、创建新 Session、发送“只回复当前工作目录的目录名”、等待成功、在同一 Session 发送“只回复你上一轮看到的目录名”、等待成功，并读取第二轮 Run 的事件历史。每一步都会打印 Provider、Agent ID、Session ID 和 Run ID。每次 HTTP 请求（包括 response body）都有 Abort deadline；Run 轮询的每次读取受该 Run 的剩余 `SMOKE_RUN_TIMEOUT_MS` 限制。任一 Provider 未安装/未登录、Session 续接失败、Run 失败、未知 Run 状态、超时或事件 `seq` 未从 1 严格连续递增，命令都会以非零退出。它不 mock Provider，也不会在 `pnpm test` 中联网。

Smoke 只覆盖三个 Provider 的顺序双轮真实连通性。仍须在目标服务器验收：两个不同 Session 并发、断开并重新连接 SSE 后 `seq` 不缺失/不重复、Session 修改不污染项目环境或另一个 Session、浏览器任务只在该 Session 的 `browser/` 产生 Profile、服务重启把在途 Run 标为 `failed/server_restarted` 且不重放输入。

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

用量账本和归因表保存在现有 SQLite 中，无需部署外部遥测服务。升级前按既有流程备份 SQLite 和 `secret.key`；首次启动创建新的 `agent_usage_*` 表并幂等保留旧 Session／Run 计数为未验证证据，不把它们补成精确账单。现有 `usage` API 保持语义。服务管理的 MCP 增加本地观察包装，Unix socket 位于私有临时目录，正常关闭会清理；没有需要对外开放的观察端口。

已有归因数据升级时，首次启动会回填首次结果索引、证据排序键和估算元数据字典，需要读取历史数据并写入 SQLite/WAL；按数据库规模预留启动时间和磁盘空间。迁移幂等，完成后不逐次重建；不会截断历史或自动执行全库 VACUUM。迁移释放的数据库页供后续写入复用，文件体积不保证立即缩小。

托管的 Codex／Claude Code Session 日志在启动恢复、Run 收尾、维护前和 Runtime 关闭后尝试采集；未登记来源的日志也参加恢复，失败状态持久保留。不扫描服务用户的任意个人日志，也不启用 Claude Code 原生遥测。外部来源默认关闭。需要显式文件导入时，在 `.env` 增加绝对路径映射，例如：

```dotenv
USAGE_IMPORT_ROOTS='{"manual":"/srv/remote-agent/usage-imports"}'
```

目录由运维创建和授权，只放本次需要导入的数据。来源登记要求管理 Token、目录 ID、相对路径、来源 Session 到业务 Session／epoch 的映射；拒绝任意绝对文件路径、远端 URL 和越界符号链接。上下文快照使用本项目的 `context-snapshot-v1` 格式，不宣称兼容某第三方的原生导出。逐步操作、合成示例和查询命令见[用量分析指南](agent-usage.md)。

需要自动工具输入排名时，配置 `USAGE_CAPTURE_UPSTREAMS`，例如 `{"codex":{"baseUrl":"https://api.openai.com/v1","protocol":"responses","apiKeyEnv":"USAGE_OPENAI_API_KEY"}}`，并由 Secret 管理方式向服务注入对应 key。配置明确切换到指定 API-key 上游，不沿用本机 OAuth／Bedrock／Vertex 凭据。采集入口仅监听 loopback，按 Session／epoch 隔离，无需开放防火墙端口；只在下一次服务启动生效。不要把 key 放入 JSON、命令参数或文档。未启用 HTTP 采集时仍保留原生日志和执行观察能力，工具输入 token 继续显示未知。

转发过程中只使用有界内存解析正文，超限、缺失及中断显式显示采集不完整；不会将模型原文写入新账本。服务必须能访问配置的上游，并给受信任的托管 Provider 进程访问本地入口的权限。上线验收应使用专门测试 Session 核对一次真实请求的上报用量和具体 MCP 身份；仓库的受控协议测试不能替代该环境验收。

JSONL 日志采用 64 KiB 流式缓冲，整文件不设 16 MiB 上限，单行仍最多 16 MiB；上下文快照保持单文件 16 MiB 上限。单来源采集限时 30 秒，同来源串行并保存 checkpoint，失败保留已提交统计，sources API 与界面显示采集状态。快照原位更新时递增 revision；文件轮换／替换需新 sourceKey。新的归因账本只保存计数和关联，不保存请求／工具正文；导入根目录的原文件由操作者管理，备份数据库不会自动备份它们。

工具内容估算默认启用，不需要 `USAGE_CAPTURE_UPSTREAMS`。MCP 包装进程就地估算文本，只发送计数元数据；Runtime 事件按 Run 模型配置估算，未知模型使用文本兜底。升级后后台从已完成 Run 的保留事件回补，优先处理较新的 Run，每批最多遍历 100 条事件、通常读取最多 4 MiB 工具正文，单事件最多 16 MiB；较大的单条事件独占一批。进度持久化，重启续做，页面自动刷新 `contentBackfill` 状态。损坏或超限事件记为明确缺口并继续处理其他记录；回补不复制原文，不把回补日期当使用日期。大型历史库会增加读 I/O 和少量计量元数据/WAL 写入，应观察处理进度；无须全库导出或执行 VACUUM。

Reset／存储清理先冻结来源并提交尾部数据，超时返回 `usage_collection_pending`，保留源和维护占用，重试或重启续做。不要绕过该状态手工删除 Provider 文件。成功清理保留统计，显式删除 Session 才撤销映射并清除其统计。停止服务会等待已接纳清理与采集收尾；部署工具需允许这一关闭阶段完成。

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

## 8. 升级、Skills 与 Session 存储恢复

Webhook 投递历史查询的升级会在启动迁移时自动创建 `webhook_deliveries_subscription_recent` 索引，无需手动执行 SQL。首次创建需要读取现有投递记录；完成迁移并启动后，检查健康接口及管理台“事件回调”的投递记录，确认历史数据、筛选和最近投递摘要正常。

### Skills Git 来源与版本升级

Skills 来源复用服务用户的 Git/SSH 凭证。先为该用户配置无交互 Git 访问、SSH 主机信任和只读仓库权限；URL 中不要嵌入 Token 或密码。管理台支持 HTTPS、SSH 和 `git@host:group/repository.git`，不接受本机目录或 `file://` 来源。来源刷新不运行安装命令，Git Hook 被禁用。Git 地址、可选 ref 和路径保存在管理数据中，凭证仍由宿主 Git 管理。

备份和恢复时，除了 SQLite 与 `secret.key`，还应保留 `DATA_DIR/skill-sources/`、`skill-revisions/`、`skill-library/` 和 `agents/` 中的配置及安装内容。版本历史暂不自动回收，需为完整包副本预留磁盘空间。升级会自动添加可空的 `runs.skills_revision`，不会补写旧 Run 的版本。

Hermes 的 Provider Home 改为每个 Session 独立。首次继续旧会话时，服务读取旧 Agent Home 的配置及 `state.db` 并迁移对应会话；已有投影目录不会跳过初始化。升级前应正常停止旧服务并备份 Hermes Home。旧会话状态缺失或结构不兼容时会明确报恢复失败，保留业务 Session、Workspace 和 Run 历史；应核验备份或明确重置 Provider 上下文后重试。

### Provider 验收与已知限制

Git 来源刷新成功只证明目录已发布；应用 Skill 后还需使用实际 Provider 验证读取结果、资源更新和回退。`skillsRevision` 可用于核对投影版本，但不能代替业务输出检查。[2026-09-14 测试记录](superpowers/validation/2026-09-14-skill-source-updates.md)包含已通过的 Codex 三轮验证与其他 Provider 的阻塞证据。

- 模型提示需要更新版本 Codex 时，核对 ACP 适配器实际调用的 CLI 版本。适配器可能使用自带 CLI，仅更新宿主命令不一定生效；选择兼容模型，或单独升级适配器后重新验收。
- `Authentication required` 或 HTTP 403 `MODEL_ACCESS_DENIED` 时，检查服务进程实际加载的认证环境以及该账号的模型权限。
- HTTP 503、模型无可用通道时，先恢复上游模型服务，再重试验收；刷新 Skill 无法解决通道故障。

当前部分 Provider 会把这些模型错误作为普通回复返回，同时报告 `completed`，上层 Run 因而可能显示成功。这一错误状态传递问题尚未修复；上线验收必须检查回复或实际产物，不得只依赖状态字段。

### Session 存储清理与恢复

Session 存储清理成功时，也会删除通过 Task 关联的全部 Webhook 投递记录并停止后续重试；Task、Conversation、事件和 Token 统计仍保留。投递删除和清理完成标记在同一事务内提交，清理失败后按原流程恢复。此行为适用于升级后完成的清理；升级前已清理 Session 的历史投递不会在启动迁移中批量删除。

升级时按正常流程停止旧进程、备份数据库和 `secret.key`，再启动新版本。启动迁移会为现有 Session 增加可空的 `pending_operation` 字段；不会改写历史活动时间。服务在调度 Run 前，先重试创建中断的目录删除，并完成持久化标记中的清理、删除或重置。

如果出现 `session_maintenance_recovery_failed sessionId=<id> operation=<operation>`，对应 Session 会保持占用，以免使用已被部分删除的目录。排除磁盘或权限问题后，自动存储清理会在下一轮重试；手动删除和重置可以重试原管理 API，或在下次服务启动时恢复。关闭自动清理只停止新的清理任务，不取消已经开始的清理。

创建失败且目录无法删除时，服务会保留 `workspace_path` 为 `pending:` 的记录，供下次启动重试。不要手动把这些记录改成空闲。修复前已丢失数据库记录的孤立目录，以及已被错误刷新的活动时间，无法由本次迁移自动还原，需要依据备份或历史记录单独核验。

### 图片与普通文件附件

消息提交端点接受最多 20 MiB 的解码附件，base64 会扩大请求体。反向代理需要允许至少 30 MiB 的请求体，覆盖 `/api/sessions/`、`/api/integration-endpoints/` 和 `/integration/v1/endpoints/` 下的消息提交；Nginx 可在对应 `server` 或 `location` 中设置 `client_max_body_size 30m;`。应用仅对 Run、外部 Task 和管理测试 Task 的提交路由放宽到约 28 MiB，其余路由（包括原生 GitHub/GitLab Webhook）维持原限制。

升级自动创建 `message_attachments` 表，无需回填旧消息或引入新依赖。原始附件存储在 SQLite BLOB 中，执行时另在 Session 工作区保留副本，备份与容量规划应覆盖数据库、WAL 及工作区。Session 保留策略清除 BLOB 内容和工作区副本，但 SQLite 文件大小不保证立即缩小；释放的页可供后续写入复用。重置上下文不删除附件，过期清理和 Session 删除沿用既有可恢复维护流程。

文字与参数的 JSON 内容（不含 `attachments`）仍限制为 1 MiB，附件不会扩大纯文本的持久化上限。

## 本地模型分词配置

需要模型对应的工具 token 估算时，配置 `USAGE_TOKENIZERS`，把固定版本的词表与配置作为服务可读资产部署，填写绝对路径及 SHA-256。详细格式与可核验的 Qwen 示例见[用量分析指南](agent-usage.md#配置多模型词表)。服务只在启动时加载并验证有界普通文件，不运行模型、不自动联网下载；备份／迁移主机时同时保留配置和对应资产。资产损坏或模型绑定冲突使启动失败。默认 `[]` 仍保留 Provider 上报用量、工具调用、输入字节及上下文证据，工具 token 自动使用通用文本兜底估算；旧估算保留原计量版本。

未配置 `USAGE_TOKENIZERS` 时仍可使用工具 token 排名：服务使用带明确标记的通用文本兜底估算。配置真实模型词表可提高对应模型的估算依据；更换配置不重算历史统计。
