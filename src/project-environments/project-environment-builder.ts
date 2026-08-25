import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
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
  dependencyFingerprint?: string | null;
};

type EnvironmentManifest = { preparationVersion?: number; repositories: ManifestRepository[] };

type InspectedRepository = { repository: EnvironmentRepository; state: RemoteRepositoryState };

const MANIFEST_NAME = ".remote-agent-environment.json";
const PREPARATION_VERSION = 3;
const UV_DEPENDENCY_FILES = ["uv.lock", "pyproject.toml", ".python-version"] as const;

const fingerprint = (values: ManifestRepository[]): string =>
  createHash("sha256").update(JSON.stringify({
    preparationVersion: PREPARATION_VERSION,
    repositories: values.map(({ dependencyFingerprint: _dependencyFingerprint, ...repository }) => repository)
  }))
    .digest("hex");

type DependencyFileSnapshot = Array<{ name: string; content: Buffer | null }>;

const readDependencyFiles = async (repositoryPath: string): Promise<DependencyFileSnapshot> => {
  const files: DependencyFileSnapshot = [];
  for (const name of UV_DEPENDENCY_FILES) {
    try {
      files.push({ name, content: await readFile(join(repositoryPath, name)) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      files.push({ name, content: null });
    }
  }
  return files;
};

const restoreDependencyFiles = async (
  repositoryPath: string,
  files: DependencyFileSnapshot
): Promise<void> => {
  for (const { name, content } of files) {
    const path = join(repositoryPath, name);
    if (content === null) await rm(path, { force: true });
    else await writeFile(path, content);
  }
};

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
  private activeBuild: Promise<{ outcome: "unchanged" | "published"; revisionId?: number }> | undefined;

  constructor(private readonly dependencies: ProjectEnvironmentBuilderDependencies) {}

  async checkAndBuild(environmentId: number): Promise<{ outcome: "unchanged" | "published"; revisionId?: number }> {
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
    environmentId: number,
    signal: AbortSignal
  ): Promise<{ outcome: "unchanged" | "published"; revisionId?: number }> {
    const environment = this.dependencies.store.get(environmentId);
    if (environment === undefined) throw new Error("environment_not_found");
    if (environment.repositories.length === 0) throw new Error("environment_has_no_repositories");
    const configurationFingerprint = this.dependencies.store.configurationFingerprint(environmentId);
    const inspected: InspectedRepository[] = [];
    for (const repository of environment.repositories) {
      inspected.push({ repository, state: await this.dependencies.commands.inspect(repository, signal) });
    }
    const manifest: EnvironmentManifest = {
      preparationVersion: PREPARATION_VERSION,
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
      try {
        await this.cleanupOldRevisions(environmentId);
      } catch (_cleanupError) {
        // Cleanup is best-effort and will be retried by a later sync or Session lifecycle event.
      }
      return { outcome: "unchanged" };
    }

    const revision = this.dependencies.store.beginRevision({
      projectEnvironmentId: environmentId,
      configurationFingerprint,
      inputFingerprint
    });
    const revisionId = revision.id;
    const workspacePath = join(
      this.dependencies.projectEnvironmentsRoot,
      String(environmentId),
      "revisions",
      String(revisionId),
      "workspace"
    );
    this.dependencies.store.setRevisionWorkspacePath(revisionId, workspacePath);
    let stage = "workspace";
    try {
      await this.dependencies.workspaceManager.createRevision(workspacePath, current?.workspacePath ?? null);
      const previousManifest = current?.workspacePath === null || current === undefined
        ? { preparationVersion: PREPARATION_VERSION, repositories: [] }
        : await this.readManifest(current.workspacePath);
      const previousByName = new Map(previousManifest.repositories.map((item) => [item.name, item]));
      const currentNames = new Set(manifest.repositories.map((item) => item.name));
      const preparationRulesChanged = previousManifest.preparationVersion !== undefined
        && previousManifest.preparationVersion !== PREPARATION_VERSION;
      for (const previous of previousManifest.repositories) {
        if (!currentNames.has(previous.name)) await rm(join(workspacePath, previous.name), { recursive: true, force: true });
      }

      for (const [index, { repository, state }] of inspected.entries()) {
        const previous = previousByName.get(repository.name);
        const destination = join(workspacePath, repository.name);
        const needsClone = previous === undefined
          || previous.gitUrl !== repository.gitUrl
          || invalidRepositories.has(repository.name);
        const sourceChanged = needsClone || previous.commit !== state.commit || previous.defaultBranch !== state.defaultBranch;
        const preparationChanged = previous?.prepareCommand !== repository.prepareCommand;
        const previousDependencyFingerprint = needsClone
          ? null
          : previous?.dependencyFingerprint
            ?? await this.dependencies.commands.dependencyFingerprint(destination, signal);
        const preparedDependencyFiles = sourceChanged && previousDependencyFingerprint !== null
          ? await readDependencyFiles(destination)
          : [];
        if (needsClone) {
          stage = `clone:${repository.name}`;
          await rm(destination, { recursive: true, force: true });
          await this.dependencies.commands.clone(repository, destination, state.defaultBranch, signal);
        } else if (sourceChanged || preparationRulesChanged || preparationChanged) {
          stage = `update:${repository.name}`;
          await this.dependencies.commands.update(repository, destination, state.defaultBranch, signal);
        }
        const nextDependencyFingerprint = await this.dependencies.commands.dependencyFingerprint(destination, signal);
        const dependenciesChanged = sourceChanged && (
          previousDependencyFingerprint === null
          || nextDependencyFingerprint === null
          || previousDependencyFingerprint !== nextDependencyFingerprint
        );
        if (needsClone || preparationRulesChanged || preparationChanged || dependenciesChanged) {
          stage = `clean:${repository.name}`;
          await this.dependencies.commands.cleanIgnored(repository, destination, signal);
          stage = `prepare:${repository.name}`;
          await this.dependencies.commands.prepare(
            repository,
            destination,
            this.dependencies.prepareTimeoutMs,
            signal
          );
        } else if (sourceChanged) {
          await restoreDependencyFiles(destination, preparedDependencyFiles);
        }
        manifest.repositories[index] = {
          ...manifest.repositories[index]!,
          dependencyFingerprint: nextDependencyFingerprint
        };
      }
      stage = "manifest";
      await writeFile(join(workspacePath, MANIFEST_NAME), JSON.stringify(manifest, null, 2), "utf8");
      this.dependencies.store.publishRevision(revision.id);
      try {
        await this.cleanupOldRevisions(environmentId);
      } catch (_cleanupError) {
        // The published environment remains authoritative; a later cleanup pass retries obsolete Workspaces.
      }
      return { outcome: "published", revisionId };
    } catch (error) {
      let workspaceRemoved = false;
      try {
        await this.dependencies.workspaceManager.removeRevision(workspacePath);
        workspaceRemoved = true;
      } catch (_cleanupError) {
        // The build error remains authoritative.
      }
      this.dependencies.store.failRevision(revision.id, stage, errorMessage(error));
      if (workspaceRemoved) this.dependencies.store.clearRevisionWorkspacePath(revision.id);
      throw error;
    }
  }

  private async readManifest(workspacePath: string): Promise<EnvironmentManifest> {
    try {
      return JSON.parse(await readFile(join(workspacePath, MANIFEST_NAME), "utf8")) as EnvironmentManifest;
    } catch (_error) {
      return { preparationVersion: PREPARATION_VERSION, repositories: [] };
    }
  }

  /** Keeps only the current environment Workspace; Session snapshots own their filesystem state. */
  async cleanupOldRevisions(environmentId: number): Promise<void> {
    const currentRevisionId = this.dependencies.store.get(environmentId)?.currentRevisionId;
    const obsolete = this.dependencies.store.listRevisions(environmentId)
      .filter((item) => item.status === "ready" || item.status === "failed");
    for (const revision of obsolete) {
      if (revision.id === currentRevisionId) continue;
      if (revision.workspacePath === null) continue;
      if (this.dependencies.store.isRevisionSnapshotPending(revision.id)) continue;
      if (!isInside(this.dependencies.projectEnvironmentsRoot, revision.workspacePath)) continue;
      await this.dependencies.workspaceManager.removeRevision(revision.workspacePath);
      await rm(dirname(revision.workspacePath), { recursive: true, force: true });
      this.dependencies.store.clearRevisionWorkspacePath(revision.id);
    }
  }
}
