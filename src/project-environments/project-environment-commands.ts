import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { EnvironmentRepository } from "../domain.js";

export type RemoteRepositoryState = { defaultBranch: string; commit: string };

export interface ProjectEnvironmentCommands {
  inspect(repository: EnvironmentRepository, signal: AbortSignal): Promise<RemoteRepositoryState>;
  isRepository(destination: string, signal: AbortSignal): Promise<boolean>;
  dependencyFingerprint(destination: string, signal: AbortSignal): Promise<string | null>;
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
  cleanIgnored(repository: EnvironmentRepository, destination: string, signal: AbortSignal): Promise<void>;
  prepare(
    repository: EnvironmentRepository,
    destination: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<void>;
}

type ProcessResult = { stdout: string; stderr: string };

const OUTPUT_LIMIT = 64 * 1024;
const PROCESS_TERM_GRACE_MS = 1_000;
const PROCESS_KILL_GRACE_MS = 1_000;
const PROCESS_POLL_INTERVAL_MS = 25;

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const processTreeExists = (child: ChildProcess): boolean => {
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  const pid = child.pid;
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForProcessTreeExit = async (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (processTreeExists(child) && Date.now() < deadline) await delay(PROCESS_POLL_INTERVAL_MS);
  return !processTreeExists(child);
};

const signalProcessTree = (child: ChildProcess, signal: NodeJS.Signals): void => {
  try {
    if (process.platform === "win32" || child.pid === undefined) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
};

const terminateProcessTree = async (child: ChildProcess): Promise<void> => {
  if (!processTreeExists(child)) return;
  signalProcessTree(child, "SIGTERM");
  if (await waitForProcessTreeExit(child, PROCESS_TERM_GRACE_MS)) return;
  signalProcessTree(child, "SIGKILL");
  if (!(await waitForProcessTreeExit(child, PROCESS_KILL_GRACE_MS))) {
    throw new Error(`Project command process group ${String(child.pid)} did not exit after SIGKILL`);
  }
};

export const runProcess = (
  command: string,
  args: string[],
  options: { cwd?: string; environment: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs?: number; successExitCodes?: readonly number[] }
): Promise<ProcessResult> => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
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

  let terminationPromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let terminate = (): void => undefined;
  const finish = (operation: () => void) => {
    if (settled) return;
    settled = true;
    options.signal.removeEventListener("abort", terminate);
    if (timer !== undefined) clearTimeout(timer);
    operation();
  };
  terminate = () => {
    terminationPromise ??= terminateProcessTree(child).catch((error: unknown) => {
      finish(() => reject(error));
    });
  };
  options.signal.addEventListener("abort", terminate, { once: true });
  timer = options.timeoutMs === undefined ? undefined : setTimeout(terminate, options.timeoutMs);
  timer?.unref();
  if (options.signal.aborted) terminate();

  child.once("error", (error) => {
    terminationPromise ??= terminateProcessTree(child);
    void terminationPromise.then(
      () => finish(() => reject(error)),
      (cleanupError: unknown) => finish(() => reject(cleanupError))
    );
  });
  child.once("close", (code, signal) => {
    void (async () => {
      try {
        await (terminationPromise ?? terminateProcessTree(child));
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      finish(() => {
        if (options.signal.aborted) {
          reject(new Error("project_environment_command_aborted"));
        } else if (signal !== null || code === null || !(options.successExitCodes ?? [0]).includes(code)) {
          reject(new Error((output || `Command exited with ${String(code)}`).trim()));
        } else {
          resolve({ stdout, stderr });
        }
      });
    })();
  });
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

  async isRepository(destination: string, signal: AbortSignal): Promise<boolean> {
    try {
      const { stdout } = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: destination, environment: this.environment, signal
      });
      return stdout.trim() === "true";
    } catch (_error) {
      return false;
    }
  }

  async dependencyFingerprint(destination: string, signal: AbortSignal): Promise<string | null> {
    const hash = createHash("sha256");
    for (const name of ["uv.lock", "pyproject.toml", ".python-version"]) {
      try {
        const { stdout } = await runProcess("git", ["rev-parse", `HEAD:${name}`], {
          cwd: destination, environment: this.environment, signal
        });
        hash.update(name).update("\0").update(stdout.trim()).update("\0");
      } catch (_error) {
        if (name === "uv.lock") return null;
      }
    }
    return hash.digest("hex");
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

  async cleanIgnored(
    _repository: EnvironmentRepository,
    destination: string,
    signal: AbortSignal
  ): Promise<void> {
    await runProcess("git", ["clean", "-fdX"], {
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
    if (existsSync(join(destination, "uv.lock")) && !existsSync(join(destination, ".venv"))) {
      await runProcess("uv", ["venv", "--relocatable", ".venv"], {
        cwd: destination, environment: this.environment, signal, timeoutMs
      });
    }
    await runProcess("/bin/sh", ["-lc", repository.prepareCommand], {
      cwd: destination, environment: this.environment, signal, timeoutMs
    });
  }
}
