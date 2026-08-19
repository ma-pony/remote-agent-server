import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertReplyDeliveryOrder,
  assertIdempotentTask,
  createJsonClient,
  loadSmokeConfig,
  refreshFailureTrace,
  submitTask,
  verifyWebhookSignature,
  type ExternalTask,
  type JsonClient
} from "../scripts/smoke-integrations.js";

afterEach(() => vi.useRealTimers());

describe("integration smoke configuration", () => {
  it("requires base URL, management token and Agent ID", () => {
    expect(() => loadSmokeConfig({})).toThrow(/SMOKE_BASE_URL/);
    expect(() => loadSmokeConfig({ SMOKE_BASE_URL: "http://127.0.0.1:3000" })).toThrow(/SMOKE_API_TOKEN/);
    expect(() => loadSmokeConfig({
      SMOKE_BASE_URL: "http://127.0.0.1:3000",
      SMOKE_API_TOKEN: "management-token"
    })).toThrow(/SMOKE_AGENT_ID/);
  });

  it("normalizes the service root and uses bounded defaults", () => {
    expect(loadSmokeConfig({
      SMOKE_BASE_URL: "http://127.0.0.1:3000/api/",
      SMOKE_API_TOKEN: "management-token",
      SMOKE_AGENT_ID: "1"
    })).toMatchObject({
      baseUrl: "http://127.0.0.1:3000",
      apiToken: "management-token",
      agentId: 1,
      pollIntervalMs: 1_000,
      taskTimeoutMs: 300_000,
      requestTimeoutMs: 30_000
    });
  });

  it("rejects invalid URLs and non-positive deadlines", () => {
    const required = { SMOKE_API_TOKEN: "token", SMOKE_AGENT_ID: "1" };
    expect(() => loadSmokeConfig({ ...required, SMOKE_BASE_URL: "file:///tmp/server" })).toThrow(/HTTP/);
    expect(() => loadSmokeConfig({
      ...required,
      SMOKE_BASE_URL: "http://127.0.0.1:3000",
      SMOKE_REQUEST_TIMEOUT_MS: "0"
    })).toThrow(/positive integer/);
  });
});

describe("integration smoke HTTP helpers", () => {
  it("aborts response body reads at the request deadline without leaking the timer", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })
    }));
    const client = createJsonClient("http://127.0.0.1:3000", "token", 20, fetchMock);

    const pending = client.request("/api/health");
    const assertion = expect(pending).rejects.toThrow(/timed out after 20ms/);
    await vi.advanceTimersByTimeAsync(20);

    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("repeating requestId must return the same taskId and runId", async () => {
    const task: ExternalTask = {
      taskId: 1, requestId: "request-1", conversationKey: "conversation-1",
      sessionId: 1, runId: 1, status: "succeeded"
    };
    const client: JsonClient = { request: vi.fn(async () => task) };
    const request = {
      requestId: "request-1", conversationKey: "conversation-1", message: "smoke", parameters: {}
    };

    const first = await submitTask(client, "smoke-endpoint", request);
    const duplicate = await submitTask(client, "smoke-endpoint", request);

    expect(() => assertIdempotentTask(first, duplicate)).not.toThrow();
    expect(duplicate.taskId).toBe(first.taskId);
    expect(duplicate.runId).toBe(first.runId);
  });

  it("verifies the Webhook signature over timestamp and the unmodified body", () => {
    const body = JSON.stringify({ eventId: "event-1", message: "agent reply" });
    const timestamp = "1770000000";
    const secret = "whsec_test";
    const signature = `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

    expect(verifyWebhookSignature({ body, timestamp, signature }, secret)).toBe(true);
    expect(verifyWebhookSignature({ body: `${body} `, timestamp, signature }, secret)).toBe(false);
  });

  it("rejects reply deliveries that do not follow first, second and third Task order", () => {
    const deliveries = [
      {
        id: 2, eventId: "event-second", dispatchOrder: 10, taskId: 2,
        eventType: "message.agent.reply", status: "succeeded", attemptCount: 1
      },
      {
        id: 3, eventId: "event-third", dispatchOrder: 20, taskId: 3,
        eventType: "message.agent.reply", status: "succeeded", attemptCount: 1
      },
      {
        id: 1, eventId: "event-first", dispatchOrder: 30, taskId: 1,
        eventType: "message.agent.reply", status: "succeeded", attemptCount: 2
      }
    ] as const;

    expect(() => assertReplyDeliveryOrder(
      [1, 2, 3],
      [...deliveries],
      ["event-second", "event-third", "event-first"]
    )).toThrow(/Task submission order/);
  });

  it("rejects receiver requests whose event IDs do not follow the Delivery order", () => {
    const deliveries = [
      {
        id: 1, eventId: "event-first", dispatchOrder: 10, taskId: 1,
        eventType: "message.agent.reply", status: "succeeded", attemptCount: 2
      },
      {
        id: 2, eventId: "event-second", dispatchOrder: 20, taskId: 2,
        eventType: "message.agent.reply", status: "succeeded", attemptCount: 1
      },
      {
        id: 3, eventId: "event-third", dispatchOrder: 30, taskId: 3,
        eventType: "message.agent.reply", status: "succeeded", attemptCount: 1
      }
    ] as const;

    expect(() => assertReplyDeliveryOrder(
      [1, 2, 3],
      [...deliveries],
      ["event-first", "event-second", "event-first", "event-third"]
    )).toThrow(/receiver order/);
  });

  it("refreshes late Session, Run and Delivery IDs for known Tasks after a failure", async () => {
    const trace = {
      endpointId: 1,
      taskIds: [1],
      sessionIds: [1],
      runIds: [],
      deliveryIds: []
    };
    const client: JsonClient = {
      request: vi.fn(async (path: string) => {
        if (path === "/api/integration-tasks/1") {
          return {
            id: 1, sessionId: 1, runId: 2
          };
        }
        return [{ id: 1 }];
      }) as JsonClient["request"]
    };

    await refreshFailureTrace(client, trace);

    expect(trace).toMatchObject({
      taskIds: [1],
      sessionIds: [1],
      runIds: [2],
      deliveryIds: [1]
    });
  });
});
