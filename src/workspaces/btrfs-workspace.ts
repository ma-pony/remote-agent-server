import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";

import {
  WorkspaceCheckError,
  WorkspaceCreateError,
  type CommandRunner,
  type Workspace,
  type WorkspaceManager
} from "./workspace-manager.js";

export type BtrfsWorkspaceManagerDependencies = {
  projectEnvironmentsRoot: string;
  sessionsRoot: string;
  commandRunner: CommandRunner;
};

/**
 * Creates isolated writable Btrfs workspace snapshots for Sessions.
 */
export class BtrfsWorkspaceManager implements WorkspaceManager {
  private readonly projectEnvironmentsRoot: string;
  private readonly sessionsRoot: string;
  private readonly commandRunner: CommandRunner;

  constructor({ projectEnvironmentsRoot, sessionsRoot, commandRunner }: BtrfsWorkspaceManagerDependencies) {
    this.projectEnvironmentsRoot = projectEnvironmentsRoot;
    this.sessionsRoot = sessionsRoot;
    this.commandRunner = commandRunner;
  }

  /**
   * Verifies that project environments and Sessions use one Btrfs filesystem.
   */
  async check(): Promise<void> {
    try {
      await this.commandRunner.run("btrfs", ["filesystem", "show", this.projectEnvironmentsRoot]);
      await this.commandRunner.run("btrfs", ["filesystem", "show", this.sessionsRoot]);
      const environmentsDevice = (await stat(this.projectEnvironmentsRoot)).dev;
      const sessionsDevice = (await stat(this.sessionsRoot)).dev;
      if (environmentsDevice !== sessionsDevice) throw new Error("different filesystems");
    } catch (_error) {
      throw new WorkspaceCheckError("Linux workspace requires environments and sessions on the same Btrfs filesystem");
    }
  }

  /**
   * Creates a Session from one explicitly selected environment revision.
   */
  async createSession(id: string, sourcePath: string): Promise<Workspace> {
    const sessionPath = join(this.sessionsRoot, id);
    const workspacePath = join(sessionPath, "workspace");
    const runtimePath = join(sessionPath, "runtime");
    const browserProfilePath = join(sessionPath, "browser");

    try {
      await mkdir(sessionPath, { recursive: true });
      await mkdir(runtimePath);
      await mkdir(browserProfilePath);
      await this.commandRunner.run("btrfs", ["subvolume", "snapshot", sourcePath, workspacePath]);
    } catch (_error) {
      try {
        await this.deleteSession(id);
      } catch (_cleanupError) {
        // The snapshot failure remains authoritative.
      }
      throw new WorkspaceCreateError();
    }

    return { workspacePath, runtimePath, browserProfilePath };
  }

  /** Removes a newly-created Session snapshot and its runtime directories. */
  async deleteSession(id: string): Promise<void> {
    const sessionPath = join(this.sessionsRoot, id);
    const workspacePath = join(sessionPath, "workspace");

    try {
      await stat(workspacePath);
      await this.commandRunner.run("btrfs", ["subvolume", "delete", workspacePath]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rm(sessionPath, { force: true, recursive: true });
  }

  /** Creates either an empty Btrfs subvolume or a writable revision snapshot. */
  async createRevision(targetPath: string, sourcePath: string | null): Promise<void> {
    try {
      await mkdir(dirname(targetPath), { recursive: true });
      const args = sourcePath === null
        ? ["subvolume", "create", targetPath]
        : ["subvolume", "snapshot", sourcePath, targetPath];
      await this.commandRunner.run("btrfs", args);
    } catch (error) {
      try {
        await this.commandRunner.run("btrfs", ["subvolume", "delete", targetPath]);
      } catch (_cleanupError) {
        // Preserve the original create failure.
      }
      await rm(targetPath, { force: true, recursive: true });
      throw error;
    }
  }

  /** Deletes one exact environment revision subvolume. */
  async removeRevision(path: string): Promise<void> {
    await this.commandRunner.run("btrfs", ["subvolume", "delete", path]);
    await rm(path, { force: true, recursive: true });
  }
}
