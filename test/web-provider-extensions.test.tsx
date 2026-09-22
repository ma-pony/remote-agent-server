// @vitest-environment jsdom
import { pagedManagementResponse } from "./paged-management-response.js";

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";

const now = "2026-08-26T00:00:00.000Z";
const agent = {
  id: 3,
  name: "爬虫开发",
  provider: "codex",
  enabled: true,
  instructions: "",
  projectEnvironmentId: 1,
  createdAt: now,
  updatedAt: now
};

const response = (value: unknown): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" }
});

beforeEach(() => {
  sessionStorage.setItem("apiToken", "secret-token");
  window.history.replaceState({}, "", `/agents/${agent.id}/extensions`);
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("按 Provider 展示插件和 Hook，并允许 Agent 显式启用", async () => {
  let enabled = false;
  const plugin = {
    id: "plugin:browser@example",
    provider: "codex",
    kind: "plugin",
    name: "browser",
    description: "浏览器自动化插件",
    version: "1.2.3",
    enabled,
    available: true
  };
  const hook = {
    id: "hook:audit",
    provider: "codex",
    kind: "hook",
    name: "PreToolUse #1",
    description: "command hook",
    version: null,
    enabled: false,
    available: true
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return pagedManagementResponse(url, agent);
    if (new URL(url, "http://localhost").pathname === `/api/agents/${agent.id}/extensions` && init?.method !== "PUT") {
      return pagedManagementResponse(url, [{ ...plugin, enabled }, hook]);
    }
    if (url === `/api/agents/${agent.id}/extensions/${encodeURIComponent(plugin.id)}` && init?.method === "PUT") {
      enabled = true;
      expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
      return pagedManagementResponse(url, { ...plugin, enabled });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByRole("heading", { name: "执行器扩展" })).toBeVisible();
  expect(screen.getByText("Codex 插件与钩子")).toBeVisible();
  expect(screen.getByText("browser")).toBeVisible();
  expect(screen.getByText("PreToolUse #1")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "启用 browser" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "停用 browser" })).toBeVisible());
});
