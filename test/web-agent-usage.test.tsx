// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserRouter } from "react-router";
import { I18nProvider } from "../src/web/i18n.js";
import { AgentUsagePage } from "../src/web/pages/agent-usage-page.js";

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const usage = { inputTotalTokens: 3000, outputTotalTokens: 300, totalTokens: 3300, cacheReadTokens: 1000 };
const summary = { usage, locatedUsage: usage, unplacedUsage: { totalTokens: 200 }, completeness: "partial", accountingBasis: "model_requests",
  observedModelRequests: 4, requestsWithCompleteUsage: 3, requestsWithMissingUsage: 1, requestsWithPartialUsage: 0,
  unverifiedObservations: 0, conflictingRanges: 0, asOf: "2026-09-21T01:00:00Z", analysisStatus: "ready" };
const ranks = [{ capability: { id: "search", name: "search", serverId: "7", kind: "mcp_tool" }, calls: 2, failures: 1,
  definitionInputTokens: 20, firstResultInputTokens: 300, repeatedResultInputTokens: 300, totalInputTokens: 620, exposureCount: 3,
  measurement: "estimated", tokenizationStatus: "single", inputBytes: 100, tokenEstimates: [], estimateCompleteness: "partial", missingExposureCount: 1, contextCoverage: { full: 2, partial: 1, opaque: 0, none: 0 } },
{ capability: { id: "read", name: "read", serverId: "8", kind: "mcp_tool" }, calls: 1, failures: 0, totalInputTokens: null,
  definitionInputTokens: null, firstResultInputTokens: null, repeatedResultInputTokens: null, exposureCount: 0,
  measurement: "estimated", tokenizationStatus: "single", inputBytes: 100, tokenEstimates: [], estimateCompleteness: "none", missingExposureCount: 0, contextCoverage: { full: 0, partial: 0, opaque: 0, none: 0 } }];
beforeEach(() => {
  sessionStorage.setItem("apiToken", "test-token");
  window.history.replaceState({}, "", "/usage?range=all");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/agents") return response([{ id: 1, name: "Example Agent" }]);
    if (url.pathname === "/api/sessions") return response({ items: [{ id: 2, title: "Example Session", agentId: 1 }] });
    if (url.pathname === "/api/usage/summary") return response(summary);
    if (url.pathname === "/api/usage/capabilities") return response({ items: ranks, total: ranks.length });
    if (url.pathname === "/api/usage/timeseries") return response({ items: [{ period: "2026-09-21", usage }] });
    if (url.pathname === "/api/usage/sources") return response([]);
    if (url.pathname === "/api/usage/context-evidence") return response({ items: [{ id: "evidence-1", capability: ranks[0]!.capability,
      modelInvocationId: "request-2", occurredAt: "2026-09-21T01:00:00Z", sessionId: "2", exposureCount: 1 }], nextCursor: null });
    if (url.pathname === "/api/usage/invocations") return response({ origin: "counted", items: [{ id: "call-1", capability: ranks[0]!.capability,
      origin: "execution", status: "succeeded", startedAt: "2026-09-21T01:00:00Z", sessionId: "2" }], nextCursor: null });
    if (url.pathname === "/api/usage/invocations/call-1") return response({ invocation: { status: "succeeded", origin: "execution", executionId: "1", executionEvidence: "inferred" },
      bodyStatus: "not_retained", exposures: [], subsequentModelInvocationIds: [] });
    if (url.pathname === "/api/usage/context-evidence/evidence-1") return response({ context: { modelInvocationId: "request-2", sessionId: "2", providerEpochId: "epoch-1" },
      bodyStatus: "not_retained", exposures: [{ modelInvocationId: "request-2", position: 1, tokens: 300, kind: "result", resultFirstUse: "repeat" }],
      subsequentModelInvocationIds: ["request-2"] });
    throw new Error(`Unexpected request ${url.pathname}`);
  }));
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });
const mount = () => render(<I18nProvider><BrowserRouter><AgentUsagePage /></BrowserRouter></I18nProvider>);

it("切换排名排序只刷新排名，保留已经加载的汇总和趋势", async () => {
  mount(); await screen.findByText("3,300"); await screen.findByRole("button", { name: "查看 search 的调用" });
  const fetch = vi.mocked(globalThis.fetch); fetch.mockClear();
  fireEvent.change(screen.getByLabelText("排序"), { target: { value: "inputBytes" } });
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes("/usage/capabilities") && String(url).includes("sort=inputBytes"))).toBe(true));
  expect(screen.getByText("3,300")).toBeInTheDocument();
  expect(fetch.mock.calls.filter(([url]) => /\/usage\/(summary|timeseries|sources)/.test(String(url)))).toEqual([]);
});

