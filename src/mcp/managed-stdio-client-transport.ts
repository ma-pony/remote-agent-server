import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough, type Stream } from "node:stream";

import {
  ReadBuffer,
  SdkError,
  SdkErrorCode,
  serializeMessage,
  type JSONRPCMessage,
  type Transport
} from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  type StdioServerParameters
} from "@modelcontextprotocol/client/stdio";

const GRACEFUL_CLOSE_MS = 1_000;
const FORCE_CLOSE_MS = 1_000;
const POLL_INTERVAL_MS = 25;

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const processGroupExists = (pid: number, child: ChildProcess): boolean => {
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForProcessGroupExit = async (
  pid: number,
  child: ChildProcess,
  timeoutMs: number
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid, child) && Date.now() < deadline) await delay(POLL_INTERVAL_MS);
  return !processGroupExists(pid, child);
};

const signalProcessGroup = (pid: number, child: ChildProcess, signal: NodeJS.Signals): void => {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
  } catch {}
};

/** Stdio MCP transport that owns and reaps the complete upstream process group. */
export class ManagedStdioClientTransport implements Transport {
  private child: ChildProcess | undefined;
  private readonly readBuffer: ReadBuffer;
  private readonly stderrStream: PassThrough | null;
  private closePromise: Promise<void> | undefined;
  private closeNotified = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly server: StdioServerParameters) {
    this.readBuffer = new ReadBuffer({ maxBufferSize: server.maxBufferSize });
    this.stderrStream = server.stderr === "pipe" || server.stderr === "overlapped"
      ? new PassThrough()
      : null;
  }

  get stderr(): Stream | null {
    return this.stderrStream ?? this.child?.stderr ?? null;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.child !== undefined) throw new Error("ManagedStdioClientTransport already started");
    this.closePromise = undefined;

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.server.command, this.server.args ?? [], {
        env: { ...getDefaultEnvironment(), ...this.server.env },
        stdio: ["pipe", "pipe", this.server.stderr ?? "inherit"],
        shell: false,
        windowsHide: process.platform === "win32",
        cwd: this.server.cwd,
        detached: process.platform !== "win32"
      });
      this.child = child;
      child.once("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.once("spawn", resolve);
      child.once("exit", () => { this.handleChildExit(child); });
      child.stdin?.on("error", (error) => { this.onerror?.(error); });
      child.stdout?.on("data", (chunk: Buffer) => {
        try {
          this.readBuffer.append(chunk);
          this.processReadBuffer();
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          void this.close();
        }
      });
      child.stdout?.on("error", (error) => { this.onerror?.(error); });
      if (this.stderrStream !== null && child.stderr !== null) child.stderr.pipe(this.stderrStream);
    });
  }

  close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.closePromise ??= this.closeProcessTree(child);
    return this.closePromise;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (stdin === undefined || stdin === null) throw new SdkError(SdkErrorCode.NotConnected, "Not connected");
    await new Promise<void>((resolve) => {
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once("drain", resolve);
    });
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private handleChildExit(child: ChildProcess): void {
    if (this.child === child) this.child = undefined;
    this.closePromise ??= this.closeProcessTree(child);
    void this.closePromise
      .catch((error: unknown) => { this.onerror?.(error instanceof Error ? error : new Error(String(error))); })
      .finally(() => { this.notifyClose(); });
  }

  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onclose?.();
  }

  private async closeProcessTree(child: ChildProcess | undefined): Promise<void> {
    const pid = child?.pid;
    if (child === undefined || pid === undefined) {
      this.readBuffer.clear();
      return;
    }

    try {
      try { child.stdin?.end(); } catch {}
      if (!(await waitForProcessGroupExit(pid, child, GRACEFUL_CLOSE_MS))) {
        signalProcessGroup(pid, child, "SIGTERM");
        if (!(await waitForProcessGroupExit(pid, child, FORCE_CLOSE_MS))) {
          signalProcessGroup(pid, child, "SIGKILL");
          if (!(await waitForProcessGroupExit(pid, child, FORCE_CLOSE_MS))) {
            throw new Error(`MCP process group ${pid} did not exit after SIGKILL`);
          }
        }
      }
    } finally {
      try { child.stdout?.destroy(); } catch {}
      try { child.stdin?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
      this.readBuffer.clear();
    }
  }
}
