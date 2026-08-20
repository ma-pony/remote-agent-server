// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";

const now = "2026-08-13T00:00:00.000Z";
const agent = {
  id: 1, name: "主力 Codex", provider: "codex", enabled: true,
  projectEnvironmentId: 1, createdAt: now, updatedAt: now
};
const server = {
  id: 1, agentId: agent.id, name: "example_mcp", transport: "http", enabled: true,
  checkTimeoutSeconds: 30, lastCheckedAt: null, lastCheckStatus: null, lastCheckMessage: null,
  lastToolCount: null, createdAt: now, updatedAt: now
};
const session = {
  id: 1, agentId: agent.id, title: "租户 A", status: "idle", providerSessionId: null,
  workspacePath: "/workspace", projectEnvironmentRevisionId: 1, createdAt: now, updatedAt: now
};
const response = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" }
});

beforeEach(() => {
  sessionStorage.setItem("apiToken", "secret-token");
  window.history.replaceState({}, "", `/agents/${agent.id}/mcp`);
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("Agent MCP 独立页面展示服务器、连接检查和 Session 参数", async () => {
  let enabledBody: unknown;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === "/api/sessions") return response([session]);
    if (url === `/api/agents/${agent.id}/mcp-servers`) return response([server]);
    if (url === `/api/agents/${agent.id}/mcp-catalog`) return response([]);
    if (url === `/api/agents/${agent.id}/session-parameters`) return response([{
      id: 1, agentId: agent.id, key: "tenant", label: "租户", description: null,
      required: true, secret: false, createdAt: now, updatedAt: now
    }]);
    if (url === `/api/agents/${agent.id}/mcp-servers/${server.id}/check` && init?.method === "POST") {
      return response({ status: "passed", toolCount: 4, message: "4 tools available" });
    }
    if (url === `/api/agents/${agent.id}/mcp-servers/${server.id}/enabled` && init?.method === "PATCH") {
      enabledBody = JSON.parse(String(init.body));
      return response({ ...server, enabled: false });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByText("MCP 服务器")).toBeInTheDocument();
  expect(await screen.findByText("example_mcp")).toBeInTheDocument();
  expect(screen.getByDisplayValue("租户")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "停用" }));
  await waitFor(() => expect(enabledBody).toEqual({ enabled: false }));
  expect(await screen.findByText("已停用")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
  expect(await screen.findByText("4 个工具可用")).toBeInTheDocument();
});

it("使用指定 Session 检查引用动态参数的 MCP", async () => {
  let checkBody: unknown;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === "/api/sessions") return response([session]);
    if (url === `/api/agents/${agent.id}/mcp-servers`) return response([server]);
    if (url === `/api/agents/${agent.id}/mcp-catalog`) return response([]);
    if (url === `/api/agents/${agent.id}/session-parameters`) return response([]);
    if (url === `/api/agents/${agent.id}/mcp-servers/${server.id}/check` && init?.method === "POST") {
      checkBody = JSON.parse(String(init.body));
      return response({ status: "passed", toolCount: 2, message: "2 tools available" });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  await screen.findByRole("option", { name: session.title });
  fireEvent.change(await screen.findByLabelText("检查使用的会话"), { target: { value: String(session.id) } });
  fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
  await waitFor(() => expect(checkBody).toEqual({ sessionId: session.id }));
});

it("点击工具数量后实时检查并展示全部工具", async () => {
  const checkedServer = { ...server, lastCheckStatus: "passed", lastToolCount: 2 };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === "/api/sessions") return response([session]);
    if (url === `/api/agents/${agent.id}/mcp-servers`) return response([checkedServer]);
    if (url === `/api/agents/${agent.id}/mcp-catalog`) return response([]);
    if (url === `/api/agents/${agent.id}/session-parameters`) return response([]);
    if (url === `/api/agents/${agent.id}/mcp-servers/${server.id}/check` && init?.method === "POST") {
      return response({
        status: "passed", toolCount: 2, message: "2 tools available",
        tools: [{ name: "ticket_get", description: "读取工单详情" }, { name: "ticket_pause", description: null }]
      });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "查看 2 个工具" }));
  expect(await screen.findByRole("heading", { name: "example_mcp 的工具" })).toBeInTheDocument();
  expect(screen.getByText("ticket_get")).toBeInTheDocument();
  expect(screen.getByText("读取工单详情")).toBeInTheDocument();
  expect(screen.getByText("ticket_pause")).toBeInTheDocument();
  expect(screen.getByText("暂无说明")).toBeInTheDocument();
});

