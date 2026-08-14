// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";

const now = "2026-08-13T10:00:00.000Z";
const agent = {
  id: "agent-1", name: "主力 Codex", provider: "codex", enabled: true,
  projectEnvironmentId: "environment-1", createdAt: now, updatedAt: now
};
const endpoint = {
  id: "endpoint-1", name: "Grab Manager 工单", slug: "grab-manager-ticket", agentId: agent.id,
  enabled: true, promptPrefix: "处理工单：", parameterMappings: [{
    parameterKey: "ticket_id", source: "request", requestKey: "ticket_id"
  }], createdAt: now, updatedAt: now
};
const task = {
  id: "task-1", endpointId: endpoint.id, conversationId: "conversation-1", sessionId: "session-1",
  runId: "run-1", requestId: "ticket-event-123", message: "分析并处理这个工单", status: "succeeded",
  result: "问题已经修复，测试通过。", error: null, createdAt: now, startedAt: now, finishedAt: now
};
const conversation = {
  id: "conversation-1", endpointId: endpoint.id, conversationKey: "ticket-1332", sessionId: "session-1",
  status: "active", createdAt: now, endedAt: null
};
const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" }
});
const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
const webhook = {
  id: "webhook-1", endpointId: endpoint.id, name: "工单回调",
  url: "https://receiver.example.com/webhook", enabled: true,
  events: ["task.succeeded", "message.agent.reply"], headers: [], signingSecretConfigured: true,
  timeoutSeconds: 10, createdAt: now, updatedAt: now
};
const delivery = (status: "pending" | "delivering" | "succeeded" | "failed", overrides: Record<string, unknown> = {}) => ({
  id: "delivery-1", eventId: "event-1", sequence: 1, dispatchOrder: 1,
  subscriptionId: webhook.id, taskId: task.id, eventType: "task.succeeded", status,
  attemptCount: status === "pending" ? 0 : 1, nextAttemptAt: now,
  lastStatusCode: status === "succeeded" ? 204 : null,
  lastDurationMs: status === "succeeded" ? 35 : null,
  lastError: status === "failed" ? "Webhook request failed" : null,
  createdAt: now, updatedAt: now, ...overrides
});

