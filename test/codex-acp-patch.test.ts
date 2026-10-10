import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAcpRuntime, createAgentRegistry, createRuntimeStore, type AcpRuntimeHandle } from "acpx/runtime";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const codexAcpSource = (): string => readFileSync(require.resolve("@agentclientprotocol/codex-acp"), "utf8");

type CodexRequest = { method: string; params: Record<string, unknown> };

const createCodexFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-agent-codex-policy-"));
  const workspace = join(root, "workspace");
  const home = join(root, "codex-home");
  const requestsPath = join(root, "requests.jsonl");
  await mkdir(workspace);
  await mkdir(home);
  // CODEX_PATH=node runs this local fake when the real bridge launches `app-server`.
  await writeFile(join(workspace, "app-server"),
    `require(${JSON.stringify(join(import.meta.dirname, "fixtures/codex-app-server.cjs"))});\n`);
  const runtime = createAcpRuntime({
    cwd: workspace,
    sessionStore: createRuntimeStore({ stateDir: join(root, "acpx") }),
    agentRegistry: createAgentRegistry({ overrides: {
      fixture: [process.execPath, require.resolve("@agentclientprotocol/codex-acp")]
    } }),
    agentProcessEnv: {
      CODEX_PATH: process.execPath,
      CODEX_HOME: home,
      CODEX_CONFIG: JSON.stringify({ sandbox_workspace_write: { network_access: false } }),
      INITIAL_AGENT_MODE: "",
      APP_SERVER_LOGS: "",
      DEFAULT_AUTH_REQUEST: "",
      MODEL_PROVIDER: "",
      CODEX_API_KEY: "",
      OPENAI_API_KEY: "",
      CODEX_TEST_REQUESTS_PATH: requestsPath
    },
    permissionMode: "approve-all",
    nonInteractivePermissions: "fail",
    timeoutMs: 5_000
  });
  return {
    runtime,
    ensure: (resumeSessionId?: string) => runtime.ensureSession({
      sessionKey: "codex-policy-test",
      agent: "fixture",
      mode: "persistent",
      cwd: workspace,
      ...(resumeSessionId === undefined ? {} : { resumeSessionId })
    }),
    prompt: async (handle: AcpRuntimeHandle) => {
      const turn = runtime.startTurn({ handle, text: "hello", mode: "prompt" });
      expect(await turn.result).toMatchObject({ status: "completed", stopReason: "end_turn" });
    },
    requests: async (): Promise<CodexRequest[]> => (await readFile(requestsPath, "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as CodexRequest),
    cleanup: async () => {
      try { await runtime.shutdown?.(); }
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
      expect(requests.filter(request => request.method === "thread/start")).toHaveLength(1);
      expect(requests.filter(request => request.method === "thread/resume")).toHaveLength(1);
      const turns = requests.filter(request => request.method === "turn/start");
      expect(turns).toHaveLength(3);
      for (const turn of turns) {
        expect(turn.params.threadId).toBe("fixture-codex-session");
        expect(turn.params.approvalPolicy).toBe("on-request");
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
    ["agent-full-access", "never", { type: "dangerFullAccess" }]
  ] as const)("preserves the %s mode policy", async (mode, approvalPolicy, sandboxPolicy) => {
    const fixture = await createCodexFixture();
    try {
      const handle = await fixture.ensure();
      await fixture.runtime.setMode!({ handle, mode });
      await fixture.prompt(handle);

      const turns = (await fixture.requests()).filter(request => request.method === "turn/start");
      expect(turns).toHaveLength(1);
      expect(turns[0]?.params.approvalPolicy).toBe(approvalPolicy);
      expect(turns[0]?.params.sandboxPolicy).toEqual(sandboxPolicy);
    } finally {
      await fixture.cleanup();
    }
  }, 15_000);
});

describe("Codex ACP MCP startup patch", () => {
  it("uses thread-scoped server info instead of transient cancelled notifications", () => {
    const source = codexAcpSource();

    expect(source).toContain("async waitForMcpServerReadiness(sessionId, requestedServers)");
    expect(source).toContain("listMcpServers(sessionId)");
    expect(source).toContain("server !== undefined && server.serverInfo !== null");
    expect(source).not.toContain("runtimeStatus");
    expect(source).not.toContain("...mcpStartup.cancelled\n    ].filter");
  });
});