it("从共享 MCP 区域一键添加并启用", async () => {
  const shared = {
    id: 8, name: "mongodb", transport: "stdio", sourceAgentId: 2,
    sourceAgentName: "数据智能体", checkTimeoutSeconds: 30
  };
  let installed = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === "/api/sessions") return response([]);
    if (url === `/api/agents/${agent.id}/session-parameters`) return response([]);
    if (url === `/api/agents/${agent.id}/mcp-servers`) return response(installed ? [{ ...server, id: 9, name: shared.name }] : []);
    if (url === `/api/agents/${agent.id}/mcp-catalog`) return response(installed ? [] : [shared]);
    if (url === `/api/agents/${agent.id}/mcp-catalog/${shared.id}/install` && init?.method === "POST") {
      installed = true;
      return response({ ...server, id: 9, name: shared.name }, 201);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByText("可添加的 MCP")).toBeInTheDocument();
  expect(screen.getByText("mongodb")).toBeInTheDocument();
  expect(screen.getByText("来自 数据智能体")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "添加并启用 mongodb" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    `/api/agents/${agent.id}/mcp-catalog/${shared.id}/install`,
    expect.objectContaining({ method: "POST" })
  ));
  await waitFor(() => expect(screen.getByText("所有共享 MCP 均已添加。")) .toBeInTheDocument());
});

it("从独立页面创建带敏感 Header 的 HTTP MCP", async () => {
  window.history.replaceState({}, "", `/agents/${agent.id}/mcp/new`);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/session-parameters`) return response([]);
    if (url === `/api/agents/${agent.id}/mcp-servers` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        name: "example_mcp", transport: "http", url: "https://example.test/mcp",
        headers: [{ name: "Authorization", source: "fixed", value: "Bearer secret-token", secret: true }]
      });
      return response({ ...server, url: "https://example.test/mcp", headers: [] }, 201);
    }
    if (url === `/api/agents/${agent.id}/mcp-servers`) return response([server]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  expect(await screen.findByRole("heading", { name: "新建 MCP" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("MCP 名称"), { target: { value: "example_mcp" } });
  fireEvent.change(screen.getByLabelText("HTTP 地址"), { target: { value: "https://example.test/mcp" } });
  fireEvent.click(screen.getByRole("button", { name: "添加请求头" }));
  fireEvent.change(screen.getByLabelText("请求头名称 1"), { target: { value: "Authorization" } });
  fireEvent.change(screen.getByLabelText("请求头值 1"), { target: { value: "Bearer secret-token" } });
  fireEvent.click(screen.getByLabelText("请求头 敏感值 1"));
  fireEvent.click(screen.getByRole("button", { name: "创建 MCP" }));

  await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agent.id}/mcp`));
});

