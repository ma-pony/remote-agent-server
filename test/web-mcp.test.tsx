// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";

const now = "2026-08-13T00:00:00.000Z";
const agent = {
  id: 1, name: "主力 Codex", provider: "codex", enabled: true,
  projectEnvironmentId: 1, createdAt: now, updatedAt: now
};
const server = {
  id: 1, agentId: agent.id, name: "example_mcp", transport: "http", enabled: true,
  allowedTools: null,
  checkTimeoutSeconds: 30, lastCheckedAt: null, lastCheckStatus: null, lastCheckMessage: null,
  lastToolCount: null, createdAt: now, updatedAt: now
};
const session = {
  id: 1, agentId: agent.id, title: "租户 A", status: "idle", providerSessionId: null,
  workspacePath: "/workspace", projectEnvironmentRevisionId: 1, createdAt: now, updatedAt: now
};
const response = (value: unknown, status = 200): Response => new Response(JSON.stringify(Array.isArray(value) ? sessionPage(value) : typeof value === "object" && value !== null && "tools" in value && Array.isArray(value.tools) ? { ...value, snapshotId: "snapshot", tools: sessionPage(value.tools) } : value), {
  status, headers: { "content-type": "application/json" }
});
const sessionPage = (
  items: unknown[],
  overrides: Partial<{ page: number; pageSize: number; total: number; totalPages: number }> = {}
) => ({
  items, page: 1, pageSize: 20, total: items.length, totalPages: items.length === 0 ? 0 : 1, ...overrides
});

// Transform the real lazy routes before starting interaction assertion deadlines.
beforeAll(async () => {
  await Promise.all([
    import("../src/web/pages/agent-pages.js"),
    import("../src/web/pages/agent-mcp-pages.js")
  ]);
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

it("Agent MCP 独立页面展示服务器和连接检查", async () => {
  let enabledBody: unknown;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/sessions?agentId=${agent.id}&storage=active&page=1&pageSize=20`) {
      return response(sessionPage([session]));
    }
    if (url === `/api/agents/${agent.id}/mcp-servers?page=1&pageSize=20`) return response([server]);
    if (url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/session-parameters?page=1&pageSize=20`) return response([{
      id: 1, agentId: agent.id, key: "tenant", label: "租户", description: null,
      required: true, secret: false, createdAt: now, updatedAt: now
    }]);
    if (url === `/api/agents/${agent.id}/mcp-servers/${server.id}/check?page=1&pageSize=20` && init?.method === "POST") {
      return response({ status: "passed", toolCount: 4, message: "4 tools available" });
    }
    if (url === `/api/agents/${agent.id}/mcp-servers/${server.id}/enabled` && init?.method === "PATCH") {
      enabledBody = JSON.parse(String(init.body));
      return response({ ...server, enabled: false });
    }
    if (url === `/api/agents/${agent.id}/system-mcp-catalog?page=1&pageSize=20` || url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByText("MCP 服务器")).toBeInTheDocument();
  expect(await screen.findByText("example_mcp")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "设置 example_mcp 的工具范围" })).toBeVisible();
  expect(screen.getByRole("link", { name: "编辑 example_mcp" })).toHaveAttribute(
    "href", `/agents/${agent.id}/mcp/${server.id}`
  );
  fireEvent.click(screen.getByRole("button", { name: "停用" }));
  await waitFor(() => expect(enabledBody).toEqual({ enabled: false }));
  expect(await screen.findByText("已停用")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "设为核心" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
  expect(await screen.findByText("4 个工具可用")).toBeInTheDocument();
});

