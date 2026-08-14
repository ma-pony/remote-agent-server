// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

beforeEach(() => {
  sessionStorage.setItem("apiToken", "management-token");
  window.history.replaceState({}, "", "/integration-endpoints");
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
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