it("HTTP Header 可引用 Session 参数", async () => {
  window.history.replaceState({}, "", `/agents/${agent.id}/mcp/new`);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}/session-parameters`) return response([{
      id: 1, agentId: agent.id, key: "tenant_token", label: "租户 Token",
      description: null, required: true, secret: true, createdAt: now, updatedAt: now
    }]);
    if (url === `/api/agents/${agent.id}/mcp-servers` && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toMatchObject({
        headers: [{ name: "X-Tenant-Token", source: "session_parameter", parameterKey: "tenant_token" }]
      });
      return response({ ...server, url: "https://example.test/mcp", headers: [] }, 201);
    }
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/mcp-servers`) return response([server]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  fireEvent.change(await screen.findByLabelText("MCP 名称"), { target: { value: "tenant_mcp" } });
  fireEvent.change(screen.getByLabelText("HTTP 地址"), { target: { value: "https://example.test/mcp" } });
  fireEvent.click(screen.getByRole("button", { name: "添加请求头" }));
  fireEvent.change(screen.getByLabelText("请求头名称 1"), { target: { value: "X-Tenant-Token" } });
  fireEvent.change(screen.getByLabelText("请求头来源 1"), { target: { value: "session_parameter" } });
  fireEvent.change(screen.getByLabelText("请求头会话参数 1"), { target: { value: "tenant_token" } });
  fireEvent.click(screen.getByRole("button", { name: "创建 MCP" }));

  await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agent.id}/mcp`));
});

it("stdio Argument 和 Environment 支持 runtime 与 Session 参数", async () => {
  window.history.replaceState({}, "", `/agents/${agent.id}/mcp/new`);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}/session-parameters`) return response([{
      id: 1, agentId: agent.id, key: "tenant", label: "租户",
      description: null, required: true, secret: false, createdAt: now, updatedAt: now
    }]);
    if (url === `/api/agents/${agent.id}/mcp-servers` && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toMatchObject({
        transport: "stdio", command: "npx",
        arguments: [{ source: "runtime", runtimeKey: "workspace_path" }],
        environment: [{ name: "TENANT", source: "session_parameter", parameterKey: "tenant" }]
      });
      return response({ ...server, transport: "stdio", command: "npx", arguments: [], environment: [] }, 201);
    }
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/mcp-servers`) return response([server]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  fireEvent.change(await screen.findByLabelText("MCP 名称"), { target: { value: "local_mcp" } });
  fireEvent.change(screen.getByLabelText("传输方式"), { target: { value: "stdio" } });
  expect(screen.getByLabelText("命令")).toHaveValue("npx");
  fireEvent.click(screen.getByRole("button", { name: "添加参数" }));
  fireEvent.change(screen.getByLabelText("参数来源 1"), { target: { value: "runtime" } });
  fireEvent.change(screen.getByLabelText("参数运行参数 1"), { target: { value: "workspace_path" } });
  fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
  fireEvent.change(screen.getByLabelText("环境变量名称 1"), { target: { value: "TENANT" } });
  fireEvent.change(screen.getByLabelText("环境变量来源 1"), { target: { value: "session_parameter" } });
  fireEvent.change(screen.getByLabelText("环境变量会话参数 1"), { target: { value: "tenant" } });
  fireEvent.click(screen.getByRole("button", { name: "创建 MCP" }));

  await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agent.id}/mcp`));
});

it("新建 stdio MCP 时空命令不能提交", async () => {
  window.history.replaceState({}, "", `/agents/${agent.id}/mcp/new`);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}/session-parameters`) return response([]);
    if (url === `/api/agents/${agent.id}`) return response(agent);
    throw new Error(`Unexpected request: GET ${url}`);
  }));

  render(<App />);
  fireEvent.change(await screen.findByLabelText("MCP 名称"), { target: { value: "local_mcp" } });
  fireEvent.change(screen.getByLabelText("传输方式"), { target: { value: "stdio" } });
  fireEvent.change(screen.getByLabelText("命令"), { target: { value: "" } });

  expect(screen.getByRole("button", { name: "创建 MCP" })).toBeDisabled();
});

it("编辑时可保留未回显的敏感值", async () => {
  window.history.replaceState({}, "", `/agents/${agent.id}/mcp/${server.id}`);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}/session-parameters`) return response([]);
    if (url === `/api/agents/${agent.id}/mcp-servers/${server.id}` && (init?.method ?? "GET") === "GET") {
      return response({ ...server, url: "https://example.test/mcp", headers: [{
        id: "89a3e131-449d-4dfa-b927-a019db9ca014", name: "Authorization", source: "fixed",
        secret: true, configured: true
      }] });
    }
    if (url === `/api/agents/${agent.id}/mcp-servers/${server.id}` && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ headers: [{
        id: "89a3e131-449d-4dfa-b927-a019db9ca014", name: "Authorization", source: "fixed", secret: true
      }] });
      expect(body.headers[0]).not.toHaveProperty("value");
      return response({ ...server, url: "https://example.test/mcp", headers: [] });
    }
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === "/api/sessions") return response([]);
    if (url === `/api/agents/${agent.id}/mcp-servers`) return response([server]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  expect(await screen.findByLabelText("请求头值 1")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "保存 MCP" }));
  await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agent.id}/mcp`));
});
