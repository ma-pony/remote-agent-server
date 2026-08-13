// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { api } from "../src/web/api.js";

beforeEach(() => {
  sessionStorage.setItem("apiToken", "secret-token");
});

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("无请求体时不声明 JSON Content-Type", async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);

  await api("/agents/agent-1", { method: "DELETE" });

  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  const headers = new Headers(init.headers);
  expect(headers.get("content-type")).toBeNull();
  expect(headers.get("authorization")).toBe("Bearer secret-token");
});

it("JSON 请求体仍自动声明 JSON Content-Type", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" }
  }));
  vi.stubGlobal("fetch", fetchMock);

  await api("/agents", { method: "POST", body: JSON.stringify({ name: "Codex" }) });

  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect(new Headers(init.headers).get("content-type")).toBe("application/json");
});
