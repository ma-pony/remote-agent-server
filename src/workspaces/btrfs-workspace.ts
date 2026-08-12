import { mkdir, rm } from "node:fs/promises";
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
  workspaceTemplate: string;
  sessionsRoot: string;
  commandRunner: CommandRunner;
};

/**
 * Creates isolated writable Btrfs workspace snapshots for Sessions.
 */
export class BtrfsWorkspaceManager implements WorkspaceManager {
  private readonly workspaceTemplate: string;
  private readonly sessionsRoot: string;
  private readonly commandRunner: CommandRunner;

  constructor({ workspaceTemplate, sessionsRoot, commandRunner }: BtrfsWorkspaceManagerDependencies) {
    this.workspaceTemplate = workspaceTemplate;
    this.sessionsRoot = sessionsRoot;
    this.commandRunner = commandRunner;
  }

  /**
   * Verifies that the configured workspace template is a Btrfs subvolume.
   */
  async check(): Promise<void> {
    try {
      await this.commandRunner.run("btrfs", ["subvolume", "show", this.workspaceTemplate]);
    } catch (_error) {
      throw new WorkspaceCheckError("Linux workspace requires Btrfs");
    }
  }

  /**
   * Creates the Session directories and its writable template snapshot.
   */
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
      await rm(sessionPath, { force: true, recursive: true });
      throw new WorkspaceCreateError();
    }

    return { workspacePath, runtimePath, browserProfilePath };
  }

  /**
   * Removes a newly-created snapshot after Session persistence fails.
   */
  /** Removes a newly-created Session snapshot and its runtime directories. */
  async rollbackSession(id: string): Promise<void> {
    const sessionPath = join(this.sessionsRoot, id);
    const workspacePath = join(sessionPath, "workspace");

    await this.commandRunner.run("btrfs", ["subvolume", "delete", workspacePath]);
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
