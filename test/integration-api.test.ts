import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { migrate } from "../src/db.js";
import { IntegrationStore } from "../src/integrations/integration-store.js";
import type { AgentRuntime, RuntimeTurnResult } from "../src/runtime/agent-runtime.js";
import type { WorkspaceManager } from "../src/workspaces/workspace-manager.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const apiToken = "integration-admin-token";

const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${apiToken}` });
const endpointHeaders = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const queuedTaskResponseKeys = [
  "conversationKey",
  "requestId",
  "runId",
  "sessionId",
  "status",
  "taskId"
].sort();
const validEndpointInput = (agentId: number, slug = "support-bot") => ({
  name: "Support Bot",
  slug,
  agentId,
  enabled: true,
  promptPrefix: "Resolve the support request.",
  parameterMappings: []
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const apps: Array<{ app: FastifyInstance; close: () => Promise<void> }> = [];

const createTestApp = async (
  runtime: AgentRuntime = createFakeRuntime(),
  configureIntegrationStore?: (store: IntegrationStore) => void
): Promise<{
  app: FastifyInstance;
  agentId: number;
  db: ReturnType<typeof createTestDatabase>["db"];
  integrationStore: IntegrationStore;
  restart(): Promise<FastifyInstance>;
}> => {
  const { db, seed } = createTestDatabase();
  const integrationStore = new IntegrationStore({ db });
  configureIntegrationStore?.(integrationStore);
  const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-integration-api-"));
  const workspaceManager: WorkspaceManager = {
    check: async () => undefined,
    createSession: async (id) => ({
      workspacePath: join(dataDir, "sessions", String(id), "workspace"),
      runtimePath: join(dataDir, "sessions", String(id), "runtime"),
      browserProfilePath: join(dataDir, "sessions", String(id), "browser")
    }),
    deleteSession: async () => undefined,
    createRevision: async () => undefined,
    removeRevision: async () => undefined
  };
  const options: Parameters<typeof buildApp>[0] = {
    config: {
      host: "127.0.0.1",
      port: 3000,
      apiToken,
      dataDir,
      databasePath: ":memory:",
      projectEnvironmentsRoot: "/unused/environments",
      sessionsRoot: "/unused/sessions",
      maxConcurrentRuns: 1,
      maxConcurrentWebhookDeliveries: 4,
      maxConcurrentEnvironmentBuilds: 1,
      projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000,
      projectPrepareTimeoutMs: 30 * 60 * 1000,
      sessionRetentionMs: 0
    },
    db,
    runtime,
    workspaceManager,
    integrationStore
  };
  let app = buildApp(options);
  apps.push({
    app,
    close: async () => {
      await app.close();
      db.close();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });
  await app.ready();
  return { app, agentId: seed.agent.id, db, integrationStore, restart: async () => {
    await app.close();
    app = buildApp({ ...options, integrationStore: new IntegrationStore({ db }) });
    await app.ready();
    return app;
  } };
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map(({ close }) => close()));
});

describe("Native webhook ingress", () => {
  it("附件消息：接入支持纯文件、幂等重试与内容冲突", async () => {
    const runtime = createFakeRuntime();
    const ensureSession = runtime.ensureSession;
    vi.spyOn(runtime, "ensureSession").mockImplementation(async (input) => {
      mkdirSync(input.workspacePath, { recursive: true });
      return ensureSession(input);
    });
    const startTurn = vi.spyOn(runtime, "startTurn");
    const { app, agentId, db } = await createTestApp(runtime);
    const created = await app.inject({ method: "POST", url: "/api/integration-endpoints", headers: authHeaders(), payload: validEndpointInput(agentId, "attachments") });
    const { token } = created.json();
    const payload = { requestId: "files-1", attachments: [{ name: "report.pdf", mediaType: "application/pdf", data: Buffer.from("%PDF-1.7 test").toString("base64") }] };
    const submit = (body: unknown) => app.inject({ method: "POST", url: "/integration/v1/endpoints/attachments/tasks", headers: endpointHeaders(token), payload: body as Record<string, unknown> });
    expect((await submit({ ...payload, message: "x".repeat(1024 * 1024) })).statusCode).toBe(400);
    expect((await submit({ ...payload, parameters: { oversized: "x".repeat(1024 * 1024) } })).statusCode).toBe(400);
    const response = await submit(payload);
    expect(response.statusCode).toBe(202);
    expect((await submit(payload)).json().taskId).toBe(response.json().taskId);
    expect((await submit({ ...payload, attachments: [{ ...payload.attachments[0], data: Buffer.from("changed").toString("base64") }] })).statusCode).toBe(409);
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
    expect(startTurn.mock.calls[0]![0].text).toContain("report.pdf");
    expect(db.prepare("SELECT count(*) AS n FROM message_attachments").get()).toEqual({ n: 1 });
    const taskId = response.json().taskId;
    const history = await app.inject({ method: "GET", url: `/api/integration-tasks/${taskId}`, headers: authHeaders() });
    expect(history.json().attachments).toHaveLength(1);
    const downloadUrl = `/api/integration-tasks/${taskId}/attachments/${history.json().attachments[0].id}`;
    expect((await app.inject({ method: "GET", url: downloadUrl, headers: endpointHeaders(token) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: downloadUrl, headers: authHeaders() })).rawPayload.toString()).toBe("%PDF-1.7 test");
    expect(JSON.stringify(db.prepare("SELECT payload_json FROM integration_task_events").all())).not.toContain(payload.attachments[0]!.data);
  });

  const secret = "native-webhook-test-secret";
  const payload = JSON.stringify({
    ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40),
    repository: { id: 42, full_name: "example/project" },
    head_commit: { message: "修复 \"Webhook\"\n验证默认请求" }
  }, null, 2);
  const signature = (body: string, key = secret) =>
    `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
  const setup = async (provider: "github" | "gitlab", configure = true) => {
    const context = await createTestApp();
    const created = await context.app.inject({
      method: "POST", url: "/api/integration-endpoints", headers: authHeaders(),
      payload: validEndpointInput(context.agentId, "native-events")
    });
    const { endpoint, token } = created.json() as { endpoint: { id: number }; token: string };
    const configUrl = `/api/integration-endpoints/${endpoint.id}/webhook-receiver`;
    if (configure) {
      const configured = await context.app.inject({
        method: "PUT", url: configUrl, headers: authHeaders(), payload: { provider, authMode: provider === "github" ? "signature" : "token", enabled: true, secret }
      });
      expect(configured.statusCode).toBe(200);
    }
    return { ...context, endpointId: endpoint.id, token, configUrl, url: "/integration/v1/endpoints/native-events/webhook" };
  };

  it("按 MR 作者筛选，忽略结果持久化且改规则后重投不创建任务", async () => {
    const { app, url, configUrl, db, endpointId } = await setup("gitlab");
    const filter = { all: [
      { field: "payload.project.id", op: "eq", value: 42 },
      { field: "payload.object_attributes.author_id", op: "in", value: [101, 102] }
    ] };
    const configure = (value: unknown) => app.inject({ method: "PUT", url: configUrl, headers: authHeaders(),
      payload: { provider: "gitlab", authMode: "token", enabled: true, filter: value } });
    const saved = await configure(filter);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ filter, filterVersion: 2 });
    const event = { object_kind: "merge_request", user: { id: 101 }, project: { id: 42 },
      object_attributes: { author_id: 900, state: "opened", action: "open" } };
    const send = (id: string, body = event) => app.inject({ method: "POST", url, payload: body,
      headers: { "x-gitlab-token": secret, "x-gitlab-event": "Merge Request Hook", "idempotency-key": id } });
    const ignored = await send("bot-mr");
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json()).toEqual({ status: "ignored", reason: "filter_not_matched" });
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM integration_tasks").get()).toEqual({ count: 0 });
    await configure(null);
    migrate(db);
    expect((await send("bot-mr")).json()).toEqual(ignored.json());
    expect((await send("bot-mr", { ...event, user: { id: 2 } })).statusCode).toBe(409);
    await configure(filter);
    const developer = { ...event, user: { id: 900 }, object_attributes: { ...event.object_attributes, author_id: 101 } };
    const responses = await Promise.all([send("developer-mr", developer), send("developer-mr", developer)]);
    expect(responses.map((response) => response.statusCode)).toEqual([202, 202]);
    expect(responses[0]!.json().taskId).toBe(responses[1]!.json().taskId);
    await configure({ field: "eventType", op: "eq", value: "Push Hook" });
    expect((await send("developer-mr", developer)).json().taskId).toBe(responses[0]!.json().taskId);
    const history = await app.inject({ method: "GET", url: `${configUrl}/receipts`, headers: authHeaders() });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject([
      { deliveryId: "developer-mr", decision: "accepted", taskId: responses[0]!.json().taskId },
      { deliveryId: "bot-mr", decision: "ignored", reason: "filter_not_matched", filterVersion: 2 }
    ]);
    expect(history.body).not.toContain("author_id");
    expect(history.body).not.toContain(secret);
    expect((await app.inject({ method: "GET", url: `${configUrl}/receipts` })).statusCode).toBe(401);
    expect(db.prepare("SELECT count(*) AS count FROM integration_tasks WHERE endpoint_id = ?").get(endpointId)).toEqual({ count: 1 });
  });

  it("任务入库失败后重启仍沿用原筛选决定，成功任务重启重投不重复执行", async () => {
    const context = await setup("gitlab");
    let app = context.app;
    const request = { method: "POST" as const, url: context.url, payload: { object_kind: "merge_request" },
      headers: { "x-gitlab-token": secret, "x-gitlab-event": "Merge Request Hook", "idempotency-key": "recover-admission" } };
    const failingWrite = vi.spyOn(context.integrationStore, "createTaskInTransaction").mockImplementationOnce(() => { throw new Error("injected transaction failure"); });
    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(500);
    failingWrite.mockRestore();
    expect(context.db.prepare("SELECT count(*) AS count FROM integration_tasks").get()).toEqual({ count: 0 });
    const ignored = await app.inject({ ...request, headers: { ...request.headers, "idempotency-key": "ignore-before-restart" },
      payload: { object_kind: "merge_request" } });
    expect(ignored.statusCode).toBe(202);
    await app.inject({ method: "PUT", url: context.configUrl, headers: authHeaders(),
      payload: { provider: "gitlab", authMode: "token", enabled: true, filter: { field: "eventType", op: "eq", value: "Push Hook" } } });
    const excluded = { ...request, headers: { ...request.headers, "idempotency-key": "excluded" } };
    expect((await app.inject(excluded)).statusCode).toBe(200);
    app = await context.restart();
    const recovered = await app.inject(request);
    expect(recovered.statusCode).toBe(202);
    const taskId = recovered.json().taskId as number;
    await vi.waitFor(() => expect(context.integrationStore.getTask(taskId)?.status).toBe("succeeded"));
    app = await context.restart();
    expect((await app.inject(request)).json().taskId).toBe(taskId);
    await app.inject({ method: "PUT", url: context.configUrl, headers: authHeaders(),
      payload: { provider: "gitlab", authMode: "token", enabled: true, filter: null } });
    expect((await app.inject(excluded)).json()).toEqual({ status: "ignored", reason: "filter_not_matched" });
    expect(context.db.prepare("SELECT count(*) AS count FROM runs WHERE session_id = ?").get(recovered.json().sessionId)).toEqual({ count: 1 });
  });

  it("筛选预览与接收使用相同语义，负向比较不放过缺失字段或类型不符", async () => {
    const { app, url, configUrl, db } = await setup("github");
    const filter = { all: [
      { field: "eventType", op: "eq", value: "pull_request" },
      { field: "payload.pull_request.user.id", op: "not_in", value: [900] }
    ] };
    const preview = (payload: unknown, rule: unknown = filter) => app.inject({ method: "POST", url: `${configUrl}/preview`, headers: authHeaders(),
      payload: { provider: "github", eventType: "pull_request", payload, filter: rule } });
    for (const [payload, matched] of [
      [{ sender: { id: 101 } }, false],
      [{ pull_request: { user: { id: "101" } } }, false],
      [{ pull_request: { user: { id: 900 } } }, false],
      [{ pull_request: { user: { id: 101 } }, sender: { id: 900 } }, true]
    ] as const) {
      const result = await preview(payload);
      expect(result.statusCode).toBe(200);
      expect(result.json().matched).toBe(matched);
      expect(result.json().checks.length).toBe(2);
    }
    expect((await preview({}, { field: "payload.x", op: "exists", value: false })).json().matched).toBe(true);
    expect((await app.inject({ method: "POST", url: `${configUrl}/preview`, payload: {} })).statusCode).toBe(401);
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
    await app.inject({ method: "PUT", url: configUrl, headers: authHeaders(), payload: { provider: "github", authMode: "signature", enabled: true, filter } });
    const body = JSON.stringify({ pull_request: { user: { id: 900 } }, sender: { id: 101 } });
    const response = await app.inject({ method: "POST", url, payload: body, headers: {
      "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "filtered-pr", "x-hub-signature-256": signature(body)
    } });
    expect(response.json()).toEqual({ status: "ignored", reason: "filter_not_matched" });
  });

  it.each(["gitlab", "github"] as const)("%s 多条件：包含 CodeReview 标签且 MR / PR 作者不是指定 Agent", async (provider) => {
    const { app, configUrl, url, db } = await setup(provider);
    const filter = { all: provider === "gitlab" ? [
      { field: "payload.labels.*.title", op: "contains", value: "CodeReview" },
      { field: "payload.object_attributes.author_id", op: "neq", value: 900 }
    ] : [
      { field: "payload.pull_request.labels.*.name", op: "contains", value: "CodeReview" },
      { field: "payload.pull_request.user.login", op: "neq", value: "xxx" }
    ] };
    const save = await app.inject({ method: "PUT", url: configUrl, headers: authHeaders(), payload: {
      provider, authMode: provider === "gitlab" ? "token" : "signature", enabled: true, filter
    } });
    expect(save.statusCode).toBe(200);
    const eventType = provider === "gitlab" ? "Merge Request Hook" : "pull_request";
    let sequence = 0;
    for (const [labels, author, expected] of [
      [["other", "CodeReview"], "developer", 202],
      [["CodeReview", "other"], "developer", 202],
      [["CodeReview"], "xxx", 200],
      [["other"], "developer", 200],
      [["codereview"], "developer", 200],
      [[], "developer", 200],
      [undefined, "developer", 200],
      [["CodeReview"], undefined, 200]
    ] as const) {
      const payload = provider === "gitlab" ? { object_kind: "merge_request", user: { id: 900, username: "xxx" },
        labels: labels?.map((title) => ({ title })), object_attributes: { author_id: author === undefined ? undefined : author === "xxx" ? 900 : 101 }
      } : { action: "opened", sender: { login: "xxx" }, pull_request: { labels: labels?.map((name) => ({ name })), user: { login: author } } };
      const preview = await app.inject({ method: "POST", url: `${configUrl}/preview`, headers: authHeaders(),
        payload: { provider, eventType, payload, filter } });
      expect(preview.json().matched).toBe(expected === 202);
      const body = JSON.stringify(payload);
      const id = `label-and-author-${++sequence}`;
      const headers = provider === "gitlab" ? { "x-gitlab-token": secret, "x-gitlab-event": eventType, "idempotency-key": id }
        : { "x-github-event": eventType, "x-github-delivery": id, "x-hub-signature-256": signature(body) };
      const received = await app.inject({ method: "POST", url, headers: { "content-type": "application/json", ...headers }, payload: body });
      expect(received.statusCode).toBe(expected);
    }
    expect(db.prepare("SELECT count(*) AS count FROM integration_tasks").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 2 });
  });

  it.each(["gitlab", "github"] as const)("%s 仅接收包含 CodeReview 且不含 Done-Pass 的事件", async (provider) => {
    const { app, configUrl, url, db } = await setup(provider);
    const eventType = provider === "gitlab" ? "Merge Request Hook" : "pull_request";
    const field = provider === "gitlab" ? "payload.labels.*.title" : "payload.pull_request.labels.*.name";
    const filter = { all: [
      { field: "eventType", op: "eq", value: eventType },
      { field, op: "contains", value: "CodeReview" },
      { field, op: "not_contains", value: "Done-Pass" }
    ] };
    const saved = await app.inject({ method: "PUT", url: configUrl, headers: authHeaders(), payload: {
      provider, authMode: provider === "gitlab" ? "token" : "signature", enabled: true, filter
    } });
    expect(saved.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: configUrl, headers: authHeaders() })).json()).toMatchObject({ filter });
    let sequence = 0;
    for (const [labels, matched] of [
      [["CodeReview"], true],
      [["other", "CodeReview"], true],
      [["CodeReview", "Done-Pass"], false],
      [["Done-Pass", "CodeReview"], false],
      [["Done-Pass"], false],
      [[], false],
      [undefined, false],
      [["CodeReview", null], false]
    ] as const) {
      const payload = provider === "gitlab"
        ? { object_kind: "merge_request", labels: labels?.map((title) => ({ title })) }
        : { action: "opened", pull_request: { labels: labels?.map((name) => ({ name })) } };
      const preview = await app.inject({ method: "POST", url: `${configUrl}/preview`, headers: authHeaders(),
        payload: { provider, eventType, payload, filter } });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({ matched });
      const body = JSON.stringify(payload);
      const deliveryId = `exclude-done-${++sequence}`;
      const headers = provider === "gitlab"
        ? { "x-gitlab-token": secret, "x-gitlab-event": eventType, "idempotency-key": deliveryId }
        : { "x-github-event": eventType, "x-github-delivery": deliveryId, "x-hub-signature-256": signature(body) };
      const request = { method: "POST" as const, url, headers: { "content-type": "application/json", ...headers }, payload: body };
      const received = await app.inject(request);
      expect(received.statusCode).toBe(matched ? 202 : 200);
      if (!matched) expect(received.json()).toEqual({ status: "ignored", reason: "filter_not_matched" });
      const retried = await app.inject(request);
      expect(retried.statusCode).toBe(matched ? 202 : 200);
      if (matched) expect(retried.json()).toMatchObject({ taskId: received.json().taskId, sessionId: received.json().sessionId });
      else expect(retried.json()).toEqual(received.json());
    }
    expect(db.prepare("SELECT count(*) AS count FROM integration_tasks").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 2 });
  });

  it("拒绝非法规则并保留原配置，省略规则保留而 null 清除", async () => {
    const { app, configUrl } = await setup("gitlab");
    const save = (filter: unknown) => app.inject({ method: "PUT", url: configUrl, headers: authHeaders(),
      payload: { provider: "gitlab", authMode: "token", enabled: true, filter } });
    let deep: unknown = { field: "eventType", op: "eq", value: "Push Hook" };
    for (let i = 0; i < 10; i++) deep = { all: [deep] };
    for (const filter of [
      { all: [] }, { any: [] }, { field: "payload.__proto__.id", op: "eq", value: 1 },
      { field: "payload.id", op: "regex", value: ".*" }, { field: "payload.id", op: "in", value: [] },
      { field: "payload.id", op: "in", value: [1, "2"] }, { field: "payload.id", op: "exists", value: "true" },
      { field: "payload.id", op: "eq", value: {} }, { field: "headers.token", op: "eq", value: "x" },
      { all: Array.from({ length: 60 }, () => ({ field: "eventType", op: "eq", value: "push" })) }, deep
    ]) expect((await save(filter)).statusCode).toBe(400);
    const filter = { field: "payload.object_attributes.author_id", op: "in", value: [101] };
    expect((await save(filter)).statusCode).toBe(200);
    const preserved = await app.inject({ method: "PUT", url: configUrl, headers: authHeaders(), payload: { provider: "gitlab", authMode: "token", enabled: true } });
    expect(preserved.json()).toMatchObject({ filter, filterVersion: 2 });
    expect((await save(null)).json()).toMatchObject({ filter: null, filterVersion: 3 });
  });

  it("原生 GitHub JSON 验签后入库并执行，重投复用同一 Task", async () => {
    const { app, url, db } = await setup("github");
    const request = {
      method: "POST" as const, url, payload,
      headers: { "content-type": "application/json", "x-github-event": "push",
        "x-github-delivery": "github-delivery-1", "x-hub-signature-256": signature(payload) }
    };
    const responses = await Promise.all([app.inject(request), app.inject(request)]);
    expect(responses.map((item) => item.statusCode)).toEqual([202, 202]);
    expect(responses[0]!.json().taskId).toBe(responses[1]!.json().taskId);
    const taskId = responses[0]!.json().taskId as number;
    await vi.waitFor(() => expect(db.prepare("SELECT status FROM integration_tasks WHERE id = ?").get(taskId))
      .toEqual({ status: "succeeded" }));
    expect(db.prepare("SELECT count(*) AS count FROM integration_tasks").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    const row = db.prepare("SELECT request_id, message, effective_prompt FROM integration_tasks WHERE id = ?").get(taskId) as {
      request_id: string; message: string; effective_prompt: string;
    };
    expect(row.request_id).toBe("github:github-delivery-1");
    expect(row.message).toContain("example/project");
    expect(row.message).toContain("github");
    expect(row.effective_prompt).toContain("Resolve the support request.");
    expect(row.message).not.toContain(secret);
    const changed = JSON.stringify({ action: "changed" });
    const conflict = await app.inject({ ...request, payload: changed,
      headers: { ...request.headers, "x-hub-signature-256": signature(changed) } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("idempotency_conflict");
  });

  it("原生 GitHub 表单 payload 使用原始字节验签", async () => {
    const { app, url } = await setup("github");
    const form = new URLSearchParams({ payload }).toString();
    const response = await app.inject({ method: "POST", url, payload: form,
      headers: { "content-type": "application/x-www-form-urlencoded", "x-github-event": "push",
        "x-github-delivery": "form-delivery", "x-hub-signature-256": signature(form) } });
    expect(response.statusCode).toBe(202);
  });

  it.each(["idempotency-key", "x-gitlab-webhook-uuid"])("原生 GitLab Token 和 %s 支持入库去重", async (idHeader) => {
    const { app, url, db } = await setup("gitlab");
    const request = { method: "POST" as const, url,
      headers: { "x-gitlab-token": secret, "x-gitlab-event": "Merge Request Hook", [idHeader]: "gitlab-delivery-1" },
      payload: { object_kind: "merge_request", project: { id: 42, web_url: "https://gitlab.example.com/example/project" },
        object_attributes: { iid: 7, action: "open", title: "检查合并请求" } } };
    const first = await app.inject(request);
    const retry = await app.inject(request);
    expect(first.statusCode).toBe(202);
    expect(retry.json().taskId).toBe(first.json().taskId);
    expect(db.prepare("SELECT count(*) AS count FROM integration_tasks").get()).toEqual({ count: 1 });
  });

  it("无效凭证、被篡改请求和错误平台不能创建 Session 或 Task", async () => {
    const { app, url, db } = await setup("github");
    for (const headers of [
      {}, { "x-hub-signature-256": signature(payload, "wrong-secret") },
      { "x-hub-signature-256": signature(JSON.stringify(JSON.parse(payload))) },
      { "x-gitlab-token": secret, "x-gitlab-event": "Push Hook" }
    ]) {
      const response = await app.inject({ method: "POST", url, payload,
        headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": "invalid", ...headers } });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(secret);
    }
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM integration_tasks").get()).toEqual({ count: 0 });
  });

  it("GitLab signing token 校验原始载荷、多签名和时间窗，不能降级为明文 Token", async () => {
    const { app, url, configUrl, db } = await setup("gitlab");
    const key = Buffer.from("0123456789abcdef0123456789abcdef");
    const signingToken = `whsec_${key.toString("base64")}`;
    const configured = await app.inject({ method: "PUT", url: configUrl, headers: authHeaders(),
      payload: { provider: "gitlab", authMode: "signature", enabled: true, secret: signingToken } });
    expect(configured.statusCode).toBe(200);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = (time: string) => `v1,${createHmac("sha256", key).update(`signed-event.${time}.`).update(payload).digest("base64")}`;
    const headers = { "content-type": "application/json", "x-gitlab-event": "Push Hook",
      "webhook-id": "signed-event", "webhook-timestamp": timestamp,
      "webhook-signature": `v1,invalid ${sign(timestamp)}` };
    const first = await app.inject({ method: "POST", url, payload, headers });
    expect(first.statusCode).toBe(202);
    const retry = await app.inject({ method: "POST", url, payload, headers });
    expect(retry.json().taskId).toBe(first.json().taskId);
    for (const delta of [-3600, 3600]) {
      const time = String(Number(timestamp) + delta);
      const response = await app.inject({ method: "POST", url, payload,
        headers: { ...headers, "webhook-timestamp": time, "webhook-signature": sign(time) } });
      expect(response.statusCode).toBe(401);
    }
    expect((await app.inject({ method: "POST", url, payload: `${payload} `, headers })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, payload,
      headers: { ...headers, "webhook-id": "tampered-id" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, payload,
      headers: { "content-type": "application/json", "x-gitlab-event": "Push Hook",
        "idempotency-key": "downgrade", "x-gitlab-token": signingToken } })).statusCode).toBe(401);
    expect(db.prepare("SELECT count(*) AS count FROM integration_tasks").get()).toEqual({ count: 1 });
  });

  it("验证方式由显式配置决定，普通 Token 可使用 whsec_ 前缀且切换方式需新密钥", async () => {
    const { app, configUrl, url } = await setup("gitlab");
    const token = `whsec_${Buffer.from("a valid plain token").toString("base64")}`;
    const save = (input: unknown) => app.inject({ method: "PUT", url: configUrl, headers: authHeaders(), payload: input });
    expect((await save({ provider: "gitlab", authMode: "token", enabled: true, secret: token })).statusCode).toBe(200);
    const response = await app.inject({ method: "POST", url, payload: { object_kind: "push" },
      headers: { "x-gitlab-token": token, "x-gitlab-event": "Push Hook", "idempotency-key": "plain-prefixed-token" } });
    expect(response.statusCode).toBe(202);
    expect((await save({ provider: "gitlab", authMode: "signature", enabled: true })).statusCode).toBe(400);
    expect((await save({ provider: "github", authMode: "token", enabled: true, secret })).statusCode).toBe(400);
    const catalog = await app.inject({ method: "GET", url: "/api/integration-webhook-providers", headers: authHeaders() });
    expect(catalog.json()).toMatchObject([
      { id: "github", name: "GitHub", authModes: ["signature"] },
      { id: "gitlab", name: "GitLab", authModes: ["signature", "token"] }
    ]);
  });

  it("旧数据库升级创建接收配置表，重复迁移保留配置且删除端点清理配置", async () => {
    const { app, configUrl, endpointId, db } = await setup("gitlab", false);
    db.exec("DROP TABLE integration_webhook_receivers");
    migrate(db);
    const configured = await app.inject({ method: "PUT", url: configUrl, headers: authHeaders(),
      payload: { provider: "gitlab", authMode: "token", enabled: true, secret } });
    expect(configured.statusCode).toBe(200);
    const ciphertext = db.prepare("SELECT encrypted_secret FROM integration_webhook_receivers WHERE endpoint_id = ?").get(endpointId);
    db.exec("ALTER TABLE integration_webhook_receivers DROP COLUMN filter_json");
    db.exec("ALTER TABLE integration_webhook_receivers DROP COLUMN filter_version");
    migrate(db);
    migrate(db);
    expect(db.prepare("SELECT encrypted_secret FROM integration_webhook_receivers WHERE endpoint_id = ?").get(endpointId)).toEqual(ciphertext);
    expect((await app.inject({ method: "GET", url: configUrl, headers: authHeaders() })).json())
      .toEqual({ provider: "gitlab", authMode: "token", enabled: true, secretConfigured: true, filter: null, filterVersion: 1 });
    expect((await app.inject({ method: "DELETE", url: `/api/integration-endpoints/${endpointId}`, headers: authHeaders() })).statusCode)
      .toBe(204);
    expect(db.prepare("SELECT count(*) AS count FROM integration_webhook_receivers").get()).toEqual({ count: 0 });
  });

  it("GitHub ping 仅确认连接，非法载荷或缺少投递 ID 不执行", async () => {
    const { app, url, db } = await setup("github");
    const request = (body: string, event = "push", delivery: string | undefined = "delivery") => app.inject({
      method: "POST", url, payload: body,
      headers: { "content-type": "application/json", "x-github-event": event,
        ...(delivery === undefined ? {} : { "x-github-delivery": delivery }), "x-hub-signature-256": signature(body) }
    });
    expect((await request('{"zen":"Keep it logically awesome."}', "ping")).statusCode).toBe(200);
    for (const body of ["null", "[]", '"text"', "{invalid", '{"nested":'.repeat(9000) + "0" + "}".repeat(9000)]) {
      expect((await request(body)).statusCode).toBe(400);
    }
    expect((await request(payload, "push", "")).statusCode).toBe(400);
    expect(db.prepare("SELECT count(*) AS count FROM integration_tasks").get()).toEqual({ count: 0 });
  });

  it("接收配置需管理鉴权，加密 Secret 并允许留空保留、轮换和停用", async () => {
    const { app, url, configUrl, endpointId, db } = await setup("gitlab", false);
    expect((await app.inject({ method: "GET", url: configUrl })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: configUrl, headers: authHeaders() })).json()).toBeNull();
    const put = (body: unknown) => app.inject({ method: "PUT", url: configUrl, headers: authHeaders(), payload: body });
    expect((await put({ provider: "gitlab", authMode: "token", enabled: true })).statusCode).toBe(400);
    expect((await put({ provider: "unknown", enabled: true, secret })).statusCode).toBe(400);
    const configured = await put({ provider: "gitlab", authMode: "token", enabled: true, secret });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({ provider: "gitlab", authMode: "token", enabled: true, secretConfigured: true });
    expect(configured.body).not.toContain(secret);
    const stored = db.prepare("SELECT encrypted_secret FROM integration_webhook_receivers WHERE endpoint_id = ?").get(endpointId) as {
      encrypted_secret: string;
    };
    expect(stored.encrypted_secret).not.toContain(secret);
    expect((await put({ provider: "gitlab", authMode: "token", enabled: true })).statusCode).toBe(200);
    const send = (token: string) => app.inject({ method: "POST", url,
      headers: { "x-gitlab-token": token, "x-gitlab-event": "Push Hook", "idempotency-key": "rotation-event" },
      payload: { object_kind: "push", project_id: 42 } });
    expect((await send("wrong-token")).statusCode).toBe(401);
    expect((await put({ provider: "gitlab", authMode: "token", enabled: true, secret: "rotated-native-secret" })).statusCode).toBe(200);
    expect((await send(secret)).statusCode).toBe(401);
    expect((await send("rotated-native-secret")).statusCode).toBe(202);
    await put({ provider: "gitlab", authMode: "token", enabled: false });
    expect((await send("rotated-native-secret")).statusCode).toBe(403);
  });

  it("默认载荷可通过现有参数映射读取嵌套标量", async () => {
    const { app, url, configUrl, endpointId, agentId, db } = await setup("gitlab");
    db.prepare("INSERT INTO agent_session_parameters (agent_id, key, label, required, secret, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)")
      .run(agentId, "project_id", "Project", "2026-09-11", "2026-09-11");
    const mapping = await app.inject({ method: "PATCH", url: `/api/integration-endpoints/${endpointId}`, headers: authHeaders(),
      payload: { parameterMappings: [{ parameterKey: "project_id", source: "request", requestKey: "project.id" }] } });
    expect(mapping.statusCode).toBe(200);
    const accepted = await app.inject({ method: "POST", url,
      headers: { "x-gitlab-token": secret, "x-gitlab-event": "Push Hook", "idempotency-key": "mapped-event" },
      payload: { object_kind: "push", project: { id: 42 } } });
    expect(accepted.statusCode).toBe(202);
    const values = db.prepare("SELECT plain_value FROM session_mcp_parameter_values WHERE session_id = ?")
      .all(accepted.json().sessionId);
    expect(values).toEqual([{ plain_value: "42" }]);
    await vi.waitFor(() => expect(db.prepare("SELECT status FROM integration_tasks WHERE id = ?").get(accepted.json().taskId))
      .toEqual({ status: "succeeded" }));
    const disabled = await app.inject({ method: "PATCH", url: `/api/integration-endpoints/${endpointId}`, headers: authHeaders(),
      payload: { enabled: false } });
    expect(disabled.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: configUrl, headers: authHeaders() })).statusCode).toBe(200);
    const refused = await app.inject({ method: "POST", url,
      headers: { "x-gitlab-token": secret, "x-gitlab-event": "Push Hook", "idempotency-key": "disabled-event" },
      payload: { object_kind: "push", project: { id: 42 } } });
    expect(refused.statusCode).toBe(403);
  });
});

