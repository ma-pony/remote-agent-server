// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/web/app.js";

const now = "2026-08-13T00:00:00.000Z";
const agent = { id: "agent-1", name: "主力 Codex", provider: "codex", enabled: true, projectEnvironmentId: "environment-1", createdAt: now, updatedAt: now };
const session = {
  id: "session-1",
  agentId: agent.id,
  title: "Crawler development",
  status: "idle",
  providerSessionId: null,
  workspacePath: "/tmp/session-1",
  projectEnvironmentRevisionId: "revision-1",
  usage: { inputTokens: 9000, outputTokens: 2345, cachedReadTokens: null, cachedWriteTokens: null, thoughtTokens: null, totalTokens: 12345 },
  agentName: "主力 Codex",
  agentProvider: "codex",
  projectEnvironmentName: "爬虫项目环境",
  integration: {
    endpointId: 2,
    endpointName: "Crawler development",
    endpointSlug: "crawler-dev",
    conversationKey: "ticket-2084",
    latestRequestId: "dispatch-2084-2"
  },
  createdAt: now,
  updatedAt: now
};
const response = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const page = (items: unknown[], overrides: Partial<{ page: number; pageSize: number; total: number; totalPages: number }> = {}) => ({
  items,
  page: 1,
  pageSize: 20,
  total: items.length,
  totalPages: items.length === 0 ? 0 : 1,
  ...overrides
});

beforeEach(() => {
  sessionStorage.setItem("apiToken", "secret-token");
  window.history.replaceState({}, "", "/sessions");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/sessions?page=1&pageSize=20") return response(page([session]));
    if (url === "/api/sessions?page=1&pageSize=20&query=ticket-2084") return response(page([session]));
    if (url === "/api/sessions?page=1&pageSize=20&query=ticket-9999") return response(page([]));
    if (url === `/api/sessions?page=1&pageSize=20&agentId=${agent.id}`) return response(page([session]));
    if (url === `/api/sessions?page=1&pageSize=20&agentId=${agent.id}&status=running`) return response(page([]));
    if (url === "/api/agents") return response([agent]);
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it("Session 列表与创建表单分离", async () => {
  render(<App />);
  expect((await screen.findAllByRole("link", { name: "Crawler development" }))[0]).toBeInTheDocument();
  expect(screen.queryByLabelText("会话标题")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "新建会话" }));
  await waitFor(() => expect(window.location.pathname).toBe("/sessions/new"));
  expect(await screen.findByLabelText("会话标题")).toBeInTheDocument();
});

it("列表展示会话来源、项目环境和累计 Token，并支持按外部标识搜索", async () => {
  render(<App />);

  expect(await screen.findByText("ticket-2084")).toBeInTheDocument();
  expect(screen.getByText("/crawler-dev")).toBeInTheDocument();
  expect(screen.getByText("爬虫项目环境")).toBeInTheDocument();
  expect(screen.getByText("12,345")).toBeInTheDocument();
  expect(screen.getByText("会话 #session-1")).toBeInTheDocument();

  const search = screen.getByLabelText("搜索会话");
  fireEvent.change(search, { target: { value: "ticket-2084" } });
  expect((await screen.findAllByRole("link", { name: session.title }))[0]).toBeInTheDocument();
  fireEvent.change(search, { target: { value: "ticket-9999" } });
  await waitFor(() => expect(screen.queryByRole("link", { name: session.title })).not.toBeInTheDocument());
});

it("会话列表支持按智能体和状态筛选", async () => {
  const fetchMock = vi.mocked(fetch);
  render(<App />);
  await screen.findByRole("link", { name: session.title });

  fireEvent.change(screen.getByLabelText("按智能体筛选"), { target: { value: agent.id } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    `/api/sessions?page=1&pageSize=20&agentId=${agent.id}`,
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  ));

  fireEvent.change(screen.getByLabelText("按会话状态筛选"), { target: { value: "running" } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    `/api/sessions?page=1&pageSize=20&agentId=${agent.id}&status=running`,
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  ));
  expect(await screen.findByText("没有匹配的会话。")).toBeVisible();
});

it("列表支持翻页并把搜索交给服务端", async () => {
  const older = { ...session, id: "session-older", title: "第二页会话" };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/sessions?page=1&pageSize=20") {
      return response(page([session], { total: 21, totalPages: 2 }));
    }
    if (url === "/api/sessions?page=2&pageSize=20") {
      return response(page([older], { page: 2, total: 21, totalPages: 2 }));
    }
    if (url === "/api/sessions?page=1&pageSize=20&query=ticket-2084") {
      return response(page([session]));
    }
    if (url === "/api/agents") return response([agent]);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);

  expect(await screen.findByText("第 1 / 2 页")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByRole("link", { name: "第二页会话" })).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("搜索会话"), { target: { value: "ticket-2084" } });
  expect(await screen.findByRole("link", { name: session.title })).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([input]) => input === "/api/sessions?page=1&pageSize=20&query=ticket-2084"))
    .toBe(true);
});

it("列表二次确认后永久删除空闲 Session 并原地移除", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/sessions?page=1&pageSize=20" && (init?.method ?? "GET") === "GET") return response(page([session]));
    if (url === "/api/agents") return response([agent]);
    if (url === `/api/sessions/${session.id}` && init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: `删除 ${session.title}` }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent("全部对话历史和工作区都会永久删除");
  fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

  await waitFor(() => expect(screen.queryByRole("link", { name: session.title })).not.toBeInTheDocument());
  expect(window.location.pathname).toBe("/sessions");
  expect(fetchMock.mock.calls.some(([input, init]) =>
    input === `/api/sessions/${session.id}` && init?.method === "DELETE"
  )).toBe(true);
});

it("运行中的 Session 禁止删除", async () => {
  const running = { ...session, status: "running" };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/sessions?page=1&pageSize=20") return response(page([running]));
    if (url === "/api/agents") return response([agent]);
    throw new Error(`Unexpected request: ${url}`);
  }));
  render(<App />);

  expect(await screen.findByRole("button", { name: `删除 ${session.title}` })).toBeDisabled();
});

it("已清理存储的 Session 仍可查看统计但不能继续发送", async () => {
  const cleaned = { ...session, storageCleanedAt: "2026-08-24T00:00:00.000Z" };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/sessions?page=1&pageSize=20") return response(page([cleaned]));
    if (url === `/api/sessions/${session.id}`) {
      return response({
        ...cleaned,
        runs: [],
        hasOlderRuns: false,
        usageSummary: { sessionCount: 1, measuredSessionCount: 1, usage: cleaned.usage }
      });
    }
    if (url === "/api/agents") return response([agent]);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);

  expect(await screen.findByText("存储已清理")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: session.title }));
  expect(await screen.findByText("该会话已过期，工作区和执行器上下文已清理；历史与 Token 统计仍保留。"))
    .toBeInTheDocument();
  expect(screen.getByLabelText("发送给智能体")).toBeDisabled();
});

it("详情页删除成功后返回 Session 列表", async () => {
  window.history.replaceState({}, "", `/sessions/${session.id}`);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/sessions/${session.id}` && (init?.method ?? "GET") === "GET") return response({ ...session, runs: [] });
    if (url === "/api/agents") return response([agent]);
    if (url === `/api/sessions/${session.id}` && init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url === "/api/sessions?page=1&pageSize=20") return response(page([]));
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: `删除 ${session.title}` }));
  fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

  await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
});
