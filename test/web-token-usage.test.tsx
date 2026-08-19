// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";

const fetchEventSourceMock = vi.hoisted(() => vi.fn());

vi.mock("@microsoft/fetch-event-source", () => ({ fetchEventSource: fetchEventSourceMock }));

const now = "2026-08-19T01:00:00.000Z";
const agent = {
  id: "agent-usage",
  name: "Usage Codex",
  provider: "codex",
  enabled: true,
  instructions: "",
  projectEnvironmentId: "environment-1",
  createdAt: now,
  updatedAt: now
};
const usage = {
  inputTokens: 12_000,
  outputTokens: 2_000,
  cachedReadTokens: 8_000,
  cachedWriteTokens: null,
  thoughtTokens: 600,
  totalTokens: 14_000,
  contextUsedTokens: 24_373,
  contextWindowTokens: 258_400
};
const summary = {
  sessionCount: 1,
  measuredSessionCount: 1,
  usage: {
    inputTokens: 12_000,
    outputTokens: 2_000,
    cachedReadTokens: 8_000,
    cachedWriteTokens: null,
    thoughtTokens: 600,
    totalTokens: 14_000
  }
};

const response = (body: unknown): Response => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" }
});

beforeEach(() => {
  fetchEventSourceMock.mockReset();
  sessionStorage.setItem("apiToken", "secret-token");
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("在 Session 累计区展示执行器上报的精确累计用量", async () => {
  window.history.replaceState({}, "", "/sessions/session-usage");
  const runs = [
    {
      id: "run-measured", sessionId: "session-usage", status: "succeeded", input: "处理任务",
      result: "完成", error: null, createdAt: now, startedAt: now, finishedAt: now, usage
    },
    {
      id: "run-unknown", sessionId: "session-usage", status: "succeeded", input: "旧任务",
      result: "完成", error: null, createdAt: now, startedAt: now, finishedAt: now, usage: null
    }
  ];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/sessions/session-usage") return response({
      id: "session-usage", agentId: agent.id, title: "用量会话", status: "idle",
      providerSessionId: null, workspacePath: "/tmp/session", projectEnvironmentRevisionId: null,
      instructionsSnapshot: "", createdAt: now, updatedAt: now, runs, usageSummary: summary
    });
    if (url === "/api/agents") return response([agent]);
    if (url.endsWith("/events?afterSeq=0")) return response([]);
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<App />);

  const cumulative = await screen.findByRole("heading", { name: "累计 Token 用量" });
  const cumulativeCard = cumulative.closest("div[data-slot='card']")!;
  expect(within(cumulativeCard).getByText("总计 1.4万")).toBeInTheDocument();
  expect(within(cumulativeCard).getByText("已统计 1 / 1 个会话")).toBeInTheDocument();
  expect(screen.queryByText("输入 1.2万 · 输出 2000 · 缓存读取 8000 · 思考 600 · 总计 1.4万")).not.toBeInTheDocument();
});

it("终态事件后读取 canonical Run 和 Session 并刷新用量", async () => {
  vi.useFakeTimers();
  window.history.replaceState({}, "", "/sessions/session-live");
  const runningRun = {
    id: "run-live", sessionId: "session-live", status: "running", input: "处理任务",
    result: null, error: null, createdAt: now, startedAt: now, finishedAt: null, usage: null
  };
  const terminalRun = { ...runningRun, status: "succeeded", result: "完成", finishedAt: now, usage };
  const emptySummary = {
    sessionCount: 1,
    measuredSessionCount: 0,
    usage: {
      inputTokens: null,
      outputTokens: null,
      cachedReadTokens: null,
      cachedWriteTokens: null,
      thoughtTokens: null,
      totalTokens: null
    }
  };
  const sessionDetail = (run: typeof runningRun | typeof terminalRun, usageSummary: typeof emptySummary | typeof summary) => ({
    id: "session-live", agentId: agent.id, title: "实时用量", status: run.status === "running" ? "running" : "idle",
    providerSessionId: null, workspacePath: "/tmp/session", projectEnvironmentRevisionId: null,
    instructionsSnapshot: "", createdAt: now, updatedAt: now, runs: [run], usageSummary
  });
  let sessionReads = 0;
  let canonicalReads = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/sessions/session-live") {
      sessionReads += 1;
      return response(sessionReads === 1 ? sessionDetail(runningRun, emptySummary) : sessionDetail(terminalRun, summary));
    }
    if (url === "/api/agents") return response([agent]);
    if (url === "/api/runs/run-live/events?afterSeq=0") return response([]);
    if (url === "/api/runs/run-live") {
      canonicalReads += 1;
      return response(canonicalReads === 1 ? runningRun : terminalRun);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  let streamOptions: { onmessage?: (event: MessageEvent<string>) => void } | undefined;
  fetchEventSourceMock.mockImplementation((_url: string, options: typeof streamOptions & { signal: AbortSignal }) => {
    streamOptions = options;
    return new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
  });

  render(<App />);

  await vi.waitFor(() => expect(screen.getByText("已统计 0 / 1 个会话")).toBeInTheDocument());
  await vi.waitFor(() => expect(streamOptions).toBeDefined());
  await act(async () => {
    streamOptions?.onmessage?.({
      data: JSON.stringify({
        id: "event-terminal", runId: "run-live", seq: 1, type: "status",
        contentJson: JSON.stringify({ status: "succeeded" }), createdAt: now
      })
    } as MessageEvent<string>);
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(canonicalReads).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(249); });
  expect(canonicalReads).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(canonicalReads).toBe(2);
  expect(screen.getByText("总计 1.4万")).toBeInTheDocument();
  expect(screen.getByText("已统计 1 / 1 个会话")).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([request]) => request.toString() === "/api/sessions/session-live")).toHaveLength(2);
});

it("在 Agent 概览用英文展示所有 Session 的累计用量", async () => {
  localStorage.setItem("remote-agent-locale", "en");
  window.history.replaceState({}, "", `/agents/${agent.id}`);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/usage`) return response({
      ...summary,
      sessionCount: 4,
      measuredSessionCount: 3
    });
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<App />);

  expect(await screen.findByRole("heading", { name: "Token usage" })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Cumulative" })).toBeInTheDocument();
  expect(screen.getByText("Measured 3 / 4 sessions")).toBeInTheDocument();
});