it("展示未知模型兜底估算和混合计量来源，保留可排名的数值", async () => {
  const metadata = { measurement: "estimated", method: "model_tokenizer", model: "example-a", modelProvider: null,
    tokenizer: "@huggingface/tokenizers", tokenizerVersion: "0.2.0", tokenizerId: "a", tokenizerRevision: "a".repeat(64), encoding: null, reason: null };
  const fetch = vi.mocked(globalThis.fetch); const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (input, init) => {
    if (String(input).includes("/usage/capabilities")) return response({ total: 2, items: [
      { ...ranks[0], totalInputTokens: 30, tokenizationStatus: "mixed", inputBytes: 1024,
        tokenEstimates: [{ ...metadata, totalInputTokens: 10, exposureCount: 1, knownExposureCount: 1 },
          { ...metadata, model: "example-b", tokenizerId: "b", totalInputTokens: 20, exposureCount: 1, knownExposureCount: 1 }] },
      { ...ranks[1], exposureCount: 1, inputBytes: 64, tokenizationStatus: "single", totalInputTokens: 16,
        definitionInputTokens: 0, firstResultInputTokens: 16, repeatedResultInputTokens: 0, tokenEstimates: [
        { ...metadata, model: "closed-model", method: "text_heuristic", heuristicVersion: "unicode-weighted-v1", tokenizer: null, tokenizerVersion: null, tokenizerId: null,
          tokenizerRevision: null, reason: "model_unmapped", totalInputTokens: 16, exposureCount: 1, knownExposureCount: 1 }] }
    ] });
    return original(input, init);
  });
  mount();
  expect(await screen.findByText("混合估算，明细见各模型")).toBeInTheDocument();
  expect(screen.getByText(/closed-model.*未配置模型词表/)).toBeInTheDocument();
  expect(screen.getByText(/兜底估算/)).toBeInTheDocument();
  expect(screen.getByText("16 估算 Token")).toBeInTheDocument();
  expect(screen.queryByText("无法估算")).not.toBeInTheDocument();
  expect(screen.getByText(/example-a.*a/)).toBeInTheDocument();
  expect(screen.getByText(/example-b.*b/)).toBeInTheDocument();
  expect(screen.queryByText("未采集模型输入")).not.toBeInTheDocument();
  expect(screen.getByText("1,024")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("排序"), { target: { value: "inputBytes" } });
  await waitFor(() => expect(window.location.search).toContain("sort=inputBytes"));
});

it("区分已知模型总量、估算工具输入和未采集状态，并能打开重复输入证据", async () => {
  mount();
  expect(await screen.findByRole("heading", { name: "用量分析" })).toBeInTheDocument();
  expect(await screen.findByText("3,300")).toBeInTheDocument();
  expect(screen.getByText("数据不完整")).toBeInTheDocument();
  expect(screen.getByText("部分估算 · 1 项输入未知 · 上下文：2 完整 / 1 部分")).toBeInTheDocument();
  expect(screen.getAllByText("未采集模型输入").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "查看 search 的调用" }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("capabilityServerId=7"))).toBe(true));
  fireEvent.click(await screen.findByRole("button", { name: /打开调用/ }));
  expect(await screen.findByText(/这次实际调用没有关联到持久化的模型输入证据/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "模型输入证据" }));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("origin=context"))).toBe(true));
  fireEvent.click(await screen.findByRole("button", { name: /打开输入证据/ }));
  expect((await screen.findAllByText("request-2")).length).toBeGreaterThan(0);
  expect(screen.getByText("正文未保留；以下为持久化的计数和关联证据。")).toBeInTheDocument();
});
it.each(["skill", "plugin", "mcp_tool", "unknown"])("%s 的输入证据可追溯模型请求且不虚构调用", async (kind) => {
  const capability = { id: "unused", name: "Input capability", kind };
  window.history.replaceState({}, "", `/usage?range=all&dimension=${kind}`);
  const fetch = vi.mocked(globalThis.fetch); const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/usage/capabilities") return response({ items: [{ ...ranks[0], capability, calls: 0, failures: 0 }], total: 1 });
    if (url.pathname === "/api/usage/invocations") return response({ items: [], nextCursor: null });
    if (url.pathname === "/api/usage/context-evidence") {
      expect(url.searchParams.get("capabilityKind")).toBe(kind);
      return response({ items: [{ id: "input-1", capability, modelInvocationId: "captured-request", occurredAt: "2026-09-21T01:00:00Z", exposureCount: 1 }], nextCursor: null });
    }
    if (url.pathname === "/api/usage/context-evidence/input-1") return response({
      context: { id: "input-1", capability, modelInvocationId: "captured-request", providerEpochId: "epoch-1", sessionId: "2" },
      exposures: [{ modelInvocationId: "captured-request", toolInvocationId: kind === "mcp_tool" ? null : "original-call",
        position: 0, kind: kind === "mcp_tool" ? "definition" : "result", tokens: 20, resultFirstUse: null }], bodyStatus: "not_retained"
    });
    return original(input, init);
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "查看 Input capability 的调用" }));
  expect(await screen.findByText("没有匹配的实际调用。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "模型输入证据" }));
  fireEvent.click(await screen.findByRole("button", { name: "打开输入证据 input-1" }));
  expect(await screen.findByText("持久化证据")).toBeInTheDocument();
  expect(screen.getAllByText("captured-request").length).toBeGreaterThan(0);
  if (kind === "mcp_tool") expect(screen.getByText(/定义 · 位置 0/)).toBeInTheDocument();
  else expect(screen.getByText(/original-call/)).toBeInTheDocument();
});

