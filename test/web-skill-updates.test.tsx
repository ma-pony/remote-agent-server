// @vitest-environment jsdom
import { pagedManagementResponse } from "./paged-management-response.js";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); vi.unstubAllGlobals(); });

it("刷新来源只重新发现目录，不会应用版本", async () => {
  const calls: string[] = [];
  let updateAvailable = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input); calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === `/api/agents/${agent.id}`) return pagedManagementResponse(url, agent);
    if (new URL(url, "http://localhost").pathname === `/api/agents/${agent.id}/skills`) return pagedManagementResponse(url, [{ ...skill, updateAvailable, latestRevision: updateAvailable ? latest : current }]);
    if (new URL(url, "http://localhost").pathname === "/api/skill-sources") return pagedManagementResponse(url, [{ id: "team", name: "Team", url: "https://example.test/skills.git", ref: null, path: "", status: "ready", lastSyncedAt: null, error: null, skillCount: 1, warnings: [] }]);
    if (url === "/api/skill-sources/team/refresh" && init?.method === "POST") { updateAvailable = true; return pagedManagementResponse(url, {}); }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  }));
  render(<App />); fireEvent.click(await screen.findByRole("button", { name: "管理 Git 来源" }));
  expect(screen.queryByRole("button", { name: "应用全部更新（1）" })).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "刷新" }));
  await waitFor(() => expect(calls).toContain("POST /api/skill-sources/team/refresh"));
  expect(await screen.findByRole("button", { name: "应用全部更新（1）" })).toBeInTheDocument();
  expect(calls.some((call) => call.includes("/revision"))).toBe(false);
});

it("刷新后迟到的旧 Skill 列表不会隐藏批量应用入口", async () => {
  let finishInitial: ((value: Response) => void) | undefined;
  let catalogReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/agents/${agent.id}`) return pagedManagementResponse(url, agent);
    if (new URL(url, "http://localhost").pathname === `/api/agents/${agent.id}/skills`) {
      if (url.includes("?")) return pagedManagementResponse(url, [skill]);
      if (++catalogReads === 1) return new Promise<Response>((resolve) => { finishInitial = resolve; });
      return response([skill]);
    }
    if (new URL(url, "http://localhost").pathname === "/api/skill-sources") return pagedManagementResponse(url, [{ id: "team", name: "Team", url: "https://example.test/skills.git", ref: null, path: "", status: "ready", lastSyncedAt: null, error: null, skillCount: 1, warnings: [] }]);
    if (url === "/api/skill-sources/team/refresh" && init?.method === "POST") return response({});
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  }));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "管理 Git 来源" }));
  await waitFor(() => expect(finishInitial).toBeDefined());
  fireEvent.click(await screen.findByRole("button", { name: "刷新" }));
  expect(await screen.findByRole("button", { name: "应用全部更新（1）" })).toBeInTheDocument();
  await act(async () => finishInitial?.(response([{ ...skill, latestRevision: current, updateAvailable: false }])));
  expect(screen.getByRole("button", { name: "应用全部更新（1）" })).toBeInTheDocument();
});

it("从 Git 来源弹窗批量应用当前智能体所有分页中的更新，并跳过本地修改和 ZIP", async () => {
  const other = { ...skill, id: "other-review", name: "other-review" };
  const local = { ...skill, id: "local-review", name: "local-review", locallyModified: true };
  const upload = { ...skill, id: "zip-review", name: "zip-review", source: "upload" };
  const fillers = Array.from({ length: 20 }, (_, index) => ({ ...skill, id: `idle-${index}`, name: `idle-${index}`, updateAvailable: false }));
  let catalog = [skill, ...fillers, other, local, upload];
  const writes: Array<{ id: string; body: unknown }> = [];
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === `/api/agents/${agent.id}`) return pagedManagementResponse(url, agent);
    if (new URL(url, "http://localhost").pathname === `/api/agents/${agent.id}/skills`) return pagedManagementResponse(url, catalog);
    if (new URL(url, "http://localhost").pathname === "/api/skill-sources") return pagedManagementResponse(url, []);
    const match = url.match(new RegExp(`^/api/agents/${agent.id}/skills/([^/]+)/revision$`));
    if (match && init?.method === "POST") {
      writes.push({ id: match[1]!, body: JSON.parse(String(init.body)) });
      catalog = catalog.map((item) => item.id === match[1] ? { ...item, currentRevision: latest, updateAvailable: false } : item);
      return pagedManagementResponse(url, catalog.find((item) => item.id === match[1]));
    }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  }));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "管理 Git 来源" }));
  fireEvent.click(await screen.findByRole("button", { name: "应用全部更新（2）" }));
  fireEvent.click(screen.getByRole("button", { name: /^应用全部更新$/ }));
  await waitFor(() => expect(writes).toEqual([
    { id: "review", body: { revision: latest, expectedRevision: current } },
    { id: "other-review", body: { revision: latest, expectedRevision: current } }
  ]));
  expect(await screen.findByText("已应用 2 个 Git Skill 更新")).toBeInTheDocument();
  expect(screen.getByText("因本地修改跳过：local-review")).toBeInTheDocument();
  expect(calls.some((call) => call.includes("/diff"))).toBe(false);
  expect(screen.queryByRole("button", { name: "应用全部更新（2）" })).not.toBeInTheDocument();
});

it("批量应用单项失败后继续处理其余更新并报告失败", async () => {
  const other = { ...skill, id: "other-review", name: "other-review" };
  let catalog = [skill, other];
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/agents/${agent.id}`) return pagedManagementResponse(url, agent);
    if (new URL(url, "http://localhost").pathname === `/api/agents/${agent.id}/skills`) return pagedManagementResponse(url, catalog);
    if (new URL(url, "http://localhost").pathname === "/api/skill-sources") return pagedManagementResponse(url, []);
    if (init?.method === "POST" && url.endsWith("/revision")) {
      writes.push(url);
      if (url.includes("/skills/review/")) return response({ error: { code: "skill_revision_conflict", message: "The selected version has changed" } }, 409);
      catalog = [skill, { ...other, currentRevision: latest, updateAvailable: false }];
      return pagedManagementResponse(url, catalog[1]);
    }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  }));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "管理 Git 来源" }));
  fireEvent.click(await screen.findByRole("button", { name: "应用全部更新（2）" }));
  fireEvent.click(screen.getByRole("button", { name: /^应用全部更新$/ }));
  expect(await screen.findByText("已应用 1 个 Git Skill 更新")).toBeInTheDocument();
  expect(screen.getByText("review: The selected version has changed")).toBeInTheDocument();
  expect(writes).toEqual([`/api/agents/${agent.id}/skills/review/revision`, `/api/agents/${agent.id}/skills/other-review/revision`]);
});

