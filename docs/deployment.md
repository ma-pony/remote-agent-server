# Remote Agent Server 部署与真实 Provider 验收

本服务支持两种原生写时复制 Workspace：macOS 使用 APFS Clone，Linux 使用 Btrfs Snapshot。运行时会根据操作系统自动选择，不提供普通目录复制回退。它以 acpx 的 `approve-all` 模式运行 Claude Code、Codex 或 Hermes。`approve-all` 只减少 Provider 的交互确认，**不是安全沙箱**；Workspace 中的代码、网络和该用户能访问的文件都应视为 Agent 可操作范围。

## macOS：APFS 原生部署

macOS 部署应使用实际登录桌面的普通用户，不使用 root，也不放入无图形会话的系统级 Daemon。这样 Claude Code、Codex、Hermes 的登录状态和有头浏览器都属于同一个用户会话。

以下示例假设项目位于 `~/Projects/remote-agent-server`，运行数据位于 `~/Library/Application Support/remote-agent-server`。

### 1. 准备 APFS 项目环境和运行目录

```bash
REMOTE_AGENT_ROOT="$HOME/Library/Application Support/remote-agent-server"
mkdir -p "$REMOTE_AGENT_ROOT/data"
mkdir -p "$REMOTE_AGENT_ROOT/template/workspace"
mkdir -p "$REMOTE_AGENT_ROOT/environments"
mkdir -p "$REMOTE_AGENT_ROOT/sessions"

TEMPLATE_DEVICE="$(df "$REMOTE_AGENT_ROOT/template/workspace" | awk 'NR == 2 { print $1 }')"
SESSIONS_DEVICE="$(df "$REMOTE_AGENT_ROOT/sessions" | awk 'NR == 2 { print $1 }')"
test "$TEMPLATE_DEVICE" = "$SESSIONS_DEVICE"
diskutil info "$TEMPLATE_DEVICE" | grep 'File System Personality:.*APFS'
```

`template/workspace`、`environments/` 和 `sessions/` 必须位于同一个 APFS Volume。服务启动时会再次检查文件系统类型和 Volume；不符合时直接拒绝启动。

`WORKSPACE_TEMPLATE` 只用于首次升级时导入原有全局 Workspace。日常项目和依赖由页面中的“项目环境”维护：添加 Git 地址和可选准备命令后，系统自动构建不可变环境版本；每三小时检查远程默认分支，也可点击“立即检查”。新 Session 通过 `cp -cR` 从 Agent 当前环境版本创建独立 APFS Clone，不会重新 clone 或安装依赖。

### 2. 安装、构建并配置环境

```bash
cd "$HOME/Projects/remote-agent-server"
corepack enable
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
chmod 0600 .env
openssl rand -hex 32
```

将随机值填入 `.env` 的 `API_TOKEN`，并把路径改成当前用户的绝对路径。路径含空格，必须保留双引号：

```dotenv
HOST=127.0.0.1
PORT=3000
API_TOKEN=替换为刚生成的随机值
DATA_DIR="/Users/当前用户/Library/Application Support/remote-agent-server/data"
DATABASE_PATH="/Users/当前用户/Library/Application Support/remote-agent-server/data/remote-agent.sqlite3"
WORKSPACE_TEMPLATE="/Users/当前用户/Library/Application Support/remote-agent-server/template/workspace"
PROJECT_ENVIRONMENTS_ROOT="/Users/当前用户/Library/Application Support/remote-agent-server/environments"
SESSIONS_ROOT="/Users/当前用户/Library/Application Support/remote-agent-server/sessions"
MAX_CONCURRENT_RUNS=4
```

`DATA_DIR/secret.key` 是 MCP 固定敏感值和 Session 敏感参数的 AES-256-GCM 主密钥。服务首次启动会自动创建，权限为 `0600`。该文件必须与 SQLite 数据库一起持久化和备份；丢失后，数据库中已有密文无法恢复。不要把该密钥写入镜像、日志或源码仓库。

使用同一个 macOS 用户完成 Provider 登录并确认命令可执行：

```bash
claude login
codex login
claude --version && codex --version && hermes --version
```

