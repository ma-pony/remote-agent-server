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
  title: "Grab Manager 爬虫开发",
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
    endpointName: "Grab Manager 爬虫开发",
    endpointSlug: "grab-impl",
    conversationKey: "ticket-2084",
    latestRequestId: "dispatch-2084-2"
  },
  createdAt: now,
  updatedAt: now
};
const response = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

beforeEach(() => {
  sessionStorage.setItem("apiToken", "secret-token");
  window.history.replaceState({}, "", "/sessions");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/sessions") return response([session]);
    if (url === "/api/agents") return response([agent]);
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it("Session 列表与创建表单分离", async () => {
  render(<App />);
  expect((await screen.findAllByRole("link", { name: "Grab Manager 爬虫开发" }))[0]).toBeInTheDocument();
  expect(screen.queryByLabelText("会话标题")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "新建会话" }));
  await waitFor(() => expect(window.location.pathname).toBe("/sessions/new"));
  expect(await screen.findByLabelText("会话标题")).toBeInTheDocument();
});

it("列表展示会话来源、项目环境和累计 Token，并支持按外部标识搜索", async () => {
  render(<App />);

  expect(await screen.findByText("ticket-2084")).toBeInTheDocument();
  expect(screen.getByText("/grab-impl")).toBeInTheDocument();
  expect(screen.getByText("爬虫项目环境")).toBeInTheDocument();
  expect(screen.getByText("12,345")).toBeInTheDocument();
  expect(screen.getByText("会话 #session-1")).toBeInTheDocument();

  const search = screen.getByLabelText("搜索会话");
  fireEvent.change(search, { target: { value: "ticket-2084" } });
  expect(screen.getAllByRole("link", { name: session.title })[0]).toBeInTheDocument();
  fireEvent.change(search, { target: { value: "ticket-9999" } });
  expect(screen.queryByRole("link", { name: session.title })).not.toBeInTheDocument();
});

it("列表二次确认后永久删除空闲 Session 并原地移除", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/sessions" && (init?.method ?? "GET") === "GET") return response([session]);
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
    if (url === "/api/sessions") return response([running]);
    if (url === "/api/agents") return response([agent]);
    throw new Error(`Unexpected request: ${url}`);
  }));
  render(<App />);

  expect(await screen.findByRole("button", { name: `删除 ${session.title}` })).toBeDisabled();
});

it("详情页删除成功后返回 Session 列表", async () => {
  window.history.replaceState({}, "", `/sessions/${session.id}`);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/sessions/${session.id}` && (init?.method ?? "GET") === "GET") return response({ ...session, runs: [] });
    if (url === "/api/agents") return response([agent]);
    if (url === `/api/sessions/${session.id}` && init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url === "/api/sessions") return response([]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: `删除 ${session.title}` }));
  fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

  await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
});
