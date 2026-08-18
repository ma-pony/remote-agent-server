import { ApfsWorkspaceManager, type FileSystemInspector } from "./apfs-workspace.js";
import { BtrfsWorkspaceManager } from "./btrfs-workspace.js";
import {
  WorkspaceCheckError,
  systemCommandRunner,
  type CommandRunner,
  type WorkspaceManager
} from "./workspace-manager.js";

export type CreateWorkspaceManagerInput = {
  platform?: NodeJS.Platform;
  projectEnvironmentsRoot: string;
  sessionsRoot: string;
  commandRunner?: CommandRunner;
  fileSystemInspector?: FileSystemInspector;
};

/**
 * Selects the host platform's native copy-on-write workspace backend.
 */
export const createWorkspaceManager = ({
  platform = process.platform,
  projectEnvironmentsRoot,
  sessionsRoot,
  commandRunner = systemCommandRunner,
  fileSystemInspector
}: CreateWorkspaceManagerInput): WorkspaceManager => {
  const dependencies = { projectEnvironmentsRoot, sessionsRoot, commandRunner };

  if (platform === "darwin") return new ApfsWorkspaceManager({ ...dependencies, fileSystemInspector });
  if (platform === "linux") return new BtrfsWorkspaceManager(dependencies);
  throw new WorkspaceCheckError(`Workspace platform is unsupported: ${platform}`);
};
