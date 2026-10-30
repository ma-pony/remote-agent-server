// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RtkSettings } from "../src/web/components/rtk-settings.js";
import { I18nProvider } from "../src/web/i18n.js";
import type { RtkStatus } from "../src/rtk/rtk-types.js";

const status = (): RtkStatus => ({ enabled: true, installed: true, currentVersion: "1.1.0", previousVersion: "1.0.0",
  recommendedVersion: "1.1.0", latestVersion: "1.2.0", releaseUrl: "https://github.com/rtk-ai/rtk/releases/tag/v1.2.0",
  updateAvailable: true, lastCheckedAt: "2026-10-30T01:00:00.000Z", checkError: null, operation: null, providers: [] });
beforeEach(() => { sessionStorage.setItem("apiToken", "test-token"); localStorage.setItem("language", "zh"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const show = () => render(<I18nProvider><RtkSettings /></I18nProvider>);

describe("RTK settings", () => {
  it("persists manual disabling and requires confirmation before rollback", async () => {
    let current = status();
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (init?.method) {
        calls.push({ url: String(input), body: JSON.parse(init.body) });
        if (init.method === "PUT") current = { ...current, enabled: false };
      }
      return Response.json(current);
    }));
    show();
    const toggle = await screen.findByLabelText("自动压缩");
    fireEvent.change(toggle, { target: { value: "false" } });
    expect(await screen.findByText("已保存，将从下一次 Run 生效。")).toBeInTheDocument();
    expect(calls[0]).toEqual({ url: "/api/system-settings/rtk", body: { enabled: false } });
    fireEvent.click(screen.getByRole("button", { name: "回退版本" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "确认回退" }));
    await waitFor(() => expect(calls[1]).toEqual({ url: "/api/system-settings/rtk/rollback", body: { version: "1.0.0" } }));
  });

  it("binds the selected update version, disables duplicate operations, then polls completion", async () => {
    let current = status();
    let completed = false;
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      if (init?.method === "POST") {
        calls.push(JSON.parse(init.body));
        current = { ...current, operation: { kind: "update", stage: "downloading", target: "1.2.0", error: null } };
      } else if (completed) current = { ...current, currentVersion: "1.2.0", updateAvailable: false,
        operation: { kind: "update", stage: "succeeded", target: "1.2.0", error: null } };
      return Response.json(current);
    }));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "更新到 1.2.0" }));
    expect(await screen.findByText("正在下载…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeDisabled();
    expect(screen.getByLabelText("自动压缩")).toBeEnabled();
    expect(calls).toEqual([{ version: "1.2.0" }]);
    completed = true;
    expect(await screen.findByText("操作已完成", {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled();
  });

  it("shows load failures and retries without claiming the version is current", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(Response.json({ ...status(), latestVersion: null, checkError: "rtk_download_failed" }));
    vi.stubGlobal("fetch", fetcher);
    show();
    expect(await screen.findByText("RTK 设置加载失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("版本检测失败")).toBeInTheDocument();
    expect(screen.getByText(/尚未检测/)).toBeInTheDocument();
  });
});
