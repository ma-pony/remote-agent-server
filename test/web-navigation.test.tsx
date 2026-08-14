// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" }
});

beforeEach(() => {
  sessionStorage.setItem("apiToken", "secret-token");
  window.history.replaceState({}, "", "/agents");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/agents" || url === "/api/project-environments" || url === "/api/integration-endpoints") return jsonResponse([]);
    if (url === "/api/sessions") return jsonResponse([]);
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("使用侧栏链接在四个资源列表间导航", async () => {
  render(<App />);

  const navigation = await screen.findByRole("navigation", { name: "主导航" });
  const environmentsLink = screen.getByRole("link", { name: "项目环境" });
  expect(navigation).toContainElement(environmentsLink);

  fireEvent.click(environmentsLink);

  await waitFor(() => expect(window.location.pathname).toBe("/project-environments"));
  expect(await screen.findByRole("heading", { name: "项目环境" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("link", { name: "接入端点" }));
  await waitFor(() => expect(window.location.pathname).toBe("/integration-endpoints"));
  expect(await screen.findByRole("heading", { name: "接入端点" })).toBeInTheDocument();
});

it("移动端从侧栏导航后自动关闭抽屉", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  });
  render(<App />);

  await waitFor(() => expect(screen.getByRole("button", { name: "切换导航" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "切换导航" }));
  expect(await screen.findByRole("dialog", { name: "Sidebar" })).toBeInTheDocument();
  const navigation = await screen.findByRole("navigation", { name: "主导航" });
  fireEvent.click(within(navigation).getByRole("link", { name: "项目环境" }));

  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).not.toBeInTheDocument());
});
