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
