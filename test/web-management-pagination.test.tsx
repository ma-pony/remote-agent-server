// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {MemoryRouter, Routes, Route} from "react-router";
import {afterEach, expect, it, vi} from "vitest";
import {SessionPage} from "../src/web/pages/session-page.js";
import {AgentDetailLayout, AgentSettingsPage} from "../src/web/pages/agent-pages.js";
import {SessionSettingsPage} from "../src/web/pages/session-settings-page.js";
import {SessionCreatePage} from "../src/web/pages/session-pages.js";
import {I18nProvider} from "../src/web/i18n.js";
vi.mock("@microsoft/fetch-event-source", () => ({fetchEventSource: vi.fn()}));
afterEach(() => {cleanup(); vi.unstubAllGlobals();});
const json = (value: unknown) => new Response(JSON.stringify(value), {headers: {"content-type": "application/json"}});
const page = <T,>(items: T[], total = items.length, current = 1) => ({items, total, page: current, pageSize: 20, totalPages: Math.ceil(total / 20)});
it.each(["already expired", "expires during pagination"])("preserves final replies when raw history %s", async mode => {
  const calls: string[] = [];
  const run = {id: 1, status: "succeeded", input: "Question", result: "Preserved final reply", error: null,
    ...(mode === "already expired" ? {eventsPrunedAt: "2026-09-20T00:00:00.000Z", eventsPrunedThroughSeq: 101} : {})};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url === "/api/sessions/1?includeParameters=false") return json({id: 1, agentId: 1, title: "History", status: "idle", runs: [run], hasOlderRuns: false});
    if (url === "/api/agents/1") return json({id: 1, name: "Agent"});
    if (url === "/api/runs/1/events?afterSeq=0&limit=100") return json(Array.from({length: 100}, (_, i) => ({id: i + 1, seq: i + 1, type: "message", contentJson: JSON.stringify({stream: "output", text: "partial"})})));
    if (url === "/api/runs/1/events?afterSeq=100&limit=100") return new Response(JSON.stringify({error: {code: "run_events_expired"}}), {status: 410});
    throw Error(`Unexpected request ${url}`);
  }));
  render(<I18nProvider><MemoryRouter><SessionPage sessionId="1" /></MemoryRouter></I18nProvider>);
  if (mode === "expires during pagination") fireEvent.click(await screen.findByRole("button", {name: "加载更多事件"}));
  expect(await screen.findByText("原始事件已过期")).toBeVisible();
  expect(screen.getByText("Preserved final reply")).toBeVisible();
  expect(screen.queryByRole("button", {name: "加载更多事件"})).not.toBeInTheDocument();
  expect(screen.queryByText(/历史加载失败/)).not.toBeInTheDocument();
  if (mode === "already expired") expect(calls.some(url => url.includes("/events?"))).toBe(false);
});
it("loads bounded Run history and appends the next page without a full Agent inventory", async () => {
  const calls: string[] = [];
  const now = "2026-09-01T00:00:00.000Z";
  const event = (seq: number) => ({id: seq, runId: 1, seq, type: "message", contentJson: JSON.stringify({stream: "output", text: seq === 101 ? "last chunk" : "a"}), createdAt: now});
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url === "/api/sessions/1?includeParameters=false") return json({id: 1, agentId: 1, title: "History", status: "idle", updatedAt: now, runs: [{id: 1, status: "succeeded", input: "Question", result: "Complete result", error: null, resolvedModel: null}], hasOlderRuns: false});
    if (url === "/api/agents/1") return json({id: 1, name: "Agent"});
    if (url === "/api/runs/1/events?afterSeq=0&limit=100") return json(Array.from({length: 100}, (_, i) => event(i + 1)));
    if (url === "/api/runs/1/events?afterSeq=100&limit=100") return json([event(101)]);
    throw Error(`Unexpected request ${url}`);
  }));
  render(<I18nProvider><MemoryRouter><SessionPage sessionId="1" /></MemoryRouter></I18nProvider>);
  const more = await screen.findByRole("button", {name: "加载更多事件"});
  expect(screen.getByText("Complete result")).toBeInTheDocument();
  fireEvent.click(more);
  await waitFor(() => expect(screen.queryByRole("button", {name: "加载更多事件"})).not.toBeInTheDocument());
  expect(calls).toContain("/api/runs/1/events?afterSeq=100&limit=100");
  expect(calls).not.toContain("/api/agents");
});
it("preserves Session parameter values across pages", async () => {
  let submitted: unknown;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/agents") return json(page([{id: 1, name: "Agent", enabled: true}]));
    if (url.pathname.endsWith("session-parameters")) {const current = Number(url.searchParams.get("page")); return json(page([{id: current, key: `key${current}`, label: `Parameter ${current}`, required: false, secret: false, description: null}], 21, current));}
    if (url.pathname === "/api/sessions" && init?.method === "POST") {submitted = JSON.parse(String(init.body)); return json({id: 2});}
    throw Error(`Unexpected request ${url}`);
  }));
  render(<I18nProvider><MemoryRouter><SessionCreatePage /></MemoryRouter></I18nProvider>);
  fireEvent.change(await screen.findByLabelText("Parameter 1"), {target: {value: "first"}});
  fireEvent.click(screen.getAllByRole("button", {name: "下一页"}).find(button => !(button as HTMLButtonElement).disabled)!);
  fireEvent.change(await screen.findByLabelText("Parameter 2"), {target: {value: "second"}});
  fireEvent.change(screen.getByLabelText("会话标题"), {target: {value: "New session"}});
  fireEvent.click(screen.getByRole("button", {name: "创建会话"}));
  await waitFor(() => expect(submitted).toMatchObject({mcpParameters: {key1: "first", key2: "second"}}));
});

