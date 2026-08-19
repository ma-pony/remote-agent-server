import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AcpAgentRegistry,
  AcpRuntime,
  AcpRuntimeDoctorReport,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimeTurn,
  AcpRuntimeTurnResult
} from "acpx/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { RuntimeSessionInput } from "../src/runtime/agent-runtime.js";
import type { RuntimeMcpServer } from "../src/mcp/mcp-types.js";
import { createFakeRuntime } from "./helpers.js";

const acpxMocks = vi.hoisted(() => ({
  createAcpRuntime: vi.fn(),
  createRuntimeStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn() }))
}));

vi.mock("acpx/runtime", () => acpxMocks);

import { AcpxAgentRuntime, AgentRuntimeError } from "../src/runtime/acpx-runtime.js";
import { BEST_EFFORT_TIMEOUT_MS, settleBestEffort } from "../src/runtime/bounded-operation.js";
import { SkillProjector } from "../src/runtime/skill-projector.js";
import { SkillManager } from "../src/skills/skill-manager.js";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_AGENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REQUEST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const tempDirs: string[] = [];

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "remote-agent-runtime-"));
  tempDirs.push(root);
  return root;
};

const makeConfig = (root: string): AppConfig => ({
  host: "127.0.0.1",
  port: 3000,
  apiToken: "test-token",
  dataDir: join(root, "data"),
  databasePath: join(root, "data", "db.sqlite3"),
  projectEnvironmentsRoot: join(root, "environments"),
  sessionsRoot: join(root, "sessions"),
  maxConcurrentRuns: 4,
  projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000,
  projectPrepareTimeoutMs: 30 * 60 * 1000
});

const sessionInput = (root: string, overrides: Partial<RuntimeSessionInput> = {}): RuntimeSessionInput => ({
  sessionId: SESSION_ID,
  agentId: AGENT_ID,
  provider: "codex",
  workspacePath: join(root, "session's workspace"),
  browserProfilePath: join(root, "browser's profile"),
  providerSessionId: null,
  instructions: "只根据当前代码和测试给出结论。",
  memory: "Always inspect the current code.",
  mcpServers: [],
  ...overrides
});

type RuntimeStub = AcpRuntime & {
  ensureSession: ReturnType<typeof vi.fn>;
  startTurn: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  doctor: ReturnType<typeof vi.fn>;
};

const runtimeStub = (overrides: {
  handle?: Partial<AcpRuntimeHandle>;
  events?: AcpRuntimeEvent[];
  result?: AcpRuntimeTurnResult;
  cumulativeUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
  };
  perRequestUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
  }>;
  doctor?: AcpRuntimeDoctorReport;
} = {}): RuntimeStub => {
  const handle: AcpRuntimeHandle = {
    sessionKey: `remote-agent:${SESSION_ID}`,
    backend: "acpx",
    runtimeSessionName: "encoded",
    agentSessionId: "provider-session-1",
    ...overrides.handle
  };
  const turn = {
    requestId: REQUEST_ID,
    events: {
      async *[Symbol.asyncIterator]() {
        yield* overrides.events ?? [];
      }
    },
    result: Promise.resolve(overrides.result ?? { status: "completed" }),
    cancel: vi.fn(async () => undefined),
    closeStream: vi.fn(async () => undefined)
  } satisfies AcpRuntimeTurn;

  return {
    ensureSession: vi.fn(async () => handle),
    startTurn: vi.fn(() => turn),
    runTurn: vi.fn(),
    getStatus: vi.fn(async () => ({
      usage: overrides.cumulativeUsage === undefined
        && overrides.perRequestUsage === undefined
        ? undefined
        : {
          ...(overrides.cumulativeUsage === undefined ? {} : { cumulative: overrides.cumulativeUsage }),
          ...(overrides.perRequestUsage === undefined ? {} : { perRequest: overrides.perRequestUsage })
        }
    })),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    doctor: vi.fn(async () => overrides.doctor ?? ({ ok: true, message: "ready", details: [] }))
  } as unknown as RuntimeStub;
};

beforeEach(() => {
  acpxMocks.createAcpRuntime.mockReset();
  acpxMocks.createRuntimeStore.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  tempDirs.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
});

