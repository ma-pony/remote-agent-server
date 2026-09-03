// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "../src/web/app.js";

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" }
});

beforeEach(() => {
  sessionStorage.setItem("apiToken", "secret-token");
  window.history.replaceState({}, "", "/agents");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/agents" || url === "/api/project-environments") return jsonResponse([]);
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("provides a skip link and a labelled main workspace", async () => {
  render(<App />);

  expect(await screen.findByRole("link", { name: "跳到主要内容" })).toHaveAttribute("href", "#main-content");
  expect(await screen.findByRole("main", { name: "智能体" })).toHaveAttribute("id", "main-content");
  expect(screen.getAllByRole("main")).toHaveLength(1);
});

it("shows the current product area in the persistent top bar", async () => {
  render(<App />);

  expect(await screen.findByTestId("workspace-context")).toHaveTextContent("智能体");
  expect(screen.getByText("工作台")).toBeInTheDocument();
});
