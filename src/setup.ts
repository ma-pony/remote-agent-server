import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { ZodError } from "zod";

import { loadConfig, type AppConfig } from "./config.js";
import { readEnvironmentFile } from "./environment-file.js";
import { applyServicePath, removeServiceSecretsFromEnvironment } from "./runtime/service-path.js";
import type { FileSystemInspector } from "./workspaces/apfs-workspace.js";
import { createWorkspaceManager } from "./workspaces/create-workspace-manager.js";
import type { CommandRunner, WorkspaceManager } from "./workspaces/workspace-manager.js";

const execFileAsync = promisify(execFile);
const providerCommands = ["codex", "claude", "hermes"];

type InstallationOptions = {
  directory?: string;
  root?: string;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  environment?: Record<string, string | undefined>;
  checkOnly?: boolean;
  commandRunner?: CommandRunner;
  fileSystemInspector?: FileSystemInspector;
};

const exists = async (path: string): Promise<boolean> => {
  try { await stat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const quoteEnvironmentValue = (value: string): string => {
  const quote = value.includes('"') ? "'" : '"';
  if (value.includes(quote) || /[\r\n\0]/.test(value)) {
    throw new Error("Configuration values must be on one line and cannot contain both kinds of quotes.");
  }
  return `${quote}${value}${quote}`;
};

/** Exercises the same create/snapshot/delete operations used for real workspaces. */
const checkWorkspaceOperations = async (manager: WorkspaceManager, config: AppConfig): Promise<void> => {
  await manager.check();
  const parents: string[] = [];
  try {
    for (const root of [config.projectEnvironmentsRoot, config.sessionsRoot]) {
      parents.push(await mkdtemp(join(root, ".setup-check-")));
    }
    const source = join(parents[0]!, "workspace");
    const snapshot = join(parents[1]!, "workspace");
    await manager.createRevision(source, null);
    await writeFile(join(source, "check.txt"), "original", { mode: 0o600 });
    await manager.createRevision(snapshot, source);
    if (await readFile(join(snapshot, "check.txt"), "utf8") !== "original") {
      throw new Error("Workspace snapshot did not preserve the source file.");
    }
    await writeFile(join(snapshot, "check.txt"), "changed");
    if (await readFile(join(source, "check.txt"), "utf8") !== "original") {
      throw new Error("Workspace snapshot is not independent of its source.");
    }
  } finally {
    const cleanup = await Promise.allSettled(parents.map(async (parent) => {
      await manager.removeRevision(join(parent, "workspace"));
      await rmdir(parent);
    }));
    if (cleanup.some((result) => result.status === "rejected")) {
      throw new Error(`Workspace check could not clean up its temporary directories: ${parents.join(", ")}. Check filesystem permissions before retrying.`);
    }
  }
};

export const initializeInstallation = async ({
  directory = process.cwd(), root, platform = process.platform, homeDirectory = homedir(),
  environment = process.env, checkOnly = false, commandRunner, fileSystemInspector
}: InstallationOptions = {}): Promise<{ configPath: string; created: boolean; fileExists: boolean; config: AppConfig; providers: string[] }> => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 22 || minor! < 13) throw new Error("Node.js 22.13 or later within Node 22 is required. Run nvm install && nvm use.");
  if (platform !== "darwin" && platform !== "linux") throw new Error("Use macOS with APFS or Linux with Btrfs.");
  const configPath = resolve(directory, ".env");
  const existing = await exists(configPath);
  const storageRoot = resolve(directory, root ?? (platform === "darwin"
    ? join(homeDirectory, "Library", "Application Support", "remote-agent-server")
    : "/srv/remote-agent"));
  const defaults = existing || checkOnly ? {} : {
    HOST: "127.0.0.1", PORT: "3000", API_TOKEN: randomBytes(32).toString("hex"),
    DATA_DIR: join(storageRoot, "data"), DATABASE_PATH: join(storageRoot, "data", "remote-agent.sqlite3"),
    PROJECT_ENVIRONMENTS_ROOT: join(storageRoot, "environments"), SESSIONS_ROOT: join(storageRoot, "sessions")
  };
  const inherited = Object.fromEntries(Object.entries(environment).filter((entry) => entry[1] !== undefined));
  const env = readEnvironmentFile(configPath, { ...defaults, ...inherited });
  if (!env.API_TOKEN || env.API_TOKEN === "replace-with-a-long-random-token") {
    throw new Error("Missing API_TOKEN or an example token is still configured. Run pnpm run init for a new installation; set a random API_TOKEN in an existing .env.");
  }
  let config: AppConfig;
  try { config = loadConfig(env); }
  catch (error) {
    if (error instanceof ZodError) throw new Error(`Invalid configuration: ${error.issues.map((issue) => issue.path.join(".")).join(", ")}. Check .env or your service environment.`);
    throw error;
  }
  const initialValues = {
    HOST: config.host, PORT: String(config.port), API_TOKEN: config.apiToken,
    DATA_DIR: config.dataDir, DATABASE_PATH: config.databasePath,
    PROJECT_ENVIRONMENTS_ROOT: config.projectEnvironmentsRoot, SESSIONS_ROOT: config.sessionsRoot
  };
  const contents = existing || checkOnly ? ""
    : Object.entries(initialValues).map(([key, value]) => `${key}=${quoteEnvironmentValue(value)}`).join("\n") + "\n";
  const childEnvironment = { ...env };
  removeServiceSecretsFromEnvironment(childEnvironment);
  const runner = commandRunner ?? {
    run: (command: string, args: string[]) => execFileAsync(command, args, {
      env: childEnvironment, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024
    })
  };
  try { await runner.run("git", ["--version"]); }
  catch { throw new Error("Git is not available. Install Git and make sure it is on the service user's PATH."); }

  for (const path of new Set([config.dataDir, dirname(config.databasePath), config.projectEnvironmentsRoot, config.sessionsRoot])) {
    try { await mkdir(path, { recursive: true, mode: 0o700 }); }
    catch { throw new Error(`Cannot create storage directory: ${path}. Choose a writable root with pnpm run init --root /absolute/path, or correct the paths in an existing .env.`); }
  }
  await checkWorkspaceOperations(createWorkspaceManager({
    platform, projectEnvironmentsRoot: config.projectEnvironmentsRoot, sessionsRoot: config.sessionsRoot,
    commandRunner: runner, fileSystemInspector
  }), config);
  const providers: string[] = [];
  for (const command of providerCommands) {
    for (const entry of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
      const path = join(entry, command);
      try {
        await access(path, constants.X_OK);
        if (!(await stat(path)).isFile()) continue;
        providers.push(command);
        break;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  if (!existing && !checkOnly) await writeFile(configPath, contents, { flag: "wx", mode: 0o600 });
  return { configPath, created: !existing && !checkOnly, fileExists: existing || !checkOnly, config, providers };
};

const isEntrypoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  void (async () => {
    const { values } = parseArgs({ options: {
      root: { type: "string" }, check: { type: "boolean" }, help: { type: "boolean", short: "h" }
    } });
    if (values.help) {
      console.log("pnpm run init [--root /absolute/storage/path]\npnpm run doctor\n\nNew installs: macOS defaults to ~/Library/Application Support/remote-agent-server; Linux defaults to /srv/remote-agent on Btrfs. Existing .env files are preserved; --root only applies to a new file. Doctor verifies configuration and temporary workspace operations without starting a Provider.");
      return;
    }
    console.log("Checking Node.js, Git, and native workspace create/snapshot/cleanup…");
    const environment = readEnvironmentFile(resolve(".env"), process.env);
    const shellEnvironment = { ...environment };
    removeServiceSecretsFromEnvironment(shellEnvironment);
    environment.PATH = applyServicePath({ environment: shellEnvironment });
    const result = await initializeInstallation({ root: values.root, checkOnly: values.check, environment });
    console.log("Workspace check passed.");
    console.log(result.fileExists
      ? `${result.created ? "Created private configuration" : "Kept existing configuration"}: ${result.configPath}`
      : "Using configuration supplied by the service environment; no .env file was created.");
    if (values.root && !result.created) console.log("Existing configuration takes precedence; --root was not applied.");
    console.log(`Provider commands found: ${result.providers.join(", ") || "none"}. Authentication and model access have not been tested.`);
    if (result.providers.length === 0) console.log("Install one Provider before running a task. See README.en.md → Prepare a Provider.");
    console.log("Log in with the service user: codex login or claude auth login. For Hermes, follow its official quickstart linked in README.en.md.");
    const host = ["0.0.0.0", "::"].includes(result.config.host) ? "127.0.0.1" : result.config.host;
    const address = host.includes(":") ? `[${host}]` : host;
    console.log(`\nNext: pnpm start\nOpen http://${address}:${result.config.port}\nCopy API_TOKEN from ${result.fileExists ? ".env" : "your service configuration"} into the login screen; the token is never printed here.\nThen: prepare a project environment → create an Agent → start a session.`);
  })().catch((error: unknown) => {
    console.error(`Setup failed: ${error instanceof Error ? error.message : "unknown error"}\nSee docs/deployment.md for filesystem preparation. Fix the issue and rerun the same command.`);
    process.exitCode = 1;
  });
}