it("MCP 列表可选择只删除当前配置或整个共享组", async () => {
  let servers = [server];
  const deletedScopes: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/sessions?agentId=${agent.id}&storage=active&page=1&pageSize=20`) return response(sessionPage([]));
    if (url === `/api/agents/${agent.id}/session-parameters?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/mcp-servers?page=1&pageSize=20`) return response(servers);
    if (url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    if (url.startsWith(`/api/agents/${agent.id}/mcp-servers/${server.id}?scope=`) && init?.method === "DELETE") {
      deletedScopes.push(new URL(url, "http://localhost").searchParams.get("scope")!);
      servers = [];
      return new Response(null, { status: 204 });
    }
    if (url === `/api/agents/${agent.id}/system-mcp-catalog?page=1&pageSize=20` || url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "删除 example_mcp" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent("只影响当前智能体");
  fireEvent.click(screen.getByRole("button", { name: "从所有智能体删除" }));
  await waitFor(() => expect(deletedScopes).toEqual(["all"]));
  expect(await screen.findByText("还没有 MCP 服务器")).toBeInTheDocument();
});

it("使用指定 Session 检查引用动态参数的 MCP", async () => {
  let checkBody: unknown;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/sessions?agentId=${agent.id}&storage=active&page=1&pageSize=20`) return response(sessionPage([session]));
    if (url === `/api/agents/${agent.id}/mcp-servers?page=1&pageSize=20`) return response([server]);
    if (url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/session-parameters?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/mcp-servers/${server.id}/check?page=1&pageSize=20` && init?.method === "POST") {
      checkBody = JSON.parse(String(init.body));
      return response({ status: "passed", toolCount: 2, message: "2 tools available" });
    }
    if (url === `/api/agents/${agent.id}/system-mcp-catalog?page=1&pageSize=20` || url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  await screen.findByRole("option", { name: session.title });
  fireEvent.change(await screen.findByLabelText("检查使用的会话"), { target: { value: String(session.id) } });
  fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
  await waitFor(() => expect(checkBody).toEqual({ sessionId: session.id }));
});

it("MCP 检查选择器按需分页加载有效 Session", async () => {
  const olderSession = { ...session, id: 101, title: "第二页租户" };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/sessions?agentId=${agent.id}&storage=active&page=1&pageSize=20`) {
      return response(sessionPage([session], { total: 101, totalPages: 2 }));
    }
    if (url === `/api/sessions?agentId=${agent.id}&storage=active&page=2&pageSize=20`) {
      return response(sessionPage([olderSession], { page: 2, total: 101, totalPages: 2 }));
    }
    if (url === `/api/agents/${agent.id}/mcp-servers?page=1&pageSize=20`) return response([server]);
    if (url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/session-parameters?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/system-mcp-catalog?page=1&pageSize=20` || url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  await screen.findByRole("option", { name: session.title });
  expect(screen.queryByRole("option", { name: olderSession.title })).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByLabelText("检查使用的会话").parentElement!.parentElement!).getByRole("button", { name: "下一页" }));
  expect(await screen.findByRole("option", { name: olderSession.title })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/sessions?agentId=${agent.id}&storage=active&page=2&pageSize=20`,
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  );
});

it("点击工具数量后实时检查并展示全部工具", async () => {
  const checkedServer = { ...server, lastCheckStatus: "passed", lastToolCount: 2 };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/sessions?agentId=${agent.id}&storage=active&page=1&pageSize=20`) return response(sessionPage([session]));
    if (url === `/api/agents/${agent.id}/mcp-servers?page=1&pageSize=20`) return response([checkedServer]);
    if (url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/session-parameters?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/mcp-servers/${server.id}/check?page=1&pageSize=20` && init?.method === "POST") {
      return response({
        status: "passed", toolCount: 2, message: "2 tools available",
        tools: [{ name: "ticket_get", description: "读取工单详情" }, { name: "ticket_pause", description: null }]
      });
    }
    if (url === `/api/agents/${agent.id}/system-mcp-catalog?page=1&pageSize=20` || url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "设置 example_mcp 的工具范围" }));
  expect(await screen.findByRole("heading", { name: "example_mcp 的工具" })).toBeInTheDocument();
  expect(screen.getByText("ticket_get")).toBeInTheDocument();
  expect(screen.getByText("读取工单详情")).toBeInTheDocument();
  expect(screen.getByText("ticket_pause")).toBeInTheDocument();
  expect(screen.getByText("暂无说明")).toBeInTheDocument();
});

it("工具说明默认单行折叠，并可独立展开和收起", async () => {
  const checkedServer = { ...server, lastCheckStatus: "passed" as const, lastToolCount: 2 };
  const description = "读取工单详情。\n参数：ticket_id，工单数字 ID。\n返回工单当前状态和执行证据。";
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/sessions?agentId=${agent.id}&storage=active&page=1&pageSize=20`) return response(sessionPage([session]));
    if (url === `/api/agents/${agent.id}/mcp-servers?page=1&pageSize=20`) return response([checkedServer]);
    if (url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/session-parameters?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/mcp-servers/${server.id}/check?page=1&pageSize=20` && init?.method === "POST") {
      return response({
        status: "passed", toolCount: 2, message: "2 tools available",
        tools: [
          { name: "ticket_get", description },
          { name: "ticket_pause", description: "暂停工单并等待人工处理。" }
        ]
      });
    }
    if (url === `/api/agents/${agent.id}/system-mcp-catalog?page=1&pageSize=20` || url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "查看 2 个工具" }));
  await screen.findByRole("heading", { name: "example_mcp 的工具" });

  const descriptionElement = screen.getByText(/读取工单详情。/);
  const expandButton = screen.getByRole("button", { name: "展开 ticket_get 的说明" });
  expect(descriptionElement).toHaveClass("line-clamp-1");
  expect(expandButton).toHaveAttribute("aria-expanded", "false");

  fireEvent.click(expandButton);
  expect(descriptionElement).not.toHaveClass("line-clamp-1");
  expect(descriptionElement).toHaveClass("whitespace-pre-wrap");
  expect(screen.getByRole("button", { name: "收起 ticket_get 的说明" })).toHaveAttribute("aria-expanded", "true");

  fireEvent.click(screen.getByRole("button", { name: "收起 ticket_get 的说明" }));
  expect(descriptionElement).toHaveClass("line-clamp-1");
});

