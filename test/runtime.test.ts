import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { createFakeRuntime } from "./helpers.js";

const acpxMocks = vi.hoisted(() => ({
  createAcpRuntime: vi.fn(),
  createRuntimeStore: vi.fn(() => ({ load: vi.fn(), save: vi.fn() }))
}));

vi.mock("acpx/runtime", () => acpxMocks);

import { AcpxAgentRuntime, AgentRuntimeError } from "../src/runtime/acpx-runtime.js";
import { BEST_EFFORT_TIMEOUT_MS, settleBestEffort } from "../src/runtime/bounded-operation.js";
import { SkillProjector } from "../src/runtime/skill-projector.js";

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
  workspaceTemplate: join(root, "template"),
  sessionsRoot: join(root, "sessions"),
  maxConcurrentRuns: 4
});

const sessionInput = (root: string, overrides: Partial<RuntimeSessionInput> = {}): RuntimeSessionInput => ({
  sessionId: SESSION_ID,
  agentId: AGENT_ID,
  provider: "codex",
  workspacePath: join(root, "session's workspace"),
  browserProfilePath: join(root, "browser's profile"),
  providerSessionId: null,
  memory: "Always inspect the current code.",
  ...overrides
});

type RuntimeStub = AcpRuntime & {
  ensureSession: ReturnType<typeof vi.fn>;
  startTurn: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  doctor: ReturnType<typeof vi.fn>;
};

