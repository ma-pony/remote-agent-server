import { mkdir, rm } from "node:fs/promises";
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
};

const APFS_CHECK_ERROR = "macOS workspace requires template and sessions on the same APFS volume";

/**
 * Creates isolated writable APFS clones for Sessions on macOS.
 */
export class ApfsWorkspaceManager implements WorkspaceManager {
  private readonly workspaceTemplate: string;
  private readonly sessionsRoot: string;
  private readonly commandRunner: CommandRunner;

  constructor({ workspaceTemplate, sessionsRoot, commandRunner }: ApfsWorkspaceManagerDependencies) {
    this.workspaceTemplate = workspaceTemplate;
    this.sessionsRoot = sessionsRoot;
    this.commandRunner = commandRunner;
  }

  /**
   * Verifies that template and Sessions share one APFS volume.
   */
  async check(): Promise<void> {
    try {
      const templateType = await this.stat("%T", this.workspaceTemplate);
      const sessionsType = await this.stat("%T", this.sessionsRoot);
      const templateDevice = await this.stat("%d", this.workspaceTemplate);
      const sessionsDevice = await this.stat("%d", this.sessionsRoot);

      if (templateType !== "apfs" || sessionsType !== "apfs" || templateDevice !== sessionsDevice) {
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
  async create(id: string): Promise<Workspace> {
    const sessionPath = join(this.sessionsRoot, id);
    const workspacePath = join(sessionPath, "workspace");
    const runtimePath = join(sessionPath, "runtime");
    const browserProfilePath = join(sessionPath, "browser");

    try {
      await mkdir(sessionPath, { recursive: true });
      await mkdir(runtimePath);
      await mkdir(browserProfilePath);
      await this.commandRunner.run("cp", ["-cR", this.workspaceTemplate, workspacePath]);
    } catch (_error) {
      await rm(sessionPath, { force: true, recursive: true });
      throw new WorkspaceCreateError();
    }

    return { workspacePath, runtimePath, browserProfilePath };
  }

  /**
   * Removes a newly-created APFS Session after persistence fails.
   */
  async rollback(id: string): Promise<void> {
    await rm(join(this.sessionsRoot, id), { force: true, recursive: true });
  }

  private async stat(format: "%T" | "%d", path: string): Promise<string> {
    const result = await this.commandRunner.run("stat", ["-f", format, path]);
    return result.stdout.trim();
  }
}
