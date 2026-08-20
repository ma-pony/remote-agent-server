// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";

const now = "2026-08-13T10:00:00.000Z";
const agent = {
  id: 1, name: "主力 Codex", provider: "codex", enabled: true,
  projectEnvironmentId: 1, createdAt: now, updatedAt: now
};
const endpoint = {
  id: 1, name: "示例工单", slug: "example-ticket", agentId: agent.id,
  enabled: true, promptPrefix: "处理工单：", parameterMappings: [{
    parameterKey: "ticket_id", source: "request", requestKey: "ticket_id"
  }], createdAt: now, updatedAt: now
};
const task = {
  id: 1, endpointId: endpoint.id, conversationId: 1, sessionId: 1,
  runId: 1, requestId: "ticket-event-123", message: "分析并处理这个工单", status: "succeeded",
  result: "问题已经修复，测试通过。", error: null, createdAt: now, startedAt: now, finishedAt: now
};
const conversation = {
  id: 1, endpointId: endpoint.id, conversationKey: "ticket-1332", sessionId: 1,
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
  id: 1, endpointId: endpoint.id, name: "工单回调",
  url: "https://receiver.example.com/webhook", enabled: true,
  events: ["task.succeeded", "message.agent.reply"], headers: [], signingSecretConfigured: true,
  timeoutSeconds: 10, createdAt: now, updatedAt: now
};
const delivery = (status: "pending" | "delivering" | "succeeded" | "failed", overrides: Record<string, unknown> = {}) => ({
  id: 1, eventId: "event-1", sequence: 1, dispatchOrder: 1,
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
      id: 1, agentId: agent.id, key: "ticket_id", label: "工单 ID", description: null,
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
          id: 1, endpointId: endpoint.id, name: "工单回调",
          url: "https://receiver.example.com/webhook", enabled: true,
          events: ["task.succeeded", "message.agent.reply"], headers: [], signingSecretConfigured: true,
          timeoutSeconds: 10, createdAt: now, updatedAt: now
        },
        signingSecret: "whsec_one_time_secret"
      }, 201);
    }
    if (url === `/api/integration-tasks/${task.id}` && method === "GET") return jsonResponse(task);
    if (url === `/api/runs/${task.runId}/events?afterSeq=0` && method === "GET") return jsonResponse([{
      id: 1, runId: task.runId, seq: 1, type: "message",
      contentJson: JSON.stringify({ stream: "output", text: task.result }), createdAt: now
    }]);
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  fireEvent.click(await screen.findByRole("link", { name: "新建接入端点" }));
  fireEvent.change(await screen.findByLabelText("端点名称"), { target: { value: endpoint.name } });
  const slugInput = screen.getByLabelText("路径标识");
  expect(slugInput).toHaveValue("");
  expect(slugInput).not.toHaveAttribute("placeholder");
  fireEvent.change(slugInput, { target: { value: endpoint.slug } });
  fireEvent.change(screen.getByLabelText("智能体"), { target: { value: String(agent.id) } });
  fireEvent.change(await screen.findByLabelText("工单 ID 来源"), { target: { value: "request" } });
  fireEvent.change(screen.getByLabelText("工单 ID 请求参数名"), { target: { value: "ticket_id" } });
  fireEvent.click(screen.getByRole("button", { name: "创建接入端点" }));

  expect(await screen.findByText("请立即保存，此访问令牌不会再次显示")).toBeVisible();
  expect(screen.getByText("ras_one_time_token")).toBeVisible();
  expect(sessionStorage.getItem("integrationEndpointToken")).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: "事件回调" }));
  await waitFor(() => expect(window.location.pathname).toBe(`/integration-endpoints/${endpoint.id}/webhooks`));
  fireEvent.click(await screen.findByRole("button", { name: "新建事件回调" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("回调名称"), { target: { value: "工单回调" } });
  fireEvent.change(within(dialog).getByLabelText("回调地址"), { target: { value: "https://receiver.example.com/webhook" } });
  fireEvent.click(within(dialog).getByLabelText("task.succeeded"));
  fireEvent.click(within(dialog).getByLabelText("message.agent.reply"));
  fireEvent.click(within(dialog).getByRole("button", { name: "创建事件回调" }));

  expect(await screen.findByText("请立即保存签名密钥，此后不会再次显示")).toBeVisible();
  expect(screen.getByText("等待首次投递")).toBeVisible();

  fireEvent.click(screen.getByRole("tab", { name: "任务" }));
  fireEvent.click(await screen.findByRole("link", { name: "ticket-event-123" }));
  expect(await screen.findByRole("link", { name: "进入智能体会话" })).toHaveAttribute("href", "/sessions/1");
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
  expect(screen.queryByLabelText("回调地址")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "删除接入端点" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
  expect(await screen.findByText("已有业务对话或任务，请停用")).toBeVisible();
});

it("调用说明展示动态参数和安全示例，并可发送真实测试任务", async () => {
  const documentedEndpoint = {
    ...endpoint,
    parameterMappings: [
      { parameterKey: "project_code", source: "request", requestKey: "project" },
      { parameterKey: "private_token", source: "fixed", configured: true }
    ]
  };
  const parameters = [
    {
      id: 1, agentId: agent.id, key: "project_code", label: "项目编号",
      description: "外部系统中的项目编号", required: true, secret: false, createdAt: now, updatedAt: now
    },
    {
      id: 2, agentId: agent.id, key: "private_token", label: "内部访问令牌",
      description: "由管理员预先配置", required: true, secret: true, createdAt: now, updatedAt: now
    }
  ];
  const testTask = {
    ...task,
    id: 2, requestId: "test-generated", conversationId: 2,
    sessionId: 2, runId: null, message: "检查项目当前状态", status: "queued",
    result: null, startedAt: null, finishedAt: null
  };
  window.history.replaceState({}, "", `/integration-endpoints/${endpoint.id}/usage`);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url === `/api/integration-endpoints/${endpoint.id}` && method === "GET") return jsonResponse(documentedEndpoint);
    if (url === "/api/agents" && method === "GET") return jsonResponse([agent]);
    if (url === `/api/agents/${agent.id}/session-parameters` && method === "GET") return jsonResponse(parameters);
    if (url === `/api/integration-endpoints/${endpoint.id}/test-tasks` && method === "POST") {
      expect(JSON.parse(String(init?.body))).toEqual({
        conversationKey: "project-42",
        message: "检查项目当前状态",
        parameters: { project: "P-42" }
      });
      return jsonResponse(testTask, 202);
    }
    if (url === `/api/integration-tasks/${testTask.id}` && method === "GET") return jsonResponse(testTask);
    if (url === `/api/integration-endpoints/${endpoint.id}/conversations` && method === "GET") return jsonResponse([]);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhook-deliveries` && method === "GET") return jsonResponse([]);
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));

  render(<App />);

  expect(await screen.findByRole("tab", { name: "调用说明" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "业务对话" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "任务" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "事件回调" })).toBeVisible();
  expect((await screen.findAllByText("外部系统中的项目编号")).length).toBeGreaterThan(0);
  expect(screen.getByText("内部访问令牌")).toBeVisible();
  expect(screen.getByText("由系统配置，请求中不要传入")).toBeVisible();
  expect(screen.getAllByText(/Authorization: Bearer <接入端点访问令牌>/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/POST \/integration\/v1\/endpoints\/example-ticket\/tasks/).length).toBeGreaterThan(0);
  expect(document.body.textContent).not.toContain("private-callback-token");

  fireEvent.change(screen.getByLabelText("测试消息"), { target: { value: "检查项目当前状态" } });
  fireEvent.change(screen.getByLabelText("对话标识（可选）"), { target: { value: "project-42" } });
  fireEvent.change(screen.getByLabelText("项目编号"), { target: { value: "P-42" } });
  fireEvent.click(screen.getByRole("button", { name: "发送测试任务" }));

  await waitFor(() => expect(window.location.pathname).toBe(`/integration-tasks/${testTask.id}`));
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

it("编辑事件回调并保留未重新填写的敏感请求头", async () => {
  window.history.replaceState({}, "", `/integration-endpoints/${endpoint.id}/webhooks`);
  const configuredWebhook = {
    ...webhook,
    headers: [{ name: "Authorization", configured: true as const }]
  };
  let updateBody: unknown;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url === `/api/integration-endpoints/${endpoint.id}`) return jsonResponse(endpoint);
    if (url === "/api/agents") return jsonResponse([agent]);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhooks` && method === "GET") return jsonResponse([configuredWebhook]);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhook-deliveries`) return jsonResponse([]);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhooks/${webhook.id}` && method === "PATCH") {
      updateBody = JSON.parse(String(init?.body));
      return jsonResponse({ ...configuredWebhook, ...(updateBody as object), headers: configuredWebhook.headers });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));

  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "编辑 工单回调" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByLabelText("回调名称")).toHaveValue("工单回调");
  expect(within(dialog).getByText("Authorization 已配置")).toBeVisible();
  fireEvent.change(within(dialog).getByLabelText("回调地址"), {
    target: { value: "https://receiver.example.com/v2/webhook" }
  });
  fireEvent.click(within(dialog).getByLabelText("task.failed"));
  fireEvent.click(within(dialog).getByRole("button", { name: "保存修改" }));

  await waitFor(() => expect(updateBody).toEqual({
    name: "工单回调",
    url: "https://receiver.example.com/v2/webhook",
    events: ["task.succeeded", "message.agent.reply", "task.failed"],
    timeoutSeconds: 10
  }));
  expect(await screen.findByText("https://receiver.example.com/v2/webhook")).toBeVisible();
});