beforeEach(() => {
  sessionStorage.setItem("apiToken", "management-token");
  window.history.replaceState({}, "", "/integration-endpoints");
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("创建 Endpoint、一次复制 Token、配置 Webhook 并查看 Task", async () => {
  const deliveries: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url === "/api/integration-endpoints" && method === "GET") return jsonResponse([]);
    if (url === "/api/agents" && method === "GET") return jsonResponse([agent]);
    if (url === `/api/agents/${agent.id}/session-parameters` && method === "GET") return jsonResponse([{
      id: "parameter-1", agentId: agent.id, key: "ticket_id", label: "工单 ID", description: null,
      required: true, secret: false, createdAt: now, updatedAt: now
    }]);
    if (url === "/api/integration-endpoints" && method === "POST") {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        name: endpoint.name, slug: endpoint.slug, agentId: agent.id,
        parameterMappings: [{ parameterKey: "ticket_id", source: "request", requestKey: "ticket_id" }]
      });
      return jsonResponse({ endpoint, token: "ras_one_time_token" }, 201);
    }
    if (url === `/api/integration-endpoints/${endpoint.id}` && method === "GET") return jsonResponse(endpoint);
    if (url === `/api/integration-endpoints/${endpoint.id}/conversations` && method === "GET") return jsonResponse([conversation]);
    if (url === `/api/integration-endpoints/${endpoint.id}/tasks` && method === "GET") return jsonResponse([task]);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhooks` && method === "GET") return jsonResponse([]);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhook-deliveries` && method === "GET") return jsonResponse(deliveries);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhooks` && method === "POST") {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        name: "工单回调", url: "https://receiver.example.com/webhook",
        events: ["task.succeeded", "message.agent.reply"]
      });
      return jsonResponse({
        webhook: {
          id: "webhook-1", endpointId: endpoint.id, name: "工单回调",
          url: "https://receiver.example.com/webhook", enabled: true,
          events: ["task.succeeded", "message.agent.reply"], headers: [], signingSecretConfigured: true,
          timeoutSeconds: 10, createdAt: now, updatedAt: now
        },
        signingSecret: "whsec_one_time_secret"
      }, 201);
    }
    if (url === `/api/integration-tasks/${task.id}` && method === "GET") return jsonResponse(task);
    if (url === `/api/runs/${task.runId}/events?afterSeq=0` && method === "GET") return jsonResponse([{
      id: "event-1", runId: task.runId, seq: 1, type: "message",
      contentJson: JSON.stringify({ stream: "output", text: task.result }), createdAt: now
    }]);
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  fireEvent.click(await screen.findByRole("link", { name: "新建接入端点" }));
  fireEvent.change(await screen.findByLabelText("端点名称"), { target: { value: endpoint.name } });
  fireEvent.change(screen.getByLabelText("端点 slug"), { target: { value: endpoint.slug } });
  fireEvent.change(screen.getByLabelText("Agent"), { target: { value: agent.id } });
  fireEvent.change(await screen.findByLabelText("工单 ID 来源"), { target: { value: "request" } });
  fireEvent.change(screen.getByLabelText("工单 ID 请求参数名"), { target: { value: "ticket_id" } });
  fireEvent.click(screen.getByRole("button", { name: "创建接入端点" }));

  expect(await screen.findByText("请立即保存，此 Token 不会再次显示")).toBeVisible();
  expect(screen.getByText("ras_one_time_token")).toBeVisible();
  expect(sessionStorage.getItem("integrationEndpointToken")).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: "Webhook" }));
  await waitFor(() => expect(window.location.pathname).toBe(`/integration-endpoints/${endpoint.id}/webhooks`));
  fireEvent.click(await screen.findByRole("button", { name: "新建 Webhook" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Webhook 名称"), { target: { value: "工单回调" } });
  fireEvent.change(within(dialog).getByLabelText("Webhook URL"), { target: { value: "https://receiver.example.com/webhook" } });
  fireEvent.click(within(dialog).getByLabelText("task.succeeded"));
  fireEvent.click(within(dialog).getByLabelText("message.agent.reply"));
  fireEvent.click(within(dialog).getByRole("button", { name: "创建 Webhook" }));

  expect(await screen.findByText("请立即保存签名密钥，此后不会再次显示")).toBeVisible();
  expect(screen.getByText("等待首次投递")).toBeVisible();

  fireEvent.click(screen.getByRole("tab", { name: "Task" }));
  fireEvent.click(await screen.findByRole("link", { name: "ticket-event-123" }));
  expect(await screen.findByRole("link", { name: "进入 Session" })).toHaveAttribute("href", "/sessions/session-1");
  expect(screen.getByText("问题已经修复，测试通过。")).toBeVisible();
  expect(screen.queryByText("ras_one_time_token")).not.toBeInTheDocument();
  expect(screen.queryByText("whsec_one_time_secret")).not.toBeInTheDocument();
});

it("详情页分区管理，并用确认对话框删除有历史的端点", async () => {
  window.history.replaceState({}, "", `/integration-endpoints/${endpoint.id}/settings`);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url === `/api/integration-endpoints/${endpoint.id}` && method === "GET") return jsonResponse(endpoint);
    if (url === "/api/agents" && method === "GET") return jsonResponse([agent]);
    if (url === `/api/integration-endpoints/${endpoint.id}` && method === "DELETE") {
      return jsonResponse({ error: { code: "endpoint_in_use", message: "Integration endpoint has history" } }, 409);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));

  render(<App />);
  expect(await screen.findByRole("tab", { name: "设置" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "删除接入端点" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
  expect(await screen.findByText("已有 Conversation 或 Task，请停用")).toBeVisible();
});

it("Webhook 测试投递异步完成后自动展示最终状态", async () => {
  vi.useFakeTimers();
  window.history.replaceState({}, "", `/integration-endpoints/${endpoint.id}/webhooks`);
  let deliveryReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url === `/api/integration-endpoints/${endpoint.id}`) return jsonResponse(endpoint);
    if (url === "/api/agents") return jsonResponse([agent]);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhooks`) return jsonResponse([webhook]);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhook-deliveries`) {
      deliveryReads += 1;
      if (deliveryReads === 1) return jsonResponse([]);
      return jsonResponse([delivery(deliveryReads === 2 ? "pending" : "succeeded")]);
    }
    if (url === `/api/integration-endpoints/${endpoint.id}/webhooks/${webhook.id}/test` && method === "POST") {
      return jsonResponse(delivery("pending"), 202);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));

  render(<App />);
  await act(flushPromises);
  fireEvent.click(screen.getByRole("button", { name: "发送测试" }));
  await act(flushPromises);
  expect(screen.getAllByText("等待投递").length).toBeGreaterThan(0);

  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

  expect(screen.getAllByText("成功").length).toBeGreaterThan(0);
  expect(screen.getAllByText("204").length).toBeGreaterThan(0);
  expect(screen.getByText(/35 ms · 尝试 1 次/)).toBeVisible();
  expect(deliveryReads).toBe(3);
});

it("离开 Webhook 页面会清理待投递短轮询", async () => {
  vi.useFakeTimers();
  window.history.replaceState({}, "", `/integration-endpoints/${endpoint.id}/webhooks`);
  let deliveryReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url === `/api/integration-endpoints/${endpoint.id}`) return jsonResponse(endpoint);
    if (url === "/api/agents") return jsonResponse([agent]);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhooks`) return jsonResponse([webhook]);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhook-deliveries`) {
      deliveryReads += 1;
      return jsonResponse([delivery("pending")]);
    }
    if (url === `/api/integration-endpoints/${endpoint.id}/webhooks/${webhook.id}/test` && method === "POST") {
      return jsonResponse(delivery("pending"), 202);
    }
    if (url === `/api/integration-endpoints/${endpoint.id}/tasks`) return jsonResponse([]);
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));

  render(<App />);
  await act(flushPromises);
  fireEvent.click(screen.getByRole("button", { name: "发送测试" }));
  await act(flushPromises);
  const readsBeforeNavigation = deliveryReads;
  fireEvent.click(screen.getByRole("tab", { name: "Task" }));
  await act(flushPromises);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

  expect(window.location.pathname).toBe(`/integration-endpoints/${endpoint.id}/tasks`);
  expect(deliveryReads).toBe(readsBeforeNavigation);
});

it("运行中的 Task 自动刷新完整详情并在终态后停止", async () => {
  vi.useFakeTimers();
  window.history.replaceState({}, "", `/integration-tasks/${task.id}`);
  const runningTask = { ...task, status: "running", result: null, finishedAt: null };
  let taskReads = 0;
  let eventReads = 0;
  let deliveryReads = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/integration-tasks/${task.id}`) {
      taskReads += 1;
      return jsonResponse(taskReads === 1 ? runningTask : task);
    }
    if (url === `/api/integration-endpoints/${endpoint.id}`) return jsonResponse(endpoint);
    if (url === `/api/integration-endpoints/${endpoint.id}/conversations`) return jsonResponse([conversation]);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhook-deliveries`) {
      deliveryReads += 1;
      return jsonResponse([delivery(deliveryReads === 1 ? "pending" : "succeeded")]);
    }
    if (url === `/api/runs/${task.runId}/events?afterSeq=0`) {
      eventReads += 1;
      return jsonResponse(eventReads === 1 ? [] : [{
        id: "event-final", runId: task.runId, seq: 2, type: "status",
        contentJson: JSON.stringify({ title: "最终状态已写入" }), createdAt: now
      }]);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  await act(flushPromises);
  expect(screen.getByText("运行中")).toBeVisible();

  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

  expect(screen.getByText("已完成")).toBeVisible();
  expect(screen.getByText("最终状态已写入")).toBeVisible();
  expect(screen.getAllByText("成功").length).toBeGreaterThan(0);
  const readsAtTerminal = { taskReads, eventReads, deliveryReads };
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect({ taskReads, eventReads, deliveryReads }).toEqual(readsAtTerminal);
});

it("取消 Task 后仍刷新到确定终态", async () => {
  vi.useFakeTimers();
  window.history.replaceState({}, "", `/integration-tasks/${task.id}`);
  const runningTask = { ...task, status: "running", result: null, finishedAt: null };
  const cancelledTask = { ...runningTask, status: "cancelled", finishedAt: now };
  let taskReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url === `/api/integration-tasks/${task.id}`) {
      taskReads += 1;
      return jsonResponse(taskReads === 1 ? runningTask : cancelledTask);
    }
    if (url === `/api/integration-tasks/${task.id}/cancel` && method === "POST") return jsonResponse(runningTask);
    if (url === `/api/integration-endpoints/${endpoint.id}`) return jsonResponse(endpoint);
    if (url === `/api/integration-endpoints/${endpoint.id}/conversations`) return jsonResponse([conversation]);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhook-deliveries`) return jsonResponse([]);
    if (url === `/api/runs/${task.runId}/events?afterSeq=0`) return jsonResponse([]);
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));

  render(<App />);
  await act(flushPromises);
  fireEvent.click(screen.getByRole("button", { name: "取消 Task" }));
  fireEvent.click(screen.getByRole("button", { name: "确认取消" }));
  await act(flushPromises);

  expect(screen.getByText("已取消")).toBeVisible();
});

