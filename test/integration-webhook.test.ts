import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { EventStore } from "../src/events/event-store.js";
import { isCurrentWebhookPayload } from "../src/integrations/webhook-contract.js";
import { IntegrationEndpointManager } from "../src/integrations/integration-endpoint-manager.js";
import { IntegrationProjection } from "../src/integrations/integration-projection.js";
import { IntegrationStore, webhookEventId } from "../src/integrations/integration-store.js";
import { WebhookDispatcher } from "../src/integrations/webhook-dispatcher.js";
import { SecretStore } from "../src/mcp/secret-store.js";
import { RunRepository } from "../src/runs/run-repository.js";
import type { WorkspaceManager } from "../src/workspaces/workspace-manager.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const apiToken = "webhook-admin-token";
const authHeaders = { authorization: `Bearer ${apiToken}` };
const temporaryDirectories: string[] = [];
const apps: Array<{ app: FastifyInstance; db: ReturnType<typeof createTestDatabase>["db"]; root: string }> = [];
const httpServers: Server[] = [];

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const listenHttp = async (handler: Parameters<typeof createServer>[0]): Promise<string> => {
  const server = createServer(handler);
  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
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

  const createDelivery = (
    subscriptionId: string,
    sequence: number,
    eventType = "task.succeeded",
    occurredAt = new Date().toISOString(),
    eventId = `event-${subscriptionId}-${sequence}`
  ) => {
    const payloadJson = JSON.stringify({
      eventId,
      eventType,
      sequence,
      occurredAt,
      endpoint: { id: endpoint.id, slug: endpoint.slug },
      task: {
        id: `task-${subscriptionId}-${sequence}`,
        requestId: `request-${subscriptionId}-${sequence}`,
        conversationKey: null,
        sessionId: `session-${subscriptionId}-${sequence}`,
        runId: null,
        status: "succeeded"
      }
    });
    return store.createDelivery({
      eventId,
      eventKey: `${subscriptionId}:${eventId}:${eventType}`,
      sequence,
      subscriptionId,
      taskId: null,
      eventType,
      payloadJson,
      nextAttemptAt: occurredAt
    });
  };

  return { db, seed, root, secrets, store, endpoint, dispatcher, createSubscription, createDelivery };
};

