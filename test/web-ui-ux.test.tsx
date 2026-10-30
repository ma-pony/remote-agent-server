// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/web/i18n.js";
import { CopyButton } from "../src/web/components/copy-button.js";
import { AppShellLayout } from "../src/web/components/app-shell.js";
import { MemoryRouter, Route, Routes } from "react-router";
import { lazy } from "react";
import { App } from "../src/web/app.js";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

const emptyPage = { items: [], page: 1, pageSize: 20, total: 0, totalPages: 0 };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.setItem("apiToken", "secret-token");
  window.history.replaceState({}, "", "/agents");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/agents?") || url.startsWith("/api/project-environments?")) return jsonResponse(emptyPage);
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("provides a skip link and a labelled main workspace", async () => {
  render(<App />);

  expect(await screen.findByRole("link", { name: "跳到主要内容" })).toHaveAttribute("href", "#main-content");
  expect(await screen.findByRole("main", { name: "智能体" })).toHaveAttribute("id", "main-content");
  expect(screen.getAllByRole("main")).toHaveLength(1);
});

it("shows the current product area in the persistent top bar", async () => {
  render(<App />);

  expect(await screen.findByTestId("workspace-context")).toHaveTextContent("智能体");
  expect(screen.getByText("工作台")).toBeInTheDocument();
});


it.each([
  ["/agents", "/api/agents", "智能体加载失败", "还没有智能体"],
  ["/sessions", "/api/sessions", "会话加载失败", "还没有会话"],
  ["/project-environments", "/api/project-environments", "项目环境加载失败", "还没有项目环境"],
  ["/integration-endpoints", "/api/integration-endpoints", "接入端点加载失败", "还没有接入端点"]
])("recovers a failed %s list without leaving a loading skeleton", async (route, endpoint, title, emptyTitle) => {
  window.history.replaceState({}, "", route);
  let fails = true;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    return path === endpoint && fails ? jsonResponse({ error: { message: "Temporarily unavailable" } }, 503) : jsonResponse(emptyPage);
  }));
  render(<App />);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(title);
  expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
  fails = false;
  fireEvent.click(within(alert).getByRole("button", { name: "重新加载" }));
  expect(await screen.findByRole("heading", { name: emptyTitle })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("does not hide Agents when only their onboarding environment check fails", async () => {
  let fails = true;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    return String(input).startsWith("/api/project-environments") && fails
      ? jsonResponse({ error: { message: "Environment unavailable" } }, 503) : jsonResponse(emptyPage);
  }));
  render(<App />);
  expect(await screen.findByRole("heading", { name: "还没有智能体" })).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent("项目环境信息加载失败");
  expect(screen.queryByText("正在检查项目环境…")).not.toBeInTheDocument();
  fails = false;
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(await screen.findByRole("link", { name: "新建项目环境" })).toBeInTheDocument();
});

it("keeps navigation available while a route module loads", async () => {
  const PendingPage = lazy(() => new Promise<{ default: () => null }>(() => undefined));
  render(<I18nProvider><MemoryRouter initialEntries={["/sessions"]}><Routes>
    <Route element={<AppShellLayout onDisconnect={() => undefined} />}><Route path="/sessions" element={<PendingPage />} /></Route>
  </Routes></MemoryRouter></I18nProvider>);
  expect(screen.getByRole("status")).toHaveTextContent("正在加载页面");
  expect(screen.getByRole("navigation", { name: "主导航" })).toBeVisible();
  expect(screen.getAllByRole("main")).toHaveLength(1);
});

it("marks integration endpoints active for a task detail and keeps collapsed logout labelled", () => {
  render(<I18nProvider><MemoryRouter initialEntries={["/integration-tasks/task-1"]}><Routes>
    <Route element={<AppShellLayout onDisconnect={() => undefined} />}><Route path="/integration-tasks/:id" element={<p>Task</p>} /></Route>
  </Routes></MemoryRouter></I18nProvider>);
  expect(screen.getByRole("link", { name: "接入端点" })).toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByRole("button", { name: "切换导航" }));
  expect(screen.getByRole("button", { name: "断开连接" })).toHaveAttribute("aria-label", "断开连接");
  expect(screen.queryByText("已连接")).not.toBeInTheDocument();
});