it("Task 路由切换会清空旧详情、中止请求且忽略迟到响应", async () => {
  vi.useFakeTimers();
  const taskA = { ...task, id: "task-a", requestId: "request-a", status: "running", result: null, finishedAt: null };
  const taskB = { ...task, id: "task-b", requestId: "request-b" };
  window.history.replaceState({}, "", `/integration-tasks/${taskA.id}`);
  let taskAReads = 0;
  let pollSignal: AbortSignal | undefined;
  let resolveLateTask!: (response: Response) => void;
  const lateTask = new Promise<Response>((resolve) => { resolveLateTask = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/integration-tasks/${taskA.id}`) {
      taskAReads += 1;
      if (taskAReads === 1) return jsonResponse(taskA);
      pollSignal = init?.signal ?? undefined;
      return lateTask;
    }
    if (url === `/api/integration-tasks/${taskB.id}`) return jsonResponse(taskB);
    if (url === `/api/integration-endpoints/${endpoint.id}`) return jsonResponse(endpoint);
    if (url === `/api/integration-endpoints/${endpoint.id}/conversations`) return jsonResponse([conversation]);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhook-deliveries`) return jsonResponse([]);
    if (url.startsWith("/api/runs/")) return jsonResponse([]);
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<App />);
  await act(flushPromises);
  expect(screen.getByText("request-a")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(taskAReads).toBe(2);

  act(() => {
    window.history.pushState({}, "", `/integration-tasks/${taskB.id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await act(flushPromises);

  expect(pollSignal?.aborted).toBe(true);
  expect(screen.queryByText("request-a")).not.toBeInTheDocument();
  expect(screen.getByText("request-b")).toBeVisible();

  resolveLateTask(jsonResponse({ ...taskA, status: "succeeded", result: "stale result" }));
  await act(flushPromises);
  expect(screen.getByText("request-b")).toBeVisible();
  expect(screen.queryByText("stale result")).not.toBeInTheDocument();
});
