import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { RtkManager } from "../src/rtk/rtk-manager.js";
import { compareRtkVersions, unpackRtk } from "../src/rtk/rtk-download.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const directories: string[] = [];
const managers: RtkManager[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const manager of managers.splice(0)) await manager.close();
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});

export const rtkArchive = (body = "fixture executable"): Buffer => {
  const content = Buffer.from(body);
  const header = Buffer.alloc(512);
  header.write("release/rtk"); header.write(content.length.toString(8).padStart(11, "0"), 124); header[156] = 48;
  return gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512 + 1024)]));
};
const setup = async (overrides: { probe?: (binary: string, version: string, signal: AbortSignal) => Promise<void>; fetch?: typeof fetch } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "remote-agent-rtk-")); directories.push(root);
  const archive = rtkArchive();
  let latest = "1.1.0";
  let checksum = createHash("sha256").update(archive).digest("hex");
  const requests: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input); requests.push(url);
    if (url.endsWith(".tar.gz")) return new Response(new Uint8Array(archive));
    const version = url.endsWith("latest") ? latest : url.split("/v").at(-1)!;
    return Response.json({ tag_name: `v${version}`, draft: false, prerelease: false, assets: [{
      name: "rtk-oss-aarch64-apple-darwin.tar.gz", digest: `sha256:${checksum}`,
      browser_download_url: `https://github.com/rtk-ai/rtk/releases/download/v${version}/rtk-oss-aarch64-apple-darwin.tar.gz`
    }] });
  });
  const probe = overrides.probe ?? vi.fn(async (binary: string) => { await readFile(binary); });
  const manager = new RtkManager({ dataDir: root, platform: "darwin", arch: "arm64", fetch: overrides.fetch ?? fetcher, probe });
  managers.push(manager);
  return { root, manager, probe, fetcher, requests, setLatest: (value: string) => { latest = value; }, corrupt: () => { checksum = "0".repeat(64); } };
};