it("可在工具列表中选择当前 Agent 暴露的 MCP 工具", async () => {
  let toolsBody: unknown;
  let currentServer = { ...server, lastCheckStatus: "passed" as const, lastToolCount: 2 };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/sessions?agentId=${agent.id}&storage=active&page=1&pageSize=20`) return response(sessionPage([session]));
    if (url === `/api/agents/${agent.id}/mcp-servers?page=1&pageSize=20`) return response([currentServer]);
    if (url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/session-parameters?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/mcp-servers/${server.id}/check?page=1&pageSize=20` && init?.method === "POST") {
      return response({
        status: "passed", toolCount: 2, message: "2 tools available",
        tools: [{ name: "ticket_get", description: "读取工单详情" }, { name: "ticket_pause", description: null }]
      });
    }
    if (url === `/api/agents/${agent.id}/mcp-servers/${server.id}/tools` && init?.method === "PATCH") {
      toolsBody = JSON.parse(String(init.body));
      currentServer = { ...currentServer, allowedTools: (toolsBody as { allowedTools: string[] }).allowedTools };
      return response(currentServer);
    }
    if (url === `/api/agents/${agent.id}/system-mcp-catalog?page=1&pageSize=20` || url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "查看 2 个工具" }));
  await screen.findByRole("heading", { name: "example_mcp 的工具" });
  expect(screen.getByText(/保存后当前运行不受影响，下一次运行会自动刷新执行器会话并生效。/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "仅所选工具" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "ticket_get" }));
  fireEvent.click(screen.getByRole("button", { name: "保存工具权限" }));

  await waitFor(() => expect(toolsBody).toEqual({ allowedTools: ["ticket_get"] }));
  expect(await screen.findByText("已选择 1 个工具")).toBeInTheDocument();
});

it("工具翻页保留页外白名单，保存不会重复发现或丢失选择", async () => {
  let saved: unknown;
  let checks = 0;
  const selectedServer = { ...server, allowedTools: ["off_page_tool"] };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/mcp-servers?page=1&pageSize=20`) return response([selectedServer]);
    if (url.includes("mcp-catalog?page=")) return response([]);
    if (url.startsWith("/api/sessions?")) return response(sessionPage([]));
    if (url.endsWith("/check?page=1&pageSize=20")) {
      checks++;
      return response({ status: "passed", toolCount: 21, message: "21 tools", snapshotId: "snapshot", tools: sessionPage([{ name: "first_tool", description: null }], { total: 21, totalPages: 2 }) });
    }
    if (url.includes("/tools?page=2")) return response(sessionPage([{ name: "off_page_tool", description: null }], { page: 2, total: 21, totalPages: 2 }));
    if (url.endsWith("/tools") && init?.method === "PATCH") { saved = JSON.parse(String(init.body)); return response(selectedServer); }
    throw new Error(`Unexpected request: ${url}`);
  }));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "设置 example_mcp 的工具范围" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "first_tool" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "下一页" }));
  expect(await screen.findByRole("checkbox", { name: "off_page_tool" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "保存工具权限" }));
  await waitFor(() => expect(saved).toEqual({ allowedTools: ["off_page_tool", "first_tool"] }));
  expect(checks).toBe(1);
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
    if (url === `/api/sessions?agentId=${agent.id}&storage=active&page=1&pageSize=20`) return response(sessionPage([]));
    if (url === `/api/agents/${agent.id}/session-parameters?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/mcp-servers?page=1&pageSize=20`) return response(installed ? [{ ...server, id: 9, name: shared.name }] : []);
    if (url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response(installed ? [] : [shared]);
    if (url === `/api/agents/${agent.id}/mcp-catalog/${shared.id}/install` && init?.method === "POST") {
      installed = true;
      return response({ ...server, id: 9, name: shared.name }, 201);
    }
    if (url === `/api/agents/${agent.id}/system-mcp-catalog?page=1&pageSize=20` || url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByText("可添加的 MCP")).toBeInTheDocument();
  expect(await screen.findByText("mongodb")).toBeInTheDocument();
  expect(screen.getByText("来自 数据智能体")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "添加并启用 mongodb" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    `/api/agents/${agent.id}/mcp-catalog/${shared.id}/install`,
    expect.objectContaining({ method: "POST" })
  ));
  await waitFor(() => expect(screen.getByText("所有共享 MCP 均已添加。")) .toBeInTheDocument());
});

it("从当前 Provider 的系统配置中发现并导入 MCP", async () => {
  const systemMcp = {
    id: "system-mcp-1",
    provider: "codex",
    name: "local-tools",
    transport: "stdio",
    installed: false
  };
  let installed = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/sessions?agentId=${agent.id}&storage=active&page=1&pageSize=20`) return response(sessionPage([]));
    if (url === `/api/agents/${agent.id}/mcp-servers?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/system-mcp-catalog?page=1&pageSize=20`) {
      return response([{ ...systemMcp, installed }]);
    }
    if (url === `/api/agents/${agent.id}/system-mcp-catalog/${systemMcp.id}/install` && init?.method === "POST") {
      installed = true;
      return response({ ...server, id: 7, name: systemMcp.name, transport: "stdio" }, 201);
    }
    if (url === `/api/agents/${agent.id}/system-mcp-catalog?page=1&pageSize=20` || url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByText("系统配置中的 MCP")).toBeVisible();
  expect(await screen.findByText("local-tools")).toBeVisible();
  expect(screen.getByText("来自 Codex 系统配置")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "导入并启用 local-tools" }));
  await waitFor(() => expect(screen.getByText("已导入")).toBeVisible());
});

