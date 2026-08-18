import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ApfsWorkspaceManager, type FileSystemInspector } from "../src/workspaces/apfs-workspace.js";
import { BtrfsWorkspaceManager } from "../src/workspaces/btrfs-workspace.js";
import { createWorkspaceManager } from "../src/workspaces/create-workspace-manager.js";
import {
  WorkspaceCheckError,
  type CommandRunner,
  type WorkspaceManager
} from "../src/workspaces/workspace-manager.js";

const tempDirs: string[] = [];

const createTempDir = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "remote-agent-workspace-"));
  tempDirs.push(directory);
  return directory;
};

const createRunner = (): { runner: CommandRunner; calls: Array<{ command: string; args: string[] }> } => {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    runner: {
      run: async (command, args) => {
        calls.push({ command, args });
        return { stdout: "", stderr: "" };
      }
    },
    calls
  };
};

const createFileSystemInspector = (types: number[], devices: number[]): {
  fileSystemInspector: FileSystemInspector;
  calls: Array<{ operation: "statfs" | "stat"; path: string }>;
} => {
  const calls: Array<{ operation: "statfs" | "stat"; path: string }> = [];
  const remainingTypes = [...types];
  const remainingDevices = [...devices];
  return {
    fileSystemInspector: {
      statfs: async (path) => {
        calls.push({ operation: "statfs", path });
        return { type: remainingTypes.shift() ?? 0 };
      },
      stat: async (path) => {
        calls.push({ operation: "stat", path });
        return { dev: remainingDevices.shift() ?? 0 };
      }
    },
    calls
  };
};

afterEach(() => {
  tempDirs.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
});

describe("BtrfsWorkspaceManager", () => {
  it("Btrfs 检查失败时返回明确的文件系统错误", async () => {
    const manager: WorkspaceManager = new BtrfsWorkspaceManager({
      projectEnvironmentsRoot: "/environments",
      sessionsRoot: "/sessions",
      commandRunner: { run: async () => Promise.reject(new Error("not btrfs")) }
    });

    await expect(manager.check()).rejects.toEqual(
      new WorkspaceCheckError("Linux workspace requires environments and sessions on the same Btrfs filesystem")
    );
  });

  it("检查项目环境和 Session 根目录位于同一 Btrfs 文件系统", async () => {
    const root = createTempDir();
    const projectEnvironmentsRoot = join(root, "environments");
    const sessionsRoot = join(root, "sessions");
    mkdirSync(projectEnvironmentsRoot);
    mkdirSync(sessionsRoot);
    const { runner, calls } = createRunner();
    const manager = new BtrfsWorkspaceManager({
      projectEnvironmentsRoot,
      sessionsRoot,
      commandRunner: runner
    });

    await manager.check();

    expect(calls).toEqual([
      { command: "btrfs", args: ["filesystem", "show", projectEnvironmentsRoot] },
      { command: "btrfs", args: ["filesystem", "show", sessionsRoot] }
    ]);
  });

  it("创建 Session 目录和模板快照", async () => {
    const root = createTempDir();
    const template = join(root, "template");
    const sessionsRoot = join(root, "sessions");
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      run: async (command, args) => {
        calls.push({ command, args });
        expect(command).toBe("btrfs");
        expect(args).toEqual(["subvolume", "snapshot", template, join(sessionsRoot, "session-123", "workspace")]);
        expect(existsSync(join(sessionsRoot, "session-123"))).toBe(true);
        expect(existsSync(join(sessionsRoot, "session-123", "runtime"))).toBe(true);
        expect(existsSync(join(sessionsRoot, "session-123", "browser"))).toBe(true);
        mkdirSync(args[3]);
        return { stdout: "", stderr: "" };
      }
    };
    const manager = new BtrfsWorkspaceManager({
      projectEnvironmentsRoot: join(root, "environments"), sessionsRoot, commandRunner: runner
    });

    const workspace = await manager.createSession("session-123", template);

    const sessionDir = join(sessionsRoot, "session-123");
    expect(workspace).toEqual({
      workspacePath: join(sessionDir, "workspace"),
      runtimePath: join(sessionDir, "runtime"),
      browserProfilePath: join(sessionDir, "browser")
    });
    expect(existsSync(workspace.runtimePath)).toBe(true);
    expect(existsSync(workspace.browserProfilePath)).toBe(true);
    expect(existsSync(workspace.workspacePath)).toBe(true);
    expect(calls).toEqual([
      { command: "btrfs", args: ["subvolume", "snapshot", template, workspace.workspacePath] }
    ]);
  });

  it("从指定版本创建 Session，并创建、复制和删除环境 Subvolume", async () => {
    const root = createTempDir();
    const sessionsRoot = join(root, "sessions");
    const source = join(root, "environment-v1");
    const emptyRevision = join(root, "environment-v2");
    const copiedRevision = join(root, "environment-v3");
    const { runner, calls } = createRunner();
    const manager = new BtrfsWorkspaceManager({
      projectEnvironmentsRoot: join(root, "environments"),
      sessionsRoot,
      commandRunner: runner
    });

    const session = await manager.createSession("session-456", source);
    await manager.createRevision(emptyRevision, null);
    await manager.createRevision(copiedRevision, source);
    await manager.removeRevision(copiedRevision);

    expect(calls).toEqual([
      { command: "btrfs", args: ["subvolume", "snapshot", source, session.workspacePath] },
      { command: "btrfs", args: ["subvolume", "create", emptyRevision] },
      { command: "btrfs", args: ["subvolume", "snapshot", source, copiedRevision] },
      { command: "btrfs", args: ["subvolume", "delete", copiedRevision] }
    ]);
  });

  it("快照失败时清理尚未持久化的 Session 目录", async () => {
    const root = createTempDir();
    const sessionsRoot = join(root, "sessions");
    const manager = new BtrfsWorkspaceManager({
      projectEnvironmentsRoot: join(root, "environments"),
      sessionsRoot,
      commandRunner: { run: async () => Promise.reject(new Error("snapshot failed")) }
    });

    await expect(manager.createSession("session-123", join(root, "template"))).rejects.toMatchObject({ code: "workspace_create_failed" });
    expect(existsSync(join(sessionsRoot, "session-123"))).toBe(false);
  });

  it("先删除 Btrfs Workspace Subvolume 再删除整个 Session 目录", async () => {
    const root = createTempDir();
    const sessionsRoot = join(root, "sessions");
    const sessionPath = join(sessionsRoot, "session-123");
    const workspacePath = join(sessionPath, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const { runner, calls } = createRunner();
    const manager = new BtrfsWorkspaceManager({
      projectEnvironmentsRoot: join(root, "environments"),
      sessionsRoot,
      commandRunner: runner
    });

    await manager.deleteSession("session-123");

    expect(calls).toEqual([{ command: "btrfs", args: ["subvolume", "delete", workspacePath] }]);
    expect(existsSync(sessionPath)).toBe(false);
  });
});

