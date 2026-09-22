import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { HostUsageCollector } from "../src/agent-usage/host-collector.js";
import type { ProjectedSkill } from "../src/runtime/skill-projector.js";
import { createTestDatabase } from "./helpers.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const createRun = (db: Database.Database, sessionId: number): number => Number(db.prepare(
  "INSERT INTO runs (session_id, status, input, created_at) VALUES (?, 'running', ?, ?)"
).run(sessionId, "test", "2026-09-21T00:00:00.000Z").lastInsertRowid);

const harness = () => {
  const { db, seed } = createTestDatabase();
  databases.push(db);
  const sessionId = seed.session().id;
  const runId = createRun(db, sessionId);
  const collector = new HostUsageCollector(db);
  return { db, seed, sessionId, runId, collector };
};

const projectedSkill = (sessionId: number, overrides: Partial<ProjectedSkill> = {}): ProjectedSkill => {
  const alias = `/tmp/session-${sessionId}/.agents/skills/_remote-agent-managed-review`;
  return {
    id: "review",
    name: "Review",
    revision: "a".repeat(64),
    source: "git",
    sourceId: "source-1",
    packageName: "review-package",
    skillMdPath: "/tmp/projected-package/skills/review/SKILL.md",
    directoryAliases: [alias, "/tmp/projected-package/skills/review"],
    ...overrides
  };
};

const ranks = (collector: HostUsageCollector, kind: "builtin_tool" | "cli" | "skill" | "plugin" | "unknown") =>
  collector.attribution.rankings({ namespace: collector.namespace }, kind);

const wrapperCall = (h: ReturnType<typeof harness>, id: string, serverId = "7") => {
  h.collector.attribution.observeInvocation(h.collector.binding(h.sessionId), {
    invocationId: id, providerEpochId: h.collector.epoch(h.sessionId), executionId: String(h.runId),
    capability: { id: `mcp:${serverId}:search`, kind: "mcp_tool", serverId, name: "search" },
    startedAt: "2026-09-21T01:00:00.100Z", endedAt: "2026-09-21T01:00:01.000Z",
    status: "succeeded", sourceId: `mcp-observer:${serverId}`, revision: 2, rawResultBytes: 10
  });
};