it("Agent、Session 与排名维度筛选保留在 URL 并传给同一查询", async () => {
  mount(); await screen.findByText("3,300");
  fireEvent.change(screen.getByLabelText("智能体筛选"), { target: { value: "1" } });
  await waitFor(() => expect(window.location.search).toContain("agentId=1"));
  fireEvent.change(screen.getByLabelText("会话筛选"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("能力维度"), { target: { value: "plugin" } });
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("dimension=plugin") && String(url).includes("sessionId=2"))).toBe(true));
});
it("加载失败有重试入口，缺少数据有接入指引", async () => {
  const fetch = vi.mocked(globalThis.fetch); const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (input, init) => String(input).includes("/usage/summary")
    ? new Response("{}", { status: 500 }) : original(input, init));
  mount(); expect(await screen.findByRole("button", { name: "重试" })).toBeInTheDocument();
  fetch.mockImplementation(async (input, init) => String(input).includes("/usage/summary") ? response({ ...summary,
    usage: { totalTokens: null }, completeness: "none", observedModelRequests: 0, analysisStatus: "empty" })
    : String(input).includes("/usage/capabilities") ? response({ items: [], total: 0 }) : original(input, init));
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("尚无用量记录")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "查看接入方法" })).toBeInTheDocument();
});

it("模型台账为空时仍显示执行调用与未知输入", async () => {
  const fetch = vi.mocked(globalThis.fetch); const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (input, init) => String(input).includes("/usage/summary") ? response({ ...summary,
    usage: { totalTokens: null }, completeness: "none", observedModelRequests: 0, analysisStatus: "empty" })
    : original(input, init));
  mount();
  expect(await screen.findByText("2 / 1")).toBeInTheDocument();
  expect(screen.getByText("部分估算 · 1 项输入未知 · 上下文：2 完整 / 1 部分")).toBeInTheDocument();
  expect(screen.queryByText("尚无用量记录")).not.toBeInTheDocument();
});

it("模型台账与排名都为空时仍显示 Skill 阶段证据", async () => {
  window.history.replaceState({}, "", "/usage?range=all&dimension=skill");
  const fetch = vi.mocked(globalThis.fetch); const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (input, init) => String(input).includes("/usage/summary") ? response({ ...summary,
    usage: { totalTokens: null }, completeness: "none", observedModelRequests: 0, analysisStatus: "empty" })
    : String(input).includes("/usage/capabilities") ? response({ items: [], total: 0, stages: [{
      capability: { id: "review", name: "Review", kind: "skill", version: "1" }, stage: "catalog_visible", count: 1
    }] }) : original(input, init));
  mount();
  expect(await screen.findByText("Review · 目录可见 · 1")).toBeInTheDocument();
  expect(screen.queryByText("尚无用量记录")).not.toBeInTheDocument();
});

