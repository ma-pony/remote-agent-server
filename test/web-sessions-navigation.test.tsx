// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/web/app.js";

const now = "2026-08-13T00:00:00.000Z";
const agent = { id: "agent-1", name: "主力 Codex", provider: "codex", enabled: true, projectEnvironmentId: "environment-1", createdAt: now, updatedAt: now };
const session = { id: "session-1", agentId: agent.id, title: "修复工单 1332", status: "idle", providerSessionId: null, workspacePath: "/tmp/session-1", projectEnvironmentRevisionId: "revision-1", createdAt: now, updatedAt: now };
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
  expect(await screen.findByRole("link", { name: "修复工单 1332" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Session 标题")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "新建 Session" }));
  await waitFor(() => expect(window.location.pathname).toBe("/sessions/new"));
  expect(await screen.findByLabelText("Session 标题")).toBeInTheDocument();
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
  expect(screen.getByRole("alertdialog")).toHaveTextContent("全部对话历史和 Workspace 都会永久删除");
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
