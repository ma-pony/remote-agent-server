import { mkdir, rm, stat as nodeStat, statfs as nodeStatfs } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";

import {
  WorkspaceCheckError,
  WorkspaceCreateError,
  type CommandRunner,
  type Workspace,
  type WorkspaceManager
} from "./workspace-manager.js";

export type ApfsWorkspaceManagerDependencies = {
  workspaceTemplate: string;
  sessionsRoot: string;
  commandRunner: CommandRunner;
  fileSystemInspector?: FileSystemInspector;
};

const APFS_CHECK_ERROR = "macOS workspace requires template and sessions on the same APFS volume";
const APFS_FILE_SYSTEM_TYPE = 26;

export interface FileSystemInspector {
  statfs(path: string): Promise<{ type: number }>;
  stat(path: string): Promise<{ dev: number }>;
}

export const nodeFileSystemInspector: FileSystemInspector = {
  async statfs(path) {
    const { type } = await nodeStatfs(path);
    return { type };
  },
  async stat(path) {
    const { dev } = await nodeStat(path);
    return { dev };
  }
};

/**
 * Creates isolated writable APFS clones for Sessions on macOS.
 */
export class ApfsWorkspaceManager implements WorkspaceManager {
  private readonly workspaceTemplate: string;
  private readonly sessionsRoot: string;
  private readonly commandRunner: CommandRunner;
  private readonly fileSystemInspector: FileSystemInspector;

  constructor({
    workspaceTemplate,
    sessionsRoot,
    commandRunner,
    fileSystemInspector = nodeFileSystemInspector
  }: ApfsWorkspaceManagerDependencies) {
    this.workspaceTemplate = workspaceTemplate;
    this.sessionsRoot = sessionsRoot;
    this.commandRunner = commandRunner;
    this.fileSystemInspector = fileSystemInspector;
  }

  /**
   * Verifies that template and Sessions share one APFS volume.
   */
  async check(): Promise<void> {
    try {
      const templateType = (await this.fileSystemInspector.statfs(this.workspaceTemplate)).type;
      const sessionsType = (await this.fileSystemInspector.statfs(this.sessionsRoot)).type;
      const templateDevice = (await this.fileSystemInspector.stat(this.workspaceTemplate)).dev;
      const sessionsDevice = (await this.fileSystemInspector.stat(this.sessionsRoot)).dev;

      if (
        templateType !== APFS_FILE_SYSTEM_TYPE
        || sessionsType !== APFS_FILE_SYSTEM_TYPE
        || templateDevice !== sessionsDevice
      ) {
        throw new WorkspaceCheckError(APFS_CHECK_ERROR);
      }
    } catch (error) {
      if (error instanceof WorkspaceCheckError) throw error;
      throw new WorkspaceCheckError(APFS_CHECK_ERROR);
    }
  }

  /**
   * Creates the Session directories and its writable APFS clone.
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
      await this.commandRunner.run("cp", ["-cR", sourcePath, workspacePath]);
    } catch (_error) {
      await rm(sessionPath, { force: true, recursive: true });
      throw new WorkspaceCreateError();
    }

    return { workspacePath, runtimePath, browserProfilePath };
  }

  /**
   * Removes a newly-created APFS Session after persistence fails.
   */
  /** Removes a newly-created Session directory. */
  async rollbackSession(id: string): Promise<void> {
    await rm(join(this.sessionsRoot, id), { force: true, recursive: true });
  }

  /** Creates either an empty environment revision or an APFS clone. */
  async createRevision(targetPath: string, sourcePath: string | null): Promise<void> {
    try {
      await mkdir(dirname(targetPath), { recursive: true });
      if (sourcePath === null) {
        await mkdir(targetPath);
      } else {
        await this.commandRunner.run("cp", ["-cR", sourcePath, targetPath]);
      }
    } catch (error) {
      await rm(targetPath, { force: true, recursive: true });
      throw error;
    }
  }

  /** Deletes one exact environment revision directory. */
  async removeRevision(path: string): Promise<void> {
    await rm(path, { force: true, recursive: true });
  }

}