describe("Integration endpoint API", () => {
  it("管理端创建 Endpoint 且 Token 只返回一次", async () => {
    const { app, agentId } = await createTestApp();
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      payload: validEndpointInput(agentId)
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toEqual({ error: { code: "unauthorized", message: "Invalid API token" } });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as { endpoint: { id: number; slug: string }; token: string };
    expect(createdBody.token).toMatch(/^ras_/);

    const list = await app.inject({ method: "GET", url: "/api/integration-endpoints", headers: authHeaders() });
    const detail = await app.inject({
      method: "GET",
      url: `/api/integration-endpoints/${createdBody.endpoint.id}`,
      headers: authHeaders()
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/integration-endpoints/${createdBody.endpoint.id}`,
      headers: authHeaders(),
      payload: { name: "Updated Support Bot" }
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject([{ id: createdBody.endpoint.id, slug: "support-bot" }]);
    expect(detail.statusCode).toBe(200);
    expect(updated.statusCode).toBe(200);
    expect(JSON.stringify({ list: list.json(), detail: detail.json(), updated: updated.json() })).not.toContain(createdBody.token);

    const rotated = await app.inject({
      method: "POST",
      url: `/api/integration-endpoints/${createdBody.endpoint.id}/rotate-token`,
      headers: authHeaders()
    });
    expect(rotated.statusCode).toBe(200);
    expect((rotated.json() as { token: string }).token).toMatch(/^ras_/);
    expect((rotated.json() as { token: string }).token).not.toBe(createdBody.token);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/integration-endpoints/${createdBody.endpoint.id}`,
      headers: authHeaders()
    });
    expect(deleted.statusCode).toBe(204);
  });

  it("管理端修改映射时可保留未回显的固定敏感值", async () => {
    const { app, agentId, db } = await createTestApp();
    db.prepare(`
      INSERT INTO agent_session_parameters
        (agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES (?, 'callback_token', 'Callback Token', NULL, 0, 1, ?, ?)
    `).run(agentId, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: {
        ...validEndpointInput(agentId),
        parameterMappings: [{ parameterKey: "callback_token", source: "fixed", value: "private-callback-token" }]
      }
    });
    const endpointId = (created.json() as { endpoint: { id: number } }).endpoint.id;

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/integration-endpoints/${endpointId}`,
      headers: authHeaders(),
      payload: { parameterMappings: [{ parameterKey: "callback_token", source: "fixed" }] }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      parameterMappings: [{ parameterKey: "callback_token", source: "fixed", configured: true }]
    });
    expect(JSON.stringify(updated.json())).not.toContain("private-callback-token");
  });

  it("基础设置修改不被后来新增的必填参数映射阻断", async () => {
    const { app, agentId, db } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "legacy-endpoint")
    });
    const endpointId = (created.json() as { endpoint: { id: number } }).endpoint.id;
    db.prepare(`
      INSERT INTO agent_session_parameters
        (agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES (?, 'ticket_id', '工单 ID', NULL, 1, 0, ?, ?)
    `).run(agentId, "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:00.000Z");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/integration-endpoints/${endpointId}`,
      headers: authHeaders(),
      payload: {
        name: "crawler-development",
        slug: "crawler-dev",
        agentId,
        enabled: true,
        promptPrefix: ""
      }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      id: endpointId,
      name: "crawler-development",
      slug: "crawler-dev",
      agentId,
      enabled: true,
      parameterMappings: []
    });
  });

  it("拒绝管理 Token 调用外部接口和端点 Token 跨 slug", async () => {
    const { app, agentId } = await createTestApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "endpoint-a")
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "endpoint-b")
    });
    const endpointA = first.json() as { token: string };
    const endpointB = second.json() as { token: string };

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const managementToken = await app.inject({
      method: "POST",
      url: "/integration/v1/endpoints/endpoint-a/tasks",
      headers: authHeaders()
    });
    const crossEndpointToken = await app.inject({
      method: "POST",
      url: "/integration/v1/endpoints/endpoint-b/tasks",
      headers: endpointHeaders(endpointA.token)
    });
    const validEndpointToken = await app.inject({
      method: "POST",
      url: "/integration/v1/endpoints/endpoint-a/tasks",
      headers: endpointHeaders(endpointA.token)
    });
    const validSecondEndpointToken = await app.inject({
      method: "POST",
      url: "/integration/v1/endpoints/endpoint-b/tasks",
      headers: endpointHeaders(endpointB.token)
    });

    expect(managementToken.statusCode).toBe(401);
    expect(managementToken.json()).toEqual({
      error: { code: "invalid_endpoint_token", message: "Invalid integration endpoint token" }
    });
    expect(crossEndpointToken.statusCode).toBe(401);
    expect(crossEndpointToken.json()).toEqual({
      error: { code: "invalid_endpoint_token", message: "Invalid integration endpoint token" }
    });
    expect(validEndpointToken.statusCode).toBe(400);
    expect(validEndpointToken.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid Integration Task input" }
    });
    expect(validSecondEndpointToken.statusCode).toBe(400);
    expect(validSecondEndpointToken.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid Integration Task input" }
    });
  });

  it("外部提交幂等 Task、查询状态并续接 Conversation", async () => {
    const { app, agentId, db } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });
    const endpoint = created.json() as { endpoint: { id: number; slug: string }; token: string };
    const payload = {
      requestId: "request-1",
      conversationKey: "ticket/1332",
      message: "Investigate the failing transfer",
      parameters: {}
    };

    const first = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload
    });
    const repeated = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload
    });
    const firstTask = first.json() as {
      taskId: number;
      requestId: string;
      conversationKey: string | null;
      sessionId: number;
      runId: number | null;
      status: string;
    };
    const continued = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload: { ...payload, requestId: "request-2", message: "Continue the investigation" }
    });
    await vi.waitFor(() => expect(
      (db.prepare("SELECT count(*) AS count FROM integration_tasks WHERE status = 'succeeded'").get() as { count: number }).count
    ).toBe(2));
    const queried = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${firstTask.taskId}`,
      headers: endpointHeaders(endpoint.token)
    });

    expect(first.statusCode).toBe(202);
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json()).toMatchObject({ taskId: firstTask.taskId });
    expect(queried.statusCode).toBe(200);
    expect(queried.json()).toMatchObject({ taskId: firstTask.taskId, status: "succeeded" });
    expect(continued.statusCode).toBe(202);
    expect(continued.json()).toMatchObject({ sessionId: firstTask.sessionId });
    for (const response of [first, repeated, queried, continued]) {
      expect(Object.keys(response.json() as Record<string, unknown>).sort()).toEqual(queuedTaskResponseKeys);
    }
    expect(firstTask).toEqual({
      taskId: firstTask.taskId,
      requestId: "request-1",
      conversationKey: "ticket/1332",
      sessionId: firstTask.sessionId,
      runId: null,
      status: "queued"
    });
    expect(firstTask.runId).toBeNull();
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 2 });
  });

  it("管理端浏览 Endpoint 汇总、Conversation、Task 和安全详情", async () => {
    const { app, agentId } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });
    const endpoint = created.json() as { endpoint: { id: number; slug: string }; token: string };
    const submitted = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload: {
        requestId: "admin-browser-request",
        conversationKey: "customer-42",
        message: "Show this Task in the console",
        parameters: {}
      }
    });
    const taskId = (submitted.json() as { taskId: number }).taskId;

    const summaries = await app.inject({ method: "GET", url: "/api/integration-endpoints", headers: authHeaders() });
    const conversations = await app.inject({
      method: "GET", url: `/api/integration-endpoints/${endpoint.endpoint.id}/conversations`, headers: authHeaders()
    });
    const tasks = await app.inject({
      method: "GET", url: `/api/integration-endpoints/${endpoint.endpoint.id}/tasks`, headers: authHeaders()
    });
    const detail = await app.inject({
      method: "GET", url: `/api/integration-tasks/${taskId}`, headers: authHeaders()
    });

    expect(summaries.statusCode).toBe(200);
    expect(summaries.json()).toMatchObject([{
      id: endpoint.endpoint.id,
      activeConversationCount: 1,
      queuedTaskCount: expect.any(Number),
      runningTaskCount: expect.any(Number),
      activeTaskCount: expect.any(Number),
      latestTask: { id: taskId, requestId: "admin-browser-request" }
    }]);
    expect(conversations.statusCode).toBe(200);
    expect(conversations.json()).toMatchObject([{ conversationKey: "customer-42" }]);
    expect(tasks.statusCode).toBe(200);
    expect(tasks.json()).toMatchObject([{ id: taskId, requestId: "admin-browser-request" }]);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: taskId, message: "Show this Task in the console" });
    expect(detail.json()).not.toHaveProperty("encryptedParameters");
    expect(detail.json()).not.toHaveProperty("requestFingerprint");
  });

  it("管理端测试调用复用端点参数映射并创建真实 Task", async () => {
    const { app, agentId, db } = await createTestApp();
    db.prepare(`
      INSERT INTO agent_session_parameters
        (agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES (?, 'project_code', '项目编号', '外部系统中的项目编号', 1, 0, ?, ?)
    `).run(agentId, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: {
        ...validEndpointInput(agentId),
        parameterMappings: [{ parameterKey: "project_code", source: "request", requestKey: "project" }]
      }
    });
    const endpointId = (created.json() as { endpoint: { id: number } }).endpoint.id;

    const tested = await app.inject({
      method: "POST",
      url: `/api/integration-endpoints/${endpointId}/test-tasks`,
      headers: authHeaders(),
      payload: {
        conversationKey: "project-42",
        message: "检查项目当前状态",
        parameters: { project: "P-42" }
      }
    });

    expect(tested.statusCode).toBe(202);
    expect(tested.json()).toMatchObject({
      endpointId,
      conversationId: expect.any(Number),
      sessionId: expect.any(Number),
      requestId: expect.stringMatching(/^test-/),
      message: "检查项目当前状态",
      status: "queued"
    });
    expect(tested.json()).not.toHaveProperty("encryptedParameters");
    expect(db.prepare(`
      SELECT count(*) AS count
      FROM integration_tasks
      WHERE endpoint_id = ? AND message = ? AND encrypted_parameters IS NOT NULL
    `).get(endpointId, "检查项目当前状态")).toEqual({ count: 1 });
  });

  it("管理端测试调用拒绝未启用的接入端点", async () => {
    const { app, agentId, db } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: { ...validEndpointInput(agentId), enabled: false }
    });
    const endpointId = (created.json() as { endpoint: { id: number } }).endpoint.id;

    const tested = await app.inject({
      method: "POST",
      url: `/api/integration-endpoints/${endpointId}/test-tasks`,
      headers: authHeaders(),
      payload: { message: "检查项目当前状态", parameters: {} }
    });

    expect(tested.statusCode).toBe(409);
    expect(tested.json()).toEqual({
      error: { code: "endpoint_disabled", message: "请先启用接入端点再发送测试任务" }
    });
    expect(db.prepare("SELECT count(*) AS count FROM integration_tasks").get()).toEqual({ count: 0 });
  });

  it("管理端测试调用用中文指出缺少的动态参数", async () => {
    const { app, agentId, db } = await createTestApp();
    db.prepare(`
      INSERT INTO agent_session_parameters
        (agent_id, key, label, description, required, secret, created_at, updated_at)
      VALUES (?, 'project_code', '项目编号', NULL, 1, 0, ?, ?)
    `).run(agentId, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: {
        ...validEndpointInput(agentId),
        parameterMappings: [{ parameterKey: "project_code", source: "request", requestKey: "project" }]
      }
    });
    const endpointId = (created.json() as { endpoint: { id: number } }).endpoint.id;

    const tested = await app.inject({
      method: "POST",
      url: `/api/integration-endpoints/${endpointId}/test-tasks`,
      headers: authHeaders(),
      payload: { message: "检查项目当前状态", parameters: {} }
    });

    expect(tested.statusCode).toBe(400);
    expect(tested.json()).toEqual({
      error: { code: "missing_request_parameter", message: "缺少必填的动态参数" }
    });
    expect(db.prepare("SELECT count(*) AS count FROM integration_tasks").get()).toEqual({ count: 0 });
  });

  it("Endpoint 列表使用 Store 聚合且不逐 Endpoint 加载 Conversation 和 Task 历史", async () => {
    const { app, agentId, integrationStore } = await createTestApp();
    await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });
    vi.spyOn(integrationStore, "listConversations").mockImplementation(() => {
      throw new Error("Endpoint list must not load Conversation history");
    });
    vi.spyOn(integrationStore, "listTasks").mockImplementation(() => {
      throw new Error("Endpoint list must not load Task history");
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/integration-endpoints",
      headers: authHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([{
      activeConversationCount: 0,
      queuedTaskCount: 0,
      runningTaskCount: 0,
      activeTaskCount: 0,
      latestTask: null
    }]);
  });

  it("Conversation 建立后禁用 Agent，后续 Task 稳定失败且不启动新 Turn", async () => {
    const runtime = createFakeRuntime();
    runtime.startTurn = vi.fn(runtime.startTurn);
    const { app, agentId, db } = await createTestApp(runtime);
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });
    const endpoint = created.json() as { endpoint: { slug: string }; token: string };
    const submit = (requestId: string) => app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload: { requestId, conversationKey: "ticket-disabled-agent", message: requestId, parameters: {} }
    });

    const first = await submit("request-before-disable");
    const firstTask = first.json() as { taskId: number };
    await vi.waitFor(() => expect(
      db.prepare("SELECT status FROM integration_tasks WHERE id = ?").get(firstTask.taskId)
    ).toEqual({ status: "succeeded" }));
    db.prepare("UPDATE agents SET enabled = 0 WHERE id = ?").run(agentId);

    const second = await submit("request-after-disable");
    const secondTask = second.json() as { taskId: number };
    await vi.waitFor(() => expect(
      db.prepare("SELECT status, error FROM integration_tasks WHERE id = ?").get(secondTask.taskId)
    ).toEqual({ status: "failed", error: "agent_disabled" }));
    const publicEvents = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${secondTask.taskId}/events`,
      headers: endpointHeaders(endpoint.token)
    });
    const notices = (publicEvents.json() as Array<{ type: string; contentJson: string }>).filter(
      (event) => event.type === "message.system.notice"
    );

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(runtime.startTurn).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(1);
    expect(JSON.parse(notices[0]!.contentJson)).toEqual({
      code: "agent_disabled",
      message: "Agent is disabled"
    });
  });

  it("外部提交冲突返回 409，繁忙 Conversation 不能结束", async () => {
    const result = deferred<RuntimeTurnResult>();
    const runtime = createFakeRuntime();
    runtime.startTurn = () => ({
      events: { async *[Symbol.asyncIterator]() {} },
      result: result.promise,
      cancel: async () => undefined,
      closeEvents: async () => undefined
    });
    runtime.cancel = async () => result.resolve({ status: "cancelled" });
    const { app, agentId } = await createTestApp(runtime);
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });
    const endpoint = created.json() as { endpoint: { slug: string }; token: string };
    const taskUrl = `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`;
    await app.inject({
      method: "POST",
      url: taskUrl,
      headers: endpointHeaders(endpoint.token),
      payload: { requestId: "request-1", conversationKey: "ticket-1332", message: "first", parameters: {} }
    });

    const conflict = await app.inject({
      method: "POST",
      url: taskUrl,
      headers: endpointHeaders(endpoint.token),
      payload: { requestId: "request-1", conversationKey: "ticket-1332", message: "changed", parameters: {} }
    });
    const busy = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/conversations/ticket-1332/end`,
      headers: endpointHeaders(endpoint.token)
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: { code: "idempotency_conflict", message: "requestId was already used with different input" }
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({
      error: { code: "conversation_busy", message: "Conversation has an active Task" }
    });
  });

  it("结束 Conversation 后保留历史并为同 key 创建新 Session", async () => {
    const { app, agentId, db } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });
    const endpoint = created.json() as { endpoint: { id: number; slug: string }; token: string };
    const taskUrl = `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`;
    const first = await app.inject({
      method: "POST",
      url: taskUrl,
      headers: endpointHeaders(endpoint.token),
      payload: { requestId: "request-1", conversationKey: "ticket-1332", message: "first", parameters: {} }
    });
    const firstTask = first.json() as { sessionId: number };
    db.prepare("UPDATE integration_tasks SET status = 'succeeded', finished_at = ?").run(new Date().toISOString());

    const ended = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/conversations/ticket-1332/end`,
      headers: endpointHeaders(endpoint.token)
    });
    const next = await app.inject({
      method: "POST",
      url: taskUrl,
      headers: endpointHeaders(endpoint.token),
      payload: { requestId: "request-2", conversationKey: "ticket-1332", message: "next", parameters: {} }
    });

    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toMatchObject({ status: "ended", sessionId: firstTask.sessionId });
    expect(next.statusCode).toBe(202);
    expect(next.json()).not.toMatchObject({ sessionId: firstTask.sessionId });
    expect(db.prepare("SELECT count(*) AS count FROM integration_conversations").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 2 });
  });

  it("Task 查询先校验 Token，并让跨 Endpoint 与随机 ID 返回相同 404", async () => {
    const { app, agentId } = await createTestApp();
    const firstEndpointResponse = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "first-endpoint")
    });
    const secondEndpointResponse = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "second-endpoint")
    });
    const firstEndpoint = firstEndpointResponse.json() as { endpoint: { slug: string }; token: string };
    const secondEndpoint = secondEndpointResponse.json() as { token: string };
    const createdTask = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${firstEndpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(firstEndpoint.token),
      payload: { requestId: "request-1", message: "work", parameters: {} }
    });
    const task = createdTask.json() as { taskId: number };

    const invalidTokenRead = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${task.taskId}`,
      headers: endpointHeaders("invalid-token")
    });

    const crossEndpointRead = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${task.taskId}`,
      headers: endpointHeaders(secondEndpoint.token)
    });
    const randomIdRead = await app.inject({
      method: "GET",
      url: "/integration/v1/tasks/does-not-exist",
      headers: endpointHeaders(secondEndpoint.token)
    });
    const invalidSubmit = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${firstEndpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(firstEndpoint.token),
      payload: { requestId: "request-2", message: "work", parameters: {}, unexpected: true }
    });

    expect(invalidTokenRead.statusCode).toBe(401);
    expect(invalidTokenRead.json()).toEqual({
      error: { code: "invalid_endpoint_token", message: "Invalid integration endpoint token" }
    });
    expect(crossEndpointRead.statusCode).toBe(404);
    expect(randomIdRead.statusCode).toBe(404);
    expect(crossEndpointRead.json()).toEqual({
      error: { code: "task_not_found", message: "Integration Task not found" }
    });
    expect(randomIdRead.json()).toEqual(crossEndpointRead.json());
    expect(invalidSubmit.statusCode).toBe(400);
    expect(invalidSubmit.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid Integration Task input" }
    });
  });

  it("Task Event 历史复用 Run seq、支持 afterSeq 并隔离 Endpoint", async () => {
    const runtime = createFakeRuntime({
      events: [
        { type: "message", stream: "output", text: "done" },
        { type: "tool", content: { toolCallId: "tool-1", title: "Inspect", status: "completed" } }
      ]
    });
    const { app, agentId, db } = await createTestApp(runtime);
    const firstEndpointResponse = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "events-a")
    });
    const secondEndpointResponse = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "events-b")
    });
    const firstEndpoint = firstEndpointResponse.json() as { endpoint: { slug: string }; token: string };
    const secondEndpoint = secondEndpointResponse.json() as { token: string };
    const submitted = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${firstEndpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(firstEndpoint.token),
      payload: { requestId: "event-request", message: "work", parameters: {} }
    });
    const task = submitted.json() as { taskId: number };
    await vi.waitFor(() => expect(
      db.prepare("SELECT status FROM integration_tasks WHERE id = ?").get(task.taskId)
    ).toEqual({ status: "succeeded" }));

    const events = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${task.taskId}/events?afterSeq=1`,
      headers: endpointHeaders(firstEndpoint.token)
    });
    const crossEndpoint = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${task.taskId}/events`,
      headers: endpointHeaders(secondEndpoint.token)
    });
    const invalidCursor = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${task.taskId}/events?afterSeq=-1`,
      headers: endpointHeaders(firstEndpoint.token)
    });

    expect(events.statusCode).toBe(200);
    expect((events.json() as Array<{ seq: number; type: string }>).map(({ seq, type }) => ({ seq, type })))
      .toEqual([{ seq: 2, type: "tool" }, { seq: 3, type: "status" }]);
    expect(crossEndpoint.statusCode).toBe(404);
    expect(crossEndpoint.json()).toEqual({
      error: { code: "task_not_found", message: "Integration Task not found" }
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid Event cursor" }
    });
  });

  it("外部 Task Event 只返回公开投影且保留 Agent 消息和 afterSeq", async () => {
    const leakedSecret = "run-event-secret-must-not-leak";
    const runtime = createFakeRuntime({
      events: [
        { type: "message", stream: "output", text: "safe agent reply" },
        {
          type: "tool",
          content: {
            toolCallId: "tool-secret-boundary",
            title: `Inspect ${leakedSecret}`,
            locations: [{ path: `/workspace/${leakedSecret}.txt`, line: 9 }],
            status: "completed",
            rawInput: { token: leakedSecret },
            rawOutput: { result: leakedSecret },
            content: { nested: leakedSecret },
            providerPrivate: { deeply: { nested: leakedSecret } }
          }
        },
        { type: "status", text: leakedSecret },
        { type: "error", code: "provider_warning", message: leakedSecret }
      ]
    });
    const { app, agentId, db } = await createTestApp(runtime);
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "public-events")
    });
    const endpoint = created.json() as { endpoint: { slug: string }; token: string };
    const submitted = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload: { requestId: "public-event-request", message: "work", parameters: {} }
    });
    const taskId = (submitted.json() as { taskId: number }).taskId;
    await vi.waitFor(() => expect(
      db.prepare("SELECT status FROM integration_tasks WHERE id = ?").get(taskId)
    ).toEqual({ status: "succeeded" }));

    const all = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${taskId}/events`,
      headers: endpointHeaders(endpoint.token)
    });
    const afterMessage = await app.inject({
      method: "GET",
      url: `/integration/v1/tasks/${taskId}/events?afterSeq=1`,
      headers: endpointHeaders(endpoint.token)
    });
    const events = all.json() as Array<{ seq: number; type: string; contentJson: string }>;

    expect(all.statusCode).toBe(200);
    expect(events.map(({ seq, type }) => ({ seq, type }))).toEqual([
      { seq: 1, type: "message" },
      { seq: 2, type: "tool" },
      { seq: 3, type: "status" },
      { seq: 4, type: "error" },
      { seq: 5, type: "status" }
    ]);
    expect(JSON.parse(events[0]!.contentJson)).toEqual({ stream: "output", text: "safe agent reply" });
    expect(JSON.parse(events[1]!.contentJson)).toEqual({
      toolCallId: "tool-secret-boundary",
      status: "completed"
    });
    expect(JSON.parse(events[2]!.contentJson)).toEqual({});
    expect(JSON.parse(events[3]!.contentJson)).toEqual({ code: "agent_run_error" });
    expect(JSON.stringify(events)).not.toContain(leakedSecret);
    expect(JSON.stringify(events)).not.toContain("rawInput");
    expect(JSON.stringify(events)).not.toContain("rawOutput");
    expect(JSON.stringify(events)).not.toContain('"content"');
    expect((afterMessage.json() as Array<{ seq: number }>).map(({ seq }) => seq)).toEqual([2, 3, 4, 5]);
  });

  it("running Task 取消委托 Runtime，终态幂等并继续调度同 Conversation 下一 Task", async () => {
    const result = deferred<RuntimeTurnResult>();
    const runtime = createFakeRuntime();
    const succeedingTurn = runtime.startTurn;
    const startedInputs: string[] = [];
    runtime.startTurn = (input) => {
      startedInputs.push(input.text);
      return input.text.includes("long work") ? {
        events: { async *[Symbol.asyncIterator]() {} },
        result: result.promise,
        cancel: async () => undefined,
        closeEvents: async () => undefined
      } : succeedingTurn(input);
    };
    runtime.cancel = vi.fn(async () => result.resolve({ status: "cancelled" }));
    const { app, agentId, db } = await createTestApp(runtime);
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "cancel-endpoint")
    });
    const endpoint = created.json() as { endpoint: { slug: string }; token: string };
    const submitted = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload: {
        requestId: "cancel-request",
        conversationKey: "cancel-conversation",
        message: "long work",
        parameters: {}
      }
    });
    const task = submitted.json() as { taskId: number; sessionId: number };
    await vi.waitFor(() => expect(
      db.prepare("SELECT status FROM integration_tasks WHERE id = ?").get(task.taskId)
    ).toEqual({ status: "running" }));
    const nextSubmitted = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload: {
        requestId: "next-request",
        conversationKey: "cancel-conversation",
        message: "next work",
        parameters: {}
      }
    });
    const nextTask = nextSubmitted.json() as { taskId: number; sessionId: number };
    expect(nextTask.sessionId).toBe(task.sessionId);
    expect(db.prepare("SELECT status, run_id FROM integration_tasks WHERE id = ?").get(nextTask.taskId))
      .toEqual({ status: "queued", run_id: null });

    const cancelled = await app.inject({
      method: "POST",
      url: `/integration/v1/tasks/${task.taskId}/cancel`,
      headers: endpointHeaders(endpoint.token)
    });
    await vi.waitFor(() => expect(
      db.prepare("SELECT status FROM integration_tasks WHERE id = ?").get(task.taskId)
    ).toEqual({ status: "cancelled" }));
    await vi.waitFor(() => expect(
      db.prepare("SELECT status FROM integration_tasks WHERE id = ?").get(nextTask.taskId)
    ).toEqual({ status: "succeeded" }), { timeout: 5_000 });
    const repeated = await app.inject({
      method: "POST",
      url: `/integration/v1/tasks/${task.taskId}/cancel`,
      headers: endpointHeaders(endpoint.token)
    });

    expect(cancelled.statusCode).toBe(200);
    expect(runtime.cancel).toHaveBeenCalledWith(task.sessionId);
    expect(startedInputs).toContain("Resolve the support request.\n\nnext work");
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ taskId: task.taskId, status: "cancelled" });
  });

  it("未关联 Run 的 queued Task 直接取消且不会调用 Runtime", async () => {
    const runtime = createFakeRuntime();
    runtime.cancel = vi.fn(runtime.cancel);
    const { app, agentId, db } = await createTestApp(runtime, (store) => {
      vi.spyOn(store, "listDispatchableTasks").mockReturnValue([]);
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "queued-cancel")
    });
    const endpoint = created.json() as { endpoint: { slug: string }; token: string };
    const submitted = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token),
      payload: { requestId: "queued-cancel-request", message: "cancel me", parameters: {} }
    });
    const task = submitted.json() as { taskId: number };

    const cancelled = await app.inject({
      method: "POST",
      url: `/integration/v1/tasks/${task.taskId}/cancel`,
      headers: endpointHeaders(endpoint.token)
    });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ taskId: task.taskId, status: "cancelled", runId: null });
    expect(db.prepare("SELECT status, run_id FROM integration_tasks WHERE id = ?").get(task.taskId))
      .toEqual({ status: "cancelled", run_id: null });
    expect(db.prepare("SELECT count(*) AS count FROM runs").get()).toEqual({ count: 0 });
    expect(runtime.cancel).not.toHaveBeenCalled();
  });

  it("重复 slug 的创建和更新返回稳定冲突错误", async () => {
    const { app, agentId } = await createTestApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "first-endpoint")
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "second-endpoint")
    });
    const duplicateCreate = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "first-endpoint")
    });
    const secondId = (second.json() as { endpoint: { id: number } }).endpoint.id;
    const duplicateUpdate = await app.inject({
      method: "PATCH",
      url: `/api/integration-endpoints/${secondId}`,
      headers: authHeaders(),
      payload: { slug: "first-endpoint" }
    });
    const secondDetail = await app.inject({
      method: "GET",
      url: `/api/integration-endpoints/${secondId}`,
      headers: authHeaders()
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(duplicateCreate.statusCode).toBe(409);
    expect(duplicateCreate.json()).toEqual({
      error: { code: "slug_conflict", message: "Integration endpoint slug already exists" }
    });
    expect(JSON.stringify(duplicateCreate.json())).not.toContain("integration_endpoints");
    expect(duplicateUpdate.statusCode).toBe(409);
    expect(duplicateUpdate.json()).toEqual({
      error: { code: "slug_conflict", message: "Integration endpoint slug already exists" }
    });
    expect(secondDetail.json()).toMatchObject({ slug: "second-endpoint" });
  });

  it("rotate-token 拒绝多余请求体且保留旧 token", async () => {
    const { app, agentId } = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId)
    });
    const endpoint = created.json() as { endpoint: { id: number; slug: string }; token: string };
    const invalidRotation = await app.inject({
      method: "POST",
      url: `/api/integration-endpoints/${endpoint.endpoint.id}/rotate-token`,
      headers: authHeaders(),
      payload: { unexpected: true }
    });
    const stillAuthorized = await app.inject({
      method: "POST",
      url: `/integration/v1/endpoints/${endpoint.endpoint.slug}/tasks`,
      headers: endpointHeaders(endpoint.token)
    });

    expect(invalidRotation.statusCode).toBe(400);
    expect(invalidRotation.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid Integration Endpoint token rotation" }
    });
    expect(stillAuthorized.statusCode).toBe(400);
    expect(stillAuthorized.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid Integration Task input" }
    });
  });

  it("管理端拒绝多余字段和不合法 slug", async () => {
    const { app, agentId } = await createTestApp();
    const extraField = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: { ...validEndpointInput(agentId), unexpected: true }
    });
    const invalidSlug = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders(),
      payload: validEndpointInput(agentId, "Support_Bot")
    });

    expect(extraField.statusCode).toBe(400);
    expect(extraField.json()).toEqual({ error: { code: "invalid_request", message: "Invalid Integration Endpoint input" } });
    expect(invalidSlug.statusCode).toBe(400);
    expect(invalidSlug.json()).toEqual({ error: { code: "invalid_request", message: "Invalid Integration Endpoint input" } });
  });

  it("SPA fallback 将未知 integration 路径保持为 JSON API 404", async () => {
    const webRoot = mkdtempSync(join(tmpdir(), "remote-agent-integration-web-"));
    mkdirSync(join(webRoot, "assets"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Remote Agent UI</title>");
    const { db } = createTestDatabase();
    const app = buildApp({
      config: {
        host: "127.0.0.1",
        port: 3000,
        apiToken,
        dataDir: webRoot,
        databasePath: ":memory:",
        projectEnvironmentsRoot: "/unused/environments",
        sessionsRoot: "/unused/sessions",
        maxConcurrentRuns: 1,
        maxConcurrentWebhookDeliveries: 4,
        maxConcurrentEnvironmentBuilds: 1,
        projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000,
        projectPrepareTimeoutMs: 30 * 60 * 1000,
        sessionRetentionMs: 0
      },
      db,
      runtime: createFakeRuntime(),
      webRoot
    });

    try {
      await app.ready();
      const response = await app.inject({
        method: "GET",
        url: "/integration/not-a-route",
        headers: { accept: "text/html" }
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json()).toEqual({ error: { code: "not_found", message: "API route not found" } });
    } finally {
      await app.close();
      db.close();
      rmSync(webRoot, { force: true, recursive: true });
    }
  });

  it("无 webRoot 时也为 API、Integration 和普通未知路径返回固定 JSON 404", async () => {
    const { db } = createTestDatabase();
    const dataDir = mkdtempSync(join(tmpdir(), "remote-agent-no-web-root-"));
    const app = buildApp({
      config: {
        host: "127.0.0.1",
        port: 3000,
        apiToken,
        dataDir,
        databasePath: ":memory:",
        projectEnvironmentsRoot: "/unused/environments",
        sessionsRoot: "/unused/sessions",
        maxConcurrentRuns: 1,
        maxConcurrentWebhookDeliveries: 4,
        maxConcurrentEnvironmentBuilds: 1,
        projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000,
        projectPrepareTimeoutMs: 30 * 60 * 1000,
        sessionRetentionMs: 0
      },
      db,
      runtime: createFakeRuntime(),
      webRoot: join(dataDir, "does-not-exist")
    });

    try {
      await app.ready();
      const missingApi = await app.inject({
        method: "GET",
        url: "/api?probe=1",
        headers: { authorization: `Bearer ${apiToken}` }
      });
      const missingIntegration = await app.inject({ method: "GET", url: "/integration?probe=1" });
      const missingRoute = await app.inject({ method: "GET", url: "/not-a-route?probe=1" });

      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.json()).toEqual({ error: { code: "not_found", message: "API route not found" } });
      expect(missingIntegration.statusCode).toBe(404);
      expect(missingIntegration.json()).toEqual({ error: { code: "not_found", message: "API route not found" } });
      expect(missingRoute.statusCode).toBe(404);
      expect(missingRoute.json()).toEqual({ error: { code: "not_found", message: "Route not found" } });
    } finally {
      await app.close();
      db.close();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });
});
