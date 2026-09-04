import { describe, expect, it } from "vitest";

import { ContextHandoffBuilder } from "../src/runs/context-handoff-builder.js";
import { createTestDatabase } from "./helpers.js";

describe("ContextHandoffBuilder", () => {
  it("injects only unseen completed Runs and redacts common credentials", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const sourceProfileId = Number(db.prepare(`
      INSERT INTO agent_core_profiles
        (agent_id, name, provider, enabled, created_at, updated_at)
      VALUES (?, 'Claude', 'claude_code', 1, ?, ?)
    `).run(seed.agent.id, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z").lastInsertRowid);
    const insert = db.prepare(`
      INSERT INTO runs
        (session_id, status, input, result, resolved_core_profile_id, resolved_provider, resolved_model,
         created_at, started_at, finished_at)
      VALUES (?, 'succeeded', ?, ?, ?, 'claude_code', 'sonnet', ?, ?, ?)
    `);
    const firstRunId = Number(insert.run(
      session.id,
      "old request",
      "old result",
      sourceProfileId,
      "2026-09-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      "2026-09-01T00:01:00Z"
    ).lastInsertRowid);
    const secondRunId = Number(insert.run(
      session.id,
      "deploy with api_key=secret-value",
      "Authorization: Bearer abc.def.ghi",
      sourceProfileId,
      "2026-09-01T00:02:00Z",
      "2026-09-01T00:02:00Z",
      "2026-09-01T00:03:00Z"
    ).lastInsertRowid);
    const currentRunId = Number(db.prepare(`
      INSERT INTO runs (session_id, status, input, created_at)
      VALUES (?, 'queued', 'continue', '2026-09-01T00:04:00Z')
    `).run(session.id).lastInsertRowid);

    const handoff = new ContextHandoffBuilder(db).compose({
      sessionId: session.id,
      targetCoreProfileId: 999,
      afterRunId: firstRunId,
      beforeRunId: currentRunId,
      currentInput: "continue"
    });

    expect(handoff).toContain(`[REMOTE_AGENT_HANDOFF v1]`);
    expect(handoff).toContain(`"runId":${secondRunId}`);
    expect(handoff).not.toContain(`"runId":${firstRunId}`);
    expect(handoff).toContain("api_key=[redacted]");
    expect(handoff).toContain("Authorization: [redacted]");
    expect(handoff).toContain("[CURRENT_USER_REQUEST]\ncontinue\n[/CURRENT_USER_REQUEST]");
    db.close();
  });

  it("redacts credentials embedded in JSON fields", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const sourceProfileId = Number(db.prepare("SELECT default_core_profile_id FROM agents WHERE id = ?")
      .pluck().get(seed.agent.id));
    const previousRunId = Number(db.prepare(`
      INSERT INTO runs
        (session_id, status, input, result, resolved_core_profile_id, resolved_provider,
         created_at, started_at, finished_at)
      VALUES (?, 'succeeded', ?, ?, ?, 'codex', ?, ?, ?)
    `).run(
      session.id,
      'deploy {"api_key":"secret-value","token":"abc.def","X-Api-Key":"gateway-key"}',
      '{"Authorization":"Bearer auth-value","password":"private","clientSecret":"oauth-secret"}',
      sourceProfileId,
      "2026-09-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      "2026-09-01T00:01:00Z"
    ).lastInsertRowid);
    const currentRunId = Number(db.prepare(`
      INSERT INTO runs (session_id, status, input, created_at)
      VALUES (?, 'queued', 'continue', '2026-09-01T00:02:00Z')
    `).run(session.id).lastInsertRowid);

    const handoff = new ContextHandoffBuilder(db).compose({
      sessionId: session.id,
      targetCoreProfileId: sourceProfileId + 1,
      afterRunId: null,
      beforeRunId: currentRunId,
      currentInput: "continue"
    });

    expect(handoff).toContain(`"runId":${previousRunId}`);
    expect(handoff).not.toContain("secret-value");
    expect(handoff).not.toContain("abc.def");
    expect(handoff).not.toContain("auth-value");
    expect(handoff).not.toContain("private");
    expect(handoff).not.toContain("gateway-key");
    expect(handoff).not.toContain("oauth-secret");
    expect(handoff.match(/\[redacted\]/g)).toHaveLength(6);
    db.close();
  });

  it("leaves the current request unchanged when there is no unseen history", () => {
    const { db, seed } = createTestDatabase();
    const session = seed.session();
    const currentRunId = Number(db.prepare(`
      INSERT INTO runs (session_id, status, input, created_at)
      VALUES (?, 'queued', 'current request', '2026-09-01T00:00:00Z')
    `).run(session.id).lastInsertRowid);

    expect(new ContextHandoffBuilder(db).compose({
      sessionId: session.id,
      targetCoreProfileId: 1,
      afterRunId: null,
      beforeRunId: currentRunId,
      currentInput: "current request"
    })).toBe("current request");
    db.close();
  });
});