### 3. 首次前台启动

```bash
cd "$HOME/Projects/remote-agent-server"
set -a
source ./.env
set +a
pnpm start
```

另一个终端验证：

```bash
curl --fail http://127.0.0.1:3000/api/health
```

预期返回 `{"ok":true}`。

### 4. 使用 LaunchAgent 随登录启动

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
    <string>cd "$HOME/Projects/remote-agent-server" &amp;&amp; set -a &amp;&amp; source ./.env &amp;&amp; set +a &amp;&amp; exec pnpm start</string>
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

以下示例使用发布目录 `/opt/remote-agent-server` 和 Btrfs 挂载点 `/srv/remote-agent`。请按实际发行版本替换项目路径，但不要让导入 Workspace、项目环境和 Session 根目录跨越不同的 Btrfs 文件系统。

## 1. 创建专用用户和 Btrfs 目录

先由管理员确认 `/srv/remote-agent` 位于一个已挂载的 Btrfs 文件系统，再创建不能拥有 sudo 权限的服务用户：

```bash
sudo useradd --create-home --shell /bin/bash remote-agent
sudo install -d -o remote-agent -g remote-agent -m 0750 /srv/remote-agent
sudo install -d -o remote-agent -g remote-agent -m 0750 /srv/remote-agent/template
sudo btrfs subvolume create /srv/remote-agent/template/workspace
sudo mkdir -p /srv/remote-agent/environments /srv/remote-agent/sessions /srv/remote-agent/data
sudo chown -R remote-agent:remote-agent /srv/remote-agent
sudo -u remote-agent btrfs subvolume show /srv/remote-agent/template/workspace
```

服务进程会直接调用 `btrfs subvolume show` 和 `btrfs subvolume snapshot`。因此必须在部署前用同一个用户验证创建快照也可行：

```bash
sudo -u remote-agent btrfs subvolume snapshot \
  /srv/remote-agent/template/workspace /srv/remote-agent/sessions/permission-check
sudo -u remote-agent btrfs subvolume delete /srv/remote-agent/sessions/permission-check
```

推荐做法是让 `remote-agent` 对这个专用 Btrfs 挂载点及以上两个目录拥有写权限，如上所示。不要为服务配置 `NOPASSWD: btrfs`、不要以 root 运行 Node，也不要向整个 Node 进程授予 `CAP_SYS_ADMIN`；该 capability 过宽。若当前内核/挂载策略仍拒绝上述 `sudo -u remote-agent` 检查，此版本不能在该挂载配置安全部署：先调整为同一服务用户可创建快照的专用 Btrfs 挂载，或在后续版本引入只允许固定快照参数的独立受限 helper。

导入用 Workspace 和每个项目环境版本都是 Btrfs subvolume，内部不得嵌套其他 subvolume。`environments/`、`sessions/` 和导入用 Workspace 必须在同一 Btrfs 文件系统上；`data/` 也应归 `remote-agent` 所有。

## 2. 安装发布目录

以受控发布方式将完整项目放到服务用户可读取的目录，并在发布目录安装服务依赖：

```bash
sudo install -d -o remote-agent -g remote-agent -m 0750 /opt/remote-agent-server
sudo rsync -a --delete --chown=remote-agent:remote-agent ./ /opt/remote-agent-server/
sudo -u remote-agent -H bash -lc 'cd /opt/remote-agent-server && corepack enable && pnpm install --frozen-lockfile'
```

不要再由管理员手工更新全局模板。服务启动后，在“项目环境”页面创建环境、添加一个或多个 Git 项目，并为需要安装依赖的项目填写一次准备命令。系统在环境版本中 clone/update 和安装依赖，全部成功后才发布；失败不会替换当前版本。已有 Session 不会自动升级。

## 3. 配置服务环境

创建生产环境文件，只有 `remote-agent` 可读取：

```bash
sudo -u remote-agent cp /opt/remote-agent-server/.env.example /opt/remote-agent-server/.env
sudo -u remote-agent chmod 0600 /opt/remote-agent-server/.env
sudo -u remote-agent openssl rand -hex 32
sudo -u remote-agent editor /opt/remote-agent-server/.env
```