it("edits Session parameter pages without replacing values on other pages", async () => {
  let submitted: unknown;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/sessions/1") return json({id: 1, title: "Settings", status: "idle"});
    if (url.pathname === "/api/sessions/1/mcp-parameters" && init?.method === "PATCH") {submitted = JSON.parse(String(init.body)); return json({id: 1, title: "Settings", status: "idle"});}
    if (url.pathname === "/api/sessions/1/mcp-parameters") {const current = Number(url.searchParams.get("page")); return json(page([{key: `key${current}`, label: `Parameter ${current}`, value: `old${current}`, required: false, secret: false, configured: true, description: null}], 21, current));}
    throw Error(`Unexpected request ${url}`);
  }));
  render(<I18nProvider><MemoryRouter initialEntries={["/sessions/1/settings"]}><Routes><Route path="/sessions/:id/settings" element={<SessionSettingsPage />} /></Routes></MemoryRouter></I18nProvider>);
  fireEvent.change(await screen.findByLabelText("Parameter 1"), {target: {value: "first"}});
  fireEvent.click(screen.getByRole("button", {name: "下一页"}));
  fireEvent.change(await screen.findByLabelText("Parameter 2"), {target: {value: "second"}});
  fireEvent.click(screen.getByRole("button", {name: "保存参数"}));
  await waitFor(() => expect(submitted).toEqual({values: {key1: "first", key2: "second"}}));
});

it("preserves a configured model outside the first catalog page when saving settings", async () => {
  const agent = {id: 1, name: "Agent", provider: "codex", enabled: true, instructions: "", projectEnvironmentId: 1,
    maxConcurrentRuns: null, effectiveMaxConcurrentRuns: 4, modelPolicy: {mode: "fixed", model: "model-25"}};
  let saved: unknown;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/agents/1" && init?.method === "PATCH") {saved = JSON.parse(String(init.body)); return json(agent);}
    if (url.pathname === "/api/agents/1") return json(agent);
    if (url.pathname === "/api/agents/1/models") return json({...page(Array.from({length: 20}, (_, i) => `model-${i + 1}`), 25), supported: true, currentModel: "model-25"});
    if (url.pathname === "/api/project-environments/1/summary") return json({id: 1, name: "Environment"});
    if (url.pathname === "/api/project-environments") return json(page([{id: 1, name: "Environment"}]));
    throw Error(`Unexpected request ${url}`);
  }));
  render(<I18nProvider><MemoryRouter initialEntries={["/agents/1/settings"]}><Routes><Route path="/agents/:id" element={<AgentDetailLayout />}><Route path="settings" element={<AgentSettingsPage />} /></Route></Routes></MemoryRouter></I18nProvider>);
  const model = await screen.findByLabelText("模型");
  await waitFor(() => expect(model).not.toBeDisabled());
  expect(model).toHaveValue("model-25");
  expect(screen.getByText("Core 默认：model-25；可选 25 个模型。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", {name: "保存设置"}));
  await waitFor(() => expect(saved).toMatchObject({modelPolicy: {mode: "fixed", model: "model-25"}}));
});
