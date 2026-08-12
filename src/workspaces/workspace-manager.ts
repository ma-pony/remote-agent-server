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
  createSession(id: string, sourcePath: string): Promise<Workspace>;
  rollbackSession(id: string): Promise<void>;
  createRevision(targetPath: string, sourcePath: string | null): Promise<void>;
  removeRevision(path: string): Promise<void>;
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