将生成的长随机值填入 `API_TOKEN`。不要提交 `.env`，不要在仓库或 systemd unit 中硬编码 Provider 凭证。Claude/Codex 的原生登录状态由该系统用户保存；Hermes 的原生状态使用后文每个 Agent 的 `HERMES_HOME`。服务建议只监听内网；若需要跨网络访问，放在 TLS 反向代理后，并仅把 Bearer Token 分发给可信调用方。

有头浏览器需要服务器上真实的桌面/X display，以及 `remote-agent` 对该 display 的访问权。先以该用户检查，再把实际 `DISPLAY` 和 `XAUTHORITY` 写入 `.env`：

```bash
sudo -u remote-agent -H env DISPLAY=:0 XAUTHORITY=/home/remote-agent/.Xauthority xdpyinfo >/dev/null
```

安装浏览器和其系统库时按发行版的 Chromium/桌面包清单执行；不要让 Provider 在首次 Run 时下载或配置浏览器。Provider 得到的 `REMOTE_AGENT_BROWSER_PROFILE` 每个 Session 都不同，Profile 应只写到该 Session 的 `browser/` 目录。

## 4. 使用同一服务用户登录 Provider

所有登录和检查都必须在 `remote-agent` 身份下进行，这样 systemd 进程能看到同一份 CLI 原生状态和 PATH。先确认 Node、pnpm、`acpx` 所需的 `npx`、以及各 CLI 都可执行；下一节会把这些命令所在目录显式写入 systemd 的 `PATH`。

```bash
sudo -u remote-agent -H bash -lc 'node --version && pnpm --version && claude --version && codex --version && hermes --version'
sudo -u remote-agent -H bash -lc 'claude login'
sudo -u remote-agent -H bash -lc 'codex login'
```

Hermes 的模型配置必须写入服务为具体 Agent 创建的 home，不能使用管理员自己的 home。该 Agent 会在服务启动后创建；具体命令见第 6 节。不要把模型 token 写入 `.env.example` 或提交的文件。

## 5. 构建、Btrfs 启动检查与 systemd

构建前先检查服务用户的 Btrfs 访问；服务启动时会重复同一项检查：

```bash
sudo -u remote-agent -H bash -lc 'cd /opt/remote-agent-server && pnpm build'
sudo -u remote-agent btrfs subvolume show /srv/remote-agent/template/workspace
```

不要假设 systemd 能加载 login shell 的 PATH。先在**同一个服务用户**下记录 login shell 首次命中的实际绝对路径；任何一个命令找不到都先修复安装，不要写 unit：