it("已选范围为空时提供清除筛选，而不是显示首次接入指引", async () => {
  window.history.replaceState({}, "", "/usage?range=7d");
  const fetch = vi.mocked(globalThis.fetch); const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (input, init) => String(input).includes("/usage/summary") ? response({ ...summary,
    usage: { totalTokens: null }, completeness: "none", observedModelRequests: 0, analysisStatus: "empty" })
    : String(input).includes("/usage/capabilities") ? response({ items: [], total: 0 }) : original(input, init));
  mount();
  expect(await screen.findByText("当前筛选没有记录")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  await waitFor(() => expect(window.location.search).toContain("range=all"));
});

it("Runtime 筛选把 Claude 别名归一到主机标识", async () => {
  window.history.replaceState({}, "", "/usage?range=all&runtimeKind=claude-code");
  mount();
  const select = await screen.findByLabelText("运行时");
  expect(select).toHaveValue("claude_code");
  expect(screen.queryByRole("option", { name: "claude-code" })).not.toBeInTheDocument();
  await waitFor(() => expect(window.location.search).toContain("runtimeKind=claude_code"));
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("runtimeKind=claude_code"))).toBe(true));
});

it("手动采集从 202 collecting 轮询到 completed，并在后台刷新指标", async () => {
  const fetch = vi.mocked(globalThis.fetch); const original = fetch.getMockImplementation()!;
  const idle = { id: "source-1", sourceKey: "synthetic-source", kind: "claude_log", status: "idle", errorCode: null,
    rejectedRecords: 0, lastSuccessAt: null, mappings: [{ sessionId: "2", state: "active" }] };
  let sourceGets = 0;
  let summaryGets = 0;
  let resolvePoll!: (value: Response) => void;
  fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/usage/sources" && (init?.method ?? "GET") === "GET") {
      sourceGets += 1;
      if (sourceGets === 1) return response([idle]);
      return new Promise<Response>((resolve) => { resolvePoll = resolve; });
    }
    if (url.pathname === "/api/usage/sources/source-1/collect") return response({ ...idle, status: "collecting" }, 202);
    if (url.pathname === "/api/usage/summary") {
      summaryGets += 1;
      return response(summaryGets === 1 ? summary : { ...summary, usage: { ...usage, totalTokens: 9900 } });
    }
    return original(input, init);
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "重新采集" }));
  expect(await screen.findByRole("button", { name: "采集中" })).toBeDisabled();
  expect(screen.getByText("3,300")).toBeInTheDocument();
  await act(async () => resolvePoll(response([{ ...idle, status: "completed", lastSuccessAt: "2026-09-21T02:00:00Z" }])));
  expect(await screen.findByText("9,900")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重新采集" })).toBeEnabled();
  expect(fetch.mock.calls.filter(([input]) => String(input).includes("/usage/capabilities")).length).toBe(2);
  expect(fetch.mock.calls.filter(([input]) => String(input).includes("/usage/timeseries")).length).toBe(2);
});

it("手动采集失败后停止轮询并恢复重试入口", async () => {
  const fetch = vi.mocked(globalThis.fetch); const original = fetch.getMockImplementation()!;
  const idle = { id: "source-2", sourceKey: "failed-source", kind: "context_snapshot", status: "idle", errorCode: null,
    rejectedRecords: 0, lastSuccessAt: null, mappings: [{ sessionId: "2", state: "active" }] };
  let sourceGets = 0;
  fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/usage/sources" && (init?.method ?? "GET") === "GET") {
      sourceGets += 1;
      return response(sourceGets === 1 ? [idle] : [{ ...idle, status: "failed", errorCode: "provider_log_malformed" }]);
    }
    if (url.pathname === "/api/usage/sources/source-2/collect") return response({ ...idle, status: "collecting" }, 202);
    return original(input, init);
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "重新采集" }));
  expect(await screen.findByText("provider_log_malformed")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重新采集" })).toBeEnabled();
  await waitFor(() => expect(sourceGets).toBe(2));
});

it("页面卸载会中止仍在进行的采集状态请求", async () => {
  const fetch = vi.mocked(globalThis.fetch); const original = fetch.getMockImplementation()!;
  const collecting = { id: "source-3", sourceKey: "slow-source", kind: "codex_log", status: "collecting", errorCode: null,
    rejectedRecords: 0, lastSuccessAt: null, mappings: [{ sessionId: "2", state: "active" }] };
  let sourceGets = 0;
  let pollSignal: AbortSignal | null = null;
  fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/usage/sources") {
      sourceGets += 1;
      if (sourceGets === 1) return response([collecting]);
      pollSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    }
    return original(input, init);
  });
  const page = mount();
  await waitFor(() => expect(pollSignal).not.toBeNull());
  page.unmount();
  expect(pollSignal!.aborted).toBe(true);
});

