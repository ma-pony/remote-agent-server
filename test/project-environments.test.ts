import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectEnvironmentBuilder } from "../src/project-environments/project-environment-builder.js";
import { ProjectEnvironmentStore } from "../src/project-environments/project-environment-store.js";
import type { ProjectEnvironmentCommands } from "../src/project-environments/project-environment-commands.js";
import type { WorkspaceManager } from "../src/workspaces/workspace-manager.js";
import { createTestDatabase } from "./helpers.js";

const tempDirectories: string[] = [];

afterEach(() => {
  tempDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

const createBuilderFixture = () => {
  const { db } = createTestDatabase();
  const store = new ProjectEnvironmentStore({ db });
  const root = mkdtempSync(join(tmpdir(), "project-environment-builder-"));
  tempDirectories.push(root);
  const remoteCommits = new Map<string, string>();
  const calls: string[] = [];
  const commands: ProjectEnvironmentCommands = {
    inspect: async (repository) => ({ defaultBranch: "main", commit: remoteCommits.get(repository.name) ?? "commit-1" }),
    clone: async (repository, destination) => {
      calls.push(`clone:${repository.name}`);
      mkdirSync(destination, { recursive: true });
    },
    update: async (repository, destination) => {
      calls.push(`update:${repository.name}`);
      expect(existsSync(destination)).toBe(true);
    },
    prepare: async (repository) => {
      calls.push(`prepare:${repository.name}`);
      if (repository.prepareCommand === "exit 1") throw new Error("prepare failed");
    }
  };
  const workspaceManager: WorkspaceManager = {
    check: async () => undefined,
    create: async () => { throw new Error("unused"); },
    rollback: async () => undefined,
    createSession: async () => { throw new Error("unused"); },
    rollbackSession: async () => undefined,
    createRevision: async (target, source) => {
      mkdirSync(join(target, ".."), { recursive: true });
      if (source === null) mkdirSync(target);
      else cpSync(source, target, { recursive: true, errorOnExist: true });
    },
    removeRevision: async (path) => rmSync(path, { recursive: true, force: true })
  };
  const builder = new ProjectEnvironmentBuilder({
    store,
    workspaceManager,
    commands,
    projectEnvironmentsRoot: root,
    prepareTimeoutMs: 1_000
  });
  return { db, store, root, remoteCommits, calls, builder };
};

describe("ProjectEnvironmentStore", () => {
  it("保存项目环境及唯一安全项目目录", () => {
    const { db } = createTestDatabase();
    const store = new ProjectEnvironmentStore({ db });
    const environment = store.create({ name: "Grab Manager 研发环境" });
    const repository = store.addRepository(environment.id, {
      name: "grab-manager-api",
      gitUrl: "git@example.test:rcc/grab-manager-api.git",
      prepareCommand: "bundle install"
    });

    expect(store.get(environment.id)).toMatchObject({
      id: environment.id,
      name: "Grab Manager 研发环境",
      currentRevisionId: null,
      repositories: [repository]
    });
    expect(() => store.create({ name: "Grab Manager 研发环境" })).toThrow(/UNIQUE/);
    expect(() => store.addRepository(environment.id, {
      name: "grab-manager-api",
      gitUrl: "git@example.test:rcc/duplicate.git",
      prepareCommand: null
    })).toThrow(/UNIQUE/);
    db.close();
  });

  it("原子 claim 和发布不可变版本", () => {
    const { db } = createTestDatabase();
    const store = new ProjectEnvironmentStore({ db });
    const environment = store.create({ name: "研发环境" });
    store.addRepository(environment.id, {
      name: "api",
      gitUrl: "git@example.test:rcc/api.git",
      prepareCommand: null
    });
    const configurationFingerprint = store.configurationFingerprint(environment.id);
    const revision = store.beginRevision({
      projectEnvironmentId: environment.id,
      configurationFingerprint,
      inputFingerprint: "input-v1",
      workspacePath: "/environments/env/revisions/rev/workspace"
    });

    expect(revision.status).toBe("preparing");
    expect(() => store.beginRevision({
      projectEnvironmentId: environment.id,
      configurationFingerprint,
      inputFingerprint: "input-v2",
      workspacePath: "/environments/env/revisions/rev-2/workspace"
    })).toThrow(/environment_busy/);

    const published = store.publishRevision(revision.id);
    expect(published.status).toBe("ready");
    expect(store.get(environment.id)?.currentRevisionId).toBe(revision.id);
    expect(store.getCurrentRevision(environment.id)?.id).toBe(revision.id);
    db.close();
  });

  it("配置在远程检查期间变化时拒绝使用陈旧输入", () => {
    const { db } = createTestDatabase();
    const store = new ProjectEnvironmentStore({ db });
    const environment = store.create({ name: "研发环境" });
    const repository = store.addRepository(environment.id, {
      name: "api",
      gitUrl: "git@example.test:rcc/api.git",
      prepareCommand: null
    });
    const staleFingerprint = store.configurationFingerprint(environment.id);
    store.updateRepository(environment.id, repository.id, { prepareCommand: "bundle install" });

    expect(() => store.beginRevision({
      projectEnvironmentId: environment.id,
      configurationFingerprint: staleFingerprint,
      inputFingerprint: "input-v1",
      workspacePath: "/environments/env/revisions/rev/workspace"
    })).toThrow(/stale_environment_input/);
    db.close();
  });

  it("服务恢复时将遗留构建标记失败但不改变当前版本", () => {
    const { db } = createTestDatabase();
    const store = new ProjectEnvironmentStore({ db });
    const environment = store.create({ name: "研发环境" });
    store.addRepository(environment.id, {
      name: "api",
      gitUrl: "git@example.test:rcc/api.git",
      prepareCommand: null
    });
    const first = store.beginRevision({
      projectEnvironmentId: environment.id,
      configurationFingerprint: store.configurationFingerprint(environment.id),
      inputFingerprint: "input-v1",
      workspacePath: "/environments/env/revisions/rev/workspace"
    });

    const recovered = store.recoverPreparing();

    expect(recovered).toEqual([expect.objectContaining({ id: first.id, status: "failed", failureStage: "interrupted" })]);
    expect(store.get(environment.id)?.currentRevisionId).toBeNull();
    db.close();
  });
});

describe("ProjectEnvironmentBuilder", () => {
  it("首次构建多个项目，成功后原子发布版本", async () => {
    const { db, store, calls, builder } = createBuilderFixture();
    const environment = store.create({ name: "研发环境" });
    store.addRepository(environment.id, { name: "api", gitUrl: "git:api", prepareCommand: "bundle install" });
    store.addRepository(environment.id, { name: "web", gitUrl: "git:web", prepareCommand: "pnpm install" });

    const result = await builder.checkAndBuild(environment.id);

    expect(result).toMatchObject({ outcome: "published", revisionId: expect.any(String) });
    expect(calls).toEqual(["clone:api", "prepare:api", "clone:web", "prepare:web"]);
    expect(store.get(environment.id)?.currentRevisionId).toBe(result.revisionId);
    expect(store.getCurrentRevision(environment.id)?.workspacePath).toSatisfy((path: string) => existsSync(path));
    db.close();
  });

  it("远程和配置无变化时不创建新版本", async () => {
    const { db, store, calls, builder } = createBuilderFixture();
    const environment = store.create({ name: "研发环境" });
    store.addRepository(environment.id, { name: "api", gitUrl: "git:api", prepareCommand: "bundle install" });
    const first = await builder.checkAndBuild(environment.id);
    calls.splice(0);

    const second = await builder.checkAndBuild(environment.id);

    expect(second).toEqual({ outcome: "unchanged" });
    expect(calls).toEqual([]);
    expect(store.listRevisions(environment.id)).toHaveLength(1);
    expect(store.get(environment.id)?.currentRevisionId).toBe(first.revisionId);
    db.close();
  });

  it("只有一个项目变化时只更新和准备该项目", async () => {
    const { db, store, remoteCommits, calls, builder } = createBuilderFixture();
    const environment = store.create({ name: "研发环境" });
    store.addRepository(environment.id, { name: "api", gitUrl: "git:api", prepareCommand: "bundle install" });
    store.addRepository(environment.id, { name: "web", gitUrl: "git:web", prepareCommand: "pnpm install" });
    await builder.checkAndBuild(environment.id);
    calls.splice(0);
    remoteCommits.set("web", "commit-2");

    await builder.checkAndBuild(environment.id);

    expect(calls).toEqual(["update:web", "prepare:web"]);
    db.close();
  });

  it("准备命令失败时保留当前版本并清理失败 Workspace", async () => {
    const { db, store, root, builder } = createBuilderFixture();
    const environment = store.create({ name: "研发环境" });
    const repository = store.addRepository(environment.id, { name: "api", gitUrl: "git:api", prepareCommand: null });
    const first = await builder.checkAndBuild(environment.id);
    store.updateRepository(environment.id, repository.id, { prepareCommand: "exit 1" });

    await expect(builder.checkAndBuild(environment.id)).rejects.toThrow("prepare failed");

    expect(store.get(environment.id)?.currentRevisionId).toBe(first.revisionId);
    const failed = store.listRevisions(environment.id)[0]!;
    expect(failed).toMatchObject({ status: "failed", failureStage: "prepare:api", workspacePath: null });
    expect(existsSync(join(root, environment.id, "revisions", failed.id, "workspace"))).toBe(false);
    db.close();
  });
});