describe("Fake AgentRuntime", () => {
  it("按给定事件序列和终态运行", async () => {
    const runtime = createFakeRuntime({
      events: [{ type: "message", stream: "output", text: "hello" }],
      result: { status: "failed", code: "provider_failed", message: "failed" }
    });

    const turn = runtime.startTurn({ sessionId: SESSION_ID, requestId: REQUEST_ID, text: "go" });

    const events = [];
    for await (const event of turn.events) events.push(event);
    expect(events).toEqual([{ type: "message", stream: "output", text: "hello" }]);
    await expect(turn.result).resolves.toEqual({ status: "failed", code: "provider_failed", message: "failed" });
  });

  it("有界 best-effort 超时后清理 timer 且不等待未结束操作", async () => {
    vi.useFakeTimers();
    try {
      const outcome = settleBestEffort(() => new Promise<void>(() => undefined));

      await vi.advanceTimersByTimeAsync(BEST_EFFORT_TIMEOUT_MS);

      await expect(outcome).resolves.toMatchObject({ status: "timed_out" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SkillProjector", () => {
  it.each([
    ["claude_code", [".claude", "skills"]],
    ["codex", [".agents", "skills"]],
    ["hermes", ["data", "agents", AGENT_ID, "provider-home", "hermes", "skills"]]
  ] as const)("为 %s 投影托管 Skills 并保留已有 Skill", (provider, destinationParts) => {
    const root = makeRoot();
    const config = makeConfig(root);
    const source = join(config.dataDir, "agents", AGENT_ID, "skills", "ticket-workflow");
    const destination = join(root, ...destinationParts);
    mkdirSync(source, { recursive: true });
    mkdirSync(join(destination, "template-skill"), { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "new skill");
    writeFileSync(join(destination, "template-skill", "SKILL.md"), "keep me");
    const memoryPath = join(config.dataDir, "agents", AGENT_ID, "MEMORY.md");
    writeFileSync(memoryPath, "remember this");

    const memory = new SkillProjector(config.dataDir).prepare(
      { id: AGENT_ID, provider },
      { workspacePath: root }
    );

    expect(memory).toBe("remember this");
    expect(readFileSync(join(destination, "_remote-agent-managed-ticket-workflow", "SKILL.md"), "utf8")).toBe("new skill");
    expect(readFileSync(join(destination, "template-skill", "SKILL.md"), "utf8")).toBe("keep me");
  });

  it("MEMORY.md 不存在时返回空文本", () => {
    const root = makeRoot();
    const config = makeConfig(root);

    const memory = new SkillProjector(config.dataDir).prepare(
      { id: AGENT_ID, provider: "codex" },
      { workspacePath: root }
    );

    expect(memory).toBe("");
  });

  it("Memory 读取失败时保留旧托管 Skills", () => {
    const root = makeRoot();
    const config = makeConfig(root);
    const managed = join(root, ".agents", "skills", "_remote-agent-managed-old-skill");
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, "SKILL.md"), "old skill");
    mkdirSync(join(config.dataDir, "agents", AGENT_ID, "MEMORY.md"), { recursive: true });

    expect(() => new SkillProjector(config.dataDir).prepare(
      { id: AGENT_ID, provider: "codex" },
      { workspacePath: root }
    )).toThrow();

    expect(readFileSync(join(managed, "SKILL.md"), "utf8")).toBe("old skill");
  });

  it("Skills 复制失败时保留旧目录并清理临时目录", () => {
    const root = makeRoot();
    const config = makeConfig(root);
    const skillsRoot = join(root, ".agents", "skills");
    const managed = join(skillsRoot, "_remote-agent-managed-old-skill");
    mkdirSync(join(config.dataDir, "agents", AGENT_ID, "skills", "new-skill"), { recursive: true });
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, "SKILL.md"), "old skill");
    const projector = new SkillProjector(config.dataDir, {
      copy: () => { throw new Error("copy failed"); }
    });

    expect(() => projector.prepare(
      { id: AGENT_ID, provider: "codex" },
      { workspacePath: root }
    )).toThrow("copy failed");

    expect(readFileSync(join(managed, "SKILL.md"), "utf8")).toBe("old skill");
    expect(readdirSync(skillsRoot)).toEqual(["_remote-agent-managed-old-skill"]);
  });
});

describe("AcpxAgentRuntime", () => {
  it.each([
    ["claude_code", "npx -y @agentclientprotocol/claude-agent-acp@^0.60.0"],
    ["codex", "npx -y @agentclientprotocol/codex-acp@^1.1.5"],
    ["hermes", "hermes acp"]
  ] as const)("固定 %s Provider 命令并安全转义路径", async (provider, providerCommand) => {
    const root = makeRoot();
    const config = makeConfig(root);
    const acp = runtimeStub();
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(config);
    const input = sessionInput(root, { provider });

    await runtime.ensureSession(input);

    const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
    const target = `remote:${provider}:${AGENT_ID}:${SESSION_ID}`;
    const command = options.agentRegistry.resolve(target);
    expect(command).toContain("REMOTE_AGENT_BROWSER_PROFILE='" + input.browserProfilePath.replaceAll("'", "'\\''") + "'");
    expect(command).toContain(providerCommand);
    if (provider === "hermes") {
      expect(command).toContain(`HERMES_HOME='${join(config.dataDir, "agents", AGENT_ID, "provider-home", "hermes")}'`);
      expect(command).not.toContain("CODEX_HOME=");
      expect(command).not.toContain("CLAUDE_CONFIG_DIR=");
    } else if (provider === "codex") {
      expect(command).toContain(`CODEX_HOME='${join(
        config.dataDir, "agents", AGENT_ID, "provider-home", "codex", "sessions", SESSION_ID
      )}'`);
      expect(command).not.toContain("HERMES_HOME=");
      expect(command).not.toContain("CLAUDE_CONFIG_DIR=");
    } else {
      expect(command).toContain(`CLAUDE_CONFIG_DIR='${join(config.dataDir, "agents", AGENT_ID, "provider-home", "claude")}'`);
      expect(command).not.toContain("HERMES_HOME=");
      expect(command).not.toContain("CODEX_HOME=");
    }
    expect(options.agentRegistry.list()).toContain(target);
  });

  it("拒绝可注入 Registry target 的非法 ID", async () => {
    const root = makeRoot();
    acpxMocks.createAcpRuntime.mockReturnValue(runtimeStub());
    const runtime = new AcpxAgentRuntime(makeConfig(root));

    await expect(runtime.ensureSession(sessionInput(root, { agentId: "bad:id; touch /tmp/pwned" })))
      .rejects.toMatchObject({ code: "invalid_runtime_target" });
    await expect(runtime.ensureSession(sessionInput(root, { sessionId: "not-a-uuid" })))
      .rejects.toMatchObject({ code: "invalid_runtime_target" });
  });

  it("Codex Provider Home 只链接登录文件并禁用主机 Skills，不复制全局插件配置", async () => {
    const root = makeRoot();
    const config = makeConfig(root);
    const hostCodexHome = join(root, "host-codex");
    mkdirSync(hostCodexHome, { recursive: true });
    writeFileSync(join(hostCodexHome, "auth.json"), "secret auth");
    writeFileSync(join(hostCodexHome, "config.toml"), "[plugins]\n");
    const hostSkill = join(root, "host-agents", "skills", "review");
    mkdirSync(hostSkill, { recursive: true });
    writeFileSync(join(hostSkill, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n");
    vi.stubEnv("CODEX_HOME", hostCodexHome);
    acpxMocks.createAcpRuntime.mockReturnValue(runtimeStub());
    const runtime = new AcpxAgentRuntime(config, new SkillManager({
      dataDir: config.dataDir,
      roots: [{ path: join(root, "host-agents", "skills"), source: "agents" }]
    }));

    await runtime.ensureSession(sessionInput(root));

    const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
    options.agentRegistry.resolve(`remote:codex:${AGENT_ID}:${SESSION_ID}`);
    const sessionHome = join(
      config.dataDir, "agents", AGENT_ID, "provider-home", "codex", "sessions", SESSION_ID
    );
    expect(readlinkSync(join(sessionHome, "auth.json"))).toBe(join(hostCodexHome, "auth.json"));
    const isolatedConfig = readFileSync(join(sessionHome, "config.toml"), "utf8");
    expect(isolatedConfig).toContain(`path = ${JSON.stringify(join(hostSkill, "SKILL.md"))}`);
    expect(isolatedConfig).toContain("enabled = false");
    expect(isolatedConfig).not.toContain("[plugins]");
  });

  it("Hermes Provider Home 复用主机模型和登录配置但不链接主机 Skills", async () => {
    const root = makeRoot();
    const config = makeConfig(root);
    const hostHermesHome = join(root, "host-hermes");
    mkdirSync(join(hostHermesHome, "skills", "global-skill"), { recursive: true });
    writeFileSync(join(hostHermesHome, "config.yaml"), "model:\n  default: test-model\n");
    writeFileSync(join(hostHermesHome, "auth.json"), "secret auth");
    writeFileSync(join(hostHermesHome, ".env"), "SECRET=value\n");
    writeFileSync(join(hostHermesHome, "skills", "global-skill", "SKILL.md"), "global skill");
    vi.stubEnv("HERMES_HOME", hostHermesHome);
    acpxMocks.createAcpRuntime.mockReturnValue(runtimeStub());
    const runtime = new AcpxAgentRuntime(config);

    await runtime.ensureSession(sessionInput(root, { provider: "hermes" }));

    const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
    options.agentRegistry.resolve(`remote:hermes:${AGENT_ID}:${SESSION_ID}`);
    const agentHome = join(config.dataDir, "agents", AGENT_ID, "provider-home", "hermes");
    for (const file of ["config.yaml", "auth.json", ".env"]) {
      expect(readlinkSync(join(agentHome, file))).toBe(join(hostHermesHome, file));
    }
    expect(existsSync(join(agentHome, "skills", "global-skill"))).toBe(false);
  });

  it("使用固定 Runtime 配置、稳定 sessionKey 和首次 system prompt", async () => {
    const root = makeRoot();
    const config = makeConfig(root);
    const acp = runtimeStub({ handle: { agentSessionId: undefined, backendSessionId: "backend-session-1" } });
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(config);
    const input = sessionInput(root, { provider: "claude_code" });

    await expect(runtime.ensureSession(input)).resolves.toEqual({ providerSessionId: "backend-session-1" });

    expect(acpxMocks.createRuntimeStore).toHaveBeenCalledWith({ stateDir: join(config.dataDir, "acpx") });
    const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
    expect(options).toMatchObject({
      cwd: config.projectEnvironmentsRoot,
      permissionMode: "approve-all",
      nonInteractivePermissions: "fail"
    });
    expect(acp.ensureSession).toHaveBeenCalledWith({
      sessionKey: `remote-agent:${SESSION_ID}`,
      agent: `remote:claude_code:${AGENT_ID}:${SESSION_ID}`,
      mode: "persistent",
      cwd: input.workspacePath,
      sessionOptions: {
        systemPrompt: {
          append: expect.stringContaining(input.memory)
        }
      }
    });
    const append = (acp.ensureSession.mock.calls[0]?.[0] as { sessionOptions: { systemPrompt: { append: string } } })
      .sessionOptions.systemPrompt.append;
    expect(append).toContain(input.workspacePath);
    expect(append).toContain(input.browserProfilePath);
    expect(append).toContain(input.instructions);
  });

  it("Codex 为每个 Session 使用独立 Home 并写入 developer instructions", async () => {
    const root = makeRoot();
    const config = makeConfig(root);
    const acp = runtimeStub();
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(config);
    const input = sessionInput(root, { provider: "codex", instructions: "保持输出简洁。" });

    await runtime.ensureSession(input);

    const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
    const command = options.agentRegistry.resolve(`remote:codex:${AGENT_ID}:${SESSION_ID}`);
    const sessionHome = join(
      config.dataDir, "agents", AGENT_ID, "provider-home", "codex", "sessions", SESSION_ID
    );
    expect(command).toContain(`CODEX_HOME='${sessionHome}'`);
    expect(readFileSync(join(sessionHome, "config.toml"), "utf8")).toContain(
      'developer_instructions = "保持输出简洁。"'
    );
  });

  it("Hermes 不把智能体指令伪装成 ACP system prompt", async () => {
    const root = makeRoot();
    const acp = runtimeStub();
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));

    await runtime.ensureSession(sessionInput(root, { provider: "hermes", instructions: "不应发送" }));

    const ensureInput = acp.ensureSession.mock.calls[0]?.[0] as { sessionOptions?: unknown };
    expect(ensureInput).not.toHaveProperty("sessionOptions");
  });

  it("恢复时传入 Provider Session ID 且不重新注入 prompt", async () => {
    const root = makeRoot();
    const acp = runtimeStub({ handle: { agentSessionId: "provider-session-1" } });
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));

    await runtime.ensureSession(sessionInput(root, { providerSessionId: "provider-session-1" }));

    expect(acp.ensureSession).toHaveBeenCalledWith(expect.objectContaining({
      resumeSessionId: "provider-session-1"
    }));
    expect(acp.ensureSession.mock.calls[0]?.[0]).not.toHaveProperty("sessionOptions");
  });

  it("为当前 Session 创建独立 Runtime 并通过 ACP 注入 HTTP/stdio MCP", async () => {
    const root = makeRoot();
    const acp = runtimeStub();
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));
    const mcpServers: RuntimeMcpServer[] = [
      {
        type: "http",
        name: "remote_http",
        url: "https://example.test/mcp",
        headers: [{ name: "Authorization", value: "Bearer secret" }]
      },
      {
        type: "stdio",
        name: "local_stdio",
        command: "/usr/bin/true",
        args: ["--mode", "safe"],
        env: [{ name: "TOKEN", value: "secret" }]
      }
    ];

    await runtime.ensureSession(sessionInput(root, { mcpServers }));

    expect(acpxMocks.createAcpRuntime).toHaveBeenCalledTimes(1);
    expect(acpxMocks.createAcpRuntime.mock.calls[0]?.[0]).toMatchObject({ mcpServers });
    expect(acp.ensureSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: `remote-agent:${SESSION_ID}`
    }));
  });

  it("恢复得到不同 Provider ID 时关闭新 Handle 并报 session_resume_failed", async () => {
    const root = makeRoot();
    const acp = runtimeStub({ handle: { agentSessionId: "wrong-provider-session" } });
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));

    await expect(runtime.ensureSession(sessionInput(root, { providerSessionId: "expected-provider-session" })))
      .rejects.toEqual(new AgentRuntimeError("session_resume_failed", "Provider session resume returned a different session ID"));
    expect(acp.close).toHaveBeenCalledWith({
      handle: expect.any(Object),
      reason: "provider_session_id_mismatch"
    });
    expect(() => runtime.startTurn({ sessionId: SESSION_ID, requestId: REQUEST_ID, text: "go" }))
      .toThrowError(expect.objectContaining({ code: "session_not_ready" }));
    const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
    expect(options.agentRegistry.list()).toEqual([]);
  });

  it("mismatch Handle 关闭失败时仍清理 cache 和 Registry 并保留 close 原错误", async () => {
    const root = makeRoot();
    const closeError = new Error("close failed");
    const acp = runtimeStub({ handle: { agentSessionId: "wrong-provider-session" } });
    acp.close.mockRejectedValueOnce(closeError);
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));

    await expect(runtime.ensureSession(sessionInput(root, { providerSessionId: "expected-provider-session" })))
      .rejects.toBe(closeError);

    expect(acp.close).toHaveBeenCalledWith({
      handle: expect.any(Object),
      reason: "provider_session_id_mismatch"
    });
    expect(() => runtime.startTurn({ sessionId: SESSION_ID, requestId: REQUEST_ID, text: "go" }))
      .toThrowError(expect.objectContaining({ code: "session_not_ready" }));
    const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
    expect(options.agentRegistry.list()).toEqual([]);
  });

  it("重复 ensure 幂等且首次 prompt 只注入一次", async () => {
    const root = makeRoot();
    const acp = runtimeStub();
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));
    const input = sessionInput(root, { provider: "claude_code" });

    const first = await runtime.ensureSession(input);
    const second = await runtime.ensureSession(input);

    expect(first).toEqual(second);
    expect(acp.ensureSession).toHaveBeenCalledTimes(1);
    expect(acp.ensureSession.mock.calls[0]?.[0]).toHaveProperty("sessionOptions");
  });

  it("已有 Provider Session 的下一次 ensure 会刷新 Handle 并继续原 Session", async () => {
    const root = makeRoot();
    const acp = runtimeStub();
    const handle = await acp.ensureSession();
    acp.ensureSession.mockReset();
    acp.ensureSession.mockResolvedValue(handle);
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));

    await runtime.ensureSession(sessionInput(root));
    await runtime.ensureSession(sessionInput(root, { providerSessionId: "provider-session-1" }));

    expect(acp.close).toHaveBeenCalledWith({ handle, reason: "session_handle_refreshed" });
    expect(acp.ensureSession).toHaveBeenCalledTimes(2);
    expect(acp.ensureSession.mock.calls[1]?.[0]).toMatchObject({
      resumeSessionId: "provider-session-1"
    });
  });

  it("并发 ensure 按 Session 串行并复用同一 Handle", async () => {
    const root = makeRoot();
    const acp = runtimeStub();
    let release!: (handle: AcpRuntimeHandle) => void;
    acp.ensureSession.mockImplementationOnce(() => new Promise<AcpRuntimeHandle>((resolve) => {
      release = resolve;
    }));
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));
    const input = sessionInput(root);

    const first = runtime.ensureSession(input);
    const second = runtime.ensureSession(input);
    await vi.waitFor(() => expect(acp.ensureSession).toHaveBeenCalledTimes(1));
    release({
      sessionKey: `remote-agent:${SESSION_ID}`,
      backend: "acpx",
      runtimeSessionName: "encoded",
      agentSessionId: "provider-session-1"
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { providerSessionId: "provider-session-1" },
      { providerSessionId: "provider-session-1" }
    ]);
    expect(acp.ensureSession).toHaveBeenCalledTimes(1);
  });

  it("替换 Session Handle 前先关闭旧 Handle", async () => {
    const root = makeRoot();
    const acp = runtimeStub();
    const oldHandle = await acp.ensureSession();
    const newHandle = { ...oldHandle, agentSessionId: "provider-session-2", runtimeSessionName: "encoded-2" };
    acp.ensureSession.mockReset();
    acp.ensureSession.mockResolvedValueOnce(oldHandle).mockImplementationOnce(async () => {
      expect(acp.close).toHaveBeenCalledWith({ handle: oldHandle, reason: "session_handle_replaced" });
      return newHandle;
    });
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));

    await runtime.ensureSession(sessionInput(root));
    await runtime.ensureSession(sessionInput(root, { providerSessionId: "provider-session-2" }));

    expect(acp.close.mock.invocationCallOrder[0]).toBeLessThan(acp.ensureSession.mock.invocationCallOrder[1]!);
    expect(acp.ensureSession).toHaveBeenCalledTimes(2);
  });

  it("成功替换不同 target 后注销旧 Registry target", async () => {
    const root = makeRoot();
    const acp = runtimeStub();
    const oldHandle = await acp.ensureSession();
    const newHandle = { ...oldHandle, agentSessionId: "provider-session-2", runtimeSessionName: "encoded-2" };
    acp.ensureSession.mockReset();
    acp.ensureSession.mockResolvedValueOnce(oldHandle).mockResolvedValueOnce(newHandle);
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));
    await runtime.ensureSession(sessionInput(root));

    await runtime.ensureSession(sessionInput(root, {
      agentId: SECOND_AGENT_ID,
      provider: "claude_code",
      providerSessionId: "provider-session-2"
    }));

    expect(acpxMocks.createAcpRuntime).toHaveBeenCalledTimes(2);
    const options = acpxMocks.createAcpRuntime.mock.calls[1]?.[0] as AcpRuntimeOptions;
    expect(options.agentRegistry.list()).toEqual([
      `remote:claude_code:${SECOND_AGENT_ID}:${SESSION_ID}`
    ]);
  });

  it("替换旧 Handle 关闭失败时保留旧 cache/target 且不创建新 Handle", async () => {
    const root = makeRoot();
    const closeError = new Error("old handle close failed");
    const acp = runtimeStub();
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));
    await runtime.ensureSession(sessionInput(root));
    acp.close.mockRejectedValueOnce(closeError);

    await expect(runtime.ensureSession(sessionInput(root, {
      agentId: SECOND_AGENT_ID,
      provider: "claude_code"
    }))).rejects.toBe(closeError);

    expect(acp.ensureSession).toHaveBeenCalledTimes(1);
    const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
    expect(options.agentRegistry.list()).toEqual([
      `remote:codex:${AGENT_ID}:${SESSION_ID}`
    ]);
    expect(() => runtime.startTurn({ sessionId: SESSION_ID, requestId: REQUEST_ID, text: "go" })).not.toThrow();
  });

  it("Handle 正在替换时拒绝 startTurn 使用旧 Handle", async () => {
    const root = makeRoot();
    const acp = runtimeStub();
    const oldHandle = await acp.ensureSession();
    const newHandle = { ...oldHandle, agentSessionId: "provider-session-2", runtimeSessionName: "encoded-2" };
    let releaseClose!: () => void;
    acp.ensureSession.mockReset();
    acp.ensureSession.mockResolvedValueOnce(oldHandle).mockResolvedValueOnce(newHandle);
    acp.close.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseClose = resolve;
    }));
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));
    await runtime.ensureSession(sessionInput(root));

    const replacing = runtime.ensureSession(sessionInput(root, { providerSessionId: "provider-session-2" }));
    await vi.waitFor(() => expect(acp.close).toHaveBeenCalledTimes(1));

    expect(() => runtime.startTurn({ sessionId: SESSION_ID, requestId: REQUEST_ID, text: "go" }))
      .toThrowError(expect.objectContaining({ code: "session_not_ready" }));
    releaseClose();
    await expect(replacing).resolves.toEqual({ providerSessionId: "provider-session-2" });
    expect(acp.startTurn).not.toHaveBeenCalled();
  });

  it("映射实时事件并只从 result 读取 canonical 终态", async () => {
    const root = makeRoot();
    const acp = runtimeStub({
      events: [
        { type: "text_delta", stream: "thought", text: "thinking" },
        { type: "tool_call", text: "Read", toolCallId: "tool-1", rawInput: { path: "README.md" } },
        { type: "status", text: "working" }
      ],
      result: { status: "failed", error: { code: "provider_failed", message: "boom" } }
    });
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));
    await runtime.ensureSession(sessionInput(root));

    const turn = runtime.startTurn({ sessionId: SESSION_ID, requestId: REQUEST_ID, text: "go" });
    const events = [];
    for await (const event of turn.events) events.push(event);

    expect(events).toEqual([
      { type: "message", stream: "thought", text: "thinking" },
      { type: "tool", content: { text: "Read", toolCallId: "tool-1", rawInput: { path: "README.md" } } },
      { type: "status", text: "working" }
    ]);
    await expect(turn.result).resolves.toEqual({ status: "failed", code: "provider_failed", message: "boom" });
    await turn.closeEvents();
    const acpTurn = acp.startTurn.mock.results[0]?.value as AcpRuntimeTurn;
    expect(acpTurn.closeStream).toHaveBeenCalledTimes(1);
  });

  it("将 acpx usage_update 保留为结构化用量并独立忽略无效字段", async () => {
    const root = makeRoot();
    const acp = runtimeStub({
      events: [
        {
          type: "status",
          tag: "usage_update",
          text: "usage updated",
          used: 24_373,
          size: 258_400,
          breakdown: {
            inputTokens: 12_000,
            outputTokens: 2_000,
            cachedReadTokens: 8_000,
            cachedWriteTokens: -1,
            thoughtTokens: Number.NaN,
            totalTokens: 14_000
          }
        },
        { type: "status", text: "working" }
      ]
    });
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));
    await runtime.ensureSession(sessionInput(root));

    const turn = runtime.startTurn({ sessionId: SESSION_ID, requestId: REQUEST_ID, text: "go" });
    const events = [];
    for await (const event of turn.events) events.push(event);

    expect(events).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 12_000,
          outputTokens: 2_000,
          cachedReadTokens: 8_000,
          totalTokens: 14_000,
          contextUsedTokens: 24_373,
          contextWindowTokens: 258_400
        }
      },
      { type: "status", text: "working" }
    ]);
  });

  it("Turn 完成后汇总 acpx 的完整 perRequest 作为 Session 精确用量", async () => {
    const root = makeRoot();
    const acp = runtimeStub({
      cumulativeUsage: {
        inputTokens: 897,
        outputTokens: 17,
        cachedReadTokens: 15_104,
        thoughtTokens: 0,
        totalTokens: 16_018
      },
      perRequestUsage: {
        first: {
          inputTokens: 4_759,
          outputTokens: 14,
          cachedReadTokens: 11_008,
          thoughtTokens: 0,
          totalTokens: 15_781
        },
        second: {
          inputTokens: 897,
          outputTokens: 17,
          cachedReadTokens: 15_104,
          thoughtTokens: 0,
          totalTokens: 16_018
        }
      }
    });
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));
    await runtime.ensureSession(sessionInput(root));

    const turn = runtime.startTurn({ sessionId: SESSION_ID, requestId: REQUEST_ID, text: "go" });

    await expect(turn.result).resolves.toEqual({
      status: "completed",
      sessionUsage: {
        inputTokens: 5_656,
        outputTokens: 31,
        cachedReadTokens: 26_112,
        thoughtTokens: 0,
        totalTokens: 31_799
      }
    });
    expect(acp.getStatus).toHaveBeenCalledWith({ handle: expect.objectContaining({ agentSessionId: "provider-session-1" }) });
  });

  it("支持 turn cancel、session cancel 和 reset discard", async () => {
    const root = makeRoot();
    const acp = runtimeStub();
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));
    const input = sessionInput(root);
    await runtime.ensureSession(input);

    const turn = runtime.startTurn({ sessionId: SESSION_ID, requestId: REQUEST_ID, text: "go" });
    await turn.cancel();
    await turn.closeEvents();
    await runtime.cancel(SESSION_ID);
    await runtime.reset(input);

    const acpTurn = acp.startTurn.mock.results[0]?.value as AcpRuntimeTurn;
    expect(acpTurn.cancel).toHaveBeenCalled();
    expect(acpTurn.closeStream).toHaveBeenCalled();
    expect(acp.cancel).toHaveBeenCalledWith(expect.objectContaining({ reason: "cancelled_by_request" }));
    expect(acp.close).toHaveBeenCalledWith(expect.objectContaining({
      reason: "provider_session_reset",
      discardPersistentState: true
    }));
  });

  it("session cancel 绑定 active turn 而不是可变 Handle cache", async () => {
    const root = makeRoot();
    const acp = runtimeStub();
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));
    await runtime.ensureSession(sessionInput(root));

    const turn = runtime.startTurn({ sessionId: SESSION_ID, requestId: REQUEST_ID, text: "go" });
    await runtime.cancel(SESSION_ID);

    const acpTurn = acp.startTurn.mock.results[0]?.value as AcpRuntimeTurn;
    expect(acpTurn.cancel).toHaveBeenCalledWith({ reason: "cancelled_by_request" });
    expect(acp.cancel).not.toHaveBeenCalled();
    await expect(turn.result).resolves.toEqual({ status: "completed" });
  });

  it("shutdown 关闭 idle cached handle 且不 discard 持久状态，并拒绝新工作", async () => {
    const root = makeRoot();
    const acp = runtimeStub();
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));
    await runtime.ensureSession(sessionInput(root));
    const handle = (acp.ensureSession.mock.results[0]?.value) as Promise<AcpRuntimeHandle>;

    await runtime.shutdown();

    expect(acp.close).toHaveBeenCalledWith({
      handle: await handle,
      reason: "service_shutdown"
    });
    expect(acp.close.mock.calls[0]?.[0]).not.toHaveProperty("discardPersistentState");
    const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
    expect(options.agentRegistry.list()).toEqual([]);
    await expect(runtime.ensureSession(sessionInput(root))).rejects.toMatchObject({ code: "runtime_shutdown" });
    expect(() => runtime.startTurn({ sessionId: SESSION_ID, requestId: REQUEST_ID, text: "go" }))
      .toThrowError(expect.objectContaining({ code: "runtime_shutdown" }));
  });

  it("shutdown cancel 永不结束时仍有界关闭 cached handle", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const root = makeRoot();
      const acp = runtimeStub();
      acpxMocks.createAcpRuntime.mockReturnValue(acp);
      const runtime = new AcpxAgentRuntime(makeConfig(root));
      await runtime.ensureSession(sessionInput(root));
      runtime.startTurn({ sessionId: SESSION_ID, requestId: REQUEST_ID, text: "go" });
      const acpTurn = acp.startTurn.mock.results[0]?.value as AcpRuntimeTurn;
      acpTurn.cancel = vi.fn(() => new Promise<void>(() => undefined));

      const shutdown = expect(runtime.shutdown()).rejects.toBeInstanceOf(AggregateError);
      await vi.advanceTimersByTimeAsync(BEST_EFFORT_TIMEOUT_MS);
      await shutdown;

      expect(acpTurn.cancel).toHaveBeenCalledWith({ reason: "service_shutdown" });
      expect(acp.close).toHaveBeenCalledWith(expect.objectContaining({ reason: "service_shutdown" }));
      expect(consoleError).toHaveBeenCalledWith(expect.any(AggregateError));
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("shutdown handle close 永不结束时保留 Handle 并 reject AggregateError", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const root = makeRoot();
      const acp = runtimeStub();
      acp.close.mockImplementation(() => new Promise<void>(() => undefined));
      acpxMocks.createAcpRuntime.mockReturnValue(acp);
      const runtime = new AcpxAgentRuntime(makeConfig(root));
      await runtime.ensureSession(sessionInput(root));

      const shutdown = expect(runtime.shutdown()).rejects.toBeInstanceOf(AggregateError);
      await vi.advanceTimersByTimeAsync(BEST_EFFORT_TIMEOUT_MS);
      await shutdown;

      expect(acp.close).toHaveBeenCalledWith(expect.objectContaining({ reason: "service_shutdown" }));
      expect(consoleError).toHaveBeenCalledWith(expect.any(AggregateError));
      const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
      expect(options.agentRegistry.list()).toEqual([`remote:codex:${AGENT_ID}:${SESSION_ID}`]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("shutdown idle handle close reject 时完成其他清理后 reject AggregateError", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const root = makeRoot();
    const acp = runtimeStub();
    acp.close.mockRejectedValueOnce(new Error("close rejected"));
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(makeConfig(root));
    await runtime.ensureSession(sessionInput(root));

    await expect(runtime.shutdown()).rejects.toEqual(expect.objectContaining({
      name: "AggregateError",
      errors: [expect.objectContaining({
        stage: "handle_close",
        sessionId: SESSION_ID,
        cause: expect.objectContaining({ message: "close rejected" })
      })]
    }));

    const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
    expect(options.agentRegistry.list()).toEqual([`remote:codex:${AGENT_ID}:${SESSION_ID}`]);
    consoleError.mockRestore();
  });

  it("shutdown failure 快照不能被调用方修改并污染内部错误", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const root = makeRoot();
      const closeError = new Error("close rejected");
      const acp = runtimeStub();
      acp.close.mockRejectedValueOnce(closeError);
      acpxMocks.createAcpRuntime.mockReturnValue(acp);
      const runtime = new AcpxAgentRuntime(makeConfig(root));
      await runtime.ensureSession(sessionInput(root));

      await expect(runtime.shutdown()).rejects.toBeInstanceOf(AggregateError);
      const snapshot = runtime.shutdownFailureState as unknown as Array<Record<string, unknown>>;
      const exposedCause = snapshot[0]?.cause;

      const entryMutationAccepted = Reflect.set(snapshot[0]!, "message", "tampered failure");
      const causeMutationAccepted = exposedCause instanceof Object
        ? Reflect.set(exposedCause, "message", "tampered cause")
        : false;
      let arrayMutationError: unknown;
      try {
        snapshot.push({ stage: "tampered", sessionId: "tampered", message: "tampered failure" });
      } catch (error) {
        arrayMutationError = error;
      }

      const nextSnapshot = runtime.shutdownFailureState;
      const repeatedError = await runtime.shutdown().catch((error: unknown) => error as AggregateError);
      const repeatedFailure = repeatedError.errors[0] as Error & { cause?: unknown };
      const expectedMessage = `Runtime shutdown handle_close failed for Session ${SESSION_ID}`;

      expect(nextSnapshot).toEqual([{ stage: "handle_close", sessionId: SESSION_ID, message: expectedMessage }]);
      expect(nextSnapshot[0]).not.toBe(snapshot[0]);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot[0])).toBe(true);
      expect(snapshot[0]).not.toHaveProperty("cause");
      expect(entryMutationAccepted).toBe(false);
      expect(causeMutationAccepted).toBe(false);
      expect(arrayMutationError).toBeInstanceOf(TypeError);
      expect(repeatedError.message).toBe(
        "Runtime shutdown timed out or failed; process exit is required to release any remaining provider resources"
      );
      expect(repeatedFailure.message).toBe(expectedMessage);
      expect(repeatedFailure.cause).toBe(closeError);
      expect(closeError.message).toBe("close rejected");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("operation timeout 后保留 target，晚返回 Handle close reject 对重复 shutdown 可见", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const root = makeRoot();
      const acp = runtimeStub();
      let releaseHandle!: (handle: AcpRuntimeHandle) => void;
      acp.ensureSession.mockImplementationOnce(() => new Promise<AcpRuntimeHandle>((resolve) => {
        releaseHandle = resolve;
      }));
      acp.close.mockRejectedValue(new Error("late close rejected"));
      acpxMocks.createAcpRuntime.mockReturnValue(acp);
      const runtime = new AcpxAgentRuntime(makeConfig(root));
      const ensuring = runtime.ensureSession(sessionInput(root));
      await vi.advanceTimersByTimeAsync(0);
      expect(acp.ensureSession).toHaveBeenCalledTimes(1);
      const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;

      const firstShutdown = expect(runtime.shutdown()).rejects.toBeInstanceOf(AggregateError);
      await vi.advanceTimersByTimeAsync(BEST_EFFORT_TIMEOUT_MS);
      await firstShutdown;

      expect(options.agentRegistry.list()).toEqual([`remote:codex:${AGENT_ID}:${SESSION_ID}`]);
      expect(runtime.shutdownFailureState).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: "session_operation", sessionId: SESSION_ID })
      ]));
      const lateHandle: AcpRuntimeHandle = {
        sessionKey: `remote-agent:${SESSION_ID}`,
        backend: "acpx",
        runtimeSessionName: "late",
        agentSessionId: "provider-session-1"
      };
      releaseHandle(lateHandle);
      await expect(ensuring).rejects.toMatchObject({ code: "runtime_shutdown" });

      expect(options.agentRegistry.list()).toEqual([`remote:codex:${AGENT_ID}:${SESSION_ID}`]);
      expect(runtime.shutdownFailureState).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: "late_handle_close", sessionId: SESSION_ID })
      ]));
      await expect(runtime.shutdown()).rejects.toEqual(expect.objectContaining({
        errors: expect.arrayContaining([
          expect.objectContaining({ stage: "session_operation", sessionId: SESSION_ID }),
          expect.objectContaining({ stage: "late_handle_close", sessionId: SESSION_ID })
        ])
      }));
      await expect(runtime.ensureSession(sessionInput(root))).rejects.toMatchObject({ code: "runtime_shutdown" });
      expect(() => runtime.startTurn({ sessionId: SESSION_ID, requestId: REQUEST_ID, text: "new work" }))
        .toThrowError(expect.objectContaining({ code: "runtime_shutdown" }));
      await runtime.cancel(SESSION_ID);
      expect(acp.cancel).toHaveBeenCalledWith({ handle: lateHandle, reason: "cancelled_by_request" });
      expect(acp.close).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("operation timeout 后晚返回 Handle close 成功才 unregister target", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const root = makeRoot();
      const acp = runtimeStub();
      let releaseHandle!: (handle: AcpRuntimeHandle) => void;
      acp.ensureSession.mockImplementationOnce(() => new Promise<AcpRuntimeHandle>((resolve) => {
        releaseHandle = resolve;
      }));
      acpxMocks.createAcpRuntime.mockReturnValue(acp);
      const runtime = new AcpxAgentRuntime(makeConfig(root));
      const ensuring = runtime.ensureSession(sessionInput(root));
      await vi.advanceTimersByTimeAsync(0);
      const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;

      const firstShutdown = expect(runtime.shutdown()).rejects.toBeInstanceOf(AggregateError);
      await vi.advanceTimersByTimeAsync(BEST_EFFORT_TIMEOUT_MS);
      await firstShutdown;
      expect(options.agentRegistry.list()).toEqual([`remote:codex:${AGENT_ID}:${SESSION_ID}`]);

      releaseHandle({
        sessionKey: `remote-agent:${SESSION_ID}`,
        backend: "acpx",
        runtimeSessionName: "late",
        agentSessionId: "provider-session-1"
      });
      await expect(ensuring).rejects.toMatchObject({ code: "runtime_shutdown" });

      expect(acp.close).toHaveBeenCalledTimes(1);
      expect(options.agentRegistry.list()).toEqual([]);
      expect(runtime.shutdownFailureState).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: "late_handle_close" })
      ]));
      await expect(runtime.shutdown()).rejects.toEqual(expect.objectContaining({
        errors: expect.arrayContaining([
          expect.objectContaining({ stage: "session_operation", sessionId: SESSION_ID })
        ])
      }));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(["claude_code", "codex", "hermes"] as const)("doctor probe 指向指定的 %s Provider", async (provider) => {
    const root = makeRoot();
    const probe = runtimeStub({ doctor: { ok: false, message: `${provider} unavailable`, details: ["missing"] } });
    acpxMocks.createAcpRuntime.mockReturnValue(probe);
    const runtime = new AcpxAgentRuntime(makeConfig(root));

    await expect(runtime.doctor(provider, AGENT_ID)).resolves.toEqual({
      ok: false,
      message: `${provider} unavailable`,
      details: ["missing"]
    });

    const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
    expect(options.probeAgent).toMatch(new RegExp(`^remote:${provider}:${AGENT_ID}:`));
    expect(options.agentRegistry.list()).toEqual([]);
  });

  it.each(["success", "undefined", "error"] as const)("doctor 在 %s 路径清理临时 Registry", async (outcome) => {
    const root = makeRoot();
    const probe = runtimeStub();
    if (outcome === "undefined") probe.doctor = undefined as never;
    if (outcome === "error") probe.doctor.mockRejectedValueOnce(new Error("probe crashed"));
    acpxMocks.createAcpRuntime.mockReturnValue(probe);
    const runtime = new AcpxAgentRuntime(makeConfig(root));

    if (outcome === "error") {
      await expect(runtime.doctor("codex", AGENT_ID)).rejects.toThrow("probe crashed");
    } else {
      await runtime.doctor("codex", AGENT_ID);
    }

    const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
    expect(options.agentRegistry.list()).toEqual([]);
  });
});
