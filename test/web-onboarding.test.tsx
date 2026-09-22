// @vitest-environment jsdom
import { pagedManagementResponse } from "./paged-management-response.js";

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";

const now = "2026-09-17T00:00:00.000Z";
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});
const environment = {
  id: 1, name: "示例平台", currentRevisionId: 1, lastCheckedAt: now, workspacePath: null,
  sync: { status: "idle", automatic: true, intervalMs: 3_600_000, nextScheduledAt: now },
  repositories: [], currentRevision: null, latestRevision: null, createdAt: now, updatedAt: now
};
const preparingEnvironment = {
  ...environment,
  currentRevisionId: null,
  latestRevision: { id: 4, projectEnvironmentId: 1, status: "preparing", workspacePath: null, inputFingerprint: "input", failureStage: null, error: null, createdAt: now, finishedAt: null }
};
const agent = {
  id: 1, name: "主力 Codex", provider: "codex", enabled: true, instructions: "",
  projectEnvironmentId: environment.id, createdAt: now, updatedAt: now
};

beforeEach(() => {
  sessionStorage.setItem("apiToken", "secret-token");
  window.history.replaceState({}, "", "/agents");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (new URL(url, "http://localhost").pathname === "/api/agents" || new URL(url, "http://localhost").pathname === "/api/project-environments") return pagedManagementResponse(url, []);
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("first-use Agent list directs users to create an environment before an Agent", async () => {
  render(<App />);

  expect(await screen.findByText(/项目环境 → 智能体 → 会话/)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "新建智能体" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "新建项目环境" })).toHaveAttribute("href", "/project-environments/new");
});

it("first-use Agent list sends users to an unready environment instead of the Agent form", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (new URL(url, "http://localhost").pathname === "/api/agents") return pagedManagementResponse(url, []);
    if (new URL(url, "http://localhost").pathname === "/api/project-environments") return pagedManagementResponse(url, [preparingEnvironment]);
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<App />);

  expect(await screen.findByText(/项目环境正在准备/)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "新建智能体" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "查看项目环境" })).toHaveAttribute("href", "/project-environments");
});

it("Agent creation distinguishes an unavailable environment from a loaded empty selector", async () => {
  window.history.replaceState({}, "", "/agents/new");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (new URL(url, "http://localhost").pathname === "/api/project-environments") return pagedManagementResponse(url, [preparingEnvironment]);
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<App />);

  expect(await screen.findByText(/现有项目环境尚未准备完成/)).toBeInTheDocument();
  expect(screen.getByLabelText("项目环境")).toBeDisabled();
  expect(screen.getByRole("link", { name: "查看项目环境" })).toHaveAttribute("href", "/project-environments");
});

it("Agent creation keeps environment loading and request failures distinct", async () => {
  window.history.replaceState({}, "", "/agents/new");
  let rejectRequest: (reason?: unknown) => void = () => undefined;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectRequest = reject; })));

  render(<App />);

  expect(screen.getByText("正在加载项目环境。")).toBeInTheDocument();
  expect(screen.getByLabelText("项目环境")).toBeDisabled();

  rejectRequest(new Error("environment service unavailable"));
  expect(await screen.findByText("无法加载项目环境，请检查服务后重试。")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(screen.getByLabelText("项目环境")).toBeDisabled();
});

it("Session creation distinguishes no enabled Agents and requires a nonblank title", async () => {
  window.history.replaceState({}, "", "/sessions/new");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (new URL(url, "http://localhost").pathname === "/api/agents") return pagedManagementResponse(url, [agent]);
    if (new URL(url, "http://localhost").pathname === `/api/agents/${agent.id}/session-parameters`) return pagedManagementResponse(url, []);
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<App />);

  expect(await screen.findByLabelText("会话标题")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "创建会话" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("会话标题"), { target: { value: "  第一次任务  " } });
  await waitFor(() => expect(screen.getByRole("button", { name: "创建会话" })).toBeEnabled());

  cleanup();
  window.history.replaceState({}, "", "/sessions/new");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (new URL(url, "http://localhost").pathname === "/api/agents") return pagedManagementResponse(url, []);
    throw new Error(`Unexpected request: ${url}`);
  }));
  render(<App />);
  expect(await screen.findByText(/没有匹配资源/)).toBeInTheDocument();
  expect(screen.getByLabelText("选择智能体")).toBeDisabled();
  expect(screen.getByRole("link", { name: "前往智能体" })).toHaveAttribute("href", "/agents");
});

it("Session creation keeps Agent loading and request failures distinct", async () => {
  window.history.replaceState({}, "", "/sessions/new");
  let rejectRequest: (reason?: unknown) => void = () => undefined;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectRequest = reject; })));

  render(<App />);

  expect(screen.getByRole("status")).toBeInTheDocument();
  expect(screen.getByLabelText("选择智能体")).toBeDisabled();

  rejectRequest(new Error("agent service unavailable"));
  expect(await screen.findByText("agent service unavailable")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(screen.getByLabelText("选择智能体")).toBeDisabled();
});

it("the token gate identifies the generated API_TOKEN without displaying a secret", () => {
  sessionStorage.clear();
  render(<App />);

  expect(screen.getByText(/pnpm run init/)).toBeInTheDocument();
  expect(screen.getByText("API_TOKEN", { exact: false })).toBeInTheDocument();
  expect(screen.getByLabelText("API 令牌")).toHaveAttribute("type", "password");
});