it("确认后轮换事件回调密钥并只展示新密钥一次", async () => {
  window.history.replaceState({}, "", `/integration-endpoints/${endpoint.id}/webhooks`);
  const rotatedSecret = "whsec_rotated_once";
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url === `/api/integration-endpoints/${endpoint.id}`) return jsonResponse(endpoint);
    if (url === "/api/agents") return jsonResponse([agent]);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhooks` && method === "GET") {
      return jsonResponse([webhook]);
    }
    if (url === `/api/integration-endpoints/${endpoint.id}/webhook-deliveries`) return jsonResponse([]);
    if (url === `/api/integration-endpoints/${endpoint.id}/webhooks/${webhook.id}/rotate-secret` && method === "POST") {
      return jsonResponse({ webhook: { ...webhook, updatedAt: "2026-08-13T10:05:00.000Z" }, signingSecret: rotatedSecret });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "轮换 工单回调的签名密钥" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("旧签名密钥将立即失效。接收方必须改用新密钥。"))
    .toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "确认轮换" }));

  expect(await screen.findByText(rotatedSecret)).toBeVisible();
  expect(screen.getByText("请立即保存新签名密钥，此后不会再次显示")).toBeVisible();
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/integration-endpoints/${endpoint.id}/webhooks/${webhook.id}/rotate-secret`,
    expect.objectContaining({ method: "POST" })
  );

  fireEvent.click(screen.getByRole("button", { name: "我已保存" }));
  expect(screen.queryByText(rotatedSecret)).not.toBeInTheDocument();
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
  fireEvent.click(screen.getByRole("tab", { name: "任务" }));
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
        id: 2, runId: task.runId, seq: 2, type: "status",
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
  fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
  fireEvent.click(screen.getByRole("button", { name: "确认取消" }));
  await act(flushPromises);

  expect(screen.getByText("已取消")).toBeVisible();
});

it("Task 路由切换会清空旧详情、中止请求且忽略迟到响应", async () => {
  vi.useFakeTimers();
  const taskA = { ...task, id: 2, requestId: "request-a", status: "running", result: null, finishedAt: null };
  const taskB = { ...task, id: 3, requestId: "request-b" };
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
