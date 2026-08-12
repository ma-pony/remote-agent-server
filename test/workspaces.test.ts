import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BtrfsWorkspaceManager } from "../src/workspaces/btrfs-workspace.js";
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

afterEach(() => {
  tempDirs.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
});

describe("BtrfsWorkspaceManager", () => {
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

  it("通过可注入命令边界检查模板 Subvolume", async () => {
    const root = createTempDir();
    const { runner, calls } = createRunner();
    const manager = new BtrfsWorkspaceManager({
      workspaceTemplate: join(root, "template"),
      sessionsRoot: join(root, "sessions"),
      commandRunner: runner
    });

    await manager.check();

    expect(calls).toEqual([{ command: "btrfs", args: ["subvolume", "show", join(root, "template")] }]);
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
    const manager = new BtrfsWorkspaceManager({ workspaceTemplate: template, sessionsRoot, commandRunner: runner });

    const workspace = await manager.create("session-123");

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

  it("快照失败时清理尚未持久化的 Session 目录", async () => {
    const root = createTempDir();
    const sessionsRoot = join(root, "sessions");
    const manager = new BtrfsWorkspaceManager({
      workspaceTemplate: join(root, "template"),
      sessionsRoot,
      commandRunner: { run: async () => Promise.reject(new Error("snapshot failed")) }
    });

    await expect(manager.create("session-123")).rejects.toMatchObject({ code: "workspace_create_failed" });
    expect(existsSync(join(sessionsRoot, "session-123"))).toBe(false);
  });
});