it("shows an unknown URL with a recovery link instead of silently redirecting", async () => {
  window.history.replaceState({}, "", "/no-such-page");
  render(<App />);
  expect(screen.getByRole("heading", { level: 1, name: "找不到这个页面" })).toBeInTheDocument();
  expect(window.location.pathname).toBe("/no-such-page");
  fireEvent.click(screen.getByRole("link", { name: "返回智能体" }));
  expect(await screen.findByRole("heading", { name: "智能体" })).toBeInTheDocument();
});

it("distinguishes a network failure from an invalid token and translates the error", async () => {
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Offline"); }));
  render(<App />);
  const input = screen.getByLabelText("API 令牌");
  fireEvent.change(input, { target: { value: "example-token" } });
  fireEvent.click(screen.getByRole("button", { name: "进入管理台" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("请检查网络和服务地址");
  expect(input).not.toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAccessibleDescription(/无法连接服务器/);
  fireEvent.click(screen.getByRole("button", { name: "切换为 English" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Check your network and server address");
});

it("offers a settings retry and never treats a blank retention field as zero", async () => {
  window.history.replaceState({}, "", "/system-settings/concurrency");
  const settings = { globalRunConcurrency: 4, webhookConcurrency: 3, environmentBuildConcurrency: 1, runTimeoutMinutes: 60, sessionStorageRetentionHours: 168 };
  let fails = true;
  vi.stubGlobal("fetch", vi.fn(async () => fails ? jsonResponse({ error: { message: "Unavailable" } }, 503) : jsonResponse(settings)));
  render(<App />);
  const settingsError = (await screen.findByText("设置加载失败")).closest('[role="alert"]')!;
  expect(screen.queryByText("保存失败")).not.toBeInTheDocument();
  expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
  fails = false;
  fireEvent.click(within(settingsError).getByRole("button", { name: "重新加载" }));
  const retention = await screen.findByLabelText("会话大文件保留（小时）");
  fireEvent.change(retention, { target: { value: "" } });
  expect(retention).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
  fireEvent.change(retention, { target: { value: "0" } });
  expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled();
});

it.each(["denied", "unavailable"])("never reports a successful copy when clipboard access is %s", async mode => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: mode === "unavailable" ? undefined : { writeText: vi.fn().mockRejectedValue(new Error("Denied")) } });
  render(<I18nProvider><CopyButton value="example-value" label="示例文本" /></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "复制示例文本" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("手动复制");
  expect(screen.queryByText("已复制")).not.toBeInTheDocument();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  fireEvent.click(screen.getByRole("button", { name: "复制示例文本" }));
  expect(await screen.findByText("已复制")).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledWith("example-value");
});

it.each([
  { outcome: "success", newCopy: false },
  { outcome: "failure", newCopy: false },
  { outcome: "success", newCopy: true },
  { outcome: "failure", newCopy: true }
])("ignores an old copy $outcome after the value changes (new copy started: $newCopy)", async ({ outcome, newCopy }) => {
  let resolveOld!: () => void;
  let rejectOld!: (reason: Error) => void;
  let resolveCurrent!: () => void;
  const oldCopy = new Promise<void>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
  const currentCopy = new Promise<void>(resolve => { resolveCurrent = resolve; });
  const writeText = vi.fn().mockReturnValueOnce(oldCopy).mockReturnValueOnce(currentCopy);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const { rerender } = render(<I18nProvider><CopyButton value="old-example" label="示例文本" /></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "复制示例文本" }));
  rerender(<I18nProvider><CopyButton value="current-example" label="示例文本" /></I18nProvider>);
  expect(screen.getByRole("button", { name: "复制示例文本" })).toBeEnabled();
  if (newCopy) fireEvent.click(screen.getByRole("button", { name: "复制示例文本" }));

  await act(async () => {
    if (outcome === "success") resolveOld(); else rejectOld(new Error("Old copy denied"));
    await oldCopy.catch(() => undefined);
  });
  if (newCopy) {
    expect(screen.getByRole("button", { name: "复制示例文本" })).toBeDisabled();
    expect(screen.getByText("复制中…")).toBeInTheDocument();
  } else {
    expect(screen.getByRole("button", { name: "复制示例文本" })).toBeEnabled();
    expect(screen.queryByText("复制中…")).not.toBeInTheDocument();
  }
  expect(screen.queryByText("已复制")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  if (!newCopy) fireEvent.click(screen.getByRole("button", { name: "复制示例文本" }));
  await act(async () => { resolveCurrent(); await currentCopy; });
  expect(screen.getByText("已复制")).toBeInTheDocument();
  expect(writeText.mock.calls).toEqual([["old-example"], ["current-example"]]);
});
