import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type Database from "better-sqlite3";

import type { CommandRunner } from "../workspaces/workspace-manager.js";
import type { ProjectEnvironmentStore } from "./project-environment-store.js";

const isGitRepository = async (path: string): Promise<boolean> => {
  try {
    return (await stat(join(path, ".git"))).isDirectory();
  } catch (_error) {
    return false;
  }
};

/** Imports the former global Workspace as the first immutable environment revision. */
export const importLegacyProjectEnvironment = async (input: {
  db: Database.Database;
  store: ProjectEnvironmentStore;
  workspaceTemplate: string;
  commandRunner: CommandRunner;
}): Promise<void> => {
  if (input.store.list().length > 0) return;
  const environment = input.store.create({ name: "默认项目环境" });
  let entries: string[] = [];
  try {
    entries = await readdir(input.workspaceTemplate);
  } catch (_error) {
    // A filesystem backend check is authoritative; an empty/non-readable legacy template imports without repositories.
  }
  for (const name of entries.sort()) {
    const path = join(input.workspaceTemplate, name);
    if (!(await isGitRepository(path))) continue;
    try {
      const { stdout } = await input.commandRunner.run("git", ["-C", path, "config", "--get", "remote.origin.url"]);
      const gitUrl = stdout.trim();
      if (gitUrl !== "") {
        input.store.addRepository(environment.id, { name, gitUrl, prepareCommand: null });
      }
    } catch (_error) {
      // A directory without a readable origin is not imported as a managed project.
    }
  }
  const revision = input.store.beginRevision({
    id: randomUUID(),
    projectEnvironmentId: environment.id,
    configurationFingerprint: input.store.configurationFingerprint(environment.id),
    inputFingerprint: `legacy:${new Date().toISOString()}`,
    workspacePath: input.workspaceTemplate
  });
  input.store.publishRevision(revision.id);
  input.db.prepare("UPDATE agents SET project_environment_id = ? WHERE project_environment_id IS NULL")
    .run(environment.id);
};
