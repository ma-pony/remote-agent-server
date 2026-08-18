import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import type { EnvironmentRepository } from "../domain.js";
import type { WorkspaceManager } from "../workspaces/workspace-manager.js";
import type { ProjectEnvironmentCommands, RemoteRepositoryState } from "./project-environment-commands.js";
import type { ProjectEnvironmentStore } from "./project-environment-store.js";

type ManifestRepository = {
  name: string;
  gitUrl: string;
  prepareCommand: string | null;
  defaultBranch: string;
  commit: string;
};

type EnvironmentManifest = { repositories: ManifestRepository[] };

type InspectedRepository = { repository: EnvironmentRepository; state: RemoteRepositoryState };

const MANIFEST_NAME = ".remote-agent-environment.json";

const fingerprint = (values: ManifestRepository[]): string =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const isInside = (root: string, path: string): boolean => {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath !== "" && !relativePath.startsWith("..") && !relativePath.startsWith("/");
};

export type ProjectEnvironmentBuilderDependencies = {
  store: ProjectEnvironmentStore;
  workspaceManager: WorkspaceManager;
  commands: ProjectEnvironmentCommands;
  projectEnvironmentsRoot: string;
  prepareTimeoutMs: number;
};

/** Builds immutable project-environment revisions and atomically publishes successful output. */
export class ProjectEnvironmentBuilder {
  private activeAbortController: AbortController | undefined;
  private activeBuild: Promise<{ outcome: "unchanged" | "published"; revisionId?: string }> | undefined;

  constructor(private readonly dependencies: ProjectEnvironmentBuilderDependencies) {}

  async checkAndBuild(environmentId: string): Promise<{ outcome: "unchanged" | "published"; revisionId?: string }> {
    if (this.activeAbortController !== undefined) throw new Error("environment_builder_busy");
    const controller = new AbortController();
    this.activeAbortController = controller;
    const build = this.build(environmentId, controller.signal);
    this.activeBuild = build;
    try {
      return await build;
    } finally {
      if (this.activeAbortController === controller) this.activeAbortController = undefined;
      if (this.activeBuild === build) this.activeBuild = undefined;
    }
  }

  async stop(): Promise<void> {
    this.activeAbortController?.abort();
    try {
      await this.activeBuild;
    } catch (_error) {
      // The active request receives the build failure; shutdown only waits for cleanup.
    }
  }

  private async build(
    environmentId: string,
    signal: AbortSignal
  ): Promise<{ outcome: "unchanged" | "published"; revisionId?: string }> {
    const environment = this.dependencies.store.get(environmentId);
    if (environment === undefined) throw new Error("environment_not_found");
    if (environment.repositories.length === 0) throw new Error("environment_has_no_repositories");
    const configurationFingerprint = this.dependencies.store.configurationFingerprint(environmentId);
    const inspected: InspectedRepository[] = [];
    for (const repository of environment.repositories) {
      inspected.push({ repository, state: await this.dependencies.commands.inspect(repository, signal) });
    }
    const manifest: EnvironmentManifest = {
      repositories: inspected.map(({ repository, state }) => ({
        name: repository.name,
        gitUrl: repository.gitUrl,
        prepareCommand: repository.prepareCommand,
        defaultBranch: state.defaultBranch,
        commit: state.commit
      }))
    };
    const inputFingerprint = fingerprint(manifest.repositories);
    const current = this.dependencies.store.getCurrentRevision(environmentId);
    const invalidRepositories = new Set<string>();
    if (current !== undefined && current.workspacePath !== null) {
      for (const { repository } of inspected) {
        const destination = join(current.workspacePath, repository.name);
        if (!await this.dependencies.commands.isRepository(destination, signal)) {
          invalidRepositories.add(repository.name);
        }
      }
    }
    this.dependencies.store.markChecked(environmentId);
    if (current?.inputFingerprint === inputFingerprint && invalidRepositories.size === 0) {
      return { outcome: "unchanged" };
    }

    const revisionId = randomUUID();
    const workspacePath = join(
      this.dependencies.projectEnvironmentsRoot,
      environmentId,
      "revisions",
      revisionId,
      "workspace"
    );
    const revision = this.dependencies.store.beginRevision({
      id: revisionId,
      projectEnvironmentId: environmentId,
      configurationFingerprint,
      inputFingerprint,
      workspacePath
    });
    let stage = "workspace";
    try {
      await this.dependencies.workspaceManager.createRevision(workspacePath, current?.workspacePath ?? null);
      const previousManifest = current?.workspacePath === null || current === undefined
        ? { repositories: [] }
        : await this.readManifest(current.workspacePath);
      const previousByName = new Map(previousManifest.repositories.map((item) => [item.name, item]));
      const currentNames = new Set(manifest.repositories.map((item) => item.name));
      for (const previous of previousManifest.repositories) {
        if (!currentNames.has(previous.name)) await rm(join(workspacePath, previous.name), { recursive: true, force: true });
      }

      for (const { repository, state } of inspected) {
        const previous = previousByName.get(repository.name);
        const destination = join(workspacePath, repository.name);
        const needsClone = previous === undefined
          || previous.gitUrl !== repository.gitUrl
          || invalidRepositories.has(repository.name);
        const sourceChanged = needsClone || previous.commit !== state.commit || previous.defaultBranch !== state.defaultBranch;
        const prepareChanged = previous?.prepareCommand !== repository.prepareCommand;
        if (needsClone) {
          stage = `clone:${repository.name}`;
          await rm(destination, { recursive: true, force: true });
          await this.dependencies.commands.clone(repository, destination, state.defaultBranch, signal);
        } else if (sourceChanged) {
          stage = `update:${repository.name}`;
          await this.dependencies.commands.update(repository, destination, state.defaultBranch, signal);
        }
        if (sourceChanged || prepareChanged) {
          stage = `prepare:${repository.name}`;
          await this.dependencies.commands.prepare(
            repository,
            destination,
            this.dependencies.prepareTimeoutMs,
            signal
          );
        }
      }
      stage = "manifest";
      await writeFile(join(workspacePath, MANIFEST_NAME), JSON.stringify(manifest, null, 2), "utf8");
      this.dependencies.store.publishRevision(revision.id);
      await this.cleanupOldRevisions(environmentId);
      return { outcome: "published", revisionId };
    } catch (error) {
      try {
        await this.dependencies.workspaceManager.removeRevision(workspacePath);
      } catch (_cleanupError) {
        // The build error remains authoritative.
      }
      this.dependencies.store.failRevision(revision.id, stage, errorMessage(error));
      this.dependencies.store.clearRevisionWorkspacePath(revision.id);
      throw error;
    }
  }

  private async readManifest(workspacePath: string): Promise<EnvironmentManifest> {
    try {
      return JSON.parse(await readFile(join(workspacePath, MANIFEST_NAME), "utf8")) as EnvironmentManifest;
    } catch (_error) {
      return { repositories: [] };
    }
  }

  private async cleanupOldRevisions(environmentId: string): Promise<void> {
    const ready = this.dependencies.store.listRevisions(environmentId).filter((item) => item.status === "ready");
    for (const revision of ready.slice(2)) {
      if (revision.workspacePath === null) continue;
      if (!isInside(this.dependencies.projectEnvironmentsRoot, revision.workspacePath)) continue;
      await this.dependencies.workspaceManager.removeRevision(revision.workspacePath);
      await rm(dirname(revision.workspacePath), { recursive: true, force: true });
      this.dependencies.store.clearRevisionWorkspacePath(revision.id);
    }
  }
}