it("选择版本后必须预览，才用 expectedRevision 明确应用或回滚", async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input);
    if (url === `/api/agents/${agent.id}`) return pagedManagementResponse(url, agent);
    if (new URL(url, "http://localhost").pathname === `/api/agents/${agent.id}/skills`) return pagedManagementResponse(url, [skill]);
    if (new URL(url, "http://localhost").pathname.endsWith("/revisions")) return pagedManagementResponse(url, revisions);
    if (url.includes("/diff?revision=")) return pagedManagementResponse(url, { revision: latest, expectedRevision: current, baseRevision: current, previewLimitBytes: 1024 * 1024, locallyModified: false, files: [{ path: "SKILL.md", status: "modified", beforeBytes: 3, afterBytes: 3, preview: "text", beforeMode: 420, afterMode: 420 }] });
    if (url.endsWith("/revision") && init?.method === "POST") { bodies.push(JSON.parse(String(init.body))); return pagedManagementResponse(url, { ...skill, currentRevision: latest }); }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  }));
  render(<App />); fireEvent.click(await screen.findByRole("button", { name: "查看更新" }));
  fireEvent.click(await screen.findByRole("button", { name: "预览变更" }));
  expect(await screen.findByText("SKILL.md")).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "应用此版本" }));
  await waitFor(() => expect(bodies).toEqual([{ revision: latest, expectedRevision: current }]));
});

it("本地修改时显示恢复指引，并且不提交应用", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { const url = String(input);
    if (url === `/api/agents/${agent.id}`) return pagedManagementResponse(url, agent);
    if (new URL(url, "http://localhost").pathname === `/api/agents/${agent.id}/skills`) return pagedManagementResponse(url, [{ ...skill, locallyModified: true }]);
    if (new URL(url, "http://localhost").pathname.endsWith("/revisions")) return pagedManagementResponse(url, revisions);
    if (url.includes("/diff?revision=")) return pagedManagementResponse(url, { revision: latest, expectedRevision: current, locallyModified: true, files: [] });
    throw new Error(`unexpected ${url}`);
  }));
  render(<App />); fireEvent.click(await screen.findByRole("button", { name: "查看更新" })); fireEvent.click(await screen.findByRole("button", { name: "预览变更" }));
  expect(await screen.findByText("检测到本地修改")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "应用此版本" })).toBeDisabled();
});