it("从独立页面创建带敏感 Header 的 HTTP MCP", async () => {
  window.history.replaceState({}, "", `/agents/${agent.id}/mcp/new`);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/session-parameters?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}/mcp-servers` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        name: "example_mcp", transport: "http", url: "https://example.test/mcp",
        headers: [{ name: "Authorization", source: "fixed", value: "Bearer secret-token", secret: true }]
      });
      return response({ ...server, url: "https://example.test/mcp", headers: [] }, 201);
    }
    if (url === `/api/agents/${agent.id}/mcp-servers?page=1&pageSize=20`) return response([server]);
    if (url === `/api/agents/${agent.id}/system-mcp-catalog?page=1&pageSize=20` || url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
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
    if (url === `/api/agents/${agent.id}/session-parameters?page=1&pageSize=20`) return response([{
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
    if (url === `/api/agents/${agent.id}/mcp-servers?page=1&pageSize=20`) return response([server]);
    if (url === `/api/agents/${agent.id}/system-mcp-catalog?page=1&pageSize=20` || url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  fireEvent.change(await screen.findByLabelText("MCP 名称"), { target: { value: "tenant_mcp" } });
  fireEvent.change(screen.getByLabelText("HTTP 地址"), { target: { value: "https://example.test/mcp" } });
  fireEvent.click(screen.getByRole("button", { name: "添加请求头" }));
  fireEvent.change(screen.getByLabelText("请求头名称 1"), { target: { value: "X-Tenant-Token" } });
  fireEvent.change(screen.getByLabelText("请求头来源 1"), { target: { value: "session_parameter" } });
  await screen.findByRole("option", { name: "租户 Token (tenant_token)" });
  fireEvent.change(screen.getByLabelText("请求头会话参数 1"), { target: { value: "tenant_token" } });
  fireEvent.click(screen.getByRole("button", { name: "创建 MCP" }));

  await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agent.id}/mcp`));
});

it("stdio Argument 和 Environment 支持 runtime 与 Session 参数", async () => {
  window.history.replaceState({}, "", `/agents/${agent.id}/mcp/new`);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}/session-parameters?page=1&pageSize=20`) return response([{
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
    if (url === `/api/agents/${agent.id}/mcp-servers?page=1&pageSize=20`) return response([server]);
    if (url === `/api/agents/${agent.id}/system-mcp-catalog?page=1&pageSize=20` || url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
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
  await screen.findByRole("option", { name: "租户 (tenant)" });
  fireEvent.change(screen.getByLabelText("环境变量会话参数 1"), { target: { value: "tenant" } });
  fireEvent.click(screen.getByRole("button", { name: "创建 MCP" }));

  await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agent.id}/mcp`));
});

it("新建 stdio MCP 时空命令不能提交", async () => {
  window.history.replaceState({}, "", `/agents/${agent.id}/mcp/new`);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}/session-parameters?page=1&pageSize=20`) return response([]);
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/system-mcp-catalog?page=1&pageSize=20` || url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
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
    if (url === `/api/agents/${agent.id}/session-parameters?page=1&pageSize=20`) return response([]);
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
    if (url === `/api/sessions?agentId=${agent.id}&storage=active&page=1&pageSize=20`) return response(sessionPage([]));
    if (url === `/api/agents/${agent.id}/mcp-servers?page=1&pageSize=20`) return response([server]);
    if (url === `/api/agents/${agent.id}/system-mcp-catalog?page=1&pageSize=20` || url === `/api/agents/${agent.id}/mcp-catalog?page=1&pageSize=20`) return response([]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  expect(await screen.findByLabelText("请求头值 1")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "保存 MCP" }));
  await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agent.id}/mcp`));
});
