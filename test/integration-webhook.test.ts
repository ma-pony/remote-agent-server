import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { EventStore } from "../src/events/event-store.js";
import { IntegrationEndpointManager } from "../src/integrations/integration-endpoint-manager.js";
import { IntegrationProjection } from "../src/integrations/integration-projection.js";
import { IntegrationStore } from "../src/integrations/integration-store.js";
import { WebhookDispatcher } from "../src/integrations/webhook-dispatcher.js";
import { SecretStore } from "../src/mcp/secret-store.js";
import { RunRepository } from "../src/runs/run-repository.js";
import type { WorkspaceManager } from "../src/workspaces/workspace-manager.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const apiToken = "webhook-admin-token";
const authHeaders = { authorization: `Bearer ${apiToken}` };
const temporaryDirectories: string[] = [];
const apps: Array<{ app: FastifyInstance; db: ReturnType<typeof createTestDatabase>["db"]; root: string }> = [];

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const createHarness = (fetchImpl: typeof fetch = vi.fn(async () => new Response(null, { status: 204 }))) => {
  const { db, seed } = createTestDatabase();
  const root = mkdtempSync(join(tmpdir(), "remote-agent-webhook-"));
  temporaryDirectories.push(root);
  const secrets = SecretStore.open({ dataDir: root });
  const store = new IntegrationStore({ db });
  const manager = new IntegrationEndpointManager({ db, store, secrets });
  const endpoint = manager.create({
    name: "Webhook endpoint",
    slug: `webhook-${Math.random().toString(36).slice(2)}`,
    agentId: seed.agent.id,
    enabled: true,
    promptPrefix: "",
    parameterMappings: []
  }).endpoint;
  const dispatcher = new WebhookDispatcher({ store, secrets, fetch: fetchImpl });

  const createSubscription = (name: string, signingSecret: string, enabled = true) => store.createSubscription({
    endpointId: endpoint.id,
    name,
    url: `https://receiver.test/${name}`,
    enabled,
    eventsJson: JSON.stringify(["task.started", "task.succeeded", "message.agent.reply", "tool.completed"]),
    encryptedHeaders: secrets.encrypt(JSON.stringify({ Authorization: "Bearer receiver-token" })),
    encryptedSigningSecret: secrets.encrypt(signingSecret),
    timeoutSeconds: 10
  });

  const createDelivery = (subscriptionId: string, sequence: number, eventType = "task.succeeded") => {
    const payloadJson = JSON.stringify({
      id: `event-${subscriptionId}-${sequence}`,
      type: eventType,
      sequence,
      taskId: null,
      occurredAt: new Date().toISOString(),
      data: { status: "succeeded" }
    });
    return store.createDelivery({
      eventId: `event-${subscriptionId}-${sequence}`,
      eventKey: `${subscriptionId}:${sequence}:${eventType}`,
      sequence,
      subscriptionId,
      taskId: null,
      eventType,
      payloadJson,
      nextAttemptAt: new Date().toISOString()
    });
  };

  return { db, seed, root, secrets, store, endpoint, dispatcher, createSubscription, createDelivery };
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async ({ app, db, root }) => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WebhookDispatcher", () => {
  it("按原始 JSON Body 生成 HMAC-SHA256 签名且不读取响应 Body", async () => {
    const requests: Array<{ body: string; headers: Headers }> = [];
    const response = new Response("sensitive response body", { status: 200 });
    const text = vi.spyOn(response, "text");
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      requests.push({ body: init?.body as string, headers: new Headers(init?.headers) });
      return response;
    });
    const harness = createHarness(fetchImpl);
    const signingSecret = "signing-secret";
    const subscription = harness.createSubscription("signed", signingSecret);
    const delivery = harness.createDelivery(subscription.id, 1);

    await harness.dispatcher.deliver(delivery.id);

    const request = requests[0]!;
    const timestamp = request.headers.get("x-remote-agent-timestamp")!;
    expect(request.body).toBe(delivery.payloadJson);
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("authorization")).toBe("Bearer receiver-token");
    expect(request.headers.get("x-remote-agent-event")).toBe(delivery.eventType);
    expect(request.headers.get("x-remote-agent-event-id")).toBe(delivery.eventId);
    expect(request.headers.get("x-remote-agent-signature")).toBe(
      `v1=${createHmac("sha256", signingSecret).update(`${timestamp}.${request.body}`).digest("hex")}`
    );
    expect(text).not.toHaveBeenCalled();
    expect(harness.store.getDelivery(delivery.id)).toMatchObject({ status: "succeeded", attemptCount: 1 });
    harness.db.close();
  });

  it("同一 Subscription 严格串行且不同 Subscription 并行", async () => {
    const requests = new Map<string, ReturnType<typeof deferred<Response>>>();
    const started: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const eventId = new Headers(init?.headers).get("x-remote-agent-event-id")!;
      started.push(eventId);
      const pending = deferred<Response>();
      requests.set(eventId, pending);
      return pending.promise;
    });
    const harness = createHarness(fetchImpl);
    const subscriptionA = harness.createSubscription("a", "secret-a");
    const subscriptionB = harness.createSubscription("b", "secret-b");
    const a1 = harness.createDelivery(subscriptionA.id, 1);
    const a2 = harness.createDelivery(subscriptionA.id, 2);
    const b1 = harness.createDelivery(subscriptionB.id, 1);

    harness.dispatcher.start();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(started).toEqual(expect.arrayContaining([a1.eventId, b1.eventId]));
    expect(started).not.toContain(a2.eventId);

    requests.get(b1.eventId)!.resolve(new Response(null, { status: 204 }));
    requests.get(a1.eventId)!.resolve(new Response(null, { status: 204 }));
    await vi.waitFor(() => expect(started).toContain(a2.eventId));
    requests.get(a2.eventId)!.resolve(new Response(null, { status: 204 }));
    await vi.waitFor(() => expect(harness.store.getDelivery(a2.id)?.status).toBe("succeeded"));

    await harness.dispatcher.stop();
    harness.db.close();
  });

  it("失败按 10s/1m/5m/30m/2h 重试并在第六次失败", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    const harness = createHarness(vi.fn(async () => new Response(null, { status: 500 })));
    const subscription = harness.createSubscription("retry", "secret");
    const delivery = harness.createDelivery(subscription.id, 1);
    const delays = [10_000, 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

    for (const [index, delay] of delays.entries()) {
      await harness.dispatcher.deliver(delivery.id);
      const current = harness.store.getDelivery(delivery.id)!;
      expect(current).toMatchObject({ status: "pending", attemptCount: index + 1, lastStatusCode: 500 });
      expect(new Date(current.nextAttemptAt).getTime()).toBe(Date.now() + delay);
      vi.setSystemTime(new Date(current.nextAttemptAt));
    }
    await harness.dispatcher.deliver(delivery.id);

    expect(harness.store.getDelivery(delivery.id)).toMatchObject({
      status: "failed",
      attemptCount: 6,
      lastStatusCode: 500,
      lastError: "HTTP 500"
    });
    harness.db.close();
  });

  it("未来 nextAttemptAt 只用最近 deadline 唤醒投递", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const harness = createHarness(fetchImpl);
    const subscription = harness.createSubscription("deadline", "secret");
    const delivery = harness.createDelivery(subscription.id, 1);
    harness.db.prepare("UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ?")
      .run("2026-08-13T00:00:10.000Z", delivery.id);

    harness.dispatcher.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(harness.store.getDelivery(delivery.id)?.status).toBe("succeeded"));

    await harness.dispatcher.stop();
    harness.db.close();
  });

  it("timeout 使用脱敏错误并保留下一次重试", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("secret timeout detail", "AbortError")), {
        once: true
      });
    }));
    const harness = createHarness(fetchImpl);
    const subscription = harness.createSubscription("timeout", "secret");
    harness.db.prepare("UPDATE webhook_subscriptions SET timeout_seconds = 0.001 WHERE id = ?").run(subscription.id);
    const delivery = harness.createDelivery(subscription.id, 1);

    await harness.dispatcher.deliver(delivery.id);

    expect(harness.store.getDelivery(delivery.id)).toMatchObject({
      status: "pending",
      attemptCount: 1,
      lastError: "Webhook request timed out"
    });
    expect(JSON.stringify(harness.store.getDelivery(delivery.id))).not.toContain("secret timeout detail");
    harness.db.close();
  });

  it("停用的 Subscription 不投递，网络错误只保存脱敏原因", async () => {
    const leakedError = "connect ECONNREFUSED 10.0.0.8 token=must-not-leak";
    const fetchImpl = vi.fn<typeof fetch>(async () => Promise.reject(new Error(leakedError)));
    const harness = createHarness(fetchImpl);
    const disabled = harness.createSubscription("disabled", "disabled-secret", false);
    const disabledDelivery = harness.createDelivery(disabled.id, 1);

    harness.dispatcher.start();
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(harness.store.getDelivery(disabledDelivery.id)?.status).toBe("pending");
    await harness.dispatcher.stop();

    const enabled = harness.createSubscription("enabled", "enabled-secret");
    const enabledDelivery = harness.createDelivery(enabled.id, 1);
    await harness.dispatcher.deliver(enabledDelivery.id);
    expect(harness.store.getDelivery(enabledDelivery.id)).toMatchObject({
      status: "pending",
      lastError: "Webhook request failed",
      lastStatusCode: null
    });
    expect(JSON.stringify(harness.store.getDelivery(enabledDelivery.id))).not.toContain(leakedError);
    harness.db.close();
  });

  it("stop 中止 active fetch 并将 Delivery 留为下次可恢复的 pending", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const harness = createHarness(fetchImpl);
    const subscription = harness.createSubscription("stop", "secret");
    const delivery = harness.createDelivery(subscription.id, 1);

    harness.dispatcher.start();
    await vi.waitFor(() => expect(harness.store.getDelivery(delivery.id)?.status).toBe("delivering"));
    await harness.dispatcher.stop();

    expect(harness.store.getDelivery(delivery.id)?.status).toBe("pending");
    harness.db.close();
  });

  it("恢复 delivering 并从 Run/Event 补建缺失的确定性 Delivery", () => {
    const harness = createHarness();
    const subscription = harness.createSubscription("recover", "secret");
    let eventStore!: EventStore;
    const projection = new IntegrationProjection({
      db: harness.db,
      store: harness.store,
      listEvents: (runId) => eventStore.list(runId, 0)
    });
    const runRepository = new RunRepository({ db: harness.db, projection });
    eventStore = new EventStore({ db: harness.db, projection });
    const session = harness.seed.session();
    const task = harness.store.createTask({
      endpointId: harness.endpoint.id,
      conversationId: null,
      sessionId: session.id,
      requestId: "recover-request",
      requestFingerprint: "recover-fingerprint",
      message: "recover",
      effectivePrompt: "recover",
      encryptedParameters: null
    });
    const run = runRepository.create(
      { sessionId: session.id, input: "recover" },
      { afterInsert: (created) => { harness.store.linkTaskRunInTransaction(task.id, created.id); return undefined; } }
    );
    runRepository.markRunning(run.id);
    eventStore.append(run.id, "message", { stream: "output", text: "recovered reply" });
    const toolEvent = eventStore.append(run.id, "tool", {
      toolCallId: "tool-recover",
      status: "completed",
      title: "Read",
      rawOutput: "must-not-leak"
    });
    runRepository.finish(run.id, { status: "succeeded", result: "done" });
    harness.db.prepare(`
      DELETE FROM webhook_deliveries
      WHERE subscription_id = ? AND event_type IN ('task.succeeded', 'message.agent.reply', 'tool.completed')
    `).run(subscription.id);
    harness.db.prepare(`
      UPDATE webhook_deliveries SET status = 'delivering'
      WHERE subscription_id = ? AND event_type = 'task.started'
    `).run(subscription.id);

    projection.recover();
    harness.dispatcher.recover();

    expect(harness.store.findDeliveryByEventKey(subscription.id, `${task.id}:task.succeeded`)).toBeDefined();
    expect(harness.store.findDeliveryByEventKey(subscription.id, `${task.id}:message.agent.reply`)).toBeDefined();
    expect(harness.store.findDeliveryByEventKey(
      subscription.id,
      `${run.id}:${toolEvent.seq}:tool.completed`
    )).toBeDefined();
    expect(harness.store.listDeliveries(subscription.id).find(({ eventType }) => eventType === "task.started"))
      .toMatchObject({ status: "pending" });
    expect(JSON.stringify(harness.store.listDeliveries(subscription.id))).not.toContain("must-not-leak");
    harness.db.close();
  });
});

