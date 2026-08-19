import { mkdir, rm, stat as systemStat } from "node:fs/promises";
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
  fileSystemInspector?: {
    stat(path: string): Promise<{ dev: number }>;
  };
};

const systemFileSystemInspector = { stat: systemStat };

/**
 * Creates isolated writable Btrfs workspace snapshots for Sessions.
 */
export class BtrfsWorkspaceManager implements WorkspaceManager {
  private readonly projectEnvironmentsRoot: string;
  private readonly sessionsRoot: string;
  private readonly commandRunner: CommandRunner;
  private readonly fileSystemInspector: NonNullable<BtrfsWorkspaceManagerDependencies["fileSystemInspector"]>;

  constructor({
    projectEnvironmentsRoot,
    sessionsRoot,
    commandRunner,
    fileSystemInspector = systemFileSystemInspector
  }: BtrfsWorkspaceManagerDependencies) {
    this.projectEnvironmentsRoot = projectEnvironmentsRoot;
    this.sessionsRoot = sessionsRoot;
    this.commandRunner = commandRunner;
    this.fileSystemInspector = fileSystemInspector;
  }

  /**
   * Verifies that project environments and Sessions use one Btrfs filesystem.
   */
  async check(): Promise<void> {
    for (const root of [this.projectEnvironmentsRoot, this.sessionsRoot]) {
      try {
        await this.commandRunner.run("btrfs", ["filesystem", "show", root]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new WorkspaceCheckError("btrfs command not found; install btrfs-progs");
        }
        throw new WorkspaceCheckError(`Linux workspace root is not on Btrfs or is not accessible: ${root}`);
      }
    }

    try {
      const environmentsDevice = (await this.fileSystemInspector.stat(this.projectEnvironmentsRoot)).dev;
      const sessionsDevice = (await this.fileSystemInspector.stat(this.sessionsRoot)).dev;
      if (environmentsDevice !== sessionsDevice) {
        throw new WorkspaceCheckError("Linux workspace requires environments and sessions on the same Btrfs filesystem");
      }
    } catch (error) {
      if (error instanceof WorkspaceCheckError) throw error;
      throw new WorkspaceCheckError("Linux workspace roots could not be inspected");
    }
  }

  /**
   * Creates a Session from one explicitly selected environment revision.
   */
  async createSession(id: number, sourcePath: string): Promise<Workspace> {
    const sessionPath = join(this.sessionsRoot, String(id));
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
  async deleteSession(id: number): Promise<void> {
    const sessionPath = join(this.sessionsRoot, String(id));
    const workspacePath = join(sessionPath, "workspace");

    try {
      await systemStat(workspacePath);
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
