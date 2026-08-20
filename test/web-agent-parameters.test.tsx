// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";

const now = "2026-08-20T00:00:00.000Z";
const agent = {
  id: 1, name: "主力 Codex", provider: "codex", enabled: true,
  instructions: "", projectEnvironmentId: 1, createdAt: now, updatedAt: now
};
const parameter = {
  id: 1, agentId: agent.id, key: "ticket_id", label: "工单 ID", description: null,
  required: true, secret: false, createdAt: now, updatedAt: now
};
const response = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" }
});

beforeEach(() => {
  sessionStorage.setItem("apiToken", "secret-token");
  window.history.replaceState({}, "", `/agents/${agent.id}/parameters`);
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("在独立页面管理智能体会话参数", async () => {
  let parameters = [parameter];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/session-parameters` && method === "GET") return response(parameters);
    if (url === `/api/agents/${agent.id}/session-parameters` && method === "POST") {
      const body = JSON.parse(String(init?.body));
      const created = { ...parameter, id: 2, ...body };
      parameters = [...parameters, created];
      return response(created, 201);
    }
    if (url === `/api/agents/${agent.id}/session-parameters/${parameter.id}` && method === "DELETE") {
      parameters = parameters.filter((item) => item.id !== parameter.id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByRole("tab", { name: "会话参数" })).toHaveAttribute("data-state", "active");
  expect(await screen.findByDisplayValue("工单 ID")).toBeVisible();
  fireEvent.change(screen.getByLabelText("显示名称", { selector: "#parameter-label" }), { target: { value: "项目编号" } });
  fireEvent.change(screen.getByLabelText("参数键"), { target: { value: "project_id" } });
  fireEvent.click(screen.getByRole("button", { name: "添加会话参数" }));
  expect(await screen.findByDisplayValue("项目编号")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "删除参数 工单 ID" }));
  await waitFor(() => expect(screen.queryByDisplayValue("工单 ID")).not.toBeInTheDocument());
});

it("MCP 列表页面不再加载或展示会话参数管理", async () => {
  window.history.replaceState({}, "", `/agents/${agent.id}/mcp`);
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/mcp-servers`) return response([]);
    if (url === `/api/agents/${agent.id}/mcp-catalog`) return response([]);
    if (url === "/api/sessions") return response([]);
    throw new Error(`Unexpected request: GET ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByText("MCP 服务器")).toBeVisible();
  expect(screen.queryByRole("button", { name: "添加会话参数" })).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith(`/api/agents/${agent.id}/session-parameters`, expect.anything());
});
