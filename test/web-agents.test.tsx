// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";

const now = "2026-08-13T00:00:00.000Z";
const environment = {
  id: "environment-1", name: "Grab Manager", currentRevisionId: "revision-1", lastCheckedAt: now,
  repositories: [], currentRevision: null, latestRevision: null, createdAt: now, updatedAt: now
};
const agent = {
  id: "agent-1", name: "主力 Codex", provider: "codex", enabled: true,
  projectEnvironmentId: environment.id, createdAt: now, updatedAt: now
};
const response = (value: unknown): Response => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json" }
});

beforeEach(() => {
  sessionStorage.setItem("apiToken", "secret-token");
  window.history.replaceState({}, "", "/agents");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/agents") return response([agent]);
    if (url === "/api/project-environments") return response([environment]);
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("Agent 列表只负责浏览，并从独立页面创建 Agent", async () => {
  render(<App />);

  expect(await screen.findByRole("link", { name: "主力 Codex" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Agent 名称")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("link", { name: "新建 Agent" }));
  await waitFor(() => expect(window.location.pathname).toBe("/agents/new"));
  expect(await screen.findByRole("heading", { name: "新建 Agent" })).toBeInTheDocument();
  expect(screen.getByLabelText("Agent 名称")).toBeInTheDocument();
});

it("在 Agent 独立 Skills 页面搜索并启用 Skill", async () => {
  window.history.replaceState({}, "", `/agents/${agent.id}/skills`);
  const skills = [{
    id: "skill-review", name: "code-review", description: "Review current changes",
    source: "codex", enabled: false, available: true
  }];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/skills` && (init?.method ?? "GET") === "GET") return response(skills);
    if (url === `/api/agents/${agent.id}/skills/skill-review` && init?.method === "PUT") {
      expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
      skills[0] = { ...skills[0]!, enabled: true };
      return response(skills[0]);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }));

  render(<App />);

  expect(await screen.findByText("code-review")).toBeInTheDocument();
  expect(screen.getByText("已启用 0 / 1。配置会在下一次 Run 生效。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "启用" }));
  expect(await screen.findByText("已启用 1 / 1。配置会在下一次 Run 生效。")).toBeInTheDocument();
});