it("选择历史版本时以同一预览流程明确回滚", async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const url = String(input);
    if (url === `/api/agents/${agent.id}`) return pagedManagementResponse(url, agent);
    if (new URL(url, "http://localhost").pathname === `/api/agents/${agent.id}/skills`) return pagedManagementResponse(url, [skill]);
    if (new URL(url, "http://localhost").pathname.endsWith("/revisions")) return pagedManagementResponse(url, revisions);
    if (url.includes(`/diff?revision=${older}`)) return pagedManagementResponse(url, { revision: older, expectedRevision: current, baseRevision: current, previewLimitBytes: 1024 * 1024, locallyModified: false, files: [{ path: "SKILL.md", status: "modified", beforeBytes: 3, afterBytes: 3, preview: "text", beforeMode: 420, afterMode: 420 }] });
    if (url.endsWith("/revision") && init?.method === "POST") { bodies.push(JSON.parse(String(init.body))); return pagedManagementResponse(url, { ...skill, currentRevision: older }); }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  }));
  render(<App />); fireEvent.click(await screen.findByRole("button", { name: "查看更新" }));
  await waitFor(() => expect(screen.getByLabelText("目标版本")).not.toBeDisabled());
  fireEvent.change(screen.getByLabelText("目标版本"), { target: { value: older } }); fireEvent.click(screen.getByRole("button", { name: "预览变更" }));
  fireEvent.click(await screen.findByRole("button", { name: "回滚到此版本" })); await waitFor(() => expect(bodies).toEqual([{ revision: older, expectedRevision: current }]));
});