afterEach(async () => {
  await Promise.all(httpServers.splice(0).map(async (server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
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
  it("发送前再次过滤数据库直写的受管 Header", async () => {
    const requests: Headers[] = [];
    const harness = createHarness(vi.fn(async (_url, init) => {
      requests.push(new Headers(init?.headers));
      return new Response(null, { status: 204 });
    }));
    const subscription = harness.createSubscription("defense-headers", "real-signing-secret");
    const injected = {
      "X-Allowed": "kept",
      Host: "attacker.test",
      "Content-Length": "999",
      "Transfer-Encoding": "chunked",
      Connection: "keep-alive",
      Forwarded: "host=attacker.test",
      Via: "attacker-proxy",
      "X-Forwarded-For": "127.0.0.1",
      "X-Forwarded-Host": "attacker.test",
      "X-Forwarded-Proto": "http",
      "X-ForwardedCustom": "attacker.test",
      "Proxy-Authorization": "secret-proxy-token",
      ProxyCustom: "secret-proxy-token",
      "X-Remote-Agent-Signature": "v1=forged"
    };
    harness.db.prepare("UPDATE webhook_subscriptions SET encrypted_headers = ? WHERE id = ?")
      .run(harness.secrets.encrypt(JSON.stringify(injected)), subscription.id);
    const delivery = harness.createDelivery(subscription.id, 1);

    await harness.dispatcher.deliver(delivery.id);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.get("x-allowed")).toBe("kept");
    for (const name of [
      "host", "content-length", "transfer-encoding", "connection", "forwarded", "via",
      "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwardedcustom",
      "proxy-authorization", "proxycustom"
    ]) expect(requests[0]!.has(name)).toBe(false);
    expect(requests[0]!.get("x-remote-agent-signature")).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(requests[0]!.get("x-remote-agent-signature")).not.toBe("v1=forged");
    harness.db.close();
  });

  it("拒绝投递数据库中的旧版或非公共 Payload", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const harness = createHarness(fetchImpl);
    const subscription = harness.createSubscription("invalid-payload", "secret");
    const delivery = harness.createDelivery(subscription.id, 1);
    const pollutedDelivery = harness.createDelivery(subscription.id, 2);
    harness.db.prepare("UPDATE webhook_deliveries SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify({
        id: "legacy-event",
        type: "task.succeeded",
        data: { rawOutput: "must-never-leak" }
      }), delivery.id);
    const pollutedPayload = JSON.parse(pollutedDelivery.payloadJson) as Record<string, unknown>;
    pollutedPayload.rawOutput = "must-never-leak";
    harness.db.prepare("UPDATE webhook_deliveries SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify(pollutedPayload), pollutedDelivery.id);

    await harness.dispatcher.deliver(delivery.id);
    await harness.dispatcher.deliver(pollutedDelivery.id);

    expect(fetchImpl).not.toHaveBeenCalled();
    for (const invalid of [delivery, pollutedDelivery]) {
      expect(harness.store.getDelivery(invalid.id)).toMatchObject({
        status: "failed",
        attemptCount: 1,
        lastStatusCode: null,
        lastError: "invalid_webhook_payload"
      });
      expect(harness.store.getDelivery(invalid.id)?.lastError).not.toContain("must-never-leak");
    }
    harness.db.close();
  });

  it("不跟随 302/307 redirect，避免向跳转目标泄露自定义 Header", async () => {
    const redirectedHeaders: Array<string | undefined> = [];
    const secondUrl = await listenHttp((request, response) => {
      redirectedHeaders.push(request.headers["x-api-key"]);
      response.writeHead(204).end();
    });
    const firstUrl = await listenHttp((request, response) => {
      response.writeHead(request.url === "/temporary" ? 307 : 302, { location: `${secondUrl}/received` }).end();
    });
    const harness = createHarness(globalThis.fetch);
    const createRedirectDelivery = (path: string) => {
      const subscription = harness.store.createSubscription({
        endpointId: harness.endpoint.id,
        name: path,
        url: `${firstUrl}/${path}`,
        enabled: true,
        eventsJson: JSON.stringify(["task.succeeded"]),
        encryptedHeaders: harness.secrets.encrypt(JSON.stringify({ "X-Api-Key": "must-not-leak" })),
        encryptedSigningSecret: harness.secrets.encrypt("redirect-secret"),
        timeoutSeconds: 10
      });
      return harness.createDelivery(subscription.id, 1);
    };
    const temporary = createRedirectDelivery("temporary");
    const found = createRedirectDelivery("found");

    await harness.dispatcher.deliver(temporary.id);
    await harness.dispatcher.deliver(found.id);

    expect(redirectedHeaders).toEqual([]);
    expect(harness.store.getDelivery(temporary.id)).toMatchObject({ status: "pending", lastStatusCode: 307 });
    expect(harness.store.getDelivery(found.id)).toMatchObject({ status: "pending", lastStatusCode: 302 });
    harness.db.close();
  });

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

  it("收到状态码后 best-effort cancel 响应流且不保存 Body", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("sensitive-infinite-body"));
      },
      cancel
    });
    const harness = createHarness(vi.fn(async () => new Response(body, { status: 200 })));
    const subscription = harness.createSubscription("stream", "secret");
    const delivery = harness.createDelivery(subscription.id, 1);

    await harness.dispatcher.deliver(delivery.id);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(harness.store.getDelivery(delivery.id)).toMatchObject({ status: "succeeded", lastStatusCode: 200 });
    expect(JSON.stringify(harness.store.getDelivery(delivery.id))).not.toContain("sensitive-infinite-body");
    harness.db.close();
  });

  it("响应流 cancel 失败不改变已取得的 2xx 判定", async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel: () => Promise.reject(new Error("sensitive cancel failure"))
    });
    const harness = createHarness(vi.fn(async () => new Response(body, { status: 202 })));
    const subscription = harness.createSubscription("cancel-failure", "secret");
    const delivery = harness.createDelivery(subscription.id, 1);

    await harness.dispatcher.deliver(delivery.id);

    expect(harness.store.getDelivery(delivery.id)).toMatchObject({
      status: "succeeded",
      lastStatusCode: 202,
      lastError: null
    });
    harness.db.close();
  });

  it("响应流 cancel 永不结束时仍在有界等待后完成投递", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>(() => undefined)
    });
    const harness = createHarness(vi.fn(async () => new Response(body, { status: 200 })));
    const subscription = harness.createSubscription("cancel-timeout", "secret");
    const delivery = harness.createDelivery(subscription.id, 1);
    let settled = false;

    const delivering = harness.dispatcher.deliver(delivery.id).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await delivering;

    expect(settled).toBe(true);
    expect(harness.store.getDelivery(delivery.id)).toMatchObject({ status: "succeeded", lastStatusCode: 200 });
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

  it("同毫秒且 eventId 哈希逆序时仍按首次创建的因果顺序投递", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    const started: string[] = [];
    const harness = createHarness(vi.fn(async (_url, init) => {
      started.push(new Headers(init?.headers).get("x-remote-agent-event-id")!);
      return new Response(null, { status: 204 });
    }));
    const subscription = harness.createSubscription("causal-tie", "secret");
    const occurredAt = "2026-08-13T00:00:00.000Z";
    const candidateA = webhookEventId(harness.endpoint.id, "causal-event-a");
    const candidateB = webhookEventId(harness.endpoint.id, "causal-event-b");
    const [firstEventId, secondEventId] = candidateA > candidateB
      ? [candidateA, candidateB]
      : [candidateB, candidateA];
    const first = harness.createDelivery(subscription.id, 1, "task.succeeded", occurredAt, firstEventId);
    const second = harness.createDelivery(subscription.id, 1, "task.succeeded", occurredAt, secondEventId);
    expect(first.eventId > second.eventId).toBe(true);

    harness.dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(started).toHaveLength(2));

    expect(started).toEqual([first.eventId, second.eventId]);
    expect(harness.db.prepare(`
      SELECT event_id, dispatch_order FROM webhook_deliveries
      WHERE subscription_id = ? ORDER BY dispatch_order
    `).all(subscription.id)).toEqual([
      { event_id: first.eventId, dispatch_order: 1 },
      { event_id: second.eventId, dispatch_order: 2 }
    ]);
    await harness.dispatcher.stop();
    harness.db.close();
  });

  it("系统时钟回拨不改变因果顺序，旧 head 重试仍只阻塞同订阅", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:10.000Z"));
    const started: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      started.push(new Headers(init?.headers).get("x-remote-agent-event-id")!);
      return new Response(null, { status: 204 });
    });
    const harness = createHarness(fetchImpl);
    const subscriptionA = harness.createSubscription("ordered-a", "secret-a");
    const subscriptionB = harness.createSubscription("ordered-b", "secret-b");
    const firstTask = harness.createDelivery(
      subscriptionA.id, 2, "task.succeeded", "2026-08-13T00:00:10.000Z"
    );
    vi.setSystemTime(new Date("2026-08-13T00:00:05.000Z"));
    const rollbackTask = harness.createDelivery(
      subscriptionA.id, 1, "task.succeeded", "2026-08-13T00:00:05.000Z"
    );
    const otherSubscription = harness.createDelivery(
      subscriptionB.id, 1, "task.succeeded", "2026-08-13T00:00:05.000Z"
    );
    harness.db.prepare("UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ?")
      .run("2026-08-13T00:00:20.000Z", firstTask.id);

    expect(harness.store.listDueDeliveries("2026-08-13T00:00:05.000Z").map(({ id }) => id))
      .toEqual([otherSubscription.id]);
    expect(harness.store.nextPendingDeliveryAt()).toBe("2026-08-13T00:00:05.000Z");
    expect(harness.store.claimDelivery(rollbackTask.id, "2026-08-13T00:00:15.000Z")).toBeUndefined();

    harness.dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(harness.store.getDelivery(otherSubscription.id)?.status).toBe("succeeded"));
    expect(started).toEqual([otherSubscription.eventId]);
    expect(started).not.toContain(rollbackTask.eventId);
    expect(harness.store.nextPendingDeliveryAt()).toBe("2026-08-13T00:00:20.000Z");

    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(started).toContain(firstTask.eventId));
    await vi.waitFor(() => expect(started).toContain(rollbackTask.eventId));
    expect(harness.store.nextPendingDeliveryAt()).toBeUndefined();
    expect(started.indexOf(firstTask.eventId)).toBeLessThan(started.indexOf(rollbackTask.eventId));

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

  it("公共 Payload 使用固定契约且每类事件只附加一个白名单对象", () => {
    const harness = createHarness();
    const subscription = harness.store.createSubscription({
      endpointId: harness.endpoint.id,
      name: "public-payload",
      url: "https://receiver.test/public",
      enabled: true,
      eventsJson: JSON.stringify(["tool.completed", "task.succeeded", "message.agent.reply"]),
      encryptedHeaders: null,
      encryptedSigningSecret: harness.secrets.encrypt("payload-secret"),
      timeoutSeconds: 10
    });
    let eventStore!: EventStore;
    const projection = new IntegrationProjection({
      db: harness.db,
      store: harness.store,
      listEvents: (runId) => eventStore.list(runId, 0)
    });
    const runRepository = new RunRepository({ db: harness.db, projection });
    eventStore = new EventStore({ db: harness.db, projection });
    const session = harness.seed.session();
    const conversation = harness.store.createConversation({
      endpointId: harness.endpoint.id,
      conversationKey: "ticket-1332",
      sessionId: session.id
    });
    const task = harness.store.createTask({
      endpointId: harness.endpoint.id,
      conversationId: conversation.id,
      sessionId: session.id,
      requestId: "payload-request",
      requestFingerprint: "payload-fingerprint",
      message: "secret-user-input",
      effectivePrompt: "secret-effective-prompt",
      encryptedParameters: harness.secrets.encrypt(JSON.stringify({ api_token: "secret-mcp-token" }))
    });
    const run = runRepository.create(
      { sessionId: session.id, input: task.effectivePrompt },
      { afterInsert: (created) => { harness.store.linkTaskRunInTransaction(task.id, created.id); return undefined; } }
    );
    runRepository.markRunning(run.id);
    const toolEvent = eventStore.append(run.id, "tool", {
      toolCallId: "tool-public",
      status: "completed",
      title: "Read provider-title-secret",
      kind: "read",
      locations: [{ path: "/workspace/provider-path-secret.md", line: 3, token: "location-secret" }],
      rawInput: "raw-input-secret",
      rawOutput: "raw-output-secret",
      content: "provider-content-secret"
    });
    eventStore.append(run.id, "message", { stream: "output", text: "Agent final answer" });
    const finished = runRepository.finish(run.id, { status: "succeeded", result: "internal-result" });

    const payloads = Object.fromEntries(harness.store.listDeliveries(subscription.id).map((delivery) => [
      delivery.eventType,
      JSON.parse(delivery.payloadJson) as Record<string, unknown>
    ]));
    const baseKeys = ["endpoint", "eventId", "eventType", "occurredAt", "sequence", "task"];
    expect(Object.keys(payloads["task.succeeded"]!).sort()).toEqual(baseKeys);
    expect(Object.keys(payloads["message.agent.reply"]!).sort()).toEqual([...baseKeys, "message"].sort());
    expect(Object.keys(payloads["tool.completed"]!).sort()).toEqual([...baseKeys, "tool"].sort());
    expect(payloads["task.succeeded"]).toMatchObject({
      eventType: "task.succeeded",
      occurredAt: finished.finishedAt,
      endpoint: { id: harness.endpoint.id, slug: harness.endpoint.slug },
      task: {
        id: task.id,
        requestId: task.requestId,
        conversationKey: "ticket-1332",
        sessionId: session.id,
        runId: run.id,
        status: "succeeded"
      }
    });
    expect(payloads["message.agent.reply"]!.message).toEqual({
      role: "agent",
      content: "Agent final answer",
      runStatus: "succeeded"
    });
    expect(payloads["tool.completed"]!.tool).toEqual({
      toolCallId: "tool-public",
      kind: "read",
      status: "completed"
    });
    expect(payloads["tool.completed"]!.occurredAt).toBe(toolEvent.createdAt);
    expect(payloads["message.agent.reply"]!.occurredAt).toBe(finished.finishedAt);
    const serialized = JSON.stringify(payloads);
    for (const secret of [
      "secret-user-input", "secret-effective-prompt", "secret-mcp-token", "location-secret",
      "raw-input-secret", "raw-output-secret", "provider-content-secret", "internal-result",
      "provider-title-secret", "provider-path-secret"
    ]) expect(serialized).not.toContain(secret);
    harness.db.close();
  });

  it("所有公共事件 exact-key union 保留源 occurredAt 且 createdAt 使用写入审计时间", () => {
    vi.useFakeTimers();
    const auditTime = "2026-08-14T00:00:00.000Z";
    vi.setSystemTime(new Date(auditTime));
    const harness = createHarness();
    const eventTypes = [
      "task.started", "task.failed", "task.cancelled", "message.user.received",
      "message.system.notice", "tool.started", "tool.failed"
    ];
    const subscription = harness.store.createSubscription({
      endpointId: harness.endpoint.id,
      name: "public-union",
      url: "https://receiver.test/public-union",
      enabled: true,
      eventsJson: JSON.stringify(eventTypes),
      encryptedHeaders: null,
      encryptedSigningSecret: harness.secrets.encrypt("public-union-secret"),
      timeoutSeconds: 10
    });
    const mirrorSubscription = harness.store.createSubscription({
      endpointId: harness.endpoint.id,
      name: "public-union-mirror",
      url: "https://receiver.test/public-union-mirror",
      enabled: true,
      eventsJson: JSON.stringify(eventTypes),
      encryptedHeaders: null,
      encryptedSigningSecret: harness.secrets.encrypt("public-union-mirror-secret"),
      timeoutSeconds: 10
    });
    const session = harness.seed.session();
    const task = harness.store.createTask({
      endpointId: harness.endpoint.id,
      conversationId: null,
      sessionId: session.id,
      requestId: "public-union-request",
      requestFingerprint: "public-union-fingerprint",
      message: "internal-input",
      effectivePrompt: "internal-prompt",
      encryptedParameters: null
    });
    const rawSecret = "raw-contract-secret";
    const cases = [
      { eventType: "task.started", payload: { status: "running", rawError: rawSecret } },
      { eventType: "task.failed", payload: { status: "failed", error: rawSecret } },
      { eventType: "task.cancelled", payload: { status: "cancelled", rawError: rawSecret } },
      { eventType: "message.user.received", payload: { message: "public user message", rawInput: rawSecret } },
      {
        eventType: "message.system.notice",
        payload: { code: "public_notice", message: "Public notice", rawError: rawSecret }
      },
      {
        eventType: "tool.started",
        payload: {
          toolCallId: "tool-started",
          title: `Read ${rawSecret}`,
          kind: "read",
          status: "started",
          locations: [{ path: `/workspace/${rawSecret}.ts`, line: 2, token: rawSecret }],
          rawInput: rawSecret
        }
      },
      {
        eventType: "tool.failed",
        payload: { toolCallId: "tool-failed", status: "failed", rawOutput: rawSecret }
      }
    ];
    const sourceTimes = Object.fromEntries(cases.map((item, index) => {
      const occurredAt = `2026-08-13T00:00:0${index + 1}.000Z`;
      harness.store.appendTaskEventInTransaction({
        taskId: task.id,
        eventType: item.eventType,
        eventKey: `${task.id}:${item.eventType}`,
        occurredAt,
        payload: item.payload
      });
      return [item.eventType, occurredAt];
    }));

    const deliveries = Object.fromEntries(harness.store.listDeliveries(subscription.id).map((delivery) => [
      delivery.eventType,
      { delivery, payload: JSON.parse(delivery.payloadJson) as Record<string, unknown> }
    ]));
    expect(harness.store.listDeliveries(subscription.id).map(({ dispatchOrder }) => dispatchOrder))
      .toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(harness.store.listDeliveries(mirrorSubscription.id).map(({ dispatchOrder }) => dispatchOrder))
      .toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(harness.db.prepare("SELECT next_delivery_order FROM integration_endpoints WHERE id = ?")
      .get(harness.endpoint.id)).toEqual({ next_delivery_order: 7 });
    const baseKeys = ["endpoint", "eventId", "eventType", "occurredAt", "sequence", "task"];
    for (const eventType of ["task.started", "task.failed", "task.cancelled"]) {
      expect(Object.keys(deliveries[eventType]!.payload).sort()).toEqual(baseKeys);
    }
    expect(Object.keys(deliveries["message.user.received"]!.payload).sort())
      .toEqual([...baseKeys, "message"].sort());
    expect(Object.keys(deliveries["message.system.notice"]!.payload).sort())
      .toEqual([...baseKeys, "notice"].sort());
    for (const eventType of ["tool.started", "tool.failed"]) {
      expect(Object.keys(deliveries[eventType]!.payload).sort()).toEqual([...baseKeys, "tool"].sort());
    }
    expect(deliveries["message.user.received"]!.payload.message).toEqual({
      role: "user", content: "public user message", runStatus: "queued"
    });
    expect(deliveries["message.system.notice"]!.payload.notice).toEqual({
      code: "public_notice", message: "Public notice"
    });
    expect(deliveries["tool.started"]!.payload.tool).toEqual({
      toolCallId: "tool-started",
      kind: "read",
      status: "started"
    });
    expect(deliveries["tool.failed"]!.payload.tool).toEqual({
      toolCallId: "tool-failed", status: "failed"
    });
    for (const eventType of eventTypes) {
      expect(deliveries[eventType]!.delivery.createdAt).toBe(auditTime);
      expect(deliveries[eventType]!.payload.occurredAt).toBe(sourceTimes[eventType]);
      expect(isCurrentWebhookPayload(deliveries[eventType]!.delivery.payloadJson, {
        eventId: deliveries[eventType]!.delivery.eventId,
        eventType,
        sequence: deliveries[eventType]!.delivery.sequence,
        endpointId: harness.endpoint.id
      })).toBe(true);
      expect(Object.keys(deliveries[eventType]!.payload.task as Record<string, unknown>).sort()).toEqual([
        "conversationKey", "id", "requestId", "runId", "sessionId", "status"
      ]);
    }
    expect(JSON.stringify(deliveries)).not.toContain(rawSecret);
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
    const originalProjected = Object.fromEntries(harness.store.listDeliveries(subscription.id)
      .filter(({ eventType }) => ["task.succeeded", "message.agent.reply", "tool.completed"].includes(eventType))
      .map((delivery) => [delivery.eventType, {
        eventId: delivery.eventId,
        eventKey: delivery.eventKey,
        sequence: delivery.sequence,
        payloadJson: delivery.payloadJson
      }]));
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
      `${task.id}:tool:tool-recover:completed`
    )).toBeDefined();
    const recoveredProjected = Object.fromEntries(harness.store.listDeliveries(subscription.id)
      .filter(({ eventType }) => ["task.succeeded", "message.agent.reply", "tool.completed"].includes(eventType))
      .map((delivery) => [delivery.eventType, {
        eventId: delivery.eventId,
        eventKey: delivery.eventKey,
        sequence: delivery.sequence,
        payloadJson: delivery.payloadJson
      }]));
    expect(recoveredProjected).toEqual(originalProjected);
    expect(harness.store.listDeliveries(subscription.id).find(({ eventType }) => eventType === "task.started"))
      .toMatchObject({ status: "pending" });
    expect(JSON.stringify(harness.store.listDeliveries(subscription.id))).not.toContain("must-not-leak");
    const snapshot = {
      deliveries: harness.db.prepare(`
        SELECT event_id, event_key, sequence, payload_json, status, attempt_count, next_attempt_at
        FROM webhook_deliveries WHERE subscription_id = ? ORDER BY rowid
      `).all(subscription.id),
      task: harness.db.prepare(`
        SELECT event_sequence, event_sequences_json FROM integration_tasks WHERE id = ?
      `).get(task.id)
    };
    projection.recover();
    expect({
      deliveries: harness.db.prepare(`
        SELECT event_id, event_key, sequence, payload_json, status, attempt_count, next_attempt_at
        FROM webhook_deliveries WHERE subscription_id = ? ORDER BY rowid
      `).all(subscription.id),
      task: harness.db.prepare(`
        SELECT event_sequence, event_sequences_json FROM integration_tasks WHERE id = ?
      `).get(task.id)
    }).toEqual(snapshot);
    harness.db.close();
  });

  it("恢复乱序写入后复用全局因果顺序并以新的审计时间投递", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    const received: string[] = [];
    const harness = createHarness(vi.fn(async (_url, init) => {
      received.push(new Headers(init?.headers).get("x-remote-agent-event")!);
      return new Response(null, { status: 204 });
    }));
    const subscription = harness.store.createSubscription({
      endpointId: harness.endpoint.id,
      name: "recovery-source-order",
      url: "https://receiver.test/recovery-source-order",
      enabled: true,
      eventsJson: JSON.stringify(["tool.completed", "task.succeeded", "message.agent.reply"]),
      encryptedHeaders: null,
      encryptedSigningSecret: harness.secrets.encrypt("source-order-secret"),
      timeoutSeconds: 10
    });
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
      requestId: "recovery-source-order",
      requestFingerprint: "recovery-source-order-fingerprint",
      message: "source order",
      effectivePrompt: "source order",
      encryptedParameters: null
    });
    const run = runRepository.create(
      { sessionId: session.id, input: "source order" },
      { afterInsert: (created) => { harness.store.linkTaskRunInTransaction(task.id, created.id); return undefined; } }
    );
    runRepository.markRunning(run.id);
    vi.setSystemTime(new Date("2026-08-13T00:00:03.000Z"));
    eventStore.append(run.id, "tool", { toolCallId: "tool-source-order", status: "completed", rawOutput: "hidden" });
    vi.setSystemTime(new Date("2026-08-13T00:00:04.000Z"));
    eventStore.append(run.id, "message", { stream: "output", text: "finished" });
    vi.setSystemTime(new Date("2026-08-13T00:00:05.000Z"));
    runRepository.finish(run.id, { status: "succeeded", result: "internal" });
    const originalOrders = harness.db.prepare(`
      SELECT event_type, dispatch_order FROM webhook_deliveries
      WHERE subscription_id = ? ORDER BY dispatch_order
    `).all(subscription.id);
    const originalTaskOrderState = harness.db.prepare(`
      SELECT event_dispatch_orders_json FROM integration_tasks WHERE id = ?
    `).get(task.id);
    const originalEndpointCounter = harness.db.prepare(`
      SELECT next_delivery_order FROM integration_endpoints WHERE id = ?
    `).get(harness.endpoint.id);
    harness.db.prepare(`
      DELETE FROM webhook_deliveries
      WHERE subscription_id = ? AND event_type IN ('tool.completed', 'task.succeeded', 'message.agent.reply')
    `).run(subscription.id);

    vi.setSystemTime(new Date("2026-08-13T00:00:10.000Z"));
    projection.recover();
    const firstRecovery = harness.db.prepare(`
      SELECT event_id, event_key, sequence, dispatch_order, payload_json, created_at
      FROM webhook_deliveries WHERE subscription_id = ? ORDER BY rowid
    `).all(subscription.id);
    expect(firstRecovery.map((row) => (row as { sequence: number }).sequence)).toEqual([4, 5, 3]);
    expect(firstRecovery.map((row) => (row as { dispatch_order: number }).dispatch_order)).toEqual([4, 5, 3]);
    expect(firstRecovery.map((row) => (row as { created_at: string }).created_at))
      .toEqual(Array(3).fill("2026-08-13T00:00:10.000Z"));
    expect(firstRecovery.map((row) => JSON.parse((row as { payload_json: string }).payload_json).occurredAt))
      .toEqual(["2026-08-13T00:00:05.000Z", "2026-08-13T00:00:05.000Z", "2026-08-13T00:00:03.000Z"]);
    expect(harness.db.prepare(`
      SELECT event_type, dispatch_order FROM webhook_deliveries
      WHERE subscription_id = ? ORDER BY dispatch_order
    `).all(subscription.id)).toEqual(originalOrders);
    expect(harness.db.prepare(`
      SELECT event_dispatch_orders_json FROM integration_tasks WHERE id = ?
    `).get(task.id)).toEqual(originalTaskOrderState);
    expect(harness.db.prepare(`
      SELECT next_delivery_order FROM integration_endpoints WHERE id = ?
    `).get(harness.endpoint.id)).toEqual(originalEndpointCounter);
    projection.recover();
    expect(harness.db.prepare(`
      SELECT event_id, event_key, sequence, dispatch_order, payload_json, created_at
      FROM webhook_deliveries WHERE subscription_id = ? ORDER BY rowid
    `).all(subscription.id)).toEqual(firstRecovery);

    harness.dispatcher.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(received).toHaveLength(3));

    expect(received).toEqual(["tool.completed", "task.succeeded", "message.agent.reply"]);
    await harness.dispatcher.stop();
    harness.db.close();
  });

  it("terminal Run 没有 output 时重复恢复不会创建 reply 或推进 sequence", () => {
    const harness = createHarness();
    const subscription = harness.store.createSubscription({
      endpointId: harness.endpoint.id,
      name: "no-output",
      url: "https://receiver.test/no-output",
      enabled: true,
      eventsJson: JSON.stringify(["task.succeeded", "message.agent.reply"]),
      encryptedHeaders: null,
      encryptedSigningSecret: harness.secrets.encrypt("no-output-secret"),
      timeoutSeconds: 10
    });
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
      requestId: "no-output-request",
      requestFingerprint: "no-output-fingerprint",
      message: "no output",
      effectivePrompt: "no output",
      encryptedParameters: null
    });
    const run = runRepository.create(
      { sessionId: session.id, input: "no output" },
      { afterInsert: (created) => { harness.store.linkTaskRunInTransaction(task.id, created.id); return undefined; } }
    );
    runRepository.markRunning(run.id);
    runRepository.finish(run.id, { status: "succeeded", result: "" });
    const before = harness.db.prepare(`
      SELECT event_sequence, event_sequences_json FROM integration_tasks WHERE id = ?
    `).get(task.id);

    projection.recover();
    projection.recover();

    expect(harness.store.listDeliveries(subscription.id).some(({ eventType }) => eventType === "message.agent.reply"))
      .toBe(false);
    expect(harness.db.prepare(`
      SELECT event_sequence, event_sequences_json FROM integration_tasks WHERE id = ?
    `).get(task.id)).toEqual(before);
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
        projectEnvironmentsRoot: "/unused/environments",
        sessionsRoot: "/unused/sessions",
        maxConcurrentRuns: 1,
        projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000,
        projectPrepareTimeoutMs: 30 * 60 * 1000
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
        name: "Example callback",
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
    const testPayload = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(Object.keys(testPayload).sort()).toEqual([
      "endpoint", "eventId", "eventType", "notice", "occurredAt", "sequence", "task"
    ]);
    expect(testPayload).toMatchObject({
      eventType: "webhook.test",
      endpoint: { id: endpointId, slug: "webhook-api" },
      task: null,
      notice: { code: "webhook_test", message: "Webhook test" }
    });
    expect(JSON.stringify(testPayload)).not.toContain(createdBody.signingSecret);
    expect(JSON.stringify(testPayload)).not.toContain("callback-secret");
    const deliveries = await app.inject({
      method: "GET",
      url: `/api/integration-endpoints/${endpointId}/webhook-deliveries`,
      headers: authHeaders
    });
    const delivery = (deliveries.json() as Array<{ id: string; eventId: string; taskId: string | null }>)[0]!;
    expect(delivery.taskId).toBeNull();
    expect(JSON.stringify(deliveries.json())).not.toContain("payloadJson");

    const auditStore = new IntegrationStore({ db });
    const auditEventId = "audit-created-at-event";
    const oldOccurredAt = "2020-01-01T00:00:00.000Z";
    const beforeAuditInsert = Date.now();
    const auditDelivery = auditStore.createDelivery({
      eventId: auditEventId,
      eventKey: "audit-created-at-event-key",
      sequence: 1,
      subscriptionId: createdBody.webhook.id,
      taskId: null,
      eventType: "task.succeeded",
      payloadJson: JSON.stringify({
        eventId: auditEventId,
        eventType: "task.succeeded",
        sequence: 1,
        occurredAt: oldOccurredAt,
        endpoint: { id: endpointId, slug: "webhook-api" },
        task: {
          id: "audit-task",
          requestId: "audit-request",
          conversationKey: null,
          sessionId: "audit-session",
          runId: null,
          status: "succeeded"
        }
      }),
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString()
    });
    const afterAuditInsert = Date.now();
    const deliveriesAfterAudit = await app.inject({
      method: "GET",
      url: `/api/integration-endpoints/${endpointId}/webhook-deliveries`,
      headers: authHeaders
    });
    const publicAuditDelivery = (deliveriesAfterAudit.json() as Array<Record<string, unknown>>)
      .find((item) => item.id === auditDelivery.id)!;
    expect(Date.parse(publicAuditDelivery.createdAt as string)).toBeGreaterThanOrEqual(beforeAuditInsert);
    expect(Date.parse(publicAuditDelivery.createdAt as string)).toBeLessThanOrEqual(afterAuditInsert);
    expect(publicAuditDelivery.createdAt).not.toBe(oldOccurredAt);
    expect(publicAuditDelivery.dispatchOrder).toEqual(expect.any(Number));

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
        projectEnvironmentsRoot: "/unused/environments", sessionsRoot: "/unused/sessions", maxConcurrentRuns: 1,
        projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000, projectPrepareTimeoutMs: 30 * 60 * 1000
      },
      db: harness.db,
      runtime: createFakeRuntime(),
      webhookFetch: vi.fn(async () => new Response(null, { status: 204 }))
    });
    await app.ready();
    const invalidBodies = [
      { name: "x", url: "file:///tmp/hook", enabled: true, events: ["task.succeeded"], headers: {}, timeoutSeconds: 10 },
      { name: "x", url: "https://user:password@receiver.test", enabled: true, events: ["task.succeeded"], headers: {}, timeoutSeconds: 10 },
      { name: "x", url: "https://receiver.test", enabled: true, events: ["task.succeeded"], headers: {}, timeoutSeconds: 61 },
      { name: "x", url: "https://receiver.test", enabled: true, events: ["unknown.event"], headers: {}, timeoutSeconds: 10 },
      ...[
        "Host", "Content-Length", "Transfer-Encoding", "Connection", "Proxy-Authorization",
        "Expect", "Forwarded", "Via", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"
      ].map((name) => ({
        name: "x",
        url: "https://receiver.test",
        enabled: true,
        events: ["task.succeeded"],
        headers: { [name]: "forged" },
        timeoutSeconds: 10
      }))
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
