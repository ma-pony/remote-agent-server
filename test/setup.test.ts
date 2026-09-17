import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { readEnvironmentFile } from "../src/environment-file.js";
import { initializeInstallation } from "../src/setup.js";
import type { CommandRunner } from "../src/workspaces/workspace-manager.js";

const directories: string[] = [];
const temporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-agent-setup-"));
  directories.push(directory);
  return directory;
};
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const inspector = { statfs: async () => ({ type: 26 }), stat: async () => ({ dev: 1 }) };
const workspaceRunner = (calls: string[][]): CommandRunner => ({
  async run(command, args) {
    calls.push([command, ...args]);
    if (command === "git") return { stdout: "git version 2.0", stderr: "" };
    if (command === "cp") await cp(args[1]!, args[2]!, { recursive: true });
    if (command === "btrfs") {
      if (args[1] === "create") await mkdir(args[2]!);
      if (args[1] === "snapshot") await cp(args[2]!, args[3]!, { recursive: true });
      if (args[1] === "delete") await rm(args[2]!, { recursive: true, force: true });
    }
    return { stdout: "", stderr: "" };
  }
});

describe("local environment file", () => {
  it("loads literal values and quoted paths, with inherited environment taking precedence", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, ".env");
    await writeFile(path, 'PORT=3100\nAPI_TOKEN=file-token\nDATA_DIR="/path with spaces/data"\nLITERAL="$(do-not-run) $HOME"\n');
    expect(readEnvironmentFile(path, { PORT: "3200", API_TOKEN: undefined })).toEqual({
      PORT: "3200", API_TOKEN: "file-token", DATA_DIR: "/path with spaces/data", LITERAL: "$(do-not-run) $HOME"
    });
  });

  it("allows environment-only deployments when .env is absent, but reports unreadable paths", async () => {
    const directory = await temporaryDirectory();
    expect(readEnvironmentFile(join(directory, ".env"), { API_TOKEN: "provided" })).toEqual({ API_TOKEN: "provided" });
    expect(() => readEnvironmentFile(directory, {})).toThrow();
  });
});

describe("installation initialization", () => {
  it.each(["darwin", "linux"] as const)("creates a private config and verifies native workspace operations on %s", async (platform) => {
    const directory = await temporaryDirectory();
    const root = join(directory, "data root");
    const calls: string[][] = [];
    const result = await initializeInstallation({
      directory, root, platform, environment: {}, commandRunner: workspaceRunner(calls), fileSystemInspector: inspector
    });
    const config = parseEnv(await readFile(join(directory, ".env"), "utf8"));
    expect(result.created).toBe(true);
    expect(config).toMatchObject({
      HOST: "127.0.0.1", PORT: "3000", DATA_DIR: join(root, "data"),
      DATABASE_PATH: join(root, "data", "remote-agent.sqlite3"),
      PROJECT_ENVIRONMENTS_ROOT: join(root, "environments"), SESSIONS_ROOT: join(root, "sessions")
    });
    expect(config.API_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(join(directory, ".env"))).mode & 0o777).toBe(0o600);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(root, "environments"))).toEqual([]);
    expect(await readdir(join(root, "sessions"))).toEqual([]);
    expect(calls.some(([command, ...args]) => platform === "darwin"
      ? command === "cp" && args[0] === "-cR"
      : command === "btrfs" && args[1] === "snapshot")).toBe(true);
  });

  it("defaults macOS storage to the user's Application Support directory", async () => {
    const directory = await temporaryDirectory();
    const result = await initializeInstallation({
      directory, platform: "darwin", homeDirectory: directory, environment: {},
      commandRunner: workspaceRunner([]), fileSystemInspector: inspector
    });
    expect(result.config.dataDir).toBe(join(directory, "Library/Application Support/remote-agent-server/data"));
  });

  it("keeps existing configuration byte-for-byte and does not rotate tokens", async () => {
    const directory = await temporaryDirectory();
    const options = { directory, root: join(directory, "storage"), platform: "darwin" as const,
      environment: {}, commandRunner: workspaceRunner([]), fileSystemInspector: inspector };
    await initializeInstallation(options);
    const original = `${await readFile(join(directory, ".env"), "utf8")}# user settings\nPORT=3210\n`;
    await writeFile(join(directory, ".env"), original);
    const result = await initializeInstallation(options);
    expect(result.created).toBe(false);
    expect(result.config.port).toBe(3210);
    expect(await readFile(join(directory, ".env"), "utf8")).toBe(original);
  });

  it("does not save a config when native filesystem checks fail", async () => {
    const directory = await temporaryDirectory();
    await expect(initializeInstallation({
      directory, root: join(directory, "storage"), platform: "darwin", environment: {},
      commandRunner: workspaceRunner([]),
      fileSystemInspector: { ...inspector, statfs: async () => ({ type: 1 }) }
    })).rejects.toThrow(/APFS/);
    await expect(stat(join(directory, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unusable clones and cleans temporary probe directories", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "storage");
    await expect(initializeInstallation({
      directory, root, platform: "darwin", environment: {}, fileSystemInspector: inspector,
      commandRunner: { run: async () => ({ stdout: "", stderr: "" }) }
    })).rejects.toThrow();
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(root, "environments"))).toEqual([]);
    expect(await readdir(join(root, "sessions"))).toEqual([]);
    await expect(stat(join(directory, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("doctor reports missing configuration without initializing files", async () => {
    const directory = await temporaryDirectory();
    await expect(initializeInstallation({ directory, checkOnly: true, environment: {} }))
      .rejects.toThrow(/pnpm run init/);
    await expect(stat(join(directory, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects installed providers without executing them and preserves a supplied token", async () => {
    const directory = await temporaryDirectory();
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 99\n");
    await chmod(join(bin, "codex"), 0o700);
    const result = await initializeInstallation({
      directory, root: join(directory, "storage"), platform: "darwin",
      environment: { PATH: bin, API_TOKEN: "existing-token" },
      commandRunner: workspaceRunner([]), fileSystemInspector: inspector
    });
    expect(result.providers).toEqual(["codex"]);
    expect(result.config.apiToken).toBe("existing-token");
  });
});
