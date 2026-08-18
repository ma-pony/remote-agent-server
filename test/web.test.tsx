// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { App } from "../src/web/app.js";
import { I18nProvider } from "../src/web/i18n.js";
import { SessionPage } from "../src/web/pages/session-page.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const fetchEventSourceMock = vi.hoisted(() => vi.fn());

vi.mock("@microsoft/fetch-event-source", () => ({
  fetchEventSource: fetchEventSourceMock
}));

const now = "2026-08-12T08:00:00.000Z";
const agent = {
  id: "agent-1",
  name: "主力 Codex",
  provider: "codex",
  enabled: true,
  projectEnvironmentId: "environment-1",
  createdAt: now,
  updatedAt: now
};
const session = {
  id: "session-1",
  agentId: agent.id,
  title: "修复工单 1332",
  status: "idle",
  providerSessionId: "provider-session-1",
  workspacePath: "/sessions/session-1/workspace",
  projectEnvironmentRevisionId: "revision-1",
  createdAt: now,
  updatedAt: now
};

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

const requestUrl = (input: RequestInfo | URL): string => typeof input === "string" ? input : input.toString();

const event = (runId: string, seq: number, type: "message" | "tool" | "status" | "error", content: unknown) => ({
  id: `${runId}-event-${seq}`,
  runId,
  seq,
  type,
  contentJson: JSON.stringify(content),
  createdAt: now
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState({}, "", "/agents");
  fetchEventSourceMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("最小管理界面", () => {
  it("Fastify 对前端深层路由回退 index.html，但不把 API 404 伪装成页面", async () => {
    const webRoot = mkdtempSync(join(tmpdir(), "remote-agent-web-"));
    mkdirSync(join(webRoot, "assets"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Remote Agent UI</title>");
    writeFileSync(join(webRoot, "assets", "app.js"), "globalThis.appLoaded = true;");
    const { db } = createTestDatabase();
    const app = buildApp({
      config: {
        host: "127.0.0.1",
        port: 3000,
        apiToken: "secret-token",
        dataDir: webRoot,
        databasePath: ":memory:",
        workspaceTemplate: "/unused/template",
        sessionsRoot: "/unused/sessions",
        maxConcurrentRuns: 1
      },
      db,
      runtime: createFakeRuntime(),
      commandRunner: { run: async () => ({ stdout: "", stderr: "" }) },
      webRoot
    });

    try {
      await app.ready();
      const page = await app.inject({ method: "GET", url: "/sessions/session-1", headers: { accept: "text/html" } });
      const headPage = await app.inject({ method: "HEAD", url: "/sessions/session-1", headers: { accept: "text/html" } });
      const jsonClient = await app.inject({ method: "GET", url: "/sessions/session-1", headers: { accept: "application/json" } });
      const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
      const missingAsset = await app.inject({ method: "GET", url: "/assets/missing.js", headers: { accept: "text/html" } });
      const extensionlessAsset = await app.inject({ method: "GET", url: "/assets/missing", headers: { accept: "text/html" } });
      const trailingAsset = await app.inject({ method: "GET", url: "/assets/missing.js/", headers: { accept: "text/html" } });
      const assetRoot = await app.inject({ method: "GET", url: "/assets/", headers: { accept: "text/html" } });
      const queriedAsset = await app.inject({ method: "GET", url: "/assets/missing?version=1", headers: { accept: "text/html" } });
      const missingFavicon = await app.inject({ method: "GET", url: "/favicon.ico", headers: { accept: "text/html" } });
      const unknownPost = await app.inject({ method: "POST", url: "/sessions/session-1", headers: { accept: "text/html" } });
      const missingApi = await app.inject({ method: "GET", url: "/api/not-a-route", headers: { authorization: "Bearer secret-token" } });
      const missingApiRoot = await app.inject({ method: "GET", url: "/api?probe=1", headers: { authorization: "Bearer secret-token" } });

      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.body).toContain("Remote Agent UI");
      expect(headPage.statusCode).toBe(200);
      expect(jsonClient.statusCode).toBe(404);
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toContain("appLoaded");
      expect(missingAsset.statusCode).toBe(404);
      expect(missingAsset.body).not.toContain("Remote Agent UI");
      expect(extensionlessAsset.statusCode).toBe(404);
      expect(trailingAsset.statusCode).toBe(404);
      expect(assetRoot.statusCode).toBe(404);
      expect(queriedAsset.statusCode).toBe(404);
      expect(missingFavicon.statusCode).toBe(404);
      expect(unknownPost.statusCode).toBe(404);
      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.headers["content-type"]).toContain("application/json");
      expect(missingApi.json()).toEqual({ error: { code: "not_found", message: "API route not found" } });
      expect(missingApiRoot.headers["content-type"]).toContain("application/json");
    } finally {
      await app.close();
      db.close();
      rmSync(webRoot, { recursive: true, force: true });
    }
  });

  it("历史 terminal status 覆盖陈旧 running 快照并解锁输入", async () => {
    sessionStorage.setItem("apiToken", "secret-token");
    window.history.replaceState({}, "", `/sessions/${session.id}`);
    const staleRun = {
      id: "run-stale",
      sessionId: session.id,
      status: "running",
      input: "完成这轮",
      result: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === `/api/sessions/${session.id}`) return jsonResponse({ ...session, status: "running", runs: [staleRun] });
      if (url === "/api/agents") return jsonResponse([agent]);
      if (url === "/api/runs/run-stale/events?afterSeq=0") return jsonResponse([
        event("run-stale", 1, "message", { stream: "output", text: "已经完成" }),
        event("run-stale", 2, "status", { status: "succeeded" })
      ]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<App />);

    expect(await screen.findByText("已经完成")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消运行" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("发送给智能体")).toBeEnabled();
    expect(fetchEventSourceMock).not.toHaveBeenCalled();
  });

  it("某个 Run 历史加载失败时保留 Session 和其他 Run 历史", async () => {
    sessionStorage.setItem("apiToken", "secret-token");
    window.history.replaceState({}, "", `/sessions/${session.id}`);
    const runs = [
      { id: "run-ok", sessionId: session.id, status: "succeeded", input: "读取日志", result: "旧结果", error: null, createdAt: now, startedAt: now, finishedAt: now },
      { id: "run-missing", sessionId: session.id, status: "succeeded", input: "检查配置", result: "配置正常", error: null, createdAt: now, startedAt: now, finishedAt: now }
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === `/api/sessions/${session.id}`) return jsonResponse({ ...session, runs });
      if (url === "/api/agents") return jsonResponse([agent]);
      if (url === "/api/runs/run-ok/events?afterSeq=0") return jsonResponse([
        event("run-ok", 1, "message", { stream: "output", text: "日志已读取" })
      ]);
      if (url === "/api/runs/run-missing/events?afterSeq=0") {
        return jsonResponse({ error: { code: "history_unavailable", message: "历史服务暂不可用" } }, 503);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<App />);

    expect(await screen.findByText("日志已读取")).toBeInTheDocument();
    expect(screen.getByText("检查配置")).toBeInTheDocument();
    expect(screen.getByText("配置正常")).toBeInTheDocument();
    expect(screen.getByText("历史加载失败：历史服务暂不可用")).toBeInTheDocument();
    expect(screen.getByLabelText("发送给智能体")).toBeEnabled();
  });

  it("初始加载期间和失败后禁止发送，重试可恢复且旧请求不会覆盖新 Session", async () => {
    sessionStorage.setItem("apiToken", "secret-token");
    const oldResponse = deferred<Response>();
    const oldSession = { ...session, id: "session-old", title: "旧 Session", runs: [] };
    const newSession = { ...session, id: "session-new", title: "新 Session", runs: [] };
    let failNew = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === "/api/sessions/session-old") return oldResponse.promise;
      if (url === "/api/sessions/session-new" && failNew) {
        failNew = false;
        return jsonResponse({ error: { code: "load_failed", message: "Session 加载失败" } }, 503);
      }
      if (url === "/api/sessions/session-new") return jsonResponse(newSession);
      if (url === "/api/agents") return jsonResponse([agent]);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const rendered = render(<I18nProvider><MemoryRouter><SessionPage sessionId="session-old" /></MemoryRouter></I18nProvider>);
    expect(screen.getByLabelText("发送给智能体")).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("发送给智能体").closest("form")!);
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === "/api/sessions/session-old/runs")).toBe(false);

    rendered.rerender(<I18nProvider><MemoryRouter><SessionPage sessionId="session-new" /></MemoryRouter></I18nProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Session 加载失败");
    expect(screen.getByLabelText("发送给智能体")).toBeDisabled();
    expect(screen.getByRole("button", { name: "重试加载" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    expect(await screen.findByRole("heading", { name: "新 Session" })).toBeInTheDocument();
    expect(screen.getByLabelText("发送给智能体")).toBeEnabled();

    await act(async () => oldResponse.resolve(jsonResponse(oldSession)));
    expect(screen.queryByRole("heading", { name: "旧 Session" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "新 Session" })).toBeInTheDocument();
  });

  it("Session 详情保留多轮历史，合并增量并显示工具、错误、终态、取消和继续输入", async () => {
    sessionStorage.setItem("apiToken", "secret-token");
    window.history.replaceState({}, "", `/sessions/${session.id}`);
    const oldRun = {
      id: "run-old",
      sessionId: session.id,
      status: "succeeded",
      input: "先读取日志",
      result: "日志已读取",
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: now
    };
    let nextRun = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === `/api/sessions/${session.id}`) return jsonResponse({ ...session, runs: [oldRun] });
      if (url === "/api/agents") return jsonResponse([agent]);
      if (url === "/api/runs/run-old/events?afterSeq=0") return jsonResponse([
        event("run-old", 1, "message", { stream: "output", text: "日志" }),
        event("run-old", 2, "message", { stream: "output", text: "已读取" })
      ]);
      if (url === `/api/sessions/${session.id}/runs` && init?.method === "POST") {
        nextRun += 1;
        return jsonResponse({
          ...oldRun,
          id: `run-${nextRun}`,
          status: "queued",
          input: (JSON.parse(String(init.body)) as { input: string }).input,
          result: null,
          startedAt: null,
          finishedAt: null
        }, 201);
      }
      if (url === "/api/runs/run-1/cancel" && init?.method === "POST") {
        return jsonResponse({ ...oldRun, id: "run-1", status: "running", input: "修复它", result: null, finishedAt: null });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }));

    const streams: Array<{ url: string; options: {
      headers?: Record<string, string>;
      signal?: AbortSignal;
      onmessage(message: { data: string }): void;
    } }> = [];
    fetchEventSourceMock.mockImplementation((url: string, options: typeof streams[number]["options"]) => {
      streams.push({ url, options });
      return new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
    });

    render(<App />);

    expect(await screen.findByText("先读取日志")).toBeInTheDocument();
    expect(screen.getByText("日志已读取")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("发送给智能体"), { target: { value: "修复它" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("修复它")).toBeInTheDocument();
    expect(screen.getByText("排队中")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "取消运行" })).toBeInTheDocument();
    expect(streams[0]?.url).toBe("/api/runs/run-1/events/stream?afterSeq=0");
    expect(streams[0]?.options.headers).toEqual({ authorization: "Bearer secret-token" });

    await act(async () => {
      streams[0]!.options.onmessage({ data: JSON.stringify(event("run-1", 1, "status", { text: "正在分析" })) });
      streams[0]!.options.onmessage({ data: JSON.stringify(event("run-1", 2, "message", { stream: "output", text: "已定位" })) });
      streams[0]!.options.onmessage({ data: JSON.stringify(event("run-1", 3, "message", { stream: "output", text: "问题" })) });
      streams[0]!.options.onmessage({ data: JSON.stringify(event("run-1", 4, "tool", { title: "读取配置", status: "completed", path: "config.yml" })) });
      streams[0]!.options.onmessage({ data: JSON.stringify(event("run-1", 5, "error", { message: "Provider 暂时不可用" })) });
    });

    expect(screen.getByText("正在分析")).toBeInTheDocument();
    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText("已定位问题")).toBeInTheDocument();
    const tool = screen.getByText("读取配置").closest("details")!;
    expect(within(tool).getByText("已完成")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Provider 暂时不可用");
    expect(screen.getByText("执行轨迹 · 3 条").closest("details")).not.toHaveAttribute("open");

    fireEvent.click(screen.getByRole("button", { name: "取消运行" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/runs/run-1/cancel",
      expect.objectContaining({ method: "POST" })
    ));

    await act(async () => {
      streams[0]!.options.onmessage({ data: JSON.stringify(event("run-1", 6, "status", { status: "succeeded" })) });
    });
    expect(screen.queryByRole("button", { name: "取消运行" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("发送给智能体")).toBeEnabled();

    fireEvent.change(screen.getByLabelText("发送给智能体"), { target: { value: "继续验证" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("继续验证")).toBeInTheDocument();
    await waitFor(() => expect(streams).toHaveLength(2));
  });

  it("SSE 断线后从最新 seq 重连，并在卸载时中止请求", async () => {
    vi.useFakeTimers();
    sessionStorage.setItem("apiToken", "secret-token");
    window.history.replaceState({}, "", `/sessions/${session.id}`);
    const runningRun = {
      id: "run-live",
      sessionId: session.id,
      status: "running",
      input: "继续执行",
      result: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === `/api/sessions/${session.id}`) return jsonResponse({ ...session, status: "running", runs: [runningRun] });
      if (url === "/api/agents") return jsonResponse([agent]);
      if (url === "/api/runs/run-live/events?afterSeq=0") return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    const signals: AbortSignal[] = [];
    fetchEventSourceMock
      .mockImplementationOnce((_url: string, options: { signal: AbortSignal; onmessage(message: { data: string }): void }) => {
        signals.push(options.signal);
        options.onmessage({ data: JSON.stringify(event("run-live", 7, "message", { stream: "output", text: "处理中" })) });
        return Promise.reject(new Error("connection lost"));
      })
      .mockImplementation((_url: string, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
      });

    const rendered = render(<App />);
    await vi.waitFor(() => expect(fetchEventSourceMock).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(fetchEventSourceMock).toHaveBeenCalledTimes(2);
    expect(fetchEventSourceMock.mock.calls[1]?.[0]).toBe("/api/runs/run-live/events/stream?afterSeq=7");
    expect(screen.getByText("处理中")).toBeInTheDocument();

    rendered.unmount();
    expect(signals.at(-1)?.aborted).toBe(true);
  });

  it("SSE 异常后 canonical Run 已终态时停止重连并解锁输入", async () => {
    vi.useFakeTimers();
    sessionStorage.setItem("apiToken", "secret-token");
    window.history.replaceState({}, "", `/sessions/${session.id}`);
    const runningRun = {
      id: "run-canonical",
      sessionId: session.id,
      status: "running",
      input: "等待异常收尾",
      result: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === `/api/sessions/${session.id}`) return jsonResponse({ ...session, status: "running", runs: [runningRun] });
      if (url === "/api/agents") return jsonResponse([agent]);
      if (url === "/api/runs/run-canonical/events?afterSeq=0") return jsonResponse([]);
      if (url === "/api/runs/run-canonical") return jsonResponse({ ...runningRun, status: "failed", error: "执行异常", finishedAt: now });
      throw new Error(`Unexpected request: ${url}`);
    }));
    fetchEventSourceMock.mockRejectedValue(new Error("connection lost"));

    render(<App />);
    await vi.waitFor(() => expect(fetchEventSourceMock).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(fetchEventSourceMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.getByText("执行异常")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消运行" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("发送给智能体")).toBeEnabled();
  });

  it("SSE 保持 open 但没有 terminal Event 时低频轮询 canonical Run 并收尾", async () => {
    vi.useFakeTimers();
    sessionStorage.setItem("apiToken", "secret-token");
    window.history.replaceState({}, "", `/sessions/${session.id}`);
    const runningRun = {
      id: "run-open",
      sessionId: session.id,
      status: "running",
      input: "等待 canonical 收尾",
      result: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null
    };
    let canonicalRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === `/api/sessions/${session.id}`) return jsonResponse({ ...session, status: "running", runs: [runningRun] });
      if (url === "/api/agents") return jsonResponse([agent]);
      if (url === "/api/runs/run-open/events?afterSeq=0") return jsonResponse([]);
      if (url === "/api/runs/run-open") {
        canonicalRequests += 1;
        if (canonicalRequests === 1) {
          return jsonResponse({ error: { code: "temporarily_unavailable", message: "暂时不可用" } }, 503);
        }
        return jsonResponse({ ...runningRun, status: "succeeded", result: "canonical result", finishedAt: now });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    let streamSignal!: AbortSignal;
    fetchEventSourceMock.mockImplementation((_url: string, options: { signal: AbortSignal }) => {
      streamSignal = options.signal;
      return new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    });

    render(<App />);
    await vi.waitFor(() => expect(fetchEventSourceMock).toHaveBeenCalledTimes(1));
    expect(canonicalRequests).toBe(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(canonicalRequests).toBe(1);
    expect(streamSignal.aborted).toBe(false);
    expect(screen.getByRole("button", { name: "取消运行" })).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(canonicalRequests).toBe(2);
    expect(streamSignal.aborted).toBe(true);
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("canonical result")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消运行" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("发送给智能体")).toBeEnabled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["401", () => jsonResponse({ error: { message: "Invalid API token" } }, 401)],
    ["非 SSE", () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })]
  ])("%s Event stream 是永久错误，不自动重试", async (_case, streamResponse) => {
    vi.useFakeTimers();
    sessionStorage.setItem("apiToken", "secret-token");
    window.history.replaceState({}, "", `/sessions/${session.id}`);
    const runningRun = {
      id: "run-permanent",
      sessionId: session.id,
      status: "running",
      input: "保持连接",
      result: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === `/api/sessions/${session.id}`) return jsonResponse({ ...session, status: "running", runs: [runningRun] });
      if (url === "/api/agents") return jsonResponse([agent]);
      if (url === "/api/runs/run-permanent/events?afterSeq=0") return jsonResponse([]);
      if (url === "/api/runs/run-permanent") return jsonResponse(runningRun);
      throw new Error(`Unexpected request: ${url}`);
    }));
    fetchEventSourceMock.mockImplementation(async (_url: string, options: {
      onopen?(response: Response): Promise<void> | void;
      onerror?(error: unknown): unknown;
    }) => {
      try {
        await options.onopen?.(streamResponse());
      } catch (reason) {
        options.onerror?.(reason);
      }
    });

    render(<App />);
    await vi.waitFor(() => expect(fetchEventSourceMock).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(fetchEventSourceMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("实时连接");
    expect(fetch).toHaveBeenCalledWith(
      "/api/runs/run-permanent",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("瞬时 SSE 失败按最新 cursor 重连，收到 Event 后重置退避", async () => {
    vi.useFakeTimers();
    sessionStorage.setItem("apiToken", "secret-token");
    window.history.replaceState({}, "", `/sessions/${session.id}`);
    const runningRun = {
      id: "run-retry",
      sessionId: session.id,
      status: "running",
      input: "持续执行",
      result: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === `/api/sessions/${session.id}`) return jsonResponse({ ...session, status: "running", runs: [runningRun] });
      if (url === "/api/agents") return jsonResponse([agent]);
      if (url === "/api/runs/run-retry/events?afterSeq=0") return jsonResponse([]);
      if (url === "/api/runs/run-retry") return jsonResponse(runningRun);
      throw new Error(`Unexpected request: ${url}`);
    }));
    fetchEventSourceMock
      .mockImplementationOnce(async (_url: string, options: {
        onopen?(response: Response): Promise<void> | void;
        onerror?(error: unknown): unknown;
      }) => {
        try {
          await options.onopen?.(jsonResponse({ error: { message: "temporarily unavailable" } }, 503));
        } catch (reason) {
          options.onerror?.(reason);
        }
      })
      .mockImplementationOnce((_url: string, options: { onmessage(message: { data: string }): void }) => {
        options.onmessage({ data: JSON.stringify(event("run-retry", 7, "message", { stream: "output", text: "第一段" })) });
        return Promise.reject(new Error("network two"));
      })
      .mockImplementation((_url: string, options: { signal: AbortSignal }) =>
        new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }))
      );

    render(<App />);
    await vi.waitFor(() => expect(fetchEventSourceMock).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetchEventSourceMock).toHaveBeenCalledTimes(2);
    expect(fetchEventSourceMock.mock.calls[1]?.[0]).toBe("/api/runs/run-retry/events/stream?afterSeq=0");

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetchEventSourceMock).toHaveBeenCalledTimes(3);
    expect(fetchEventSourceMock.mock.calls[2]?.[0]).toBe("/api/runs/run-retry/events/stream?afterSeq=7");
    expect(screen.getByText("第一段")).toBeInTheDocument();
  });

  it("瞬时 SSE 连续失败最多重试五次，耗尽后提供手动重连", async () => {
    vi.useFakeTimers();
    sessionStorage.setItem("apiToken", "secret-token");
    window.history.replaceState({}, "", `/sessions/${session.id}`);
    const runningRun = {
      id: "run-exhausted",
      sessionId: session.id,
      status: "running",
      input: "持续执行",
      result: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url === `/api/sessions/${session.id}`) return jsonResponse({ ...session, status: "running", runs: [runningRun] });
      if (url === "/api/agents") return jsonResponse([agent]);
      if (url === "/api/runs/run-exhausted/events?afterSeq=0") return jsonResponse([]);
      if (url === "/api/runs/run-exhausted") return jsonResponse(runningRun);
      throw new Error(`Unexpected request: ${url}`);
    }));
    fetchEventSourceMock.mockRejectedValue(new Error("network unavailable"));

    render(<App />);
    await vi.waitFor(() => expect(fetchEventSourceMock).toHaveBeenCalledTimes(1));
    for (const [index, delay] of [500, 1_000, 2_000, 4_000, 5_000].entries()) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
      expect(fetchEventSourceMock).toHaveBeenCalledTimes(index + 2);
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(fetchEventSourceMock).toHaveBeenCalledTimes(6);
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => requestUrl(input) === "/api/runs/run-exhausted")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "重新连接实时事件" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("自动重连已停止");

    fireEvent.click(screen.getByRole("button", { name: "重新连接实时事件" }));
    await vi.waitFor(() => expect(fetchEventSourceMock).toHaveBeenCalledTimes(7));
  });
});
