// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/web/app.js";

const now = "2026-08-13T00:00:00.000Z";
const revision = {
  id: "revision-1", projectEnvironmentId: "environment-1", status: "ready" as const,
  workspacePath: "/srv/remote-agent/environments/environment-1/revisions/revision-1/workspace",
  inputFingerprint: "input-v1", failureStage: null, error: null, createdAt: now, finishedAt: now
};
const environment = {
  id: "environment-1", name: "Grab Manager", currentRevisionId: "revision-1", lastCheckedAt: now,
  workspacePath: revision.workspacePath,
  sync: { status: "idle" as const, automatic: true as const, intervalMs: 10_800_000, nextScheduledAt: "2026-08-13T03:00:00.000Z" },
  repositories: [{
    id: "repository-1", projectEnvironmentId: "environment-1", name: "grab-manager-api",
    gitUrl: "git@example.test:rcc/grab-manager-api.git", prepareCommand: "bundle install",
    workspacePath: `${revision.workspacePath}/grab-manager-api`, createdAt: now, updatedAt: now
  }],
  currentRevision: revision, latestRevision: revision, createdAt: now, updatedAt: now
};
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

it("展示整个项目环境的同步计划和路径，并可立即同步", async () => {
  window.history.replaceState({}, "", `/project-environments/${environment.id}`);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/project-environments/${environment.id}` && (init?.method ?? "GET") === "GET") return response(environment);
    if (url === `/api/project-environments/${environment.id}/sync` && init?.method === "POST") return response({ accepted: true });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByText(revision.workspacePath)).toBeInTheDocument();
  expect(screen.getByText("每 3 小时")).toBeInTheDocument();
  expect(screen.getByText("2026/8/13 11:00:00")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "立即同步" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) =>
    input === `/api/project-environments/${environment.id}/sync` && init?.method === "POST"
  )).toBe(true));
  expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/check"))).toBe(false);
});

it("项目列表展示实际路径并说明随环境整体同步", async () => {
  window.history.replaceState({}, "", `/project-environments/${environment.id}/repositories`);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/project-environments/${environment.id}`) return response(environment);
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<App />);

  expect(await screen.findByText(`${revision.workspacePath}/grab-manager-api`)).toBeInTheDocument();
  expect(screen.getByText("随项目环境整体同步")).toBeInTheDocument();
});

it("同步排队时禁止重复触发", async () => {
  window.history.replaceState({}, "", `/project-environments/${environment.id}`);
  const queued = { ...environment, sync: { ...environment.sync, status: "queued" as const } };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `/api/project-environments/${environment.id}`) return response(queued);
    throw new Error(`Unexpected request: ${url}`);
  }));

  render(<App />);

  expect(await screen.findByRole("button", { name: "等待同步" })).toBeDisabled();
});
