import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { ProjectEnvironmentBuilder } from "../src/project-environments/project-environment-builder.js";
import { ProjectEnvironmentScheduler } from "../src/project-environments/project-environment-scheduler.js";
import { ProjectEnvironmentStore } from "../src/project-environments/project-environment-store.js";
import {
  SystemProjectEnvironmentCommands,
  type ProjectEnvironmentCommands
} from "../src/project-environments/project-environment-commands.js";
import type { WorkspaceManager } from "../src/workspaces/workspace-manager.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const tempDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
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
    isRepository: async (destination) => existsSync(join(destination, ".git", "HEAD")),
    clone: async (repository, destination) => {
      calls.push(`clone:${repository.name}`);
      mkdirSync(join(destination, ".git"), { recursive: true });
      writeFileSync(join(destination, ".git", "HEAD"), "ref: refs/heads/main\n");
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
    createSession: async () => { throw new Error("unused"); },
    deleteSession: async () => undefined,
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
    const environment = store.create({ name: "示例研发环境" });
    const repository = store.addRepository(environment.id, {
      name: "example-service",
      gitUrl: "git@example.test:team/example-service.git",
      prepareCommand: "bundle install"
    });

    expect(store.get(environment.id)).toMatchObject({
      id: environment.id,
      name: "示例研发环境",
      currentRevisionId: null,
      repositories: [repository]
    });
    expect(() => store.create({ name: "示例研发环境" })).toThrow(/UNIQUE/);
    expect(() => store.addRepository(environment.id, {
      name: "example-service",
      gitUrl: "git@example.test:team/duplicate.git",
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
      gitUrl: "git@example.test:team/api.git",
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
      gitUrl: "git@example.test:team/api.git",
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
      gitUrl: "git@example.test:team/api.git",
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

describe("SystemProjectEnvironmentCommands", () => {
  it("项目准备命令可使用用户 local bin 中的工具", async () => {
    const home = mkdtempSync(join(tmpdir(), "project-environment-home-"));
    tempDirectories.push(home);
    const localBin = join(home, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const tool = join(localBin, "project-tool");
    writeFileSync(tool, "#!/bin/sh\nprintf 'tool-found\\n'\n", { mode: 0o700 });
    chmodSync(tool, 0o700);
    const commands = new SystemProjectEnvironmentCommands({
      environment: { HOME: home, PATH: "/usr/bin:/bin" }
    });

    await expect(commands.prepare({
      id: "repository-1",
      projectEnvironmentId: "environment-1",
      name: "api",
      gitUrl: "git@example.test:api.git",
      prepareCommand: "test \"$(project-tool)\" = tool-found",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z"
    }, "/tmp", 1_000, new AbortController().signal)).resolves.toBeUndefined();
  });

  it("准备失败时同时保留 stderr 警告和 stdout 的真正错误", async () => {
    const commands = new SystemProjectEnvironmentCommands();
    const controller = new AbortController();

    await expect(commands.prepare({
      id: "repository-1",
      projectEnvironmentId: "environment-1",
      name: "api",
      gitUrl: "git@example.test:api.git",
      prepareCommand: "printf 'warning\\n' >&2; sleep 0.05; printf 'actual failure\\n'; exit 1",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z"
    }, "/tmp", 5_000, controller.signal)).rejects.toThrow("warning\nactual failure");
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

  it("当前项目副本损坏时重新克隆并发布完整版本", async () => {
    const { db, store, calls, builder } = createBuilderFixture();
    const environment = store.create({ name: "研发环境" });
    store.addRepository(environment.id, { name: "api", gitUrl: "git:api", prepareCommand: "bundle install" });
    await builder.checkAndBuild(environment.id);
    const currentWorkspace = store.getCurrentRevision(environment.id)?.workspacePath;
    expect(currentWorkspace).not.toBeNull();
    rmSync(join(currentWorkspace!, "api", ".git", "HEAD"));
    calls.splice(0);

    const rebuilt = await builder.checkAndBuild(environment.id);

    expect(rebuilt).toMatchObject({ outcome: "published", revisionId: expect.any(String) });
    expect(calls).toEqual(["clone:api", "prepare:api"]);
    expect(existsSync(join(store.getCurrentRevision(environment.id)!.workspacePath!, "api", ".git", "HEAD"))).toBe(true);
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

describe("ProjectEnvironmentScheduler", () => {
  it("展示运行、排队和下一次自动同步时间", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    const { db, store } = createBuilderFixture();
    const first = store.create({ name: "环境一" });
    const second = store.create({ name: "环境二" });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const scheduler = new ProjectEnvironmentScheduler({
      store,
      builder: {
        checkAndBuild: async (id) => {
          if (id === first.id) await firstBlocked;
          return { outcome: "unchanged" as const };
        },
        stop: async () => { releaseFirst(); }
      },
      intervalMs: 3 * 60 * 60 * 1000
    });
    scheduler.start();

    const firstRequest = scheduler.requestCheck(first.id);
    const secondRequest = scheduler.requestCheck(second.id);
    expect(scheduler.getState(first.id)).toEqual({
      status: "running",
      automatic: true,
      intervalMs: 10_800_000,
      nextScheduledAt: "2026-08-13T03:00:00.000Z"
    });
    expect(scheduler.getState(second.id).status).toBe("queued");

    releaseFirst();
    await Promise.all([firstRequest, secondRequest]);
    expect(scheduler.getState(first.id).status).toBe("idle");
    expect(scheduler.getState(second.id).status).toBe("idle");
    await scheduler.stop();
    db.close();
  });

  it("每三小时检查所有项目环境并在停止时清理定时器", async () => {
    const { db, store } = createBuilderFixture();
    const first = store.create({ name: "环境一" });
    const second = store.create({ name: "环境二" });
    const checked: string[] = [];
    const scheduler = new ProjectEnvironmentScheduler({
      store,
      builder: {
        checkAndBuild: async (id) => { checked.push(id); return { outcome: "unchanged" as const }; },
        stop: async () => undefined
      },
      intervalMs: 3 * 60 * 60 * 1000
    });
    scheduler.start();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(checked).toEqual([]);
    await scheduler.runScheduledCheck();
    expect(new Set(checked)).toEqual(new Set(store.list().map(({ id }) => id)));

    await scheduler.stop();
    await expect(scheduler.requestCheck(first.id)).rejects.toThrow("environment_scheduler_stopped");
    db.close();
  });

  it("合并重复请求并全局串行构建", async () => {
    const { db, store } = createBuilderFixture();
    const first = store.create({ name: "环境一" });
    const second = store.create({ name: "环境二" });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const scheduler = new ProjectEnvironmentScheduler({
      store,
      builder: {
        checkAndBuild: async (id) => {
          order.push(`start:${id}`);
          if (id === first.id) await firstBlocked;
          order.push(`end:${id}`);
          return { outcome: "unchanged" as const };
        },
        stop: async () => undefined
      },
      intervalMs: 3 * 60 * 60 * 1000
    });
    scheduler.start();

    const firstRequest = scheduler.requestCheck(first.id);
    const duplicate = scheduler.requestCheck(first.id);
    const secondRequest = scheduler.requestCheck(second.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([`start:${first.id}`]);
    releaseFirst();
    await Promise.all([firstRequest, duplicate, secondRequest]);

    expect(order).toEqual([
      `start:${first.id}`,
      `end:${first.id}`,
      `start:${second.id}`,
      `end:${second.id}`
    ]);
    await scheduler.stop();
    db.close();
  });

  it("停止时取消排队请求且不再启动新的环境构建", async () => {
    const { db, store } = createBuilderFixture();
    const first = store.create({ name: "环境一" });
    const second = store.create({ name: "环境二" });
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const scheduler = new ProjectEnvironmentScheduler({
      store,
      builder: {
        checkAndBuild: async (id) => {
          started.push(id);
          if (id === first.id) await firstBlocked;
          return { outcome: "unchanged" as const };
        },
        stop: async () => { releaseFirst(); }
      },
      intervalMs: 3 * 60 * 60 * 1000
    });

    const firstRequest = scheduler.requestCheck(first.id);
    const queuedRequest = scheduler.requestCheck(second.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stopped = scheduler.stop();

    await expect(queuedRequest).rejects.toThrow("environment_scheduler_stopped");
    await firstRequest;
    await stopped;
    expect(started).toEqual([first.id]);
    db.close();
  });
});

describe("Project environment API", () => {
  it("鉴权后管理多项目环境，并在项目变化时自动请求构建", async () => {
    const fixture = createBuilderFixture();
    const checks: string[] = [];
    const scheduler = {
      start: () => undefined,
      stop: async () => undefined,
      requestCheck: async (id: string) => { checks.push(id); },
      getState: () => ({
        status: "idle" as const,
        automatic: true as const,
        intervalMs: 10_800_000,
        nextScheduledAt: "2026-08-13T03:00:00.000Z"
      })
    };
    const app = buildApp({
      config: {
        host: "127.0.0.1",
        port: 3000,
        apiToken: "secret-token",
        dataDir: fixture.root,
        databasePath: ":memory:",
        projectEnvironmentsRoot: fixture.root,
        sessionsRoot: join(fixture.root, "sessions"),
        maxConcurrentRuns: 1,
        projectEnvironmentCheckIntervalMs: 10_800_000,
        projectPrepareTimeoutMs: 1_800_000
      },
      db: fixture.db,
      runtime: createFakeRuntime(),
      workspaceManager: {
        check: async () => undefined,
        createSession: async () => { throw new Error("unused"); },
        deleteSession: async () => undefined,
        createRevision: async () => undefined,
        removeRevision: async () => undefined
      },
      projectEnvironmentStore: fixture.store,
      projectEnvironmentScheduler: scheduler
    });
    await app.ready();
    const headers = { authorization: "Bearer secret-token" };

    const unauthorized = await app.inject({ method: "GET", url: "/api/project-environments" });
    const created = await app.inject({
      method: "POST", url: "/api/project-environments", headers, payload: { name: "研发环境" }
    });
    const environmentId = (created.json() as { id: string }).id;
    const invalid = await app.inject({
      method: "POST",
      url: `/api/project-environments/${environmentId}/repositories`,
      headers,
      payload: { name: "../escape", gitUrl: "git:escape" }
    });
    const repository = await app.inject({
      method: "POST",
      url: `/api/project-environments/${environmentId}/repositories`,
      headers,
      payload: { name: "api", gitUrl: "git:api", prepareCommand: "bundle install" }
    });
    const configurationFingerprint = fixture.store.configurationFingerprint(environmentId);
    const revision = fixture.store.beginRevision({
      projectEnvironmentId: environmentId,
      configurationFingerprint,
      inputFingerprint: "input-v1",
      workspacePath: `/environments/${environmentId}/revisions/revision-1/workspace`
    });
    fixture.store.publishRevision(revision.id);
    const accepted = await app.inject({ method: "POST", url: `/api/project-environments/${environmentId}/sync`, headers });
    const detail = await app.inject({
      method: "GET", url: `/api/project-environments/${environmentId}`, headers
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(created.statusCode).toBe(201);
    expect(invalid.statusCode).toBe(400);
    expect(repository.statusCode).toBe(201);
    expect(accepted.statusCode).toBe(202);
    expect(detail.json()).toMatchObject({
      id: environmentId,
      name: "研发环境",
      workspacePath: `/environments/${environmentId}/revisions/revision-1/workspace`,
      sync: {
        status: "idle",
        automatic: true,
        intervalMs: 10_800_000,
        nextScheduledAt: "2026-08-13T03:00:00.000Z"
      },
      repositories: [{
        name: "api",
        gitUrl: "git:api",
        prepareCommand: "bundle install",
        workspacePath: `/environments/${environmentId}/revisions/revision-1/workspace/api`
      }]
    });
    expect(checks).toEqual([environmentId, environmentId]);
    await app.close();
    fixture.db.close();
  });
});
