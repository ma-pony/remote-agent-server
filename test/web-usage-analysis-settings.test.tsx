// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserRouter } from "react-router";
import { I18nProvider } from "../src/web/i18n.js";
import { UsageAnalysisSettings } from "../src/web/components/usage-analysis-settings.js";
import { AgentUsagePage } from "../src/web/pages/agent-usage-page.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
let enabled = true;
let requests: Array<{ path: string; method: string; body?: string }> = [];

beforeEach(() => {
  sessionStorage.setItem("apiToken", "test-token");
  enabled = true;
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    requests.push({ path: url.pathname, method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (url.pathname === "/api/system-settings/usage-analysis") {
      if (init?.method === "PUT") enabled = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled;
      return json({ enabled });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  }));
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

const mount = (element: React.ReactElement) => render(<I18nProvider><BrowserRouter>{element}</BrowserRouter></I18nProvider>);

it("asks for confirmation before disabling usage analysis and can enable it again", async () => {
  mount(<UsageAnalysisSettings />);
  expect(await screen.findByText("已开启")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "关闭用量分析" }));
  expect(await screen.findByRole("alertdialog", { name: "关闭用量分析？" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(requests.some(({ method }) => method === "PUT")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "关闭用量分析" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认关闭" }));
  expect(await screen.findByText("已关闭")).toBeInTheDocument();
  expect(requests.find(({ method }) => method === "PUT")).toMatchObject({ body: JSON.stringify({ enabled: false }) });
  expect(screen.getByRole("status")).toHaveTextContent("已保存，将从下一次 Run 生效");

  fireEvent.click(screen.getByRole("button", { name: "开启用量分析" }));
  expect(await screen.findByText("已开启")).toBeInTheDocument();
  expect(requests.filter(({ method }) => method === "PUT").at(-1)).toMatchObject({ body: JSON.stringify({ enabled: true }) });
});

it("shows a retryable error when the switch cannot be loaded", async () => {
  const fetch = vi.mocked(globalThis.fetch), original = fetch.getMockImplementation()!;
  fetch.mockImplementationOnce(async () => json({ error: { code: "internal_error", message: "settings unavailable" } }, 500));
  fetch.mockImplementation(original);
  mount(<UsageAnalysisSettings />);
  expect(await screen.findByText("用量分析设置加载失败")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  expect(await screen.findByText("已开启")).toBeInTheDocument();
});

it("shows the disabled state on the usage analysis page without issuing analysis queries", async () => {
  enabled = false;
  window.history.replaceState({}, "", "/usage?range=all");
  mount(<AgentUsagePage />);
  expect(await screen.findByRole("heading", { name: "用量分析已关闭" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "前往系统设置" })).toHaveAttribute("href", "/system-settings/concurrency");
  expect(screen.getByRole("link", { name: "查看用量看板" })).toHaveAttribute("href", "/dashboard");
  await waitFor(() => expect(requests.map(({ path }) => path)).toEqual(["/api/system-settings/usage-analysis"]));
});