describe("Webhook management API", () => {
  it("管理 Webhook、只在创建返回 secret，并加密 Header 和 secret", async () => {
    const { db, seed } = createTestDatabase();
    const root = mkdtempSync(join(tmpdir(), "remote-agent-webhook-api-"));
    const requests: Array<{ url: string; headers: Headers; body: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body as string });
      return new Response(null, { status: 204 });
    });
    const workspaceManager: WorkspaceManager = {
      check: async () => undefined,
      createSession: async (id) => ({
        workspacePath: join(root, "sessions", id, "workspace"),
        runtimePath: join(root, "sessions", id, "runtime"),
        browserProfilePath: join(root, "sessions", id, "browser")
      }),
      deleteSession: async () => undefined,
      createRevision: async () => undefined,
      removeRevision: async () => undefined
    };
    const app = buildApp({
      config: {
        host: "127.0.0.1",
        port: 3000,
        apiToken,
        dataDir: root,
        databasePath: ":memory:",
        workspaceTemplate: "/unused/template",
        sessionsRoot: "/unused/sessions",
        maxConcurrentRuns: 1
      },
      db,
      runtime: createFakeRuntime(),
      workspaceManager,
      webhookFetch: fetchImpl
    });
    apps.push({ app, db, root });
    await app.ready();
    const endpointResponse = await app.inject({
      method: "POST",
      url: "/api/integration-endpoints",
      headers: authHeaders,
      payload: {
        name: "Webhook API",
        slug: "webhook-api",
        agentId: seed.agent.id,
        enabled: true,
        promptPrefix: "",
        parameterMappings: []
      }
    });
    const endpointId = (endpointResponse.json() as { endpoint: { id: string } }).endpoint.id;
    const unauthorized = await app.inject({ method: "GET", url: `/api/integration-endpoints/${endpointId}/webhooks` });
    const reservedHeader = await app.inject({
      method: "POST",
      url: `/api/integration-endpoints/${endpointId}/webhooks`,
      headers: authHeaders,
      payload: {
        name: "invalid",
        url: "https://receiver.test/hook",
        enabled: true,
        events: ["task.succeeded"],
        headers: { "X-Remote-Agent-Signature": "forged" },
        timeoutSeconds: 10
      }
    });
    const created = await app.inject({
      method: "POST",
      url: `/api/integration-endpoints/${endpointId}/webhooks`,
      headers: authHeaders,
      payload: {
        name: "Grab callback",
        url: "https://receiver.test/hook",
        enabled: true,
        events: ["task.succeeded", "message.agent.reply"],
        headers: { Authorization: "Bearer callback-secret" },
        timeoutSeconds: 12
      }
    });
    const createdBody = created.json() as {
      webhook: { id: string; headers: Array<{ name: string; configured: boolean }>; signingSecretConfigured: boolean };
      signingSecret: string;
    };

    expect(unauthorized.statusCode).toBe(401);
    expect(reservedHeader.statusCode).toBe(400);
    expect(created.statusCode).toBe(201);
    expect(createdBody.signingSecret).toMatch(/^whsec_/);
    expect(createdBody.webhook.headers).toEqual([{ name: "Authorization", configured: true }]);
    expect(createdBody.webhook.signingSecretConfigured).toBe(true);

    const listed = await app.inject({
      method: "GET",
      url: `/api/integration-endpoints/${endpointId}/webhooks`,
      headers: authHeaders
    });
    const persisted = db.prepare(`
      SELECT encrypted_headers, encrypted_signing_secret FROM webhook_subscriptions WHERE id = ?
    `).get(createdBody.webhook.id) as { encrypted_headers: string; encrypted_signing_secret: string };
    expect(JSON.stringify(listed.json())).not.toContain(createdBody.signingSecret);
    expect(JSON.stringify(listed.json())).not.toContain("callback-secret");
    expect(persisted.encrypted_headers).not.toContain("callback-secret");
    expect(persisted.encrypted_signing_secret).not.toContain(createdBody.signingSecret);

    const tested = await app.inject({
      method: "POST",
      url: `/api/integration-endpoints/${endpointId}/webhooks/${createdBody.webhook.id}/test`,
      headers: authHeaders
    });
    expect(tested.statusCode).toBe(202);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.headers.get("x-remote-agent-event")).toBe("webhook.test");
    const deliveries = await app.inject({
      method: "GET",
      url: `/api/integration-endpoints/${endpointId}/webhook-deliveries`,
      headers: authHeaders
    });
    const delivery = (deliveries.json() as Array<{ id: string; eventId: string; taskId: string | null }>)[0]!;
    expect(delivery.taskId).toBeNull();
    expect(JSON.stringify(deliveries.json())).not.toContain("payloadJson");

    db.prepare("UPDATE webhook_deliveries SET status = 'failed', attempt_count = 6 WHERE id = ?").run(delivery.id);
    const original = db.prepare("SELECT event_id, payload_json FROM webhook_deliveries WHERE id = ?").get(delivery.id);
    const retried = await app.inject({
      method: "POST",
      url: `/api/webhook-deliveries/${delivery.id}/retry`,
      headers: authHeaders
    });
    expect(retried.statusCode).toBe(202);
    expect(retried.json()).toMatchObject({ id: delivery.id, eventId: delivery.eventId, status: "pending", attemptCount: 0 });
    expect(db.prepare("SELECT event_id, payload_json FROM webhook_deliveries WHERE id = ?").get(delivery.id)).toEqual(original);

    const encryptedSigningSecret = persisted.encrypted_signing_secret;
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/integration-endpoints/${endpointId}/webhooks/${createdBody.webhook.id}`,
      headers: authHeaders,
      payload: { name: "Updated callback", headers: {}, timeoutSeconds: 20 }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      name: "Updated callback",
      headers: [],
      signingSecretConfigured: true,
      timeoutSeconds: 20
    });
    expect(updated.json()).not.toHaveProperty("signingSecret");
    expect((db.prepare("SELECT encrypted_signing_secret FROM webhook_subscriptions WHERE id = ?")
      .get(createdBody.webhook.id) as { encrypted_signing_secret: string }).encrypted_signing_secret)
      .toBe(encryptedSigningSecret);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/integration-endpoints/${endpointId}/webhooks/${createdBody.webhook.id}`,
      headers: authHeaders
    });
    expect(deleted.statusCode).toBe(204);
    expect(db.prepare("SELECT 1 FROM webhook_subscriptions WHERE id = ?").get(createdBody.webhook.id)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM webhook_deliveries WHERE subscription_id = ?").get(createdBody.webhook.id)).toBeUndefined();
  });

  it("拒绝非法 URL、timeout 和未知 event", async () => {
    const harness = createHarness();
    const app = buildApp({
      config: {
        host: "127.0.0.1", port: 3000, apiToken, dataDir: harness.root, databasePath: ":memory:",
        workspaceTemplate: "/unused/template", sessionsRoot: "/unused/sessions", maxConcurrentRuns: 1
      },
      db: harness.db,
      runtime: createFakeRuntime(),
      webhookFetch: vi.fn(async () => new Response(null, { status: 204 }))
    });
    await app.ready();
    const invalidBodies = [
      { name: "x", url: "file:///tmp/hook", enabled: true, events: ["task.succeeded"], headers: {}, timeoutSeconds: 10 },
      { name: "x", url: "https://receiver.test", enabled: true, events: ["task.succeeded"], headers: {}, timeoutSeconds: 61 },
      { name: "x", url: "https://receiver.test", enabled: true, events: ["unknown.event"], headers: {}, timeoutSeconds: 10 }
    ];
    for (const payload of invalidBodies) {
      const response = await app.inject({
        method: "POST",
        url: `/api/integration-endpoints/${harness.endpoint.id}/webhooks`,
        headers: authHeaders,
        payload
      });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
    harness.db.close();
  });
});