```bash
REMOTE_AGENT_LOGIN_PATH="$(sudo -u remote-agent -H bash -lc 'printf %s "$PATH"')"
NODE_BIN="$(sudo -u remote-agent -H bash -lc 'command -v node')"
PNPM_BIN="$(sudo -u remote-agent -H bash -lc 'command -v pnpm')"
NPX_BIN="$(sudo -u remote-agent -H bash -lc 'command -v npx')"
CLAUDE_BIN="$(sudo -u remote-agent -H bash -lc 'command -v claude')"
CODEX_BIN="$(sudo -u remote-agent -H bash -lc 'command -v codex')"
HERMES_BIN="$(sudo -u remote-agent -H bash -lc 'command -v hermes')"

for bin in "$NODE_BIN" "$PNPM_BIN" "$NPX_BIN" "$CLAUDE_BIN" "$CODEX_BIN" "$HERMES_BIN"; do
  test -n "$bin" && test -x "$bin" || { echo "Provider command is missing" >&2; exit 1; }
done

# 先保留 login PATH 的目录顺序，再按 node/pnpm/npx/claude/codex/hermes 的原命中顺序补目录。
# awk 只删除后续重复项，绝不 sort，因此不会改变 command -v 的优先级。
REMOTE_AGENT_PATH="$({
  printf '%s\n' "$REMOTE_AGENT_LOGIN_PATH" | tr ':' '\n'
  dirname "$NODE_BIN"
  dirname "$PNPM_BIN"
  dirname "$NPX_BIN"
  dirname "$CLAUDE_BIN"
  dirname "$CODEX_BIN"
  dirname "$HERMES_BIN"
} | awk 'NF && !seen[$0]++ { printf "%s%s", separator, $0; separator=":" }')"
test -n "$REMOTE_AGENT_PATH" || { echo "Generated PATH is empty" >&2; exit 1; }

verify_systemd_path_command() {
  command_name="$1"
  expected_bin="$2"
  actual_bin="$(sudo -u remote-agent -H env PATH="$REMOTE_AGENT_PATH" \
    /bin/bash -c 'command -v "$1"' bash "$command_name")"
  test "$actual_bin" = "$expected_bin" || {
    echo "PATH changes $command_name: expected $expected_bin, got $actual_bin" >&2
    exit 1
  }
}

verify_systemd_path_command node "$NODE_BIN"
verify_systemd_path_command pnpm "$PNPM_BIN"
verify_systemd_path_command npx "$NPX_BIN"
verify_systemd_path_command claude "$CLAUDE_BIN"
verify_systemd_path_command codex "$CODEX_BIN"
verify_systemd_path_command hermes "$HERMES_BIN"

# 按 systemd 的绝对 ExecStart 与精确 PATH 验证 pnpm 和实际启动的 Node。
sudo -u remote-agent -H env PATH="$REMOTE_AGENT_PATH" "$PNPM_BIN" --version
sudo -u remote-agent -H env PATH="$REMOTE_AGENT_PATH" "$NODE_BIN" --version
PNPM_NODE_BIN="$(sudo -u remote-agent -H env PATH="$REMOTE_AGENT_PATH" \
  "$PNPM_BIN" exec node -p 'process.execPath')"
test "$PNPM_NODE_BIN" = "$NODE_BIN" || {
  echo "pnpm would start $PNPM_NODE_BIN, expected $NODE_BIN" >&2
  exit 1
}
```

将刚验证的**精确** PATH 和绝对 pnpm 路径写入 `/etc/systemd/system/remote-agent.service`；不要使用 `/usr/bin/env pnpm`、不受控 wrapper 或 root：

```bash
sudo tee /etc/systemd/system/remote-agent.service >/dev/null <<EOF
[Unit]
Description=Remote Agent Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=remote-agent
Group=remote-agent
WorkingDirectory=/opt/remote-agent-server
EnvironmentFile=/opt/remote-agent-server/.env
Environment=HOME=/home/remote-agent
Environment="PATH=$REMOTE_AGENT_PATH"
ExecStart=$PNPM_BIN start
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
```

这里 `Environment="PATH=..."` 是 systemd 的 Environment 赋值格式；不要手动改写为排序后的 PATH，也不要留下尖括号占位符。`pnpm start` 在此项目固定执行 `node dist/server/main.js`，因此 `WorkingDirectory` 必须是已执行 `pnpm build` 的发布目录。不要使用 `DynamicUser=yes`：Provider CLI 原生登录状态、Btrfs 权限和 Hermes home 都需要稳定的 `remote-agent` UID/HOME。

启用服务并确认健康接口：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now remote-agent
curl --fail http://127.0.0.1:3000/api/health
sudo journalctl -u remote-agent -n 100 --no-pager
```

服务能启动只证明 Btrfs doctor 通过，不代表 systemd 的 PATH 或三个 Provider 都可用。第 6 节的完整 smoke 会经**应用 HTTP doctor**验证三种 Provider；任一个失败都先修复 unit 的 PATH、CLI 或登录状态，而不是跳过。

## 6. 创建项目环境并执行真实三 Provider smoke

先打开管理页面的“项目环境”：

1. 创建一个项目环境。
2. 添加至少一个服务用户能够访问的 Git 项目；一个环境可以包含多个项目。
3. 按项目填写可选准备命令，例如 `bundle install` 或 `pnpm install --frozen-lockfile`。
4. 等待状态变成“可用”。失败时直接在页面查看失败项目、阶段和错误摘要。

只有存在 ready 项目环境时，smoke 才会创建 Agent。脚本按名称和 ID 稳定选择第一个 ready 环境，并让三种 Provider 共用它。

先用 `--prepare` 创建或复用三个固定名称的 Agent。该模式只确保并打印 Agent ID，**不会**创建 Session/Run，也不会调用 doctor，因此可以先获得 Hermes 的专用 home。匹配 0 条时创建、1 条时复用或重新启用；同名同 Provider 多于 1 条时会以非零退出并打印所有冲突 ID，必须人工清理后再继续，不能任选一条。

```bash
HERMES_AGENT_ID="$(sudo -u remote-agent -H bash -lc '
  cd /opt/remote-agent-server
  set -a; . ./.env; set +a
  pnpm --silent smoke:providers --prepare