describe("ApfsWorkspaceManager", () => {
  it("检查项目环境和 Sessions 根目录位于同一 APFS Volume", async () => {
    const root = createTempDir();
    const projectEnvironmentsRoot = join(root, "environments");
    const sessionsRoot = join(root, "sessions");
    const { fileSystemInspector, calls } = createFileSystemInspector([26, 26], [42, 42]);
    const manager = new ApfsWorkspaceManager({
      projectEnvironmentsRoot,
      sessionsRoot,
      commandRunner: createRunner().runner,
      fileSystemInspector
    });

    await manager.check();

    expect(calls).toEqual([
      { operation: "statfs", path: projectEnvironmentsRoot },
      { operation: "statfs", path: sessionsRoot },
      { operation: "stat", path: projectEnvironmentsRoot },
      { operation: "stat", path: sessionsRoot }
    ]);
  });

  it.each([
    { types: [17, 26], devices: [42, 42], name: "非 APFS 路径" },
    { types: [26, 26], devices: [42, 43], name: "不同 Volume" }
  ])("拒绝$name", async ({ types, devices }) => {
    const root = createTempDir();
    const { fileSystemInspector } = createFileSystemInspector(types, devices);
    const manager = new ApfsWorkspaceManager({
      projectEnvironmentsRoot: join(root, "environments"),
      sessionsRoot: join(root, "sessions"),
      commandRunner: createRunner().runner,
      fileSystemInspector
    });

    await expect(manager.check()).rejects.toThrow(
      "macOS workspace requires environments and sessions on the same APFS volume"
    );
  });

  it("文件系统命令失败时返回明确的检查错误", async () => {
    const manager = new ApfsWorkspaceManager({
      projectEnvironmentsRoot: "/environments",
      sessionsRoot: "/sessions",
      commandRunner: createRunner().runner,
      fileSystemInspector: {
        statfs: async () => Promise.reject(new Error("statfs failed")),
        stat: async () => ({ dev: 42 })
      }
    });

    await expect(manager.check()).rejects.toEqual(
      new WorkspaceCheckError("macOS workspace requires environments and sessions on the same APFS volume")
    );
  });

  it("创建 APFS Clone 和 Session 运行目录", async () => {
    const root = createTempDir();
    const template = join(root, "template");
    const sessionsRoot = join(root, "sessions");
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      run: async (command, args) => {
        calls.push({ command, args });
        mkdirSync(args[2]);
        return { stdout: "", stderr: "" };
      }
    };
    const manager = new ApfsWorkspaceManager({
      projectEnvironmentsRoot: join(root, "environments"), sessionsRoot, commandRunner: runner
    });

    const workspace = await manager.createSession("session-123", template);

    expect(calls).toEqual([{ command: "cp", args: ["-cR", template, workspace.workspacePath] }]);
    expect(existsSync(workspace.runtimePath)).toBe(true);
    expect(existsSync(workspace.browserProfilePath)).toBe(true);
    expect(existsSync(workspace.workspacePath)).toBe(true);
  });

  it("从指定版本创建 Session，并创建、复制和删除环境目录", async () => {
    const root = createTempDir();
    const sessionsRoot = join(root, "sessions");
    const source = join(root, "environment-v1");
    const emptyRevision = join(root, "environment-v2");
    const copiedRevision = join(root, "environment-v3");
    mkdirSync(source);
    const { runner, calls } = createRunner();
    const manager = new ApfsWorkspaceManager({
      projectEnvironmentsRoot: join(root, "environments"),
      sessionsRoot,
      commandRunner: runner
    });

    const session = await manager.createSession("session-456", source);
    await manager.createRevision(emptyRevision, null);
    await manager.createRevision(copiedRevision, source);
    await manager.removeRevision(copiedRevision);

    expect(calls).toEqual([
      { command: "cp", args: ["-cR", source, session.workspacePath] },
      { command: "cp", args: ["-cR", source, copiedRevision] }
    ]);
    expect(existsSync(emptyRevision)).toBe(true);
    expect(existsSync(copiedRevision)).toBe(false);
  });

  it("Clone 失败时清理 Session 目录", async () => {
    const root = createTempDir();
    const sessionsRoot = join(root, "sessions");
    const manager = new ApfsWorkspaceManager({
      projectEnvironmentsRoot: join(root, "environments"),
      sessionsRoot,
      commandRunner: { run: async () => Promise.reject(new Error("clone failed")) }
    });

    await expect(manager.createSession("session-123", join(root, "template"))).rejects.toMatchObject({ code: "workspace_create_failed" });
    expect(existsSync(join(sessionsRoot, "session-123"))).toBe(false);
  });

  it("幂等删除整个 APFS Session 目录", async () => {
    const root = createTempDir();
    const sessionsRoot = join(root, "sessions");
    const sessionPath = join(sessionsRoot, "session-123");
    mkdirSync(sessionPath, { recursive: true });
    const manager = new ApfsWorkspaceManager({
      projectEnvironmentsRoot: join(root, "environments"),
      sessionsRoot,
      commandRunner: createRunner().runner
    });

    await manager.deleteSession("session-123");
    await manager.deleteSession("session-123");

    expect(existsSync(sessionPath)).toBe(false);
  });
});

describe("createWorkspaceManager", () => {
  it("按平台选择原生实现并拒绝其他平台", () => {
    const dependencies = {
      projectEnvironmentsRoot: "/environments",
      sessionsRoot: "/sessions",
      commandRunner: createRunner().runner
    };

    expect(createWorkspaceManager({ ...dependencies, platform: "darwin" })).toBeInstanceOf(ApfsWorkspaceManager);
    expect(createWorkspaceManager({ ...dependencies, platform: "linux" })).toBeInstanceOf(BtrfsWorkspaceManager);
    expect(() => createWorkspaceManager({ ...dependencies, platform: "win32" })).toThrow(
      "Workspace platform is unsupported: win32"
    );
  });
});
