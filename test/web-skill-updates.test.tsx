// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/web/app.js";

const agent = { id: 31, name: "更新测试", provider: "codex", enabled: true, instructions: "", projectEnvironmentId: 1, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const current = "a".repeat(64); const latest = "b".repeat(64); const older = "c".repeat(64);
const skill = { id: "review", name: "review", description: "Review", source: "git", enabled: true, available: true, currentRevision: current, latestRevision: latest, updateAvailable: true, locallyModified: false };
const revisions = { currentRevision: current, latestRevision: latest, revisions: [
  { revision: latest, createdAt: "2026-09-14T00:00:00.000Z", name: "review", description: "new", source: "git", skillPath: "SKILL.md" },
  { revision: older, createdAt: "2026-09-13T00:00:00.000Z", name: "review", description: "old", source: "git", skillPath: "SKILL.md" }
] };

// Transform the real lazy route before starting interaction assertion deadlines.
beforeAll(async () => { await import("../src/web/pages/agent-pages.js"); });
beforeEach(() => { sessionStorage.setItem("apiToken", "test"); window.history.replaceState({}, "", `/agents/${agent.id}/skills`); });
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it("刷新来源只重新发现目录，不会应用版本", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input); calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/skills`) return response([skill]);
    if (url === "/api/skill-sources") return response([{ id: "team", name: "Team", url: "https://example.test/skills.git", ref: null, path: "", status: "ready", lastSyncedAt: null, error: null, skillCount: 1, warnings: [] }]);
    if (url === "/api/skill-sources/team/refresh" && init?.method === "POST") return response({});
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  }));
  render(<App />); fireEvent.click(await screen.findByRole("button", { name: "管理 Git 来源" }));
  fireEvent.click(await screen.findByRole("button", { name: "刷新" }));
  await waitFor(() => expect(calls).toContain("POST /api/skill-sources/team/refresh"));
  expect(calls.some((call) => call.includes("/revision"))).toBe(false);
});

it("选择版本后必须预览，才用 expectedRevision 明确应用或回滚", async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input);
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/skills`) return response([skill]);
    if (url.endsWith("/revisions")) return response(revisions);
    if (url.includes("/diff?revision=")) return response({ revision: latest, expectedRevision: current, locallyModified: false, files: [{ path: "SKILL.md", status: "modified", before: "old", after: "new", beforeMode: 420, afterMode: 420 }] });
    if (url.endsWith("/revision") && init?.method === "POST") { bodies.push(JSON.parse(String(init.body))); return response({ ...skill, currentRevision: latest }); }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  }));
  render(<App />); fireEvent.click(await screen.findByRole("button", { name: "查看更新" }));
  fireEvent.click(await screen.findByRole("button", { name: "预览变更" }));
  expect(await screen.findByText("SKILL.md")).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "应用此版本" }));
  await waitFor(() => expect(bodies).toEqual([{ revision: latest, expectedRevision: current }]));
});

it("本地修改时显示恢复指引，并且不提交应用", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { const url = String(input);
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/skills`) return response([{ ...skill, locallyModified: true }]);
    if (url.endsWith("/revisions")) return response(revisions);
    if (url.includes("/diff?revision=")) return response({ revision: latest, expectedRevision: current, locallyModified: true, files: [] });
    throw new Error(`unexpected ${url}`);
  }));
  render(<App />); fireEvent.click(await screen.findByRole("button", { name: "查看更新" })); fireEvent.click(await screen.findByRole("button", { name: "预览变更" }));
  expect(await screen.findByText("检测到本地修改")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "应用此版本" })).toBeDisabled();
});

it("选择历史版本时以同一预览流程明确回滚", async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input);
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/skills`) return response([skill]);
    if (url.endsWith("/revisions")) return response(revisions);
    if (url.includes(`/diff?revision=${older}`)) return response({ revision: older, expectedRevision: current, locallyModified: false, files: [{ path: "SKILL.md", status: "modified", before: "new", after: "old", beforeMode: 420, afterMode: 420 }] });
    if (url.endsWith("/revision") && init?.method === "POST") { bodies.push(JSON.parse(String(init.body))); return response({ ...skill, currentRevision: older }); }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  }));
  render(<App />); fireEvent.click(await screen.findByRole("button", { name: "查看更新" }));
  fireEvent.change(await screen.findByLabelText("目标版本"), { target: { value: older } }); fireEvent.click(screen.getByRole("button", { name: "预览变更" }));
  fireEvent.click(await screen.findByRole("button", { name: "回滚到此版本" })); await waitFor(() => expect(bodies).toEqual([{ revision: older, expectedRevision: current }]));
});

