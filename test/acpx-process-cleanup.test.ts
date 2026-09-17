import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "acpx/runtime";
import { expect, it, vi } from "vitest";

type FixtureMode = "fail-initialize" | "crash-during-session" | "crash-during-load"
  | "crash-during-resume" | "crash-after-session" | "reject-session" | "timeout-session";

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const createFixture = async (mode?: FixtureMode) => {
  const root = await mkdtemp(join(tmpdir(), "remote-agent-acpx-tree-"));
  const pidFile = join(root, "pids.json");
  const runtime = createAcpRuntime({
    cwd: root,
    sessionStore: createRuntimeStore({ stateDir: join(root, "acpx") }),
    agentRegistry: createAgentRegistry({ overrides: {
      fixture: [
        process.execPath, join(import.meta.dirname, "fixtures/acp-orphan-agent.mjs"),
        ...(mode === "timeout-session" ? ["claude-agent-acp"] : [])
      ]
    } }),
    agentProcessEnv: {
      ACP_TEST_PID_FILE: pidFile,
      ...(mode === undefined ? {} : { ACP_TEST_MODE: mode })
    },
    permissionMode: "approve-all",
    nonInteractivePermissions: "fail"
  });
  const pids = async (): Promise<{ agent: number; descendant: number; stdinEnded?: boolean }> =>
    JSON.parse(await readFile(pidFile, "utf8"));
  return {
    runtime,
    waitForStdinEnd: () => vi.waitFor(async () => {
      expect((await pids()).stdinEnded).toBe(true);
    }, { timeout: 4_000, interval: 10 }),
    ensure: () => runtime.ensureSession({
      sessionKey: "cleanup-test",
      agent: "fixture",
      mode: "persistent",
      cwd: root,
      ...(mode === "crash-during-load" || mode === "crash-during-resume"
        ? { resumeSessionId: "test-session" }
        : {})
    }),
    assertStopped: async () => {
      const { agent, descendant } = await pids();
      await vi.waitFor(() => {
        expect(processExists(agent)).toBe(false);
        expect(processExists(descendant)).toBe(false);
      }, { timeout: 4_000, interval: 25 });
    },
    cleanup: async () => {
      await runtime.shutdown().catch(() => undefined);
      const remaining = await pids().catch(() => undefined);
      for (const pid of remaining === undefined ? [] : [remaining.agent, remaining.descendant]) {
        if (processExists(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  };
};

const processTest = it.runIf(process.env.REMOTE_AGENT_ACPX_PROCESS_TEST === "1");

processTest.each([undefined, "reject-session", "timeout-session"] as const)(
  "Session 建立结束后停止后台采样（模式：%s）",
  async (mode) => {
    const fixture = await createFixture(mode);
    // Observe real timer ownership without changing scheduling or process inspection.
    const startInterval = globalThis.setInterval;
    const stopInterval = globalThis.clearInterval;
    const active = new Set<ReturnType<typeof setInterval>>();
    let started = 0;
    const startSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((...args) => {
      const timer = startInterval(...args);
      active.add(timer);
      started += 1;
      return timer;
    });
    const stopSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation((timer) => {
      active.delete(timer as ReturnType<typeof setInterval>);
      stopInterval(timer);
    });
    try {
      if (mode === "timeout-session") {
        vi.stubEnv("ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS", "100");
        // The RPC stays pending while timeout recovery closes the bridge.
        const rejection = expect(fixture.ensure()).rejects.toThrow("session creation timed out");
        await fixture.waitForStdinEnd();
        const activeAfterTimeout = active.size;
        await rejection;
        expect(activeAfterTimeout).toBe(0);
      } else if (mode === "reject-session") {
        await expect(fixture.ensure()).rejects.toThrow("fixture session rejected");
      } else {
        await fixture.ensure();
      }
      expect(started).toBeGreaterThan(0);
      expect(active.size).toBe(0);
    } finally {
      await fixture.cleanup();
      for (const timer of active) stopInterval(timer);
      startSpy.mockRestore();
      stopSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  },
  15_000
);

processTest.each(["close", "shutdown"] as const)(
  "%s 回收 ACP Runtime 及已经脱离父进程组的后代进程",
  async (operation) => {
    const fixture = await createFixture();
    try {
      const handle = await fixture.ensure();
      if (operation === "close") await fixture.runtime.close({ handle, reason: "test" });
      else await fixture.runtime.shutdown();
      await fixture.assertStopped();
    } finally {
      await fixture.cleanup();
    }
  },
  15_000
);

processTest.each([
  ["初始化", "fail-initialize"],
  ["创建 Session", "crash-during-session"],
  ["加载 Session", "crash-during-load"],
  ["恢复 Session", "crash-during-resume"]
] as const)(
  "%s 完成前桥接进程崩溃时回收后代进程",
  async (_phase, mode) => {
    const fixture = await createFixture(mode);
    try {
      await expect(fixture.ensure()).rejects.toThrow();
      await fixture.assertStopped();
    } finally {
      await fixture.cleanup();
    }
  },
  15_000
);

processTest("ACP 运行中异常退出时立即回收后代进程", async () => {
  const fixture = await createFixture("crash-after-session");
  try {
    await fixture.ensure();
    await fixture.assertStopped();
  } finally {
    await fixture.cleanup();
  }
}, 15_000);
