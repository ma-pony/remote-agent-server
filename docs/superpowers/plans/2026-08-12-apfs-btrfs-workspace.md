# APFS/Btrfs 双工作区实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Remote Agent Server 在 macOS/APFS 和 Linux/Btrfs 上自动使用原生写时复制工作区，并在不支持的文件系统上拒绝启动。

**Architecture:** 抽取不依赖文件系统的 `WorkspaceManager` 契约，保留现有 Btrfs 实现，新增 APFS 实现，并由一个平台工厂自动选择。Session、Run、API 只依赖统一接口；启动时在监听和恢复 Run 之前完成文件系统检查。

**Tech Stack:** TypeScript、Node.js、Vitest、Node `fs.statfs()`/`fs.stat()`、macOS `cp -cR`、Linux `btrfs` CLI。

## 全局约束

- macOS 仅支持 APFS，Linux 仅支持 Btrfs。
- 其他平台或不匹配的文件系统必须拒绝启动。
- 不实现普通递归复制后端。
- 不新增数据库字段、环境变量或第三方依赖。
- 保持现有 `workspace_create_failed` 与 `session_create_failed` API 语义。
- 所有行为变更先留下预期失败的测试，再写最小实现。

---

### Task 1: 抽取统一 Workspace 契约并保持 Btrfs 行为

**Files:**
- Create: `src/workspaces/workspace-manager.ts`
- Modify: `src/workspaces/btrfs-workspace.ts`
- Modify: `src/sessions/session-manager.ts`
- Modify: `src/sessions/session-routes.ts`
- Modify: `src/app.ts`
- Modify: `src/main.ts`
- Modify: `test/workspaces.test.ts`
- Modify: `test/sessions.test.ts`
- Modify: `test/run-executor.test.ts`

**Interfaces:**
- Produces: `WorkspaceManager`，包含 `check(): Promise<void>`、`create(id: string): Promise<Workspace>`、`rollback(id: string): Promise<void>`。
- Produces: `Workspace`、`CommandRunner`、`WorkspaceCreateError`、`WorkspaceCheckError` 和 `systemCommandRunner`。
- Consumes: 现有 `BtrfsWorkspaceManager` 的命令与目录生命周期。

- [ ] **Step 1: 写统一接口的失败测试**

在 `test/workspaces.test.ts` 中把共享类型改从新模块导入，并新增对 Btrfs 检查错误的断言：

```ts
import {
  WorkspaceCheckError,
  type CommandRunner,
  type WorkspaceManager
} from "../src/workspaces/workspace-manager.js";

it("Btrfs 检查失败时返回明确的文件系统错误", async () => {
  const manager: WorkspaceManager = new BtrfsWorkspaceManager({
    workspaceTemplate: "/template",
    sessionsRoot: "/sessions",
    commandRunner: { run: async () => Promise.reject(new Error("not btrfs")) }
  });

  await expect(manager.check()).rejects.toEqual(
    new WorkspaceCheckError("Linux workspace requires Btrfs")
  );
});
```

- [ ] **Step 2: 运行测试并确认失败原因正确**

Run: `pnpm vitest run test/workspaces.test.ts`

Expected: FAIL，因为 `workspace-manager.ts` 和 `WorkspaceCheckError` 尚不存在。

- [ ] **Step 3: 写最小统一接口并迁移 Btrfs 类型**

