import { ApfsWorkspaceManager } from "./apfs-workspace.js";
import { BtrfsWorkspaceManager } from "./btrfs-workspace.js";
import {
  WorkspaceCheckError,
  systemCommandRunner,
  type CommandRunner,
  type WorkspaceManager
} from "./workspace-manager.js";

export type CreateWorkspaceManagerInput = {
  platform?: NodeJS.Platform;
  workspaceTemplate: string;
  sessionsRoot: string;
  commandRunner?: CommandRunner;
};

/**
 * Selects the host platform's native copy-on-write workspace backend.
 */
export const createWorkspaceManager = ({
  platform = process.platform,
  workspaceTemplate,
  sessionsRoot,
  commandRunner = systemCommandRunner
}: CreateWorkspaceManagerInput): WorkspaceManager => {
  const dependencies = { workspaceTemplate, sessionsRoot, commandRunner };

  if (platform === "darwin") return new ApfsWorkspaceManager(dependencies);
  if (platform === "linux") return new BtrfsWorkspaceManager(dependencies);
  throw new WorkspaceCheckError(`Workspace platform is unsupported: ${platform}`);
};
