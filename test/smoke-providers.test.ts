import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertEventHistory,
  createSmokeApi,
  ensureAgent,
  ensureReadyProjectEnvironment,
  main,
  readSmokeConfig,
  waitForTerminalRun
} from "../scripts/smoke-providers.js";

const config = readSmokeConfig({ API_TOKEN: "test-token", SMOKE_RUN_TIMEOUT_MS: "20" });

afterEach(() => vi.useRealTimers());

describe("provider smoke configuration", () => {
  it("requires an API token before it can contact the server", () => {
    expect(() => readSmokeConfig({})).toThrow("API_TOKEN");
  });

  it("uses a local API URL and bounded polling defaults", () => {
    expect(readSmokeConfig({ API_TOKEN: "test-token" })).toMatchObject({
      baseUrl: "http://127.0.0.1:3000/api",
      pollIntervalMs: 1_000,
      runTimeoutMs: 300_000
    });
  });

  it("aborts a half-open response body at the request deadline and clears its timer", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })
    }));
    const api = createSmokeApi(config, fetchMock);

    const pending = api.request("/agents", "GET", undefined, 20);
    const assertion = expect(pending).rejects.toThrow("timed out after 20ms");
    await vi.advanceTimersByTimeAsync(20);

    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [[{ id: "one", seq: 2, type: "status" }]],
    [[{ id: "one", seq: 1, type: "status" }, { id: "two", seq: 3, type: "message" }]],
    [[{ id: "two", seq: 2, type: "status" }, { id: "one", seq: 1, type: "message" }]],
    [[{ id: "one", seq: 1.5, type: "status" }]]
  ])("rejects invalid event history: %j", async (events) => {
    const api = { request: vi.fn(async () => events) };

    await expect(assertEventHistory(api, "run-1")).rejects.toThrow("strictly contiguous");
  });

  it("refuses duplicate smoke Agent records and reports every ID", async () => {
    const api = {
      request: vi.fn(async () => [
        { id: "agent-1", name: "remote-agent-smoke-codex", provider: "codex", enabled: true },
        { id: "agent-2", name: "remote-agent-smoke-codex", provider: "codex", enabled: true }
      ])
    };

    await expect(ensureAgent(api, "codex", "environment-1")).rejects.toThrow("agent-1, agent-2");
  });

  it("requires a ready project environment before preparing Agents", async () => {
    const api = { request: vi.fn(async () => [{ id: "environment-1", name: "未准备", currentRevisionId: null }]) };

    await expect(ensureReadyProjectEnvironment(api)).rejects.toThrow("ready project environment");
  });

  it("prepare only ensures Agents and does not create Sessions or Runs", async () => {
    const agents = ["claude_code", "codex", "hermes"].map((provider) => ({
      id: `agent-${provider}`,
      name: `remote-agent-smoke-${provider}`,
      provider,
      enabled: true,
      projectEnvironmentId: "environment-1"
    }));
    const api = { request: vi.fn(async (path: string) => path === "/project-environments"
      ? [{ id: "environment-1", name: "默认项目环境", currentRevisionId: "revision-1" }]
      : agents) };

    await main({ API_TOKEN: "test-token" }, { args: ["--prepare"], api });

    expect(api.request).toHaveBeenCalledTimes(4);
    expect(api.request.mock.calls[0]?.[0]).toBe("/project-environments");
    expect(api.request.mock.calls.slice(1).every(([path]) => path === "/agents")).toBe(true);
  });

  it("fails immediately when a Run endpoint returns an unknown status", async () => {
    const api = { request: vi.fn(async () => ({ id: "run-1", status: "lost", result: null, error: null })) };

    await expect(waitForTerminalRun(api, config, "run-1")).rejects.toThrow("unknown status");
    expect(api.request.mock.calls[0]?.[3]).toBeGreaterThan(0);
    expect(api.request.mock.calls[0]?.[3]).toBeLessThanOrEqual(config.runTimeoutMs);
  });
});
