import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";

import type { EnvironmentRepository } from "../domain.js";

export type RemoteRepositoryState = { defaultBranch: string; commit: string };

export interface ProjectEnvironmentCommands {
  inspect(repository: EnvironmentRepository, signal: AbortSignal): Promise<RemoteRepositoryState>;
  clone(
    repository: EnvironmentRepository,
    destination: string,
    defaultBranch: string,
    signal: AbortSignal
  ): Promise<void>;
  update(
    repository: EnvironmentRepository,
    destination: string,
    defaultBranch: string,
    signal: AbortSignal
  ): Promise<void>;
  prepare(
    repository: EnvironmentRepository,
    destination: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<void>;
}

type ProcessResult = { stdout: string; stderr: string };

const OUTPUT_LIMIT = 64 * 1024;

const runProcess = (
  command: string,
  args: string[],
  options: { cwd?: string; environment: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs?: number }
): Promise<ProcessResult> => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let output = "";
  let settled = false;
  const append = (current: string, chunk: Buffer): string =>
    (current + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
    output = append(output, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
    output = append(output, chunk);
  });

  const terminate = () => child.kill("SIGTERM");
  options.signal.addEventListener("abort", terminate, { once: true });
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(terminate, options.timeoutMs);
  timer?.unref();

  const finish = (operation: () => void) => {
    if (settled) return;
    settled = true;
    options.signal.removeEventListener("abort", terminate);
    if (timer !== undefined) clearTimeout(timer);
    operation();
  };
  child.once("error", (error) => finish(() => reject(error)));
  child.once("close", (code, signal) => finish(() => {
    if (options.signal.aborted) {
      reject(new Error("project_environment_command_aborted"));
    } else if (signal !== null || code !== 0) {
      reject(new Error((output || `Command exited with ${String(code)}`).trim()));
    } else {
      resolve({ stdout, stderr });
    }
  }));
});

/** Executes the trusted Git and project preparation commands. */
export class SystemProjectEnvironmentCommands implements ProjectEnvironmentCommands {
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: { environment?: NodeJS.ProcessEnv } = {}) {
    const environment = options.environment ?? process.env;
    const localBin = environment.HOME === undefined ? undefined : join(environment.HOME, ".local", "bin");
    const path = (environment.PATH ?? "").split(delimiter).filter((item) => item !== "");
    this.environment = {
      ...environment,
      PATH: localBin === undefined || path.includes(localBin)
        ? path.join(delimiter)
        : [localBin, ...path].join(delimiter)
    };
  }

  async inspect(repository: EnvironmentRepository, signal: AbortSignal): Promise<RemoteRepositoryState> {
    const { stdout } = await runProcess("git", ["ls-remote", "--symref", repository.gitUrl, "HEAD"], {
      environment: this.environment, signal
    });
    const branch = stdout.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/m)?.[1];
    const commit = stdout.match(/^([0-9a-fA-F]+)\s+HEAD$/m)?.[1];
    if (branch === undefined || commit === undefined) throw new Error("git_remote_default_branch_not_found");
    return { defaultBranch: branch, commit };
  }

  async clone(
    repository: EnvironmentRepository,
    destination: string,
    defaultBranch: string,
    signal: AbortSignal
  ): Promise<void> {
    await runProcess("git", ["clone", "--branch", defaultBranch, "--single-branch", "--", repository.gitUrl, destination], {
      environment: this.environment, signal
    });
  }

  async update(
    repository: EnvironmentRepository,
    destination: string,
    defaultBranch: string,
    signal: AbortSignal
  ): Promise<void> {
    await runProcess("git", ["remote", "set-url", "origin", repository.gitUrl], {
      cwd: destination, environment: this.environment, signal
    });
    await runProcess("git", ["fetch", "origin", defaultBranch], {
      cwd: destination, environment: this.environment, signal
    });
    await runProcess("git", ["reset", "--hard", `origin/${defaultBranch}`], {
      cwd: destination, environment: this.environment, signal
    });
  }

  async prepare(
    repository: EnvironmentRepository,
    destination: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<void> {
    if (repository.prepareCommand === null || repository.prepareCommand.trim() === "") return;
    await runProcess("/bin/sh", ["-lc", repository.prepareCommand], {
      cwd: destination, environment: this.environment, signal, timeoutMs
    });
  }
}
