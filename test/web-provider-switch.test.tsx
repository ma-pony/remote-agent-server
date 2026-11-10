// @vitest-environment jsdom
import { pagedManagementResponse } from "./paged-management-response.js";

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";
import "../src/web/pages/agent-pages.js";

const now = "2026-08-13T00:00:00.000Z";
const environment = {
  id: 1, name: "示例平台", currentRevisionId: 1, lastCheckedAt: now,
  repositories: [], currentRevision: null, latestRevision: null, createdAt: now, updatedAt: now
};
const agent = {
  id: 1, name: "主力 Codex", provider: "codex", enabled: true,
  instructions: "先运行测试再给出结论。",
  projectEnvironmentId: environment.id, createdAt: now, updatedAt: now
};
const endpoint = {
  id: 7, name: "工单入口", slug: "ticket-agent", agentId: agent.id, enabled: true,
  activeConversationCount: 0, queuedTaskCount: 0, runningTaskCount: 0,
  activeTaskCount: 0, latestTask: null, createdAt: now, updatedAt: now
};
const usageSummary = {
  completeness: "none",
  usage: {
    inputTotalTokens: null, outputTotalTokens: null, cacheReadTokens: null,
    cacheWriteTokens: null, reasoningOutputTokens: null, totalTokens: null
  }
};
const response = (value: unknown): Response => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json" }
});

beforeEach(() => {
  sessionStorage.setItem("apiToken", "secret-token");
  window.history.replaceState({}, "", "/agents");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (new URL(url, "http://localhost").pathname === "/api/agents") return pagedManagementResponse(url, [agent]);
    if (new URL(url, "http://localhost").pathname === "/api/project-environments") return pagedManagementResponse(url, [environment]);
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});


it("切换执行器保留当前 Agent 页面并提交交接说明", async () => {
  window.history.replaceState({}, "", "/agents/1");
  let body: unknown;
  let complete: (response: Response) => void = () => {};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/agents/1/provider-switch") {
      body = JSON.parse(String(init?.body));
      return new Promise<Response>(resolve => { complete = resolve; });
    }
    if (url === "/api/agents/1") return response(agent);
    if (url.startsWith("/api/usage/summary")) return response(usageSummary);
    if (url.startsWith("/api/integration-endpoints")) return pagedManagementResponse(url, []);
    throw new Error(url);
  }));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "切换执行器" }));
  expect(screen.getByRole("button", { name: "确认切换" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("目标执行器"), { target: { value: "deepseek_harness" } });
  expect(screen.getByText("原生插件兼容性")).toBeInTheDocument();
  expect(screen.getByText("RTK 不受支持")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("模型配置"), { target: { value: "default" } });
  fireEvent.change(screen.getByLabelText("交接说明（可选）"), { target: { value: "  请先阅读工作区文档。  " } });
  fireEvent.click(screen.getByRole("button", { name: "确认切换" }));
  await waitFor(() => expect(body).toEqual({ provider: "deepseek_harness", modelPolicy: { mode: "provider_default" }, handoff: "请先阅读工作区文档。" }));
  expect(screen.getByRole("button", { name: "切换中…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  complete(response({ ...agent, provider: "deepseek_harness" }));
  expect(await screen.findByRole("status")).toHaveTextContent("执行器已切换");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(window.location.pathname).toBe("/agents/1");
  expect(screen.getByText("DeepSeek Harness")).toBeInTheDocument();
});

it("切换失败保留选择与原 Agent，取消不发送请求", async () => {
  window.history.replaceState({}, "", "/agents/1");
  let switches = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/agents/1/provider-switch") {
      switches++;
      return new Response(JSON.stringify({ error: { code: "agent_has_running_sessions", message: "Agent has queued work" } }), { status: 409 });
    }
    if (url === "/api/agents/1") return response(agent);
    if (url.startsWith("/api/usage/summary")) return response(usageSummary);
    if (url.startsWith("/api/integration-endpoints")) return pagedManagementResponse(url, []);
    throw new Error(url);
  }));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "切换执行器" }));
  fireEvent.change(screen.getByLabelText("目标执行器"), { target: { value: "hermes" } });
  expect(screen.getByText("指令不兼容")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认切换" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("目标执行器"), { target: { value: "deepseek_harness" } });
  fireEvent.click(screen.getByRole("button", { name: "确认切换" }));
  expect(await screen.findByText("Agent has queued work")).toBeInTheDocument();
  expect(screen.getByLabelText("目标执行器")).toHaveValue("deepseek_harness");
  expect(screen.getByRole("button", { name: "确认切换" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(switches).toBe(1);
  expect(screen.getByText("Codex")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "切换执行器" }));
  expect(screen.getByLabelText("目标执行器")).toHaveValue("codex");
  expect(screen.queryByText("Agent has queued work")).not.toBeInTheDocument();
});
