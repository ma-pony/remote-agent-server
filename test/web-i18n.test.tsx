// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