const runtimeStub = (overrides: {
  handle?: Partial<AcpRuntimeHandle>;
  events?: AcpRuntimeEvent[];
  result?: AcpRuntimeTurnResult;
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
    mkdirSync(join(destination, "_remote-agent-managed", "stale"), { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "new skill");
    writeFileSync(join(destination, "template-skill", "SKILL.md"), "keep me");
    writeFileSync(join(destination, "_remote-agent-managed", "stale", "SKILL.md"), "remove me");
    const memoryPath = join(config.dataDir, "agents", AGENT_ID, "MEMORY.md");
    writeFileSync(memoryPath, "remember this");

    const memory = new SkillProjector(config.dataDir).prepare(
      { id: AGENT_ID, provider },
      { workspacePath: root }
    );

    expect(memory).toBe("remember this");
    expect(readFileSync(join(destination, "_remote-agent-managed", "ticket-workflow", "SKILL.md"), "utf8")).toBe("new skill");
    expect(readFileSync(join(destination, "template-skill", "SKILL.md"), "utf8")).toBe("keep me");
    expect(existsSync(join(destination, "_remote-agent-managed", "stale"))).toBe(false);
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
    const managed = join(root, ".agents", "skills", "_remote-agent-managed");
    mkdirSync(join(managed, "old-skill"), { recursive: true });
    writeFileSync(join(managed, "old-skill", "SKILL.md"), "old skill");
    mkdirSync(join(config.dataDir, "agents", AGENT_ID, "MEMORY.md"), { recursive: true });

    expect(() => new SkillProjector(config.dataDir).prepare(
      { id: AGENT_ID, provider: "codex" },
      { workspacePath: root }
    )).toThrow();

    expect(readFileSync(join(managed, "old-skill", "SKILL.md"), "utf8")).toBe("old skill");
  });

  it("Skills 复制失败时保留旧目录并清理临时目录", () => {
    const root = makeRoot();
    const config = makeConfig(root);
    const skillsRoot = join(root, ".agents", "skills");
    const managed = join(skillsRoot, "_remote-agent-managed");
    mkdirSync(join(config.dataDir, "agents", AGENT_ID, "skills", "new-skill"), { recursive: true });
    mkdirSync(join(managed, "old-skill"), { recursive: true });
    writeFileSync(join(managed, "old-skill", "SKILL.md"), "old skill");
    const projector = new SkillProjector(config.dataDir, {
      copy: () => { throw new Error("copy failed"); }
    });

    expect(() => projector.prepare(
      { id: AGENT_ID, provider: "codex" },
      { workspacePath: root }
    )).toThrow("copy failed");

    expect(readFileSync(join(managed, "old-skill", "SKILL.md"), "utf8")).toBe("old skill");
    expect(readdirSync(skillsRoot)).toEqual(["_remote-agent-managed"]);
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
    } else {
      expect(command).not.toContain("HERMES_HOME=");
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

  it("使用固定 Runtime 配置、稳定 sessionKey 和首次 system prompt", async () => {
    const root = makeRoot();
    const config = makeConfig(root);
    const acp = runtimeStub({ handle: { agentSessionId: undefined, backendSessionId: "backend-session-1" } });
    acpxMocks.createAcpRuntime.mockReturnValue(acp);
    const runtime = new AcpxAgentRuntime(config);
    const input = sessionInput(root);

    await expect(runtime.ensureSession(input)).resolves.toEqual({ providerSessionId: "backend-session-1" });

    expect(acpxMocks.createRuntimeStore).toHaveBeenCalledWith({ stateDir: join(config.dataDir, "acpx") });
    const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
    expect(options).toMatchObject({
      cwd: config.workspaceTemplate,
      permissionMode: "approve-all",
      nonInteractivePermissions: "fail"
    });
    expect(acp.ensureSession).toHaveBeenCalledWith({
      sessionKey: `remote-agent:${SESSION_ID}`,
      agent: `remote:codex:${AGENT_ID}:${SESSION_ID}`,
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
    const input = sessionInput(root);

    const first = await runtime.ensureSession(input);
    const second = await runtime.ensureSession(input);

    expect(first).toEqual(second);
    expect(acp.ensureSession).toHaveBeenCalledTimes(1);
    expect(acp.ensureSession.mock.calls[0]?.[0]).toHaveProperty("sessionOptions");
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

    const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
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

  it("shutdown 期间晚返回 Handle 的 close reject 被聚合且不注销 target", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
    await vi.waitFor(() => expect(acp.ensureSession).toHaveBeenCalledTimes(1));

    const shutdown = expect(runtime.shutdown()).rejects.toEqual(expect.objectContaining({
      name: "AggregateError",
      errors: expect.arrayContaining([
        expect.objectContaining({ stage: "late_handle_close", sessionId: SESSION_ID }),
        expect.objectContaining({ stage: "session_operation", sessionId: SESSION_ID }),
        expect.objectContaining({ stage: "handle_close", sessionId: SESSION_ID })
      ])
    }));
    releaseHandle({
      sessionKey: `remote-agent:${SESSION_ID}`,
      backend: "acpx",
      runtimeSessionName: "late",
      agentSessionId: "provider-session-1"
    });

    await expect(ensuring).rejects.toMatchObject({ code: "runtime_shutdown" });
    await shutdown;

    const options = acpxMocks.createAcpRuntime.mock.calls[0]?.[0] as AcpRuntimeOptions;
    expect(options.agentRegistry.list()).toEqual([`remote:codex:${AGENT_ID}:${SESSION_ID}`]);
    expect(acp.close).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it.each(["claude_code", "codex", "hermes"] as const)("doctor probe 指向指定的 %s Provider", async (provider) => {
    const root = makeRoot();
    const main = runtimeStub();
    const probe = runtimeStub({ doctor: { ok: false, message: `${provider} unavailable`, details: ["missing"] } });
    acpxMocks.createAcpRuntime.mockReturnValueOnce(main).mockReturnValueOnce(probe);
    const runtime = new AcpxAgentRuntime(makeConfig(root));

    await expect(runtime.doctor(provider, AGENT_ID)).resolves.toEqual({
      ok: false,
      message: `${provider} unavailable`,
      details: ["missing"]
    });

    const options = acpxMocks.createAcpRuntime.mock.calls[1]?.[0] as AcpRuntimeOptions;
    expect(options.probeAgent).toMatch(new RegExp(`^remote:${provider}:${AGENT_ID}:`));
    expect(options.agentRegistry.list()).toEqual([]);
  });

  it.each(["success", "undefined", "error"] as const)("doctor 在 %s 路径清理临时 Registry", async (outcome) => {
    const root = makeRoot();
    const main = runtimeStub();
    const probe = runtimeStub();
    if (outcome === "undefined") probe.doctor = undefined as never;
    if (outcome === "error") probe.doctor.mockRejectedValueOnce(new Error("probe crashed"));
    acpxMocks.createAcpRuntime.mockReturnValueOnce(main).mockReturnValueOnce(probe);
    const runtime = new AcpxAgentRuntime(makeConfig(root));

    if (outcome === "error") {
      await expect(runtime.doctor("codex", AGENT_ID)).rejects.toThrow("probe crashed");
    } else {
      await runtime.doctor("codex", AGENT_ID);
    }

    const options = acpxMocks.createAcpRuntime.mock.calls[1]?.[0] as AcpRuntimeOptions;
    expect(options.agentRegistry.list()).toEqual([]);
  });
});
