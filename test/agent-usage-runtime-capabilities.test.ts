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

describe("Runtime capability evidence", () => {
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