在 `src/workspaces/workspace-manager.ts` 定义：

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandRunner {
  run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export type Workspace = {
  workspacePath: string;
  runtimePath: string;
  browserProfilePath: string;
};

export interface WorkspaceManager {
  check(): Promise<void>;
  create(id: string): Promise<Workspace>;
  rollback(id: string): Promise<void>;
}

export class WorkspaceCreateError extends Error {
  readonly code = "workspace_create_failed";
  constructor() {
    super("Failed to create workspace");
  }
}

export class WorkspaceCheckError extends Error {
  readonly code = "workspace_check_failed";
}

export const systemCommandRunner: CommandRunner = {
  async run(command, args) {
    const { stdout, stderr } = await execFileAsync(command, args);
    return { stdout, stderr };
  }
};
```

让 `BtrfsWorkspaceManager implements WorkspaceManager`，从共享模块导入类型。`check()` 捕获底层命令错误并抛出 `new WorkspaceCheckError("Linux workspace requires Btrfs")`；创建与回滚命令保持不变。

将 `SessionManagerDependencies.workspaceManager`、`SessionManager` 字段和 `AppDependencies.workspaceManager` 改为 `WorkspaceManager`。`SessionManager`、`session-routes.ts`、`app.ts`、`main.ts` 和测试中的共享错误、Runner 类型改从 `workspace-manager.ts` 导入；测试辅助构造继续注入真实 Btrfs Manager。

- [ ] **Step 4: 运行聚焦测试并确认通过**

Run: `pnpm vitest run test/workspaces.test.ts test/sessions.test.ts test/run-executor.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交统一接口改动**

```bash
git add src/workspaces/workspace-manager.ts src/workspaces/btrfs-workspace.ts src/sessions/session-manager.ts src/sessions/session-routes.ts src/app.ts src/main.ts test/workspaces.test.ts test/sessions.test.ts test/run-executor.test.ts
git commit -m "refactor: define workspace manager contract"
```

---

### Task 2: 新增 APFS 实现和自动选择工厂

**Files:**
- Create: `src/workspaces/apfs-workspace.ts`
- Create: `src/workspaces/create-workspace-manager.ts`
- Modify: `test/workspaces.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `WorkspaceManager`、`Workspace`、`CommandRunner`、`WorkspaceCreateError`、`WorkspaceCheckError`。
- Produces: `ApfsWorkspaceManager`。
- Produces: `FileSystemInspector`，包含 `statfs(path)` 的文件系统类型和 `stat(path)` 的设备 ID。
- Produces: `createWorkspaceManager(input: { platform?: NodeJS.Platform; workspaceTemplate: string; sessionsRoot: string; commandRunner?: CommandRunner; fileSystemInspector?: FileSystemInspector }): WorkspaceManager`。

- [ ] **Step 1: 写 APFS 和平台工厂的失败测试**

在 `test/workspaces.test.ts` 新增以下行为：

```ts
it("macOS 选择 APFS，Linux 选择 Btrfs，其他平台失败", () => {
  const dependencies = {
    workspaceTemplate: "/template",
    sessionsRoot: "/sessions",
    commandRunner: createRunner().runner
  };
  expect(createWorkspaceManager({ ...dependencies, platform: "darwin" })).toBeInstanceOf(ApfsWorkspaceManager);
  expect(createWorkspaceManager({ ...dependencies, platform: "linux" })).toBeInstanceOf(BtrfsWorkspaceManager);
  expect(() => createWorkspaceManager({ ...dependencies, platform: "win32" })).toThrow(
    "Workspace platform is unsupported: win32"
  );
});

it("APFS 检查模板和 Sessions 根目录位于同一 APFS Volume", async () => {
  const { fileSystemInspector, calls } = createFileSystemInspector([26, 26], [42, 42]);
  const manager = new ApfsWorkspaceManager({
    workspaceTemplate: template,
    sessionsRoot,
    commandRunner: createRunner().runner,
    fileSystemInspector
  });

  await manager.check();

  expect(calls).toEqual([
    { operation: "statfs", path: template },
    { operation: "statfs", path: sessionsRoot },
    { operation: "stat", path: template },
    { operation: "stat", path: sessionsRoot }
  ]);
});

it("APFS 创建 Clone 和 Session 运行目录", async () => {
  const manager = new ApfsWorkspaceManager({ workspaceTemplate: template, sessionsRoot, commandRunner: runner });
  const workspace = await manager.create("session-123");

  expect(calls).toEqual([{ command: "cp", args: ["-cR", template, workspace.workspacePath] }]);
  expect(existsSync(workspace.runtimePath)).toBe(true);
  expect(existsSync(workspace.browserProfilePath)).toBe(true);
});

it.each([
  { types: [17, 26], devices: [42, 42], name: "非 APFS 路径" },
  { types: [26, 26], devices: [42, 43], name: "不同 Volume" }
])("APFS 拒绝$name", async ({ types, devices }) => {
  const { fileSystemInspector } = createFileSystemInspector(types, devices);
  const manager = new ApfsWorkspaceManager({
    workspaceTemplate: template,
    sessionsRoot,
    commandRunner: createRunner().runner,
    fileSystemInspector
  });

  await expect(manager.check()).rejects.toThrow(
    "macOS workspace requires template and sessions on the same APFS volume"
  );
});

it("APFS Clone 失败时清理 Session 目录", async () => {
  const manager = new ApfsWorkspaceManager({
    workspaceTemplate: template,
    sessionsRoot,
    commandRunner: { run: async () => Promise.reject(new Error("clone failed")) }
  });

  await expect(manager.create("session-123")).rejects.toMatchObject({ code: "workspace_create_failed" });
  expect(existsSync(join(sessionsRoot, "session-123"))).toBe(false);
});

it("APFS rollback 删除整个 Session 目录", async () => {
  const sessionPath = join(sessionsRoot, "session-123");
  mkdirSync(sessionPath, { recursive: true });
  const manager = new ApfsWorkspaceManager({ workspaceTemplate: template, sessionsRoot, commandRunner: createRunner().runner });

  await manager.rollback("session-123");

  expect(existsSync(sessionPath)).toBe(false);
});
```

为上述检查增加以下文件系统检查器：

```ts
const createFileSystemInspector = (types: number[], devices: number[]) => {
  const calls: Array<{ operation: "statfs" | "stat"; path: string }> = [];
  const fileSystemInspector: FileSystemInspector = {
    statfs: async (path) => {
      calls.push({ operation: "statfs", path });
      return { type: types.shift() ?? 0 };
    },
    stat: async (path) => {
      calls.push({ operation: "stat", path });
      return { dev: devices.shift() ?? 0 };
    }
  };
  return { fileSystemInspector, calls };
};
```

- [ ] **Step 2: 运行测试并确认失败原因正确**

Run: `pnpm vitest run test/workspaces.test.ts`

Expected: FAIL，因为 APFS Manager 和平台工厂尚不存在。

- [ ] **Step 3: 实现最小 APFS Manager**

`check()` 依次通过 Node `fs.statfs()` 读取两个路径的文件系统类型，通过 `fs.stat()` 读取设备 ID。任一读取失败、类型不是 Darwin APFS `f_type=26` 或设备 ID 不同，都抛出：

```ts
throw new WorkspaceCheckError("macOS workspace requires template and sessions on the same APFS volume");
```

`create()` 与 Btrfs 保持相同目录顺序，然后调用：

```ts
await this.commandRunner.run("cp", ["-cR", this.workspaceTemplate, workspacePath]);
```

失败时递归删除 Session 目录并抛出 `WorkspaceCreateError`。`rollback()` 递归删除 Session 目录。

- [ ] **Step 4: 实现平台工厂**

`createWorkspaceManager()` 默认使用 `process.platform` 和 `systemCommandRunner`：

```ts
if (platform === "darwin") return new ApfsWorkspaceManager(dependencies);
if (platform === "linux") return new BtrfsWorkspaceManager(dependencies);
throw new WorkspaceCheckError(`Workspace platform is unsupported: ${platform}`);
```

- [ ] **Step 5: 运行聚焦测试并确认通过**

Run: `pnpm vitest run test/workspaces.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交 APFS 和工厂实现**

```bash
git add src/workspaces/apfs-workspace.ts src/workspaces/create-workspace-manager.ts test/workspaces.test.ts
git commit -m "feat: support APFS session workspaces"
```

---

### Task 3: 接入启动流程、补充部署说明并进行本机验收

**Files:**
- Modify: `src/main.ts`
- Modify: `src/app.ts`
- Modify: `test/runs.test.ts`
- Modify: `docs/deployment.md`

**Interfaces:**
- Consumes: Task 2 的 `createWorkspaceManager()`。
- Produces: macOS/APFS 和 Linux/Btrfs 自动启动行为。
- 保持: `buildApp()` 仍允许测试显式注入 `WorkspaceManager`。

- [ ] **Step 1: 写启动自动选择的失败测试**

在 `test/runs.test.ts` 的启动测试中注入 `platform: "darwin"` 和 `FileSystemInspector`，断言启动检查按模板、Sessions 顺序调用 `statfs/stat`，且不调用 `btrfs`。为此在 `StartServerOptions` 新增仅用于装配与测试的可选 `platform?: NodeJS.Platform` 和 `fileSystemInspector?: FileSystemInspector`。

再写一例 `platform: "linux"`，断言仍执行：

```ts
expect(calls[0]).toEqual({ command: "btrfs", args: ["subvolume", "show", workspaceTemplate] });
```

- [ ] **Step 2: 运行启动测试并确认失败原因正确**

Run: `pnpm vitest run test/runs.test.ts`

Expected: FAIL，因为 `startServer()` 仍直接构造 Btrfs Manager，且不接受 `platform`。

- [ ] **Step 3: 将应用与启动装配切换到工厂**

在 `startServer()` 中先创建 `sessionsRoot`，再调用：

```ts
const workspaceManager = createWorkspaceManager({
  platform: options.platform,
  workspaceTemplate: config.workspaceTemplate,
  sessionsRoot: config.sessionsRoot,
  commandRunner: options.commandRunner ?? systemCommandRunner
});
await workspaceManager.check();
```

`buildApp()` 未注入 WorkspaceManager 时也调用同一个工厂；测试和生产仍可注入命令 Runner，不增加用户配置。

- [ ] **Step 4: 更新中文部署说明与 Mac 示例路径**

保持 `.env.example` 的 Linux 默认值不变。在 `docs/deployment.md` 开头补充 macOS 章节，明确：

- 数据目录建议放在 `$HOME/Library/Application Support/remote-agent-server`。
- 模板与 Sessions 根目录必须位于同一个 APFS Volume。
- 使用 `df` 确认模板和 Sessions 的设备一致，再用 `diskutil info <设备>` 检查 APFS。
- 使用登录用户的 LaunchAgent 启动，保证 Provider 登录状态和有头浏览器可见。
- Linux 部署仍要求 Btrfs，不允许完整复制回退。

- [ ] **Step 5: 运行完整自动验证**

Run: `pnpm test`

Expected: 0 failed。

Run: `pnpm typecheck`

Expected: exit 0。

Run: `pnpm build && node --check dist/server/main.js && git diff --check`

Expected: 全部 exit 0。

- [ ] **Step 6: 在当前 Mac 上执行真实 APFS Clone 验收**

在 `/private/tmp/remote-agent-server-local` 创建模板、Sessions 和 data 目录；确认它们为 APFS。启动服务时使用临时环境变量，不写入或提交凭证：

```bash
mkdir -p /private/tmp/remote-agent-server-local/template/workspace
mkdir -p /private/tmp/remote-agent-server-local/sessions
mkdir -p /private/tmp/remote-agent-server-local/data
touch /private/tmp/remote-agent-server-local/template/workspace/template-only

env \
  API_TOKEN=local-apfs-smoke-token-20260812 \
  DATA_DIR=/private/tmp/remote-agent-server-local/data \
  DATABASE_PATH=/private/tmp/remote-agent-server-local/data/remote-agent.sqlite3 \
  WORKSPACE_TEMPLATE=/private/tmp/remote-agent-server-local/template/workspace \
  SESSIONS_ROOT=/private/tmp/remote-agent-server-local/sessions \
  HOST=127.0.0.1 PORT=3000 \
  pnpm start
```

另一个终端执行：

```bash
curl --fail http://127.0.0.1:3000/api/health
```

Expected: `{"ok":true}`。再创建测试 Agent 和 Session：

```bash
AGENT_ID="$(curl --fail -sS http://127.0.0.1:3000/api/agents \
  -H 'Authorization: Bearer local-apfs-smoke-token-20260812' \
  -H 'Content-Type: application/json' \
  --data '{"name":"APFS smoke","provider":"codex"}' \
  | node -e 'let body=""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => console.log(JSON.parse(body).id))')"

SESSION_PATH="$(curl --fail -sS http://127.0.0.1:3000/api/sessions \
  -H 'Authorization: Bearer local-apfs-smoke-token-20260812' \
  -H 'Content-Type: application/json' \
  --data "{\"agentId\":\"$AGENT_ID\",\"title\":\"APFS smoke\"}" \
  | node -e 'let body=""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => console.log(JSON.parse(body).workspacePath))')"

test -f "$SESSION_PATH/template-only"
touch "$SESSION_PATH/session-only"
test ! -e /private/tmp/remote-agent-server-local/template/workspace/session-only
```

Expected: 所有命令 exit 0，Session Workspace 存在，修改 Session 不影响模板。

- [ ] **Step 7: 提交启动与文档改动**

```bash
git add src/main.ts src/app.ts test/runs.test.ts docs/deployment.md
git commit -m "feat: select native workspace backend"
```
