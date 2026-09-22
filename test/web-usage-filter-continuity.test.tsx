// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {BrowserRouter} from "react-router";
import {I18nProvider} from "../src/web/i18n.js";
import {PagedResourceSelect} from "../src/web/components/paged-resource-select.js";
import {AgentUsagePage} from "../src/web/pages/agent-usage-page.js";
const json = (value: unknown) => new Response(JSON.stringify(value), {headers: {"content-type": "application/json"}});
const page = (items: unknown[]) => ({items, page: 1, pageSize: 20, total: items.length, totalPages: items.length ? 1 : 0});
const requests: URL[] = [];
beforeEach(() => {
  requests.length = 0;
  sessionStorage.setItem("apiToken", "test");
  window.history.replaceState({}, "", "/usage");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost"); requests.push(url);
    if (url.pathname === "/api/agents") return json(page([{id: 1, name: "Agent"}]));
    if (url.pathname === "/api/sessions") return json(page([{id: 25, agentId: 1, title: "Session 25"}]));
    if (url.pathname === "/api/usage/sources") return json(page([]));
    if (url.pathname === "/api/usage/timeseries") return json({items: [], total: 0});
    if (url.pathname === "/api/usage/capabilities") return json({items: [], total: 0, stages: [], stageTotal: 0});
    if (url.pathname === "/api/usage/summary") return json({usage: {totalTokens: null}, locatedUsage: {totalTokens: null}, unplacedUsage: {totalTokens: null},
      completeness: "partial", observedModelRequests: 0, requestsWithCompleteUsage: 0, requestsWithMissingUsage: 0, requestsWithPartialUsage: 0,
      unverifiedObservations: 0, conflictingRanges: 0, analysisStatus: "ready", hasCapabilityEvidence: true});
    throw Error(`Unexpected request ${url}`);
  }));
});
afterEach(() => {cleanup(); vi.unstubAllGlobals(); sessionStorage.clear();});
const mount = () => render(<I18nProvider><BrowserRouter><AgentUsagePage /></BrowserRouter></I18nProvider>);
const lastRanking = () => requests.findLast(url => url.pathname === "/api/usage/capabilities");
it("retains Session 25 through CLI and All capabilities after each rendered selection", async () => {
  mount();
  await screen.findByRole("option", {name: "Session 25"});
  fireEvent.change(screen.getByLabelText("会话筛选"), {target: {value: "25"}});
  await waitFor(() => expect(lastRanking()?.searchParams.get("sessionId")).toBe("25"));
  fireEvent.change(screen.getByLabelText("能力维度"), {target: {value: "cli"}});
  await waitFor(() => expect(lastRanking()?.searchParams.get("dimension")).toBe("cli"));
  expect(lastRanking()?.searchParams.get("sessionId")).toBe("25");
  fireEvent.change(screen.getByLabelText("能力维度"), {target: {value: "all"}});
  await waitFor(() => expect(lastRanking()?.searchParams.get("dimension")).toBe("all"));
  expect(lastRanking()?.searchParams.get("sessionId")).toBe("25");
  expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("25");
  expect(screen.getByLabelText("会话筛选")).toHaveValue("25");
});
it("retains Session when subsequent filters run before the navigation render commits", async () => {
  mount(); await screen.findByRole("option", {name: "Session 25"});
  act(() => {
    fireEvent.change(screen.getByLabelText("会话筛选"), {target: {value: "25"}});
    fireEvent.change(screen.getByLabelText("能力维度"), {target: {value: "cli"}});
    fireEvent.change(screen.getByLabelText("能力维度"), {target: {value: "all"}});
  });
  await waitFor(() => expect(lastRanking()?.searchParams.get("dimension")).toBe("all"));
  expect(new URLSearchParams(window.location.search).get("sessionId")).toBe("25");
  expect(lastRanking()?.searchParams.get("sessionId")).toBe("25");
});

it("does not rewrite the selected Session when the selector endpoint changes or an old page arrives late", async () => {
  let finishOld!: (value: Response) => void;
  const oldPage = new Promise<Response>(resolve => {finishOld = resolve;});
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    return url.searchParams.get("agentId") === "1" ? oldPage : json(page([{id: 26, title: "Another Session"}]));
  }));
  const changed = vi.fn();
  const selector = (endpoint: string) => <I18nProvider><PagedResourceSelect<{id: number; title: string}>
    endpoint={endpoint} ariaLabel="Session selector" value="25" selectedLabel="Selected Session 25"
    onValueChange={changed} getOption={item => ({value: String(item.id), label: item.title})} /></I18nProvider>;
  const mounted = render(selector("/sessions?agentId=1"));
  mounted.rerender(selector("/sessions?agentId=2"));
  await screen.findByRole("option", {name: "Another Session"});
  await act(async () => {finishOld(json(page([{id: 25, title: "Stale Session"}])));});
  expect(screen.getByLabelText("Session selector")).toHaveValue("25");
  expect(screen.getByRole("option", {name: "Selected Session 25"})).toBeInTheDocument();
  expect(screen.queryByRole("option", {name: "Stale Session"})).not.toBeInTheDocument();
  expect(changed).not.toHaveBeenCalled();
});
