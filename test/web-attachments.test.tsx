// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { SessionPage } from "../src/web/pages/session-page.js";
import { I18nProvider } from "../src/web/i18n.js";
import { MessageAttachments } from "../src/web/components/message-attachments.js";

vi.mock("@microsoft/fetch-event-source", () => ({ fetchEventSource: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const setup = (fail = false) => {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    let body: unknown;
    let status = 200;
    if (init?.method === "POST") {
      bodies.push(JSON.parse(String(init.body)));
      status = fail ? 400 : 201;
      body = fail ? { error: { message: "upload rejected" } } : { id: 7, sessionId: 1, input: "", status: "succeeded", result: "ok", error: null };
    } else if (url.startsWith("/api/usage/summary?")) body = { completeness: "none", usage: { totalTokens: null } };
    else if (url === "/api/agents") body = [{ id: 1, name: "Agent" }];
    else body = { id: 1, agentId: 1, title: "Files", status: "idle", runs: [], mcpParameters: [] };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }));
  render(<I18nProvider><MemoryRouter><SessionPage sessionId="1" /></MemoryRouter></I18nProvider>);
  return bodies;
};

it("附件消息：选择、移除和纯文件发送，成功后清空草稿", async () => {
  const bodies = setup();
  await screen.findByRole("heading", { name: "Files" });
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("添加图片或文件"), { target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] } });
  await screen.findByRole("button", { name: "移除 notes.txt" });
  fireEvent.click(screen.getByRole("button", { name: "移除 notes.txt" }));
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("添加图片或文件"), { target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] } });
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(bodies).toEqual([{ input: "", attachments: [{ name: "notes.txt", mediaType: "text/plain", data: "aGVsbG8=" }] }]));
  await waitFor(() => expect(screen.queryByRole("button", { name: "移除 notes.txt" })).not.toBeInTheDocument());
});

it("附件消息：发送失败保留附件，粘贴图片可预览", async () => {
  setup(true);
  await screen.findByRole("heading", { name: "Files" });
  const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "paste.png", { type: "image/png" });
  fireEvent.paste(screen.getByLabelText("发送给智能体"), { clipboardData: { files: [png] } });
  await screen.findByRole("img", { name: "paste.png" });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText("upload rejected");
  expect(screen.getByRole("button", { name: "移除 paste.png" })).toBeEnabled();
});

it("附件消息：超限文件不会启用发送", async () => {
  setup();
  await screen.findByRole("heading", { name: "Files" });
  const file = new File(["x"], "large.txt", { type: "text/plain" });
  Object.defineProperty(file, "size", { value: 11 * 1024 * 1024 });
  fireEvent.change(screen.getByLabelText("添加图片或文件"), { target: { files: [file] } });
  await screen.findByText(/单个文件最多 10 MiB/);
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
});

it("附件消息：鉴权预览与下载复用 Blob，离开页面释放对象 URL", async () => {
  const createObjectURL = vi.fn(() => "blob:attachment-preview");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
  sessionStorage.setItem("apiToken", "attachment-test-token");
  const fetch = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }));
  vi.stubGlobal("fetch", fetch);
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
    expect(this.isConnected).toBe(true);
    expect(this.download).toBe("image.png");
    expect(this.href).toBe("blob:attachment-preview");
  });
  const { unmount } = render(<I18nProvider><MessageAttachments pathPrefix="/runs/1/attachments" attachments={[{ id: 2, name: "image.png", mediaType: "image/png", size: 4, available: true }]} /></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "预览" }));
  await screen.findByRole("img", { name: "image.png" });
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/runs/1/attachments/2");
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer attachment-test-token");
  fireEvent.click(screen.getByRole("button", { name: "下载 image.png" }));
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(fetch).toHaveBeenCalledOnce();
  expect(revokeObjectURL).not.toHaveBeenCalled();
  unmount();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:attachment-preview");
  sessionStorage.removeItem("apiToken");
});