it("预览请求失败会显示错误，并在忙碌时禁用重复预览", async () => {
  let rejectDiff: ((reason: Error) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => { const url = String(input);
    if (url === `/api/agents/${agent.id}`) return Promise.resolve(pagedManagementResponse(url, agent));
    if (new URL(url, "http://localhost").pathname === `/api/agents/${agent.id}/skills`) return Promise.resolve(pagedManagementResponse(url, [skill]));
    if (new URL(url, "http://localhost").pathname.endsWith("/revisions")) return Promise.resolve(pagedManagementResponse(url, revisions));
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
    if (url === `/api/agents/${agent.id}`) return pagedManagementResponse(url, agent);
    if (new URL(url, "http://localhost").pathname === `/api/agents/${agent.id}/skills`) return pagedManagementResponse(url, [{ ...skill, source: "upload" }]);
    if (init?.method === "POST") { writes.push({ url, body: JSON.parse(String(init.body)) }); return pagedManagementResponse(url, skill); }
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
    if (url === `/api/agents/${agent.id}`) return pagedManagementResponse(url, agent);
    if (new URL(url, "http://localhost").pathname === `/api/agents/${agent.id}/skills`) return pagedManagementResponse(url, [skill]);
    if (new URL(url, "http://localhost").pathname === "/api/skill-sources") {
      if (init?.method === "POST") { writes.push(JSON.parse(String(init.body))); return pagedManagementResponse(url, {}); }
      return pagedManagementResponse(url, []);
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
    if (url === `/api/agents/${agent.id}`) return pagedManagementResponse(url, agent);
    if (new URL(url, "http://localhost").pathname === `/api/agents/${agent.id}/skills`) return pagedManagementResponse(url, [skill]);
    if (new URL(url, "http://localhost").pathname.endsWith("/revisions")) return pagedManagementResponse(url, revisions);
    if (url.includes("/diff?revision=")) return pagedManagementResponse(url, { revision: latest, expectedRevision: current, locallyModified: false, files: [] });
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

const fileDiff = { revision: latest, expectedRevision: current, baseRevision: current, locallyModified: false, previewLimitBytes: 1024 * 1024, files: [
  { path: "references/guide.md", status: "modified", beforeBytes: 32_000, afterBytes: 32_100, beforeMode: 420, afterMode: 420, preview: "text" },
  { path: "scripts/check.sh", status: "modified", beforeBytes: 100, afterBytes: 110, beforeMode: 420, afterMode: 493, preview: "text" },
  { path: "image.png", status: "added", beforeBytes: null, afterBytes: 1_000, beforeMode: null, afterMode: 420, preview: "binary" },
  { path: "legacy.txt", status: "added", beforeBytes: null, afterBytes: 1_000, beforeMode: null, afterMode: 420, preview: "unsupported_encoding" },
  { path: "huge.txt", status: "added", beforeBytes: null, afterBytes: 2_000_000, beforeMode: null, afterMode: 420, preview: "too_large" }
] };
const setupFilePreview = async (preview: (url: string, init?: RequestInit) => Promise<Response>, english = false) => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/agents/${agent.id}`) return Promise.resolve(pagedManagementResponse(url, agent));
    if (new URL(url, "http://localhost").pathname === `/api/agents/${agent.id}/skills`) return Promise.resolve(pagedManagementResponse(url, [skill]));
    if (new URL(url, "http://localhost").pathname.endsWith("/revisions")) return Promise.resolve(pagedManagementResponse(url, revisions));
    if (url.includes("/diff?revision=")) return Promise.resolve(pagedManagementResponse(url, { ...fileDiff, revision: new URL(url, "http://localhost").searchParams.get("revision") }));
    if (url.includes("/diff/file?")) return preview(url, init);
    throw new Error(`unexpected ${url}`);
  }));
  if (english) localStorage.setItem("remote-agent-locale", "en");
  render(<App />); fireEvent.click(await screen.findByRole("button", { name: english ? "View update" : "查看更新" }));
  fireEvent.click(await screen.findByRole("button", { name: english ? "Preview changes" : "预览变更" }));
  await screen.findByText("references/guide.md");
};

it("按文件加载较大文本差异，展示大小、截断及无法预览的具体原因", async () => {
  const calls: string[] = [];
  let finish: ((result: Response) => void) | undefined;
  await setupFilePreview((url) => { calls.push(url); return new Promise((resolve) => { finish = resolve; }); });
  expect(calls).toEqual([]);
  expect(screen.getByText("31.3 KiB → 31.3 KiB")).toBeInTheDocument();
  expect(screen.getByText("二进制文件，不提供文本差异。")).toBeInTheDocument();
  expect(screen.getByText("文件不是有效的 UTF-8 文本，无法预览。")).toBeInTheDocument();
  expect(screen.getByText("文件超过单侧 1.0 MiB 的预览限制。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "查看 references/guide.md 的差异" }));
  expect(screen.getByRole("button", { name: "查看 references/guide.md 的差异" })).toBeDisabled();
  await waitFor(() => expect(calls).toHaveLength(1));
  const query = new URL(calls[0]!, "http://localhost").searchParams;
  expect(Object.fromEntries(query)).toEqual({ revision: latest, baseRevision: current, path: "references/guide.md" });
  await act(async () => finish?.(response({ path: "references/guide.md", kind: "text", patch: "@@ -10 +10 @@\n-old\n+new\n", truncated: true })));
  expect(await screen.findByText(/-old/)).toBeInTheDocument();
  expect(screen.getByText("差异超过 64 KiB，当前仅显示开头部分。")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "查看 scripts/check.sh 的差异" })).toBeEnabled();
  expect(calls).toHaveLength(1);
});

it("单文件加载失败可重试，成功后移除错误", async () => {
  let attempts = 0;
  await setupFilePreview(async () => {
    if (++attempts === 1) return response({ error: { code: "skill_preview_failed", message: "Preview unavailable" } }, 503);
    return response({ path: "references/guide.md", kind: "text", patch: "-before\n+after\n", truncated: false });
  });
  fireEvent.click(screen.getByRole("button", { name: "查看 references/guide.md 的差异" }));
  expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试 references/guide.md 的差异" }));
  expect(await screen.findByText(/\+after/)).toBeInTheDocument();
  expect(screen.queryByText("Preview unavailable")).not.toBeInTheDocument();
  expect(attempts).toBe(2);
});

it("切换版本取消单文件请求，迟到结果不会混入新的预览", async () => {
  let signal: AbortSignal | null | undefined;
  let finish: ((result: Response) => void) | undefined;
  await setupFilePreview((_url, init) => { signal = init?.signal; return new Promise((resolve) => { finish = resolve; }); });
  fireEvent.click(screen.getByRole("button", { name: "查看 references/guide.md 的差异" }));
  await waitFor(() => expect(signal).toBeDefined());
  fireEvent.change(screen.getByLabelText("目标版本"), { target: { value: older } });
  expect(signal?.aborted).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "预览变更" }));
  await screen.findByText("references/guide.md");
  await act(async () => finish?.(response({ path: "references/guide.md", kind: "text", patch: "stale preview", truncated: false })));
  expect(screen.queryByText("stale preview")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "查看 references/guide.md 的差异" })).toBeEnabled();
});

it("英文界面显示明确的预览原因，并在关闭弹窗时取消文件请求", async () => {
  let signal: AbortSignal | null | undefined;
  await setupFilePreview((_url, init) => { signal = init?.signal; return new Promise(() => undefined); }, true);
  expect(screen.getByText("Binary file; text diff is unavailable.")).toBeInTheDocument();
  expect(screen.getByText("The file is not valid UTF-8 text and cannot be previewed.")).toBeInTheDocument();
  expect(screen.getByText("The file exceeds the 1.0 MiB preview limit per side.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View changes for references/guide.md" }));
  await waitFor(() => expect(signal).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(signal?.aborted).toBe(true));
});
