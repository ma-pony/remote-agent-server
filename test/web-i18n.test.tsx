// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  document.documentElement.lang = "";
  window.history.replaceState({}, "", "/agents");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

it("首次访问默认显示中文，并可切换和持久化英文", () => {
  const first = render(<App />);

  expect(screen.getByRole("heading", { name: "连接智能体服务" })).toBeInTheDocument();
  expect(document.documentElement.lang).toBe("zh-CN");

  fireEvent.click(screen.getByRole("button", { name: "切换为 English" }));

  expect(screen.getByRole("heading", { name: "Connect to Remote Agent" })).toBeInTheDocument();
  expect(document.documentElement.lang).toBe("en");
  expect(localStorage.getItem("remote-agent-locale")).toBe("en");

  first.unmount();
  render(<App />);
  expect(screen.getByRole("heading", { name: "Connect to Remote Agent" })).toBeInTheDocument();
});

it("错误 API 令牌不能进入管理台或写入浏览器会话", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    error: { code: "unauthorized", message: "Invalid API token" }
  }), {
    status: 401,
    headers: { "content-type": "application/json" }
  }));
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  fireEvent.change(screen.getByLabelText("API 令牌"), { target: { value: "wrong-token" } });
  fireEvent.click(screen.getByRole("button", { name: "进入管理台" }));

  expect(await screen.findByText("API 令牌无效")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "连接智能体服务" })).toBeInTheDocument();
  expect(sessionStorage.getItem("apiToken")).toBeNull();
  expect(fetchMock).toHaveBeenCalledWith("/api/auth/verify", expect.objectContaining({
    headers: { authorization: "Bearer wrong-token" }
  }));
});

it("验证正确 API 令牌后才进入管理台并保存令牌", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/auth/verify") return new Response(null, { status: 204 });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  fireEvent.change(screen.getByLabelText("API 令牌"), { target: { value: "correct-token" } });
  fireEvent.click(screen.getByRole("button", { name: "进入管理台" }));

  expect(await screen.findByRole("heading", { name: "智能体" })).toBeInTheDocument();
  expect(sessionStorage.getItem("apiToken")).toBe("correct-token");
});

it("启动时清除浏览器中已经失效的 API 令牌", async () => {
  sessionStorage.setItem("apiToken", "stale-token");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    error: { code: "unauthorized", message: "Invalid API token" }
  }), {
    status: 401,
    headers: { "content-type": "application/json" }
  })));

  render(<App />);

  expect(await screen.findByRole("heading", { name: "连接智能体服务" })).toBeInTheDocument();
  await waitFor(() => expect(sessionStorage.getItem("apiToken")).toBeNull());
});

it("控制台导航和页面随语言切换，并在中文模式下使用完整中文名称", async () => {
  sessionStorage.setItem("apiToken", "test-token");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", {
    status: 200,
    headers: { "content-type": "application/json" }
  })));

  render(<App />);

  expect(await screen.findByRole("heading", { name: "智能体" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "项目环境" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "会话" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "接入端点" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "切换为 English" }));

  expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Project environments" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Sessions" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Integration endpoints" })).toBeInTheDocument();
});

it("README 默认中文并链接独立英文版", () => {
  const root = process.cwd();
  const chinese = readFileSync(join(root, "README.md"), "utf8");
  const english = readFileSync(join(root, "README.en.md"), "utf8");

  expect(chinese).toContain("Remote Agent Server 是一个");
  expect(chinese).toContain("[English](README.en.md)");
  expect(english).toContain("Remote Agent Server is a self-hosted");
  expect(english).toContain("[简体中文](README.md)");
});