describe("Runtime capability evidence", () => {
  it("excludes live MCP mirrors with Unicode and spaces in their structured names", () => {
    const h = harness();
    h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId: "unicode-live", kind: "execute", status: "completed",
      rawInput: { server: "项目 工具", tool: "搜索 内容", arguments: {} }, rawOutput: "结果" });
    expect(h.collector.attribution.invocations()).toEqual([]);
  });

  it("restores historical MCP names containing Unicode and spaces without changing their identity", () => {
    const h = harness();
    h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId: "unicode-history", kind: "execute", status: "completed",
      rawInput: { server: "项目 工具", tool: "搜索 内容", arguments: {} }, rawOutput: "结果" },
    { eventId: 45, sequence: 45, occurredAt: "2026-09-21T01:00:01.000Z" });
    expect(h.collector.attribution.invocations()).toEqual([expect.objectContaining({
      capability: { id: "mcp:runtime:项目 工具:搜索 内容", kind: "mcp_tool", name: "搜索 内容", serverId: "runtime:项目 工具" }
    })]);
  });
  it.each(["full", "sparse"])("waits for terminal MCP output and retains pending estimates across restart (%s)", mode => {
    const h = harness();
    wrapperCall(h, "streamed-wrapper");
    h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId: "streamed", kind: "execute", status: "in_progress",
      rawInput: { server: "7", tool: "search", arguments: {} }, rawOutput: "private stream chunk" },
    { eventId: 41, sequence: 41, occurredAt: "2026-09-21T01:00:00.200Z" });
    expect(h.collector.attribution.invocations()[0]?.resultEstimate).toBeNull();
    const restarted = new HostUsageCollector(h.db);
    restarted.runtimeCapabilities.recordTool(h.runId, { toolCallId: "streamed", status: "completed",
      ...(mode === "full" ? { rawOutput: "complete result" } : {}) },
    { eventId: 42, sequence: 42, occurredAt: "2026-09-21T01:00:01.000Z" });
    expect(restarted.attribution.invocations()[0]?.resultEstimate?.byteLength).toBe(mode === "full" ? 15 : 20);
    const metadata = JSON.stringify(h.db.prepare("SELECT * FROM agent_usage_runtime_mcp_mirrors").all());
    expect(metadata).not.toContain('"complete result"');
    expect(metadata).not.toContain("private stream chunk");
  });

  it.each(["recreated", "renamed"])("does not duplicate a historical wrapper after its server was %s", change => {
    const h = harness();
    wrapperCall(h, "old-server-wrapper");
    const binding = h.collector.binding(h.sessionId);
    h.db.prepare(`INSERT INTO agent_mcp_servers (id,agent_id,name,transport,enabled,created_at,updated_at)
      VALUES (?,?,?,'stdio',1,'2026-09-22T00:00:00Z','2026-09-22T00:00:00Z')`)
      .run(change === "recreated" ? 8 : 7, binding.agentId, change === "recreated" ? "project-tools" : "renamed-tools");
    h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId: "old-name", status: "completed",
      rawInput: { server: "project-tools", tool: "search", arguments: {} }, rawOutput: "unknown owner" },
    { eventId: 43, sequence: 43, occurredAt: "2026-09-21T01:00:01.000Z" });
    expect(h.collector.attribution.invocations()).toEqual([expect.objectContaining({ invocationId: "old-server-wrapper", resultEstimate: null })]);
  });

  it("does not treat current server configuration as confirmed historical identity without wrapper evidence", () => {
    const h = harness();
    h.db.prepare(`INSERT INTO agent_mcp_servers (id,agent_id,name,transport,enabled,created_at,updated_at)
      VALUES (8,?,'project-tools','stdio',1,'2026-09-22T00:00:00Z','2026-09-22T00:00:00Z')`)
      .run(h.collector.binding(h.sessionId).agentId);
    h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId: "unknown-history", status: "completed",
      rawInput: { server: "project-tools", tool: "search", arguments: {} }, rawOutput: "old result" },
    { eventId: 44, sequence: 44, occurredAt: "2026-09-21T01:00:01.000Z" });
    expect(h.collector.attribution.invocations()[0]?.capability.serverId).toBe("runtime:project-tools");
  });

  it("does not serialize a live MCP mirror output that is excluded from Runtime accounting", () => {
    const h = harness();
    let serialized = 0;
    h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId: "unmeasured", status: "completed",
      rawInput: { server: "7", tool: "search", arguments: {} },
      rawOutput: { toJSON: () => { serialized++; return "large output"; } } });
    expect(serialized).toBe(0);
    expect(h.collector.attribution.invocations()).toEqual([]);
  });
  it("freezes a Run before its first tool event and does not move established timestamps on replay", () => {
    const h = harness();
    h.collector.runtimeCapabilities.recordRun(h.runId);
    h.db.prepare("UPDATE agent_usage_subjects SET epoch = epoch + 1 WHERE kind = 'session'").run();
    h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId: "frozen", kind: "read", status: "completed", rawOutput: "final result" },
      { eventId: 20, sequence: 20, occurredAt: "2026-09-21T01:00:01.000Z" });
    h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId: "frozen", kind: "read", status: "in_progress",
      rawInput: { path: "README.md" }, rawOutput: "partial" },
    { eventId: 19, sequence: 19, occurredAt: "2026-09-21T01:00:00.000Z" });
    expect(h.collector.attribution.invocations()[0]).toMatchObject({ providerEpochId: `session:${h.sessionId}:epoch:1`,
      startedAt: "2026-09-21T01:00:00.000Z", endedAt: "2026-09-21T01:00:01.000Z", status: "succeeded",
      rawResultBytes: 12, resultEstimate: expect.objectContaining({ byteLength: 12 }) });
  });

  it("recovers a legacy Run epoch from existing invocations without the new Run binding table", () => {
    const h = harness();
    wrapperCall(h, "legacy-wrapper");
    h.db.prepare("UPDATE agent_usage_subjects SET epoch = epoch + 1 WHERE kind = 'session'").run();
    const restarted = new HostUsageCollector(h.db);
    restarted.runtimeCapabilities.recordTool(h.runId, { toolCallId: "legacy-read", kind: "read", status: "completed" },
      { eventId: 21, sequence: 21, occurredAt: "2026-09-21T01:00:01.000Z" });
    expect(restarted.attribution.invocations().every(row => row.providerEpochId === `session:${h.sessionId}:epoch:1`)).toBe(true);
  });

  it("does not pair a mirror with a different-time wrapper or reuse an already claimed wrapper", () => {
    const h = harness();
    wrapperCall(h, "single-wrapper");
    for (const [toolCallId, occurredAt] of [["far", "2026-09-21T02:00:00.000Z"],
      ["near", "2026-09-21T01:00:01.000Z"], ["second-near", "2026-09-21T01:00:01.000Z"]]) {
      h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId, kind: "execute", status: "completed",
        rawInput: { server: "7", tool: "search", arguments: {} }, rawOutput: toolCallId },
      { eventId: 22, sequence: 22, occurredAt: occurredAt! });
    }
    expect(h.collector.attribution.rankings({}, "mcp_tool")[0]).toMatchObject({ calls: 1, observedResultCalls: 1 });
    expect(h.collector.attribution.invocations()[0]?.resultEstimate?.byteLength).toBe(4);
  });
  it("enriches one original MCP wrapper across live mirror, sparse historical replay and restart", () => {
    const h = harness();
    wrapperCall(h, "wrapper-one");
    const start = { toolCallId: "native-one", kind: "execute", status: "in_progress",
      rawInput: { server: "7", tool: "search", arguments: { query: "private query" } } };
    h.collector.runtimeCapabilities.recordTool(h.runId, start);
    expect(h.collector.attribution.rankings({}, "mcp_tool")[0]).toMatchObject({ calls: 1, observedArgumentCalls: 0 });
    h.collector.runtimeCapabilities.recordTool(h.runId, start,
      { eventId: 1, sequence: 1, occurredAt: "2026-09-21T01:00:00.000Z" });
    const restarted = new HostUsageCollector(h.db);
    const terminal = { toolCallId: "native-one", status: "completed", rawOutput: "private result" };
    const event = { eventId: 2, sequence: 2, occurredAt: "2026-09-21T01:00:01.100Z" };
    restarted.runtimeCapabilities.recordTool(h.runId, terminal, event);
    restarted.runtimeCapabilities.recordTool(h.runId, terminal, event);
    expect(restarted.attribution.rankings({}, "mcp_tool")[0]).toMatchObject({ calls: 1, successes: 1,
      observedArgumentCalls: 1, observedResultCalls: 1 });
    expect(restarted.attribution.invocations()).toEqual([expect.objectContaining({ invocationId: "wrapper-one",
      startedAt: "2026-09-21T01:00:00.100Z", endedAt: "2026-09-21T01:00:01.000Z" })]);
    const metadata = JSON.stringify(h.db.prepare("SELECT * FROM agent_usage_runtime_mcp_mirrors").all());
    expect(metadata).not.toContain("private query");
    expect(metadata).not.toContain("private result");
  });

  it("restores historical MCP calls without wrapper evidence using original date and stable epoch", () => {
    const h = harness();
    const content = { toolCallId: "legacy-mcp", kind: "execute", status: "completed",
      rawInput: { server: "docs", tool: "search", arguments: { query: "history" } }, rawOutput: "found" };
    const event = { eventId: 3, sequence: 3, occurredAt: "2026-09-21T01:00:01.000Z" };
    h.collector.runtimeCapabilities.recordTool(h.runId, content, event);
    h.db.prepare("UPDATE agent_usage_subjects SET epoch = epoch + 1 WHERE kind = 'session'").run();
    const restarted = new HostUsageCollector(h.db);
    restarted.runtimeCapabilities.recordTool(h.runId, content, event);
    expect(restarted.attribution.rankings({ from: "2026-09-21T00:00:00Z", to: "2026-09-22T00:00:00Z" }, "mcp_tool"))
      .toEqual([expect.objectContaining({ calls: 1, observedArgumentCalls: 1, observedResultCalls: 1 })]);
    expect(restarted.attribution.invocations()[0]).toMatchObject({ providerEpochId: `session:${h.sessionId}:run:${h.runId}`,
      endedAt: "2026-09-21T01:00:01.000Z", sourceId: "runtime_capabilities" });
  });

  it("does not assign concurrent ambiguous MCP output or create a duplicate fallback", () => {
    const h = harness();
    wrapperCall(h, "wrapper-one"); wrapperCall(h, "wrapper-two");
    h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId: "ambiguous", kind: "execute", status: "completed",
      rawInput: { server: "7", tool: "search", arguments: { query: "unknown owner" } }, rawOutput: "ambiguous output" },
    { eventId: 4, sequence: 4, occurredAt: "2026-09-21T01:00:01.100Z" });
    expect(h.collector.attribution.rankings({}, "mcp_tool")).toEqual([expect.objectContaining({ calls: 2,
      observedArgumentCalls: 0, observedResultCalls: 0 })]);
  });
  it("attributes shell reads, reference reads and interpreter scripts to Skill and plugin", () => {
    const h = harness();
    const skill = projectedSkill(h.sessionId, { pluginId: "example@marketplace", pluginName: "Example" });
    h.collector.runtimeCapabilities.recordProjection(h.runId, [skill]);
    const commands = [
      `rtk cat '${skill.directoryAliases[0]}/SKILL.md'`,
      `head -n 20 ${skill.directoryAliases[0]}/references/check.md`,
      `python3 ${skill.directoryAliases[0]}/scripts/check.py`
    ];
    commands.forEach((command, index) => h.collector.runtimeCapabilities.recordTool(h.runId, {
      toolCallId: `shell-${index}`, kind: "execute", status: "completed", rawInput: { command }, rawOutput: "ok"
    }));
    expect(ranks(h.collector, "skill")[0]).toMatchObject({ calls: 3, successes: 3, observedResultCalls: 3 });
    expect(ranks(h.collector, "plugin")[0]).toMatchObject({ calls: 3 });
    expect(h.collector.runtimeCapabilities.stageCounts({})).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "body_read", count: 1 }),
      expect.objectContaining({ stage: "reference_read", count: 1 }),
      expect.objectContaining({ stage: "script_executed", count: 1 })
    ]));
  });

  it("replays terminal shell history on its original epoch and dates after reset and restart", () => {
    const h = harness();
    const skill = projectedSkill(h.sessionId);
    h.collector.runtimeCapabilities.recordProjection(h.runId, [skill]);
    h.collector.runtimeCapabilities.recordTool(h.runId, {
      toolCallId: "old", kind: "execute", status: "completed", rawInput: { command: "unknown && compound" }
    });
    h.db.prepare("UPDATE agent_usage_invocations SET ended_at = '2026-09-21T01:00:01.000Z'").run();
    h.db.prepare("UPDATE agent_usage_subjects SET epoch = epoch + 1 WHERE kind = 'session'").run();
    const restarted = new HostUsageCollector(h.db);
    const replay = () => {
      restarted.runtimeCapabilities.recordTool(h.runId, {
        toolCallId: "old", kind: "execute", status: "in_progress", rawInput: { command: `cat ${skill.skillMdPath}` }
      }, { eventId: 101, sequence: 1, occurredAt: "2026-09-21T01:00:00.000Z" });
      restarted.runtimeCapabilities.recordTool(h.runId, {
        toolCallId: "old", status: "completed", rawOutput: "historical body"
      }, { eventId: 102, sequence: 2, occurredAt: "2026-09-21T01:00:01.000Z" });
    };
    replay(); replay();
    expect(ranks(restarted, "cli")).toEqual([expect.objectContaining({
      capability: expect.objectContaining({ name: "cat" }), calls: 1, successes: 1,
      observedArgumentCalls: 1, observedResultCalls: 1
    })]);
    const cli = restarted.attribution.invocations().find(row => row.capability.kind === "cli");
    expect(cli).toMatchObject({ providerEpochId: `session:${h.sessionId}:epoch:1`,
      startedAt: "2026-09-21T01:00:00.000Z", endedAt: "2026-09-21T01:00:01.000Z" });
    expect(restarted.runtimeCapabilities.stageCounts({ from: "2026-09-21T00:00:00.000Z", to: "2026-09-22T00:00:00.000Z" }))
      .toContainEqual(expect.objectContaining({ stage: "body_read", count: 1 }));
  });
  it("does not count structured MCP execute events or sparse updates as CLI", () => {
    const h = harness();
    h.collector.runtimeCapabilities.recordTool(h.runId, {
      toolCallId: "mcp-search", kind: "execute", status: "in_progress",
      rawInput: { server: "project-tools", tool: "search", arguments: { query: "private" } }
    });
    h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId: "mcp-search", status: "completed" });
    expect(ranks(h.collector, "cli")).toEqual([]);
    expect(ranks(h.collector, "unknown")).toEqual([]);
  });

  it("requires command evidence and upgrades a sparse unknown classification", () => {
    const h = harness();
    h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId: "unknown", kind: "execute", status: "completed" });
    h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId: "command", status: "pending" });
    h.collector.runtimeCapabilities.recordTool(h.runId, {
      toolCallId: "command", kind: "execute", status: "in_progress", rawInput: { command: "echo hello" }
    });
    h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId: "command", status: "completed" });
    expect(ranks(h.collector, "cli")).toEqual([expect.objectContaining({ calls: 1, successes: 1 })]);
    expect(ranks(h.collector, "unknown")).toEqual([expect.objectContaining({ calls: 1 })]);
    expect(h.collector.attribution.invocations({ namespace: h.collector.namespace }).find((row) => row.invocationId.endsWith(":command"))?.capability.kind).toBe("cli");
  });

  it("keeps projection visibility separate from Skill use", () => {
    const h = harness();
    h.collector.runtimeCapabilities.recordProjection(h.runId, [projectedSkill(h.sessionId)]);

    expect(ranks(h.collector, "skill")).toEqual([]);
    expect(h.collector.runtimeCapabilities.stageCounts({ namespace: h.collector.namespace })).toEqual([
      expect.objectContaining({ capability: expect.objectContaining({ id: "review", kind: "skill" }), stage: "catalog_visible", count: 1 })
    ]);
  });

  it("counts a SKILL.md read once across running and completed updates and distinguishes references", () => {
    const h = harness();
    const skill = projectedSkill(h.sessionId);
    h.collector.runtimeCapabilities.recordProjection(h.runId, [skill]);
    const skillPath = `${skill.directoryAliases[0]}/SKILL.md`;
    h.collector.runtimeCapabilities.recordTool(h.runId, {
      toolCallId: "read-skill", kind: "read", status: "in_progress", rawInput: { path: skillPath }
    });
    h.collector.runtimeCapabilities.recordTool(h.runId, {
      toolCallId: "read-skill", status: "completed", rawOutput: "abc"
    });
    h.collector.runtimeCapabilities.recordTool(h.runId, {
      toolCallId: "read-reference", kind: "read", status: "completed",
      rawInput: { path: `${skill.directoryAliases[0]}/references/checklist.md` }
    });

    expect(ranks(h.collector, "skill")).toEqual([
      expect.objectContaining({ calls: 2, successes: 2, rawResultBytes: 3 })
    ]);
    expect(h.collector.runtimeCapabilities.stageCounts({ namespace: h.collector.namespace }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: "body_read", count: 1 }),
        expect.objectContaining({ stage: "reference_read", count: 1 })
      ]));
  });

  it("keeps same-named builtin tools separate across Runtime providers", () => {
    const h = harness();
    h.collector.runtimeCapabilities.recordTool(h.runId, {
      toolCallId: "read-1", kind: "read", status: "completed", rawInput: { path: "README.md" }
    });
    const agentId = Number(h.db.prepare(
      "INSERT INTO agents (name, provider, project_environment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run("Claude", "claude_code", h.seed.projectEnvironment.id, "2026-09-21T00:00:00.000Z", "2026-09-21T00:00:00.000Z").lastInsertRowid);
    const sessionId = Number(h.db.prepare(
      "INSERT INTO sessions (agent_id, title, status, workspace_path, created_at, updated_at) VALUES (?, ?, 'idle', ?, ?, ?)"
    ).run(agentId, "Claude", "/tmp/claude-session", "2026-09-21T00:00:00.000Z", "2026-09-21T00:00:00.000Z").lastInsertRowid);
    const runId = createRun(h.db, sessionId);
    h.collector.runtimeCapabilities.recordTool(runId, {
      toolCallId: "read-1", kind: "read", status: "completed", rawInput: { path: "README.md" }
    });

    const builtin = ranks(h.collector, "builtin_tool");
    expect(builtin).toHaveLength(2);
    expect(new Set(builtin.map((row) => row.capability.id))).toEqual(new Set([
      "runtime:codex:builtin:read",
      "runtime:claude_code:builtin:read"
    ]));
  });

  it("records only the structured outer executable and keeps composite shell commands opaque", () => {
    const h = harness();
    h.collector.runtimeCapabilities.recordTool(h.runId, {
      toolCallId: "structured", kind: "execute", status: "completed",
      rawInput: { executable: "/bin/bash", argv: ["/bin/bash", "-lc", "curl example.test && python task.py"] }
    });
    h.collector.runtimeCapabilities.recordTool(h.runId, {
      toolCallId: "composite", kind: "execute", status: "completed",
      rawInput: { command: "curl example.test && python task.py" }
    });

    const cli = ranks(h.collector, "cli");
    expect(cli.map((row) => row.capability.name).sort()).toEqual(["Shell command", "bash"]);
    const stored = (h.db.prepare("SELECT GROUP_CONCAT(capability_json) AS value FROM agent_usage_invocations")
      .get() as { value: string }).value;
    expect(stored).not.toContain("curl");
    expect(stored).not.toContain("python");
  });

  it("attributes structured Skill scripts to overlapping Skill and plugin views", () => {
    const h = harness();
    const skill = projectedSkill(h.sessionId, {
      source: "plugin",
      pluginId: "example@marketplace",
      pluginName: "Example plugin"
    });
    h.collector.runtimeCapabilities.recordProjection(h.runId, [skill]);
    h.collector.runtimeCapabilities.recordTool(h.runId, {
      toolCallId: "script", kind: "execute", status: "completed",
      rawInput: { executable: `${skill.directoryAliases[0]}/scripts/check.sh`, argv: [`${skill.directoryAliases[0]}/scripts/check.sh`] }
    });

    expect(ranks(h.collector, "cli")).toHaveLength(1);
    expect(ranks(h.collector, "skill")).toEqual([expect.objectContaining({ calls: 1, successes: 1 })]);
    expect(ranks(h.collector, "plugin")).toEqual([
      expect.objectContaining({ capability: expect.objectContaining({ id: "example@marketplace" }), calls: 1, successes: 1 })
    ]);
    expect(h.collector.runtimeCapabilities.stageCounts({ namespace: h.collector.namespace }))
      .toContainEqual(expect.objectContaining({ stage: "script_executed", count: 1 }));
  });

  it("finishes persisted Skill and plugin associations from sparse terminal updates", () => {
    const h = harness();
    const skill = projectedSkill(h.sessionId, {
      source: "plugin",
      pluginId: "example@marketplace",
      pluginName: "Example plugin"
    });
    h.collector.runtimeCapabilities.recordProjection(h.runId, [skill]);
    const skillPath = `${skill.directoryAliases[0]}/SKILL.md`;
    for (const [toolCallId, status, output] of [
      ["sparse-completed", "completed", "ok"],
      ["sparse-failed", "failed", "bad"],
      ["sparse-cancelled", "cancelled", "stop"]
    ] as const) {
      h.collector.runtimeCapabilities.recordTool(h.runId, {
        toolCallId, kind: "read", status: "in_progress", rawInput: { path: skillPath }
      });
      h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId, status, rawOutput: output });
    }

    const invocationRows = (kind: "skill" | "plugin") => h.db.prepare(`SELECT status, started_at, ended_at, raw_result_bytes
      FROM agent_usage_invocations WHERE capability_json LIKE ? ORDER BY invocation_id ASC`)
      .all(`%\"kind\":\"${kind}\"%`) as Array<{
        status: string; started_at: string | null; ended_at: string | null; raw_result_bytes: number | null;
      }>;
    const expected = [
      { status: "cancelled", raw_result_bytes: 4 },
      { status: "succeeded", raw_result_bytes: 2 },
      { status: "tool_error", raw_result_bytes: 3 }
    ];
    for (const kind of ["skill", "plugin"] as const) {
      const rows = invocationRows(kind);
      expect(rows.map(({ status, raw_result_bytes }) => ({ status, raw_result_bytes }))).toEqual(expected);
      expect(rows.every((row) => row.started_at !== null && row.ended_at !== null)).toBe(true);
    }
    expect(h.collector.runtimeCapabilities.stageCounts({ namespace: h.collector.namespace }))
      .toContainEqual(expect.objectContaining({
        capability: expect.objectContaining({ kind: "skill" }),
        stage: "body_read",
        count: 3
      }));
  });

  it("scopes reused native IDs by Run and preserves the first association and unknown start", () => {
    const h = harness();
    h.collector.runtimeCapabilities.recordTool(h.runId, {
      toolCallId: "same-native-id", kind: "read", status: "in_progress", rawInput: { path: "one.md" }
    });
    h.db.prepare("UPDATE runs SET status = 'succeeded', finished_at = ? WHERE id = ?")
      .run("2026-09-21T00:01:00.000Z", h.runId);
    const secondRunId = createRun(h.db, h.sessionId);
    h.collector.runtimeCapabilities.recordTool(secondRunId, {
      toolCallId: "same-native-id", kind: "read", status: "completed", rawInput: { path: "two.md" }
    });
    h.collector.runtimeCapabilities.recordTool(h.runId, {
      toolCallId: "same-native-id", kind: "read", status: "completed", rawInput: { path: "one.md" }
    });

    const rows = h.db.prepare(`SELECT execution_id, status, started_at FROM agent_usage_invocations
      WHERE capability_json LIKE '%builtin_tool%' ORDER BY CAST(execution_id AS INTEGER)`).all() as Array<{
        execution_id: string; status: string; started_at: string | null;
      }>;
    expect(rows).toEqual([
      { execution_id: String(h.runId), status: "succeeded", started_at: expect.any(String) },
      { execution_id: String(secondRunId), status: "succeeded", started_at: null }
    ]);
  });

  it("records running, success, failure and cancellation without multiplying updates", () => {
    const h = harness();
    for (const [toolCallId, status] of [
      ["running", "in_progress"],
      ["success", "completed"],
      ["failure", "failed"],
      ["cancel", "cancelled"]
    ] as const) {
      h.collector.runtimeCapabilities.recordTool(h.runId, { toolCallId, kind: "read", status });
    }
    const [rank] = ranks(h.collector, "builtin_tool");
    expect(rank).toMatchObject({ calls: 4, successes: 1, failures: 2, unfinished: 1 });
  });

  it("deletes projections and activity and rejects late recreation", () => {
    const h = harness();
    h.collector.runtimeCapabilities.recordProjection(h.runId, [projectedSkill(h.sessionId)]);
    h.collector.deleteSession(h.sessionId);

    expect(() => h.collector.runtimeCapabilities.recordTool(h.runId, {
      toolCallId: "late", kind: "read", status: "completed", rawInput: { path: "README.md" }
    })).toThrow("usage_subject_deleted");
    expect(h.collector.runtimeCapabilities.stageCounts({ namespace: h.collector.namespace })).toEqual([]);
    expect(ranks(h.collector, "builtin_tool")).toEqual([]);
  });

  it("ignores updates without a stable native tool ID", () => {
    const h = harness();
    h.collector.runtimeCapabilities.recordTool(h.runId, { kind: "read", status: "completed", title: "dynamic" });
    expect(ranks(h.collector, "builtin_tool")).toEqual([]);
  });
});