describe("managed RTK lifecycle", () => {
  it.each(["missing", "not executable", "corrupted"])("repairs a %s executable without losing its active version or rollback target", async (failure) => {
    const { manager, root, setLatest } = await setup({ probe: async (binary) => {
      if (await readFile(binary, "utf8") !== "fixture executable") throw new Error("invalid executable");
    } });
    await manager.ensureInstalled();
    setLatest("1.2.0"); manager.check(); await manager.waitForIdle(); manager.update("1.2.0"); await manager.waitForIdle();
    const original = await manager.resolveForRun("codex");
    if (failure === "missing") await rm(original.binaryPath!);
    else if (failure === "not executable") await chmod(original.binaryPath!, 0o600);
    else await writeFile(original.binaryPath!, "corrupted executable");
    manager.setEnabled(false);
    expect(await manager.ensureInstalled()).toMatchObject({ installed: true, enabled: false, currentVersion: "1.2.0", previousVersion: "1.1.0", operation: { stage: "succeeded" } });
    expect(await readFile(original.binaryPath!, "utf8")).toBe("fixture executable");
    expect((await readdir(join(root, "tools/rtk/versions"))).sort()).toEqual(["1.1.0", "1.2.0"]);
  });

  it("reuses a healthy same-version executable without replacing its inode", async () => {
    const { manager, root } = await setup();
    await manager.ensureInstalled();
    const binary = (await manager.resolveForRun("codex")).binaryPath!;
    const original = await stat(binary);
    manager.update("1.1.0"); await manager.waitForIdle();
    expect(manager.status()).toMatchObject({ currentVersion: "1.1.0", previousVersion: null, operation: { stage: "succeeded" } });
    expect((await stat(binary)).ino).toBe(original.ino);
    expect(await readdir(join(root, "tools/rtk/versions"))).toEqual(["1.1.0"]);
  });

  it("leaves the old executable and rollback state intact when the replacement fails validation", async () => {
    const { manager, root, setLatest, corrupt } = await setup();
    await manager.ensureInstalled();
    setLatest("1.2.0"); manager.check(); await manager.waitForIdle(); manager.update("1.2.0"); await manager.waitForIdle();
    const binary = (await manager.resolveForRun("codex")).binaryPath!;
    await writeFile(binary, "damaged existing file");
    const original = await stat(binary);
    manager.setEnabled(false); corrupt(); manager.update("1.2.0"); await manager.waitForIdle();
    expect(manager.status()).toMatchObject({ enabled: false, currentVersion: "1.2.0", previousVersion: "1.1.0", operation: { stage: "failed", error: "rtk_checksum_mismatch" } });
    expect(await readFile(binary, "utf8")).toBe("damaged existing file");
    expect((await stat(binary)).ino).toBe(original.ino);
    expect((await readdir(join(root, "tools/rtk/versions"))).sort()).toEqual(["1.1.0", "1.2.0"]);
  });

  it("does not mistake cancellation during an existing-version probe for executable corruption", async () => {
    let cancelDuringProbe = false, probed!: () => void;
    const waiting = new Promise<void>(resolve => { probed = resolve; });
    const { manager, root } = await setup({ probe: async (binary, _version, signal) => {
      if (cancelDuringProbe && !binary.includes(".staging-")) {
        probed();
        await new Promise<void>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
      }
      await readFile(binary);
    } });
    await manager.ensureInstalled();
    const binary = (await manager.resolveForRun("codex")).binaryPath!;
    const original = await stat(binary);
    cancelDuringProbe = true;
    manager.update("1.1.0"); await waiting; await manager.close();
    expect(manager.status()).toMatchObject({ currentVersion: "1.1.0", previousVersion: null, operation: { stage: "failed", error: "rtk_operation_cancelled" } });
    expect((await stat(binary)).ino).toBe(original.ino);
    expect(await readdir(join(root, "tools/rtk/versions"))).toEqual(["1.1.0"]);
  });

  it("checks on startup and daily, retries failed checks hourly, and keeps checking while disabled", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-30T00:00:00.000Z"));
    const { manager, fetcher } = await setup();
    manager.setEnabled(false); manager.start(); manager.start();
    fetcher.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(1_000); await manager.waitForIdle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000); await manager.waitForIdle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1_000); await manager.waitForIdle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000); await manager.waitForIdle();
    expect(fetcher).toHaveBeenCalledTimes(3);
    await manager.close(); await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60 * 1_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("accepts the native rewrite command's ask exit code during installation and local inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "rtk-probe-contract-")); directories.push(root);
    const archive = rtkArchive(`#!${process.execPath}\nif(process.argv[2]==='--version') console.log('rtk 1.1.0'); else {console.log('rtk git status');process.exitCode=3;}\n`);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const manager = new RtkManager({ dataDir: root, platform: "darwin", arch: "arm64", fetch: async (input) => String(input).endsWith(".tar.gz")
      ? new Response(new Uint8Array(archive)) : Response.json({ tag_name: "v1.1.0", draft: false, prerelease: false, assets: [{
        name: "rtk-oss-aarch64-apple-darwin.tar.gz", digest: `sha256:${sha256}`,
        browser_download_url: "https://github.com/rtk-ai/rtk/releases/download/v1.1.0/rtk-oss-aarch64-apple-darwin.tar.gz"
      }] }) });
    managers.push(manager);
    expect(await manager.ensureInstalled()).toMatchObject({ installed: true, currentVersion: "1.1.0" });
    expect(await manager.inspect()).toMatchObject({ installed: true });
  });

  it("defaults enabled, installs once, persists disabled state and detects stable versions numerically", async () => {
    const { root, manager, requests, setLatest } = await setup();
    expect(manager.status()).toMatchObject({ enabled: true, installed: false, latestVersion: null });
    await manager.ensureInstalled();
    expect(manager.status()).toMatchObject({ installed: true, currentVersion: "1.1.0" });
    const count = requests.length;
    await manager.ensureInstalled(); expect(requests).toHaveLength(count);
    manager.setEnabled(false);
    const restored = new RtkManager({ dataDir: root }); managers.push(restored);
    expect(restored.status().enabled).toBe(false);
    setLatest("1.10.0"); manager.check(); await manager.waitForIdle();
    expect(manager.status()).toMatchObject({ latestVersion: "1.10.0", updateAvailable: true, checkError: null });
    expect(compareRtkVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });

  it("pins old Run paths across update and rollback, preserving the previous usable binary", async () => {
    const { manager, setLatest } = await setup();
    await manager.ensureInstalled();
    const original = await manager.resolveForRun("codex");
    setLatest("1.2.0"); manager.check(); await manager.waitForIdle();
    manager.update("1.2.0"); await manager.waitForIdle();
    const updated = await manager.resolveForRun("codex");
    expect(updated).toMatchObject({ enabled: true, version: "1.2.0", mode: "hook" });
    expect(original.version).toBe("1.1.0"); expect(existsSync(original.binaryPath!)).toBe(true);
    expect(updated.binaryPath).not.toBe(original.binaryPath);
    manager.rollback("1.1.0"); await manager.waitForIdle();
    expect(manager.status()).toMatchObject({ currentVersion: "1.1.0", previousVersion: "1.2.0" });
    expect(existsSync(updated.binaryPath!)).toBe(true);
    manager.setEnabled(false);
    expect(await manager.resolveForRun("codex")).toMatchObject({ enabled: false, reason: "disabled", version: "1.1.0" });
    manager.setEnabled(true);
    expect(await manager.resolveForRun("deepseek_harness")).toMatchObject({ enabled: false, reason: "unsupported" });
    expect(await manager.resolveForRun("hermes")).toMatchObject({ enabled: true, mode: "plugin" });
  });

  it("keeps the active version when checksum or executable self-test fails", async () => {
    let rejectProbe = false;
    const { manager, setLatest, corrupt, root } = await setup({ probe: async (path) => {
      await readFile(path); if (rejectProbe) throw new Error("private executable payload");
    } });
    await manager.ensureInstalled();
    setLatest("1.2.0"); manager.check(); await manager.waitForIdle();
    rejectProbe = true; manager.update("1.2.0"); await manager.waitForIdle();
    expect(manager.status()).toMatchObject({ currentVersion: "1.1.0", operation: { stage: "failed", error: "rtk_self_test_failed" } });
    rejectProbe = false; corrupt(); manager.update("1.2.0"); await manager.waitForIdle();
    expect(manager.status()).toMatchObject({ currentVersion: "1.1.0", operation: { error: "rtk_checksum_mismatch" } });
    expect(await readdir(join(root, "tools/rtk/versions"))).toEqual(["1.1.0"]);
  });

  it("retains last successful check on network failure and rejects races, invalid versions and unexpected targets", async () => {
    const { manager, fetcher } = await setup();
    manager.check(); await manager.waitForIdle();
    const last = manager.status().lastCheckedAt;
    fetcher.mockRejectedValueOnce(new Error("secret upstream detail"));
    manager.check(); await manager.waitForIdle();
    expect(manager.status()).toMatchObject({ latestVersion: "1.1.0", lastCheckedAt: last, checkError: "rtk_download_failed" });
    expect(() => manager.update("../../bad")).toThrow("rtk_invalid_version");
    expect(() => manager.update("7.0.0")).toThrow("rtk_version_conflict");
    expect(() => manager.rollback("1.1.0")).toThrow("rtk_version_conflict");
  });

  it("serializes operations across manager instances and cancels downloads on shutdown", async () => {
    const { root, manager, fetcher } = await setup();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    fetcher.mockImplementation(async (_input, init) => new Promise((_resolve, reject) => {
      started(); init!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    manager.check(); manager.check();
    await ready;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => manager.update("1.1.0")).toThrow("rtk_busy");
    expect(manager.setEnabled(false).enabled).toBe(false);
    const other = new RtkManager({ dataDir: root }); managers.push(other);
    expect(() => other.check()).toThrow("rtk_busy");
    await manager.close();
    expect(manager.status().operation).toMatchObject({ stage: "failed", error: "rtk_operation_cancelled" });
    expect(existsSync(join(root, "tools/rtk/operation.lock"))).toBe(false);
  });

  it("recovers interrupted staging before runs and only reclaims unused versions on startup", async () => {
    const { root, manager, setLatest } = await setup();
    await manager.ensureInstalled();
    for (const version of ["1.2.0", "1.3.0"]) {
      setLatest(version); manager.check(); await manager.waitForIdle(); manager.update(version); await manager.waitForIdle();
    }
    const versions = join(root, "tools/rtk/versions");
    expect(existsSync(join(versions, "1.1.0/rtk"))).toBe(true);
    await mkdir(join(versions, ".staging-interrupted"));
    const restarted = new RtkManager({ dataDir: root }); managers.push(restarted);
    await restarted.recover();
    expect((await readdir(versions)).sort()).toEqual(["1.2.0", "1.3.0"]);
    expect(restarted.status()).toMatchObject({ currentVersion: "1.3.0", previousVersion: "1.2.0" });
  });

  it("passes through when the executable is missing or not executable", async () => {
    const { manager } = await setup();
    expect(await manager.resolveForRun("codex")).toMatchObject({ enabled: false, reason: "unavailable" });
    await manager.ensureInstalled();
    const plan = await manager.resolveForRun("codex");
    await chmod(plan.binaryPath!, 0o600);
    expect(await manager.resolveForRun("codex")).toMatchObject({ enabled: false, reason: "unavailable" });
  });

  it("validates archive integrity and never extracts archive paths", async () => {
    const archive = rtkArchive("binary");
    expect((await unpackRtk(archive, createHash("sha256").update(archive).digest("hex"))).toString()).toBe("binary");
    await expect(unpackRtk(archive, "f".repeat(64))).rejects.toThrow("rtk_checksum_mismatch");
  });
});

describe("RTK management API", () => {
  it("authenticates and validates operations, saves settings, and returns asynchronous progress", async () => {
    const { root, manager } = await setup();
    const { db } = createTestDatabase();
    const app = buildApp({ config: loadConfig({ API_TOKEN: "test-token", DATA_DIR: root }), db,
      runtime: createFakeRuntime(), rtkManager: manager });
    closers.push(async () => { await app.close(); db.close(); });
    const headers = { authorization: "Bearer test-token" };
    expect((await app.inject({ url: "/api/system-settings/rtk" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/system-settings/rtk/update", payload: { version: "1.1.0" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/system-settings/rtk", headers, payload: { enabled: "yes" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/system-settings/rtk", headers, payload: { enabled: false } })).json()).toMatchObject({ enabled: false });
    expect((await app.inject({ method: "POST", url: "/api/system-settings/rtk/update", headers, payload: { version: "../../bad" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/system-settings/rtk/update", headers, payload: { version: "9.0.0" } })).statusCode).toBe(409);
    const result = await app.inject({ method: "POST", url: "/api/system-settings/rtk/update", headers, payload: { version: "1.1.0" } });
    expect(result.statusCode).toBe(202);
    await manager.waitForIdle();
    const loaded = await app.inject({ url: "/api/system-settings/rtk", headers });
    expect(loaded.json()).toMatchObject({ enabled: false, installed: true, currentVersion: "1.1.0", operation: { stage: "succeeded" } });
    expect(loaded.body).not.toContain(root);
  });
});
