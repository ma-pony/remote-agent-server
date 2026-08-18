// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";

const now = "2026-08-13T00:00:00.000Z";
const environment = {
  id: "environment-1", name: "示例平台", currentRevisionId: "revision-1", lastCheckedAt: now,
  repositories: [], currentRevision: null, latestRevision: null, createdAt: now, updatedAt: now
};
const agent = {
  id: "agent-1", name: "主力 Codex", provider: "codex", enabled: true,
  instructions: "先运行测试再给出结论。",
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
  expect(screen.queryByLabelText("智能体名称")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("link", { name: "新建智能体" }));
  await waitFor(() => expect(window.location.pathname).toBe("/agents/new"));
  expect(await screen.findByRole("heading", { name: "新建智能体" })).toBeInTheDocument();
  expect(screen.getByLabelText("智能体名称")).toBeInTheDocument();
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

it("Skills 已启用项排在前面且描述单行省略并悬浮显示全文", async () => {
  window.history.replaceState({}, "", `/agents/${agent.id}/skills`);
  const enabledDescription = "这是一段较长的完整 Skill 描述，用于验证单行省略和悬浮全文。";
  const skills = [
    { id: "skill-disabled", name: "disabled-skill", description: "未启用说明", source: "codex", enabled: false, available: true },
    { id: "skill-enabled", name: "enabled-skill", description: enabledDescription, source: "codex", enabled: true, available: true }
  ];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/skills`) return response(skills);
    throw new Error(`Unexpected request: GET ${url}`);
  }));

  render(<App />);

  const enabledName = await screen.findByText("enabled-skill");
  const disabledName = screen.getByText("disabled-skill");
  expect(enabledName.compareDocumentPosition(disabledName) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  const description = screen.getByText(enabledDescription);
  expect(description).toHaveClass("line-clamp-1");
  expect(description).toHaveAttribute("title", enabledDescription);
});

it("新建支持的 Agent 时提交智能体指令，Hermes 明确禁用该配置", async () => {
  window.history.replaceState({}, "", "/agents/new");
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/project-environments") return response([environment]);
    if (url === "/api/agents" && init?.method === "POST") {
      requests.push(JSON.parse(String(init.body)));
      return response(agent);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }));

  render(<App />);

  fireEvent.change(await screen.findByLabelText("智能体名称"), { target: { value: "审核智能体" } });
  const instructions = screen.getByLabelText("智能体指令");
  fireEvent.change(instructions, { target: { value: "只报告可以复现的问题。" } });
  fireEvent.click(screen.getByRole("button", { name: "创建智能体" }));
  await waitFor(() => expect(requests).toEqual([{
    name: "审核智能体",
    provider: "codex",
    projectEnvironmentId: environment.id,
    instructions: "只报告可以复现的问题。"
  }]));

  cleanup();
  window.history.replaceState({}, "", "/agents/new");
  render(<App />);
  fireEvent.change(await screen.findByLabelText("执行器"), { target: { value: "hermes" } });
  expect(screen.getByLabelText("智能体指令")).toBeDisabled();
  expect(screen.getByText("Hermes 当前不支持智能体指令")).toBeInTheDocument();
});

it("在设置页修改 Codex 智能体指令", async () => {
  window.history.replaceState({}, "", `/agents/${agent.id}/settings`);
  let patchBody: unknown;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}` && (init?.method ?? "GET") === "GET") return response(agent);
    if (url === "/api/project-environments") return response([environment]);
    if (url === `/api/agents/${agent.id}` && init?.method === "PATCH") {
      patchBody = JSON.parse(String(init.body));
      return response({ ...agent, ...(patchBody as object) });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }));

  render(<App />);

  const instructions = await screen.findByLabelText("智能体指令");
  expect(instructions).toHaveValue("先运行测试再给出结论。");
  fireEvent.change(instructions, { target: { value: "修改后只影响新会话。" } });
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

  await waitFor(() => expect(patchBody).toMatchObject({
    name: agent.name,
    projectEnvironmentId: environment.id,
    instructions: "修改后只影响新会话。"
  }));
});
