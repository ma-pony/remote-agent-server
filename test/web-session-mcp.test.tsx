// @vitest-environment jsdom
import { pagedManagementResponse } from "./paged-management-response.js";

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";

const now = "2026-08-13T00:00:00.000Z";
const agent = { id: 1, name: "主力 Codex", provider: "codex", enabled: true, projectEnvironmentId: 1, createdAt: now, updatedAt: now };
const definitions = [{
  id: 1, agentId: agent.id, key: "access_token", label: "访问令牌",
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
    if (new URL(url, "http://localhost").pathname === "/api/agents") return pagedManagementResponse(url, [agent]);
    if (new URL(url, "http://localhost").pathname === `/api/agents/${agent.id}/session-parameters`) return pagedManagementResponse(url, definitions);
    if (new URL(url, "http://localhost").pathname === "/api/sessions" && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toEqual({
        title: "租户工单", agentId: agent.id, mcpParameters: { access_token: "session-secret" }
      });
      return pagedManagementResponse(url, { id: 1 }, 201);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  fireEvent.change(await screen.findByLabelText("会话标题"), { target: { value: "租户工单" } });
  expect(await screen.findByLabelText("访问令牌（必填）")).toHaveAttribute("type", "password");
  fireEvent.change(screen.getByLabelText("访问令牌（必填）"), { target: { value: "session-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
  await waitFor(() => expect(window.location.pathname).toBe("/sessions/1"));
});

it("Session 设置页修改参数，缺少必填参数时对话页禁止发送", async () => {
  window.history.replaceState({}, "", "/sessions/1/settings");
  const detail = {
    id: 1, agentId: agent.id, title: "租户工单", status: "idle", providerSessionId: null,
    workspacePath: "/tmp/session-1", projectEnvironmentRevisionId: 1, createdAt: now, updatedAt: now,
    mcpParametersValid: false, missingMcpParameters: ["access_token"],
    mcpParameters: [{ key: "access_token", label: "访问令牌", description: "当前租户令牌", required: true, secret: true, configured: false }],
    runs: []
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (new URL(url, "http://localhost").pathname === "/api/sessions/1/mcp-parameters" && (init?.method ?? "GET") === "GET") return pagedManagementResponse(url, detail.mcpParameters);
    if (new URL(url, "http://localhost").pathname === "/api/sessions/1" && (init?.method ?? "GET") === "GET") return pagedManagementResponse(url, detail);
    if (new URL(url, "http://localhost").pathname === "/api/sessions/1/mcp-parameters" && init?.method === "PATCH") {
      expect(JSON.parse(String(init.body))).toEqual({ values: { access_token: "new-secret" } });
      return pagedManagementResponse(url, { ...detail, mcpParametersValid: true, missingMcpParameters: [], mcpParameters: [{ ...detail.mcpParameters[0], configured: true }] });
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

it("空闲 Session 确认后重建执行器会话并说明保留的数据", async () => {
  window.history.replaceState({}, "", "/sessions/1/settings");
  const detail = {
    id: 1, agentId: agent.id, title: "租户工单", status: "idle", providerSessionId: "provider-session-1",
    workspacePath: "/tmp/session-1", projectEnvironmentRevisionId: 1, createdAt: now, updatedAt: now,
    mcpParametersValid: true, missingMcpParameters: [], mcpParameters: [], runs: []
  };
  let resolveReset!: (value: Response) => void;
  const resetResponse = new Promise<Response>((resolve) => { resolveReset = resolve; });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (new URL(url, "http://localhost").pathname === "/api/sessions/1/mcp-parameters" && (init?.method ?? "GET") === "GET") return pagedManagementResponse(url, detail.mcpParameters);
    if (new URL(url, "http://localhost").pathname === "/api/sessions/1" && (init?.method ?? "GET") === "GET") return pagedManagementResponse(url, detail);
    if (new URL(url, "http://localhost").pathname === "/api/sessions/1/reset" && init?.method === "POST") {
      return resetResponse;
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "重建执行器会话" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent("保留对话历史、运行记录、工作区和浏览器数据");
  expect(screen.getByRole("alertdialog")).toHaveTextContent("只清除执行器上下文");
  fireEvent.click(screen.getByRole("button", { name: "确认重建" }));
  expect(await screen.findByRole("button", { name: "重建中…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "保存参数" })).toBeDisabled();
  resolveReset(response({ ...detail, providerSessionId: null }));

  expect(await screen.findByText("执行器会话已重建；下一轮将创建新执行器会话并重新注入 MCP。"))
    .toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([input, init]) =>
    input === "/api/sessions/1/reset?includeParameters=false" && init?.method === "POST"
  )).toBe(true);
});

it("运行中的 Session 禁止重建执行器会话", async () => {
  window.history.replaceState({}, "", "/sessions/1/settings");
  const detail = {
    id: 1, agentId: agent.id, title: "租户工单", status: "running", providerSessionId: "provider-session-1",
    workspacePath: "/tmp/session-1", projectEnvironmentRevisionId: 1, createdAt: now, updatedAt: now,
    mcpParametersValid: true, missingMcpParameters: [], mcpParameters: [], runs: []
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (new URL(url, "http://localhost").pathname === "/api/sessions/1/mcp-parameters" && (init?.method ?? "GET") === "GET") return pagedManagementResponse(url, detail.mcpParameters);
    if (new URL(url, "http://localhost").pathname === "/api/sessions/1") return pagedManagementResponse(url, detail);
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<App />);

  expect(await screen.findByRole("button", { name: "重建执行器会话" })).toBeDisabled();
});
