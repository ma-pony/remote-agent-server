import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
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

export class WorkspaceCreateError extends Error {
  readonly code = "workspace_create_failed";

  constructor() {
    super("Failed to create workspace");
  }
}

export const systemCommandRunner: CommandRunner = {
  async run(command, args) {
    const { stdout, stderr } = await execFileAsync(command, args);
    return { stdout, stderr };
  }
};

export type BtrfsWorkspaceManagerDependencies = {
  workspaceTemplate: string;
  sessionsRoot: string;
  commandRunner: CommandRunner;
};

/**
 * Creates isolated writable Btrfs workspace snapshots for Sessions.
 */
export class BtrfsWorkspaceManager {
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
    await this.commandRunner.run("btrfs", ["subvolume", "show", this.workspaceTemplate]);
  }

  /**
   * Creates the Session directories and its writable template snapshot.
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
      await this.commandRunner.run("btrfs", ["subvolume", "snapshot", this.workspaceTemplate, workspacePath]);
    } catch (_error) {
      await rm(sessionPath, { force: true, recursive: true });
      throw new WorkspaceCreateError();
    }

    return { workspacePath, runtimePath, browserProfilePath };
  }

  /**
   * Removes a newly-created snapshot after Session persistence fails.
   */
  async rollback(id: string): Promise<void> {
    const sessionPath = join(this.sessionsRoot, id);
    const workspacePath = join(sessionPath, "workspace");

    await this.commandRunner.run("btrfs", ["subvolume", "delete", workspacePath]);
    await rm(sessionPath, { force: true, recursive: true });
  }
}