it("预览请求失败会显示错误，并在忙碌时禁用重复预览", async () => {
  let rejectDiff: ((reason: Error) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => { const url = String(input);
    if (url === `/api/agents/${agent.id}`) return Promise.resolve(response(agent));
    if (url === `/api/agents/${agent.id}/skills`) return Promise.resolve(response([skill]));
    if (url.endsWith("/revisions")) return Promise.resolve(response(revisions));
    if (url.includes("/diff?revision=")) return new Promise<Response>((_resolve, reject) => { rejectDiff = reject; });
    throw new Error(`unexpected ${url}`);
  }));
  render(<App />); fireEvent.click(await screen.findByRole("button", { name: "查看更新" })); fireEvent.click(await screen.findByRole("button", { name: "预览变更" }));
  expect(screen.getByRole("button", { name: "预览变更" })).toBeDisabled(); rejectDiff?.(new Error("preview unavailable"));
  expect(await screen.findByText("preview unavailable")).toBeInTheDocument();
});

it("从上传 Skill 行发布新 ZIP，不会自动应用到 Agent", async () => {
  const writes: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/skills`) return response([{ ...skill, source: "upload" }]);
    if (init?.method === "POST") { writes.push({ url, body: JSON.parse(String(init.body)) }); return response(skill); }
    throw new Error(`unexpected ${url}`);
  }));
  render(<App />);
  const input = await screen.findByLabelText("为 review 上传新版本");
  fireEvent.change(input, { target: { files: [new File(["zip contents"], "review.zip", { type: "application/zip" })] } });
  await waitFor(() => expect(writes).toEqual([{ url: `/api/agents/${agent.id}/skills/review/upload`, body: { fileName: "review.zip", contentBase64: btoa("zip contents") } }]));
});

it("Git 来源表单允许 SSH scp 地址", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/skills`) return response([skill]);
    if (url === "/api/skill-sources") {
      if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return response({}); }
      return response([]);
    }
    throw new Error(`unexpected ${url}`);
  }));
  render(<App />); fireEvent.click(await screen.findByRole("button", { name: "管理 Git 来源" }));
  fireEvent.change(await screen.findByLabelText("名称"), { target: { value: "Team" } });
  const input = screen.getByLabelText("Git URL") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "git@gitlab.example.com:team/skills.git" } });
  expect(input.checkValidity()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "添加来源" }));
  await waitFor(() => expect(writes).toEqual([{ name: "Team", url: "git@gitlab.example.com:team/skills.git" }]));
});

it("重新打开版本弹窗会清除旧预览", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/agents/${agent.id}`) return response(agent);
    if (url === `/api/agents/${agent.id}/skills`) return response([skill]);
    if (url.endsWith("/revisions")) return response(revisions);
    if (url.includes("/diff?revision=")) return response({ revision: latest, expectedRevision: current, locallyModified: false, files: [] });
    throw new Error(`unexpected ${url}`);
  }));
  render(<App />); fireEvent.click(await screen.findByRole("button", { name: "查看更新" }));
  fireEvent.click(await screen.findByRole("button", { name: "预览变更" }));
  expect(await screen.findByRole("button", { name: "应用此版本" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  fireEvent.click(await screen.findByRole("button", { name: "查看更新" }));
  await screen.findByRole("button", { name: "预览变更" });
  expect(screen.queryByRole("button", { name: "应用此版本" })).not.toBeInTheDocument();
});