' | jq -er 'select(.provider == "hermes" and .outcome == "prepared") | .agentId')" || exit 1
test -n "$HERMES_AGENT_ID" || exit 1
```

该命令需要 `jq`；不安装它时直接运行其中的 `pnpm smoke:providers --prepare` 并从 JSON 输出中手动记录 Hermes `agentId`。不要继续使用无条件 `POST /api/agents`，因为当前 API 没有 Agent 名称唯一约束。

Hermes 必须使用刚才 `remote-agent-smoke-hermes` 返回的 `id` 配置模型并通过 ACP 检查：

```bash
sudo -u remote-agent -H env \
  HERMES_HOME=/srv/remote-agent/data/agents/$HERMES_AGENT_ID/provider-home/hermes \
  hermes model
sudo -u remote-agent -H env \
  HERMES_HOME=/srv/remote-agent/data/agents/$HERMES_AGENT_ID/provider-home/hermes \
  hermes acp --check
```

`hermes model` 是交互式模型配置；按组织许可完成后再进行真实 smoke。

随后运行：

```bash
sudo -u remote-agent -H bash -lc '
  cd /opt/remote-agent-server
  set -a; . ./.env; set +a
  pnpm smoke:providers
'
```

该脚本通过 HTTP API 按 Claude Code、Codex、Hermes 顺序执行：确保固定 smoke Agent 存在并通过应用 doctor、创建新 Session、发送“只回复当前工作目录的目录名”、等待成功、在同一 Session 发送“只回复你上一轮看到的目录名”、等待成功，并读取第二轮 Run 的事件历史。每一步都会打印 Provider、Agent ID、Session ID 和 Run ID。每次 HTTP 请求（包括 response body）都有 Abort deadline；Run 轮询的每次读取受该 Run 的剩余 `SMOKE_RUN_TIMEOUT_MS` 限制。任一 Provider 未安装/未登录、Session 续接失败、Run 失败、未知 Run 状态、超时或事件 `seq` 未从 1 严格连续递增，命令都会以非零退出。它不 mock Provider，也不会在 `pnpm test` 中联网。

Smoke 只覆盖三个 Provider 的顺序双轮真实连通性。仍须在目标服务器验收：两个不同 Session 并发、断开并重新连接 SSE 后 `seq` 不缺失/不重复、Session 修改不污染项目环境或另一个 Session、浏览器任务只在该 Session 的 `browser/` 产生 Profile、服务重启把在途 Run 标为 `failed/server_restarted` 且不重放输入。

## 7. 外部系统接入

### 7.1 创建接入端点并保存 Token

管理员在“外部接入”页面创建 Endpoint，选择一个已启用且项目环境可用的 Agent。Endpoint Token 只在创建或轮换成功后展示一次，服务端只保存哈希，离开提示页后不能找回。应立即把 Token 放进调用方的 Secret 管理系统；不要写入 Git、请求日志、Webhook Header 或 Remote Agent Server 的 `.env`。

管理端使用全局 `API_TOKEN`，外部调用方只使用所属 Endpoint Token。两者权限不同，不能互换。下面用占位符演示调用；生产环境应从 Secret 管理系统注入变量：

```bash
REMOTE_AGENT_URL=https://agent.example.com
ENDPOINT_SLUG=grab-manager-ticket
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
set -a; . ./.env; set +a
export SMOKE_BASE_URL=http://127.0.0.1:3000
export SMOKE_API_TOKEN="$API_TOKEN"
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
