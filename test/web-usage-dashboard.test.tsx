// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserRouter } from "react-router";
import { I18nProvider } from "../src/web/i18n.js";
import { UsageDashboardPage } from "../src/web/pages/usage-dashboard-page.js";
import { emptyUsage } from "../src/agent-usage/core/usage.js";

const metrics = (total: number | null) => ({ ...emptyUsage(), totalTokens: total, inputTotalTokens: total, outputTotalTokens: total === null ? null : 0 });
const summary = { usage: metrics(100), completeness: "partial" };
const metadata = { asOf: "2026-10-14T01:00:00Z", timeZone: "UTC" };
const dashboard = { ...metadata, summary, unplacedUsage: emptyUsage(), counts: { newSessions: 3, activeSessions: 2, runs: 5 },
  daily: [
    { day: "2026-10-10", usage: metrics(100), newSessions: 2, activeSessions: 1, runs: 4, reportedSessions: 2, averageTokensPerSession: 50 },
    { day: "2026-10-11", usage: metrics(0), newSessions: 1, activeSessions: 1, runs: 1, reportedSessions: 1, averageTokensPerSession: 0 },
    { day: "2026-10-12", usage: metrics(null), newSessions: 0, activeSessions: 0, runs: 0, reportedSessions: 0, averageTokensPerSession: null }
  ] };
const sessions = { ...metadata, total: 75, items: [
  { sessionId: 10, title: "Review session", agentId: 1, agentName: "First agent", createdAt: "2026-10-10T00:00:00.000Z", summary },
  { sessionId: 11, title: "Unknown session", agentId: 2, agentName: "Second agent", createdAt: "2026-10-11T00:00:00.000Z", summary: { usage: metrics(null), completeness: "none" } }
] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const mount = () => render(<I18nProvider><BrowserRouter><UsageDashboardPage /></BrowserRouter></I18nProvider>);
beforeEach(() => {
  window.history.replaceState({}, "", "/dashboard?range=7");
  sessionStorage.setItem("apiToken", "test-token");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/agents") return response({ items: [{ id: 1, name: "First agent" }, { id: 2, name: "Second agent" }], total: 2, page: 1, pageSize: 20, totalPages: 1 });
    if (url.pathname === "/api/usage/dashboard") return response(dashboard);
    if (url.pathname === "/api/usage/session-trend") return response(sessions);
    throw new Error(`Unexpected request: ${url.pathname}`);
  }));
});
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); vi.unstubAllGlobals(); });
const showData = (name: string) => {
  const region = screen.getByRole("region", { name });
  fireEvent.mouseDown(within(region).getByRole("tab", { name: "明细" }), { button: 0, ctrlKey: false });
  fireEvent.click(within(region).getByRole("tab", { name: "明细" }));
  return within(region);
};

it("renders all four trends and exposes exact averages, reporting counts and Session links in data views", async () => {
  mount();
  expect(await screen.findByRole("heading", { name: "每日 token 用量" })).toBeInTheDocument();
  for (const name of ["每日 token 用量", "每日每会话平均 token", "每日会话数量", "每次会话 token 总量"]) {
    expect(screen.getByRole("group", { name })).toBeInTheDocument();
  }
  const average = showData("每日每会话平均 token");
  expect(average.getByRole("table")).toBeInTheDocument();
  expect(average.getByRole("row", { name: "2026-10-10 50 2" })).toBeInTheDocument();
  expect(average.getByRole("row", { name: "2026-10-11 0 1" })).toBeInTheDocument();
  expect(average.getByRole("row", { name: "2026-10-12 未上报 0" })).toBeInTheDocument();
  const cohort = showData("每次会话 token 总量");
  expect(cohort.getByRole("link", { name: "Review session" })).toHaveAttribute("href", "/sessions/10");
  expect(cohort.getByText("Second agent")).toBeInTheDocument();
  expect(cohort.getAllByText("未上报").length).toBeGreaterThan(0);
  expect(screen.getByText(/完整历史累计.*范围外用量/)).toBeInTheDocument();
});

it("keeps Agent and UTC date filters in both queries and resets Session pagination", async () => {
  window.history.replaceState({}, "", "/dashboard?range=7&page=2");
  mount();
  const agent = await screen.findByRole("combobox", { name: "智能体" });
  await waitFor(() => expect(agent).toBeEnabled());
  const fetch = vi.mocked(globalThis.fetch);
  expect(fetch.mock.calls.some(([input]) => String(input).includes("offset=50"))).toBe(true);
  fireEvent.change(agent, { target: { value: "2" } });
  fireEvent.change(screen.getByRole("combobox", { name: "日期范围" }), { target: { value: "30" } });
  await waitFor(() => {
    for (const endpoint of ["dashboard", "session-trend"]) expect(fetch.mock.calls.some(([input]) => {
      const url = new URL(String(input), "http://localhost");
      return url.pathname === `/api/usage/${endpoint}` && url.searchParams.get("agentId") === "2"
        && Date.parse(url.searchParams.get("to")!) - Date.parse(url.searchParams.get("from")!) === 30 * 86_400_000
        && (endpoint === "dashboard" || url.searchParams.get("offset") === "0");
    })).toBe(true);
  });
  expect(window.location.search).toContain("agentId=2");
  expect(window.location.search).not.toContain("page=");
  expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(window.location.search).toContain("page=2"));
});