it("把上下文证据数与实际调用分开并显示待恢复会话", async () => {
  const fetch = vi.mocked(globalThis.fetch); const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (input, init) => String(input).includes("/usage/summary") ? response({ ...summary,
    accountingBasis: "interval_totals", collectionFailures: [{ sessionId: "2", status: "failed", errorCode: "usage_discovery_failed" }] })
    : String(input).includes("/usage/capabilities") ? response({ items: [{ ...ranks[0], contextOnlyCalls: 3 }], total: 1 })
    : original(input, init));
  mount();
  expect(await screen.findByText("上下文证据：3")).toBeInTheDocument();
  expect(screen.getByText("2 / 1")).toBeInTheDocument();
  expect(screen.getByText("采集尚未完成")).toBeInTheDocument();
  expect(screen.getByText(/会话 2/)).toBeInTheDocument();
  expect(screen.getByText("累计增量区间")).toBeInTheDocument();
});

it("后台发现失败在没有来源注册时仍刷新到恢复成功", async () => {
  const fetch = vi.mocked(globalThis.fetch); const original = fetch.getMockImplementation()!;
  let gets = 0;
  fetch.mockImplementation(async (input, init) => String(input).includes("/usage/summary")
    ? response(++gets === 1 ? { ...summary, collectionFailures: [{ sessionId: "2", status: "failed", errorCode: "usage_discovery_failed" }] }
      : { ...summary, collectionFailures: [], usage: { ...usage, totalTokens: 8800 } }) : original(input, init));
  mount();
  expect(await screen.findByText("8,800", {}, { timeout: 2000 })).toBeInTheDocument();
  expect(screen.queryByText("采集尚未完成")).not.toBeInTheDocument();
});

it("失败来源后台恢复时无需等到 collecting 就刷新指标", async () => {
  const fetch = vi.mocked(globalThis.fetch); const original = fetch.getMockImplementation()!;
  let gets = 0; let summaries = 0;
  const source = { id: "retry", sourceKey: "retry", kind: "claude_log", status: "failed", errorCode: "usage_collection_failed", mappings: [], rejectedRecords: 0, lastSuccessAt: null };
  fetch.mockImplementation(async (input, init) => String(input).endsWith("/usage/sources")
    ? response([{ ...source, status: ++gets === 1 ? "failed" : "completed", errorCode: null }])
    : String(input).includes("/usage/summary") ? response({ ...summary, usage: { ...usage, totalTokens: ++summaries === 1 ? 3300 : 7700 } }) : original(input, init));
  mount(); expect(await screen.findByText("7,700", {}, { timeout: 2000 })).toBeInTheDocument();
});
it("自动采集尚未观察到请求时显示等待状态并刷新到已观察", async () => {
  const fetch = vi.mocked(globalThis.fetch); const original = fetch.getMockImplementation()!; let gets = 0;
  fetch.mockImplementation(async (input, init) => String(input).includes("/usage/summary") ? response({ ...summary,
    captureHealth: [{ sessionId: "2", runtimeKind: "codex", status: ++gets === 1 ? "waiting" : "observed", observed: gets === 1 ? 0 : 1, incomplete: 0, errorCode: null }] }) : original(input, init));
  mount(); expect(await screen.findByText(/已观察 1 次请求/)).toBeInTheDocument();
});
it("等待首次请求达到轮询上限后安静停止，不把正常空闲状态显示成加载失败", async () => {
  vi.useFakeTimers();
  try {
    const fetch = vi.mocked(globalThis.fetch); const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => String(input).includes("/usage/summary") ? response({ ...summary,
      captureHealth: [{ sessionId: "2", runtimeKind: "codex", status: "waiting", observed: 0, incomplete: 0, errorCode: null }] }) : original(input, init));
    mount(); await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("3,300")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    const requests = fetch.mock.calls.filter(([input]) => String(input).includes("/usage/summary")).length;
    expect(requests).toBe(61);
    expect(screen.getByText("等待请求，覆盖尚未验证")).toBeInTheDocument();
    expect(screen.queryByText("用量分析加载失败")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetch.mock.calls.filter(([input]) => String(input).includes("/usage/summary"))).toHaveLength(requests);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "刷新采集状态" })); await vi.advanceTimersByTimeAsync(0); });
    expect(fetch.mock.calls.filter(([input]) => String(input).includes("/usage/summary")).length).toBeGreaterThan(requests);
  } finally { vi.useRealTimers(); }
});
