// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/web/app.js";

const now = "2026-08-13T00:00:00.000Z";
const environment = { id: "environment-1", name: "Grab Manager", currentRevisionId: "revision-1", lastCheckedAt: now, repositories: [], currentRevision: null, latestRevision: null, createdAt: now, updatedAt: now };
const response = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

beforeEach(() => {
  sessionStorage.setItem("apiToken", "secret-token");
  window.history.replaceState({}, "", "/project-environments");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/project-environments") return response([environment]);
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it("项目环境列表与创建表单分离", async () => {
  render(<App />);
  expect(await screen.findByRole("link", { name: "Grab Manager" })).toBeInTheDocument();
  expect(screen.queryByLabelText("项目环境名称")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "新建项目环境" }));
  await waitFor(() => expect(window.location.pathname).toBe("/project-environments/new"));
  expect(await screen.findByLabelText("项目环境名称")).toBeInTheDocument();
});
