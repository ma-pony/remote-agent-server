// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";

const now = "2026-08-13T00:00:00.000Z";
const agent = { id: "agent-1", name: "主力 Codex", provider: "codex", enabled: true, projectEnvironmentId: "env-1", createdAt: now, updatedAt: now };
const definitions = [{
  id: "parameter-1", agentId: agent.id, key: "access_token", label: "访问令牌",
  description: "当前租户令牌", required: true, secret: true, createdAt: now, updatedAt: now
}];
const response = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" }
});

beforeEach(() => sessionStorage.setItem("apiToken", "secret-token"));
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it("创建 Session 时加载所选 Agent 的 MCP 参数", async () => {
  window.history.replaceState({}, "", "/sessions/new");
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/agents") return response([agent]);
    if (url === `/api/agents/${agent.id}/session-parameters`) return response(definitions);
    if (url === "/api/sessions" && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toEqual({
        title: "租户工单", agentId: agent.id, mcpParameters: { access_token: "session-secret" }
      });
      return response({ id: "session-1" }, 201);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  fireEvent.change(await screen.findByLabelText("会话标题"), { target: { value: "租户工单" } });
  expect(await screen.findByLabelText("访问令牌（必填）")).toHaveAttribute("type", "password");
  fireEvent.change(screen.getByLabelText("访问令牌（必填）"), { target: { value: "session-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
  await waitFor(() => expect(window.location.pathname).toBe("/sessions/session-1"));
});

it("Session 设置页修改参数，缺少必填参数时对话页禁止发送", async () => {
  window.history.replaceState({}, "", "/sessions/session-1/settings");
  const detail = {
    id: "session-1", agentId: agent.id, title: "租户工单", status: "idle", providerSessionId: null,
    workspacePath: "/tmp/session-1", projectEnvironmentRevisionId: "revision-1", createdAt: now, updatedAt: now,
    mcpParametersValid: false, missingMcpParameters: ["access_token"],
    mcpParameters: [{ key: "access_token", label: "访问令牌", description: "当前租户令牌", required: true, secret: true, configured: false }],
    runs: []
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/sessions/session-1" && (init?.method ?? "GET") === "GET") return response(detail);
    if (url === "/api/sessions/session-1/mcp-parameters" && init?.method === "PATCH") {
      expect(JSON.parse(String(init.body))).toEqual({ values: { access_token: "new-secret" } });
      return response({ ...detail, mcpParametersValid: true, missingMcpParameters: [], mcpParameters: [{ ...detail.mcpParameters[0], configured: true }] });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  const input = await screen.findByLabelText("访问令牌（必填）");
  fireEvent.change(input, { target: { value: "new-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
  expect(await screen.findByText("参数已保存")).toBeInTheDocument();
});