it("supports keyboard inspection of unknown, zero and known chart points", async () => {
  mount();
  const region = await screen.findByRole("region", { name: "每日每会话平均 token" });
  const chart = within(region).getByRole("group", { name: "每日每会话平均 token" });
  expect(within(region).getByText("2026-10-12 · 0 个会话参与计算")).toBeInTheDocument();
  fireEvent.keyDown(chart, { key: "ArrowLeft" });
  expect(within(region).getByText("2026-10-11 · 1 个会话参与计算")).toBeInTheDocument();
  fireEvent.keyDown(chart, { key: "Home" });
  expect(within(region).getByText("2026-10-10 · 2 个会话参与计算")).toBeInTheDocument();
  expect(within(region).getByText("50", { selector: "span" })).toBeInTheDocument();
});

it("keeps pointer inspection aligned after the chart resizes to a narrow screen", async () => {
  const callbacks: ResizeObserverCallback[] = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("PointerEvent", MouseEvent);
  mount();
  const region = await screen.findByRole("region", { name: "每日每会话平均 token" });
  const chart = within(region).getByRole("group", { name: "每日每会话平均 token" });
  act(() => callbacks.forEach(callback => callback(
    [{ contentRect: new DOMRect(0, 0, 320, 248) } as ResizeObserverEntry], {} as ResizeObserver
  )));
  vi.spyOn(chart, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 248));
  fireEvent.pointerMove(chart, { clientX: 110 });
  expect(within(region).getByText("2026-10-10 · 2 个会话参与计算")).toBeInTheDocument();
  fireEvent.pointerMove(chart, { clientX: 190 });
  expect(within(region).getByText("2026-10-11 · 1 个会话参与计算")).toBeInTheDocument();
  fireEvent.pointerMove(chart, { clientX: 300 });
  expect(within(region).getByText("2026-10-12 · 0 个会话参与计算")).toBeInTheDocument();
});

it("loads Session usage independently of daily failures and allows retry and refresh", async () => {
  const fetch = vi.mocked(globalThis.fetch), original = fetch.getMockImplementation()!;
  let fail = true;
  fetch.mockImplementation((input, init) => fail && String(input).includes("/usage/dashboard")
    ? Promise.resolve(response({ error: { message: "Temporarily unavailable" } }, 503)) : original(input, init));
  mount();
  expect(await screen.findByText("每日统计加载失败")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "每次会话 token 总量" })).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  expect(await screen.findByRole("heading", { name: "每日 token 用量" })).toBeInTheDocument();
  fetch.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "刷新统计" }));
  await waitFor(() => {
    for (const endpoint of ["dashboard", "session-trend"]) expect(fetch.mock.calls.some(([input]) => String(input).includes(`/usage/${endpoint}?`))).toBe(true);
  });
});

it("shows loading and empty states without treating an empty Session page as a zero token measurement", async () => {
  const fetch = vi.mocked(globalThis.fetch), original = fetch.getMockImplementation()!;
  let complete!: (value: Response) => void;
  fetch.mockImplementation((input, init) => String(input).includes("/usage/session-trend")
    ? new Promise(resolve => { complete = resolve; }) : original(input, init));
  mount();
  expect(screen.getByLabelText("正在加载会话用量")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "刷新统计" })).toBeDisabled();
  await act(async () => complete(response({ ...metadata, total: 0, items: [] })));
  expect(screen.getByRole("heading", { name: "没有匹配的会话" })).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "每次会话 token 总量" })).not.toBeInTheDocument();
});

it("discards slow results for the previous Agent after a filter change", async () => {
  const fetch = vi.mocked(globalThis.fetch), original = fetch.getMockImplementation()!;
  const pending: Array<(value: Response) => void> = [];
  fetch.mockImplementation((input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/usage/session-trend") {
      if (!url.searchParams.has("agentId")) return new Promise(resolve => pending.push(resolve));
      return Promise.resolve(response({ ...sessions, total: 1, items: [{ ...sessions.items[0], title: "Filtered session" }] }));
    }
    return original(input, init);
  });
  mount();
  const agent = screen.getByRole("combobox", { name: "智能体" });
  await waitFor(() => expect(agent).toBeEnabled());
  fireEvent.change(agent, { target: { value: "2" } });
  expect(await screen.findByText(/Filtered session/)).toBeInTheDocument();
  await act(async () => { pending.forEach(resolve => resolve(response(sessions))); });
  expect(screen.getByText(/Filtered session/)).toBeInTheDocument();
  expect(screen.queryByText(/Unknown session/)).not.toBeInTheDocument();
});

it("renders English labels and explains unavailable daily allocation", async () => {
  localStorage.setItem("remote-agent-locale", "en");
  const fetch = vi.mocked(globalThis.fetch), original = fetch.getMockImplementation()!;
  fetch.mockImplementation((input, init) => String(input).includes("/usage/dashboard")
    ? Promise.resolve(response({ ...dashboard, unplacedUsage: metrics(200) })) : original(input, init));
  mount();
  expect(await screen.findByRole("heading", { name: "Daily average tokens per session" })).toBeInTheDocument();
  expect(screen.getByText(/Undated or cross-day usage is not distributed/)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Total tokens per session" })).toBeInTheDocument();
});
