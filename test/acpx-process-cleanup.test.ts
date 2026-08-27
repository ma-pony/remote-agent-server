import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it, vi } from "vitest";

type AcpClientLike = {
  start(): Promise<void>;
  close(): Promise<void>;
  createSession(cwd?: string): Promise<unknown>;
};

type AcpClientConstructor = new (options: {
  agentCommand: string;
  cwd: string;
  mcpServers: never[];
  permissionMode: "approve-all";
  nonInteractivePermissions: "fail";
  sessionOptions: { env: Record<string, string> };
}) => AcpClientLike;

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForProcessExit = async (pid: number, timeoutMs = 4_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const createClient = (
  AcpClient: AcpClientConstructor,
  root: string,
  pidFile: string,
  mode?: "fail-initialize" | "crash-after-session"
): AcpClientLike => {
  const fixture = join(process.cwd(), "test/fixtures/acp-orphan-agent.mjs");
  return new AcpClient({
    agentCommand: `${process.execPath} ${fixture}`,
    cwd: root,
    mcpServers: [],
    permissionMode: "approve-all",
    nonInteractivePermissions: "fail",
    sessionOptions: { env: {
      ACP_TEST_PID_FILE: pidFile,
      ...(mode === undefined ? {} : { ACP_TEST_MODE: mode })
    } }
  });
};

const loadAcpClient = async (): Promise<AcpClientConstructor> => {
  const bundle = join(
    process.cwd(),
    "node_modules/acpx/dist/live-checkpoint-DQp4JSHD.js"
  );
  const module = await import(pathToFileURL(bundle).href) as { k: AcpClientConstructor };
  return module.k;
};

it.runIf(process.env.REMOTE_AGENT_ACPX_PROCESS_TEST === "1")(
  "关闭 ACP 客户端时回收已经脱离父进程组的后代进程",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-agent-acpx-tree-"));
    const pidFile = join(root, "pids.json");
    const AcpClient = await loadAcpClient();
    const client = createClient(AcpClient, root, pidFile);
    let descendantPid: number | undefined;

    try {
      await client.start();
      await vi.waitFor(async () => {
        const pids = JSON.parse(await readFile(pidFile, "utf8")) as { descendant: number };
        descendantPid = pids.descendant;
        expect(processExists(descendantPid)).toBe(true);
      });

      await client.close();
      await waitForProcessExit(descendantPid!);

      expect(processExists(descendantPid!)).toBe(false);
    } finally {
      await client.close().catch(() => undefined);
      if (descendantPid !== undefined && processExists(descendantPid)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000
);

it.runIf(process.env.REMOTE_AGENT_ACPX_PROCESS_TEST === "1")(
  "ACP 初始化失败时回收已经脱离父进程组的后代进程",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-agent-acpx-init-fail-"));
    const pidFile = join(root, "pids.json");
    const AcpClient = await loadAcpClient();
    const client = createClient(AcpClient, root, pidFile, "fail-initialize");
    let descendantPid: number | undefined;

    try {
      await expect(client.start()).rejects.toThrow();
      const pids = JSON.parse(await readFile(pidFile, "utf8")) as { descendant: number };
      descendantPid = pids.descendant;
      await waitForProcessExit(descendantPid);

      expect(processExists(descendantPid)).toBe(false);
    } finally {
      await client.close().catch(() => undefined);
      if (descendantPid !== undefined && processExists(descendantPid)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000
);

it.runIf(process.env.REMOTE_AGENT_ACPX_PROCESS_TEST === "1")(
  "ACP 运行中异常退出时立即回收已经脱离父进程组的后代进程",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-agent-acpx-runtime-fail-"));
    const pidFile = join(root, "pids.json");
    const AcpClient = await loadAcpClient();
    const client = createClient(AcpClient, root, pidFile, "crash-after-session");
    let descendantPid: number | undefined;

    try {
      await client.start();
      await client.createSession(root);
      const pids = JSON.parse(await readFile(pidFile, "utf8")) as { descendant: number };
      descendantPid = pids.descendant;
      await waitForProcessExit(descendantPid);

      expect(processExists(descendantPid)).toBe(false);
    } finally {
      await client.close().catch(() => undefined);
      if (descendantPid !== undefined && processExists(descendantPid)) {
        try { process.kill(descendantPid, "SIGKILL"); } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000
);
