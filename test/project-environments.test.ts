import { describe, expect, it } from "vitest";

import { ProjectEnvironmentStore } from "../src/project-environments/project-environment-store.js";
import { createTestDatabase } from "./helpers.js";

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
