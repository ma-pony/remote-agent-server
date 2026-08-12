import { describe, expect, it } from "vitest";

import { RunRepository, RunRepositoryError } from "../src/runs/run-repository.js";
import { createTestDatabase } from "./helpers.js";

describe("RunRepository", () => {
  it("创建 queued Run 时同步将 Session 标为 running", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const repository = new RunRepository({ db });

    const run = repository.create({ sessionId: session.id, input: "修复工单 1332" });

    expect(run).toMatchObject({ sessionId: session.id, status: "queued", input: "修复工单 1332" });
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "running" });
    db.close();
  });

  it("同一个 Session 的第二个活动 Run 返回 session_busy", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const repository = new RunRepository({ db });
    repository.create({ sessionId: session.id, input: "first" });

    expect(() => repository.create({ sessionId: session.id, input: "second" })).toThrow(
      expect.objectContaining({ code: "session_busy" })
    );
    expect(repository.listBySession(session.id)).toHaveLength(1);
    db.close();
  });

  it("结束 running Run 时原子恢复 Session 为 idle", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const repository = new RunRepository({ db });
    const run = repository.create({ sessionId: session.id, input: "work" });
    repository.markRunning(run.id);
    db.exec(`
      CREATE TRIGGER reject_idle_session
      BEFORE UPDATE OF status ON sessions
      WHEN NEW.status = 'idle'
      BEGIN
        SELECT RAISE(ABORT, 'session update rejected');
      END;
    `);

    expect(() => repository.finish(run.id, { status: "succeeded", result: "done" })).toThrow("session update rejected");
    expect(repository.get(run.id)).toMatchObject({ status: "running", result: null, finishedAt: null });
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "running" });
    db.exec("DROP TRIGGER reject_idle_session");

    expect(repository.finish(run.id, { status: "succeeded", result: "done" })).toMatchObject({
      status: "succeeded",
      result: "done",
      error: null
    });
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "idle" });
    db.close();
  });

  it("拒绝非法的 Run 状态转换", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const repository = new RunRepository({ db });
    const run = repository.create({ sessionId: session.id, input: "work" });

    expect(() => repository.finish(run.id, { status: "succeeded", result: "done" })).toThrow(
      expect.objectContaining({ code: "invalid_run_state" } satisfies Partial<RunRepositoryError>)
    );
    repository.markRunning(run.id);
    expect(() => repository.cancelQueued(run.id)).toThrow(
      expect.objectContaining({ code: "invalid_run_state" } satisfies Partial<RunRepositoryError>)
    );
    db.close();
  });

  it("取消 queued Run 时恢复 Session 为 idle", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const repository = new RunRepository({ db });
    const run = repository.create({ sessionId: session.id, input: "work" });

    expect(repository.cancelQueued(run.id)).toMatchObject({ status: "cancelled" });
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id)).toEqual({ status: "idle" });
    db.close();
  });

  it("重启后仅失败旧 running Run，并保留 queued Run", () => {
    const { db, seed } = createTestDatabase();
    const runningSession = seed.session();
    const queuedSession = seed.session();
    seed.run(runningSession.id, "running");
    seed.run(queuedSession.id, "queued");
    db.prepare("UPDATE sessions SET status = 'running'").run();
    const repository = new RunRepository({ db });

    repository.recoverAfterRestart();

    expect(repository.listBySession(runningSession.id)).toMatchObject([{ status: "failed", error: "server_restarted" }]);
    expect(repository.listBySession(queuedSession.id)).toMatchObject([{ status: "queued", error: null }]);
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(runningSession.id)).toEqual({ status: "idle" });
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(queuedSession.id)).toEqual({ status: "running" });
    expect(repository.listQueued()).toMatchObject([{ sessionId: queuedSession.id, status: "queued" }]);
    db.close();
  });
});
