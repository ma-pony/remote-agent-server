import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { createAcpRuntime, createAgentRegistry, createRuntimeStore, type AcpRuntimeHandle } from "acpx/runtime";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
type CodexRequest = { method: string; params: Record<string, unknown> };
type McpServerState = {
  name: string;
  runtimeStatus: string | null;
  readyAfterPolls?: number;
  serverInfo?: { name: string; version: string };
};
type FixtureState = {
  servers?: McpServerState[];
  configuredServers?: string[];
  startupEvents?: Array<{ threadId?: string | null; name?: string; status: string }>;
  pageSize?: number;
  hangMcpList?: boolean;
  exitOnMcpList?: boolean;
};
const businessTurns = (requests: CodexRequest[]) => requests.filter(request =>
  request.method === "turn/start" && request.params.threadId === "fixture-codex-session");
const processExists = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const createCodexFixture = async (initialState: FixtureState = {}, timeoutMs = 5_000) => {
  const root = await mkdtemp(join(tmpdir(), "remote-agent-codex-policy-"));
  const workspace = join(root, "workspace");
  const home = join(root, "codex-home");
  const requestsPath = join(root, "requests.jsonl");
  const statePath = join(root, "state.json");
  const pidPath = join(root, "app-server.pid");
  await mkdir(workspace);
  await mkdir(home);
  await writeFile(statePath, JSON.stringify(initialState));
  // CODEX_PATH=node runs this local fake when the real bridge launches `app-server`.
  await writeFile(join(workspace, "app-server"),
    `require(${JSON.stringify(join(import.meta.dirname, "fixtures/codex-app-server.cjs"))});\n`);
  const agentProcessEnv = {
    CODEX_PATH: process.execPath,
    CODEX_HOME: home,
    CODEX_CONFIG: JSON.stringify({ sandbox_workspace_write: { network_access: false } }),
    DISABLE_MCP_CONFIG_FILTERING: "",
    INITIAL_AGENT_MODE: "",
    APP_SERVER_LOGS: "",
    DEFAULT_AUTH_REQUEST: "",
    MODEL_PROVIDER: "",
    CODEX_API_KEY: "",
    OPENAI_API_KEY: "",
    CODEX_TEST_REQUESTS_PATH: requestsPath,
    CODEX_TEST_STATE_PATH: statePath,
    CODEX_TEST_PID_PATH: pidPath
  };
  const mcpServers = initialState.servers?.map(server => ({
    name: server.name, command: "unused-fixture-mcp", args: [], env: []
  })) ?? [];
  const runtime = createAcpRuntime({
    cwd: workspace,
    sessionStore: createRuntimeStore({ stateDir: join(root, "acpx") }),
    agentRegistry: createAgentRegistry({ overrides: {
      fixture: [process.execPath, require.resolve("@agentclientprotocol/codex-acp")]
    } }),
    agentProcessEnv,
    mcpServers,
    permissionMode: "approve-all",
    nonInteractivePermissions: "fail",
    timeoutMs
  });
  const expectAppServerStopped = async () => {
    const pid = Number(await readFile(pidPath, "utf8"));
    await vi.waitFor(() => expect(processExists(pid)).toBe(false), { timeout: 3_000 });
  };
  return {
    runtime,
    expectAppServerStopped,
    // acpx prefers session/resume; exercise the separate ACP session/load path directly.
    loadAndPrompt: async () => {
      const child = spawn(process.execPath, [require.resolve("@agentclientprotocol/codex-acp")], {
        cwd: workspace, env: { ...process.env, ...agentProcessEnv }, stdio: ["pipe", "pipe", "ignore"]
      });
      const closed = once(child, "close");
      const replies = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
      createInterface({ input: child.stdout }).on("line", line => {
        const message = JSON.parse(line);
        const pending = replies.get(message.id);
        if (!pending) return;
        replies.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      });
      child.on("close", () => {
        for (const pending of replies.values()) pending.reject(new Error("ACP fixture exited"));
      });
      let nextId = 0;
      const request = async (method: string, params: Record<string, unknown>) => {
        const id = ++nextId;
        let timer: ReturnType<typeof setTimeout>;
        try {
          return await new Promise<unknown>((resolve, reject) => {
            replies.set(id, { resolve, reject });
            timer = setTimeout(() => reject(new Error(`ACP fixture timed out: ${method}`)), 5_000);
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
          });
        } finally { clearTimeout(timer!); replies.delete(id); }
      };
      try {
        await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        await request("session/load", { sessionId: "fixture-codex-session", cwd: workspace, mcpServers });
        return await request("session/prompt", {
          sessionId: "fixture-codex-session", prompt: [{ type: "text", text: "hello" }]
        });
      } finally {
        child.stdin.end();
        const forceClose = setTimeout(() => child.kill("SIGKILL"), 3_000);
        try { await closed; } finally { clearTimeout(forceClose); }
      }
    },
    setState: async (settings: FixtureState) => {
      await writeFile(`${statePath}.tmp`, JSON.stringify(settings));
      await rename(`${statePath}.tmp`, statePath);
    },
    crashAppServer: async () => {
      const pid = Number(await readFile(pidPath, "utf8"));
      process.kill(pid, "SIGKILL");
      await vi.waitFor(() => expect(processExists(pid)).toBe(false));
    },
    startTurn: (handle: AcpRuntimeHandle, turnTimeoutMs?: number) => runtime.startTurn({
      handle, requestId: randomUUID(), text: "hello", mode: "prompt", timeoutMs: turnTimeoutMs
    }),
    ensure: (resumeSessionId?: string) => runtime.ensureSession({
      sessionKey: "codex-policy-test",
      agent: "fixture",
      mode: "persistent",
      cwd: workspace,
      ...(resumeSessionId === undefined ? {} : { resumeSessionId })
    }),
    prompt: async (handle: AcpRuntimeHandle) => {
      const turn = runtime.startTurn({ handle, requestId: randomUUID(), text: "hello", mode: "prompt" });
      expect(await turn.result).toMatchObject({ status: "completed", stopReason: "end_turn" });
    },
    requests: async (): Promise<CodexRequest[]> => (await readFile(requestsPath, "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as CodexRequest),
    cleanup: async () => {
      try {
        await runtime.shutdown?.();
        await expectAppServerStopped();
      }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  };
};

describe("Codex ACP default network policy", () => {
  it("enables networking for new, reused and resumed sessions without changing workspace sandboxing", async () => {
    const fixture = await createCodexFixture();
    try {
      const handle = await fixture.ensure();
      await fixture.prompt(handle);
      await fixture.prompt(handle);
      await fixture.runtime.close({ handle, reason: "test-resume" });
      const providerSessionId = handle.agentSessionId ?? handle.backendSessionId;
      expect(providerSessionId).toBe("fixture-codex-session");
      const resumed = await fixture.ensure(providerSessionId);
      await fixture.prompt(resumed);

      const requests = await fixture.requests();
      expect(requests.filter(request => request.method === "thread/start" && !request.params.ephemeral)).toHaveLength(1);
      expect(requests.filter(request => request.method === "thread/resume")).toHaveLength(1);
      const turns = businessTurns(requests);
      expect(turns).toHaveLength(3);
      for (const turn of turns) {
        expect(turn.params.threadId).toBe("fixture-codex-session");
        expect(turn.params.approvalPolicy).toBe("on-request");
        expect(turn.params.approvalsReviewer).toBe("auto_review");
        expect(turn.params.sandboxPolicy).toEqual({
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        });
      }
    } finally {
      await fixture.cleanup();
    }
  }, 15_000);

  it.each([
    ["read-only", "on-request", { type: "readOnly", networkAccess: false }],
    ["workspace-write", "on-request", {
      type: "workspaceWrite", writableRoots: [], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false
    }],
    ["agent-full-access", "never", { type: "dangerFullAccess" }]
  ] as const)("preserves the %s mode policy", async (mode, approvalPolicy, sandboxPolicy) => {
    const fixture = await createCodexFixture();
    try {
      const handle = await fixture.ensure();
      await fixture.runtime.setMode!({ handle, mode });
      await fixture.prompt(handle);

      const turns = businessTurns(await fixture.requests());
      expect(turns).toHaveLength(1);
      expect(turns[0]?.params.approvalPolicy).toBe(approvalPolicy);
      expect(turns[0]?.params.sandboxPolicy).toEqual(sandboxPolicy);
    } finally {
      await fixture.cleanup();
    }
  }, 15_000);
});

describe("Codex ACP MCP startup patch", () => {
  it("waits for every page of thread-scoped MCP connections, ignoring premature ready/cancelled events", async () => {
    const fixture = await createCodexFixture({
      servers: [
        { name: "docs", runtimeStatus: "starting", readyAfterPolls: 3 },
        { name: "search", runtimeStatus: "cancelled", readyAfterPolls: 4 }
      ],
      pageSize: 1,
      startupEvents: [
        { threadId: "other-session", status: "cancelled" },
        { threadId: null, status: "cancelled" },
        { status: "cancelled" },
        { status: "ready" },
        { name: "search", status: "ready" }
      ]
    });
    try {
      const handle = await fixture.ensure();
      await fixture.prompt(handle);
      await fixture.prompt(handle);
      const requests = await fixture.requests();
      const queries = requests.filter(request => request.method === "mcpServerStatus/list");
      expect(queries.length).toBeGreaterThanOrEqual(8);
      expect(queries.every(request => request.params.threadId === "fixture-codex-session")).toBe(true);
      const firstTurn = requests.findIndex(request => businessTurns([request]).length > 0);
      const snapshots = requests.slice(0, firstTurn).filter(request => request.method === "fixture/mcp-status");
      expect(snapshots.slice(-2).map(request => request.params.data)).toEqual([
        [expect.objectContaining({ name: "docs", runtimeStatus: "connected" })],
        [expect.objectContaining({ name: "search", runtimeStatus: "connected" })]
      ]);
      expect(businessTurns(requests)).toHaveLength(2);
    } finally { await fixture.cleanup(); }
  }, 15_000);

  it.each(["failed", "disabled", "authenticationRequired"])("blocks prompts when a required MCP is %s, even with cached server info", async runtimeStatus => {
    const fixture = await createCodexFixture({ servers: [
      { name: "ready", runtimeStatus: "connected" },
      { name: "broken", runtimeStatus, serverInfo: { name: "cached", version: "1" } }
    ] });
    try {
      const handle = await fixture.ensure();
      // Also verify the result survives completion of the background startup report.
      await vi.waitFor(async () => expect((await fixture.requests()).some(request => request.method === "mcpServerStatus/list")).toBe(true));
      const result = await fixture.startTurn(handle).result;
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result)).toContain("broken");
      await fixture.setState({ servers: [{ name: "ready", runtimeStatus: "connected" }, { name: "broken", runtimeStatus: "connected" }] });
      expect((await fixture.startTurn(handle).result).status).toBe("failed");
      expect(businessTurns(await fixture.requests())).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  }, 15_000);

  it.each([false, true])("blocks after the 30-second deadline, including a hung status RPC (hung=%s)", async hangMcpList => {
    const fixture = await createCodexFixture({
      servers: [{ name: "slow", runtimeStatus: "starting" }], hangMcpList
    }, 40_000);
    try {
      const handle = await fixture.ensure();
      const result = await fixture.startTurn(handle).result;
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result)).toContain("MCP startup timed out");
      expect(businessTurns(await fixture.requests())).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  }, 45_000);

  it.each(["starting", "failed"])("still requires a selected MCP supplied by Codex config to be ready (%s)", async runtimeStatus => {
    const fixture = await createCodexFixture({
      configuredServers: ["docs"],
      servers: [{ name: "docs", runtimeStatus, ...(runtimeStatus === "starting" ? { readyAfterPolls: 3 } : {}) }]
    });
    try {
      const handle = await fixture.ensure();
      expect((await fixture.startTurn(handle).result).status).toBe(runtimeStatus === "failed" ? "failed" : "completed");
      const requests = await fixture.requests();
      const start = requests.find(request => request.method === "thread/start" && !request.params.ephemeral);
      expect(start).toBeDefined();
      // Upstream skips injecting a same-name MCP, but its connection remains required.
      expect(start?.params.config).not.toHaveProperty("mcp_servers.docs");
      const queries = requests.filter(request => request.method === "mcpServerStatus/list");
      expect(queries.length).toBeGreaterThanOrEqual(runtimeStatus === "failed" ? 1 : 3);
      expect(queries.every(request => request.params.threadId === "fixture-codex-session")).toBe(true);
      expect(businessTurns(requests)).toHaveLength(runtimeStatus === "failed" ? 0 : 1);
    } finally { await fixture.cleanup(); }
  }, 15_000);

  it.each(["close", "shutdown"] as const)("releases the app-server with a hung status RPC on %s", async operation => {
    const fixture = await createCodexFixture({
      servers: [{ name: "docs", runtimeStatus: "starting" }], hangMcpList: true
    });
    try {
      const handle = await fixture.ensure();
      const turn = fixture.startTurn(handle);
      await vi.waitFor(async () => expect((await fixture.requests()).some(request => request.method === "mcpServerStatus/list")).toBe(true));
      if (operation === "close") await fixture.runtime.close({ handle, reason: "test-hung-close" });
      else await fixture.runtime.shutdown?.();
      expect((await turn.result).status).not.toBe("completed");
      await fixture.expectAppServerStopped();
      expect(businessTurns(await fixture.requests())).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  }, 15_000);

  it("checks MCP readiness again after resuming a Provider session", async () => {
    const fixture = await createCodexFixture({ servers: [{ name: "docs", runtimeStatus: "connected" }] });
    try {
      const handle = await fixture.ensure();
      await fixture.prompt(handle);
      await fixture.runtime.close({ handle, reason: "test-resume" });
      await fixture.setState({ servers: [{ name: "docs", runtimeStatus: "failed" }] });
      const resumed = await fixture.ensure(handle.agentSessionId ?? handle.backendSessionId);
      expect((await fixture.startTurn(resumed).result).status).toBe("failed");
      expect(businessTurns(await fixture.requests())).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  }, 15_000);

  it.each(["starting", "failed"])("checks MCP readiness on session/load (%s)", async runtimeStatus => {
    const fixture = await createCodexFixture({ servers: [{
      name: "docs", runtimeStatus, ...(runtimeStatus === "starting" ? { readyAfterPolls: 3 } : {})
    }] });
    try {
      if (runtimeStatus === "failed") {
        await expect(fixture.loadAndPrompt()).rejects.toThrow("MCP servers failed to start: docs");
        expect(businessTurns(await fixture.requests())).toHaveLength(0);
      } else {
        await expect(fixture.loadAndPrompt()).resolves.toMatchObject({ stopReason: "end_turn" });
        const requests = await fixture.requests();
        expect(requests.filter(request => request.method === "mcpServerStatus/list").length).toBeGreaterThanOrEqual(3);
        expect(businessTurns(requests)[0]?.params.sandboxPolicy).toMatchObject({ networkAccess: true });
      }
    } finally { await fixture.cleanup(); }
  }, 15_000);

  it("blocks model work when the app-server exits during MCP startup", async () => {
    const fixture = await createCodexFixture({
      servers: [{ name: "docs", runtimeStatus: "starting" }], exitOnMcpList: true
    });
    try {
      const handle = await fixture.ensure();
      expect((await fixture.startTurn(handle).result).status).toBe("failed");
      expect(businessTurns(await fixture.requests())).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  }, 15_000);

  it.each(["starting", "failed"])("rechecks MCP after automatic app-server recovery (%s)", async runtimeStatus => {
    const fixture = await createCodexFixture({ servers: [{ name: "docs", runtimeStatus: "connected" }] });
    try {
      const handle = await fixture.ensure();
      await fixture.prompt(handle);
      const before = (await fixture.requests()).length;
      await fixture.setState({ servers: [{
        name: "docs", runtimeStatus, ...(runtimeStatus === "starting" ? { readyAfterPolls: 3 } : {})
      }] });
      await fixture.crashAppServer();
      const result = await fixture.startTurn(handle).result;
      expect(result.status).toBe(runtimeStatus === "failed" ? "failed" : "completed");
      const recoveredRequests = (await fixture.requests()).slice(before);
      expect(recoveredRequests.some(request => request.method === "thread/resume")).toBe(true);
      const checks = recoveredRequests.filter(request => request.method === "mcpServerStatus/list");
      expect(checks.length).toBeGreaterThanOrEqual(runtimeStatus === "failed" ? 1 : 3);
      expect(businessTurns(recoveredRequests)).toHaveLength(runtimeStatus === "failed" ? 0 : 1);
    } finally { await fixture.cleanup(); }
  }, 15_000);

  it.each(["cancel", "close", "shutdown", "timeout"] as const)("stops a pending prompt on %s without a late turn", async operation => {
    const fixture = await createCodexFixture({ servers: [{ name: "docs", runtimeStatus: "starting" }] });
    try {
      const handle = await fixture.ensure();
      const turn = fixture.startTurn(handle, operation === "timeout" ? 1_000 : undefined);
      await vi.waitFor(async () => expect((await fixture.requests()).filter(request => request.method === "mcpServerStatus/list").length).toBeGreaterThanOrEqual(2));
      if (operation === "cancel") await turn.cancel();
      else if (operation === "close") await fixture.runtime.close({ handle, reason: "test-close" });
      else if (operation === "shutdown") await fixture.runtime.shutdown?.();
      const result = await turn.result;
      expect(result.status).not.toBe("completed");
      await fixture.setState({ servers: [{ name: "docs", runtimeStatus: "connected" }] });
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(businessTurns(await fixture.requests())).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  }, 15_000);
});
