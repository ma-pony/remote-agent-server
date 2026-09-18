import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { SkillManager } from "../src/skills/skill-manager.js";
import { SkillSourceManager } from "../src/skills/skill-source-manager.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("authenticates source management and explicitly applies a previewed revision to one Agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-api-")); roots.push(root);
  const dataDir = join(root, "data");
  let body = "first";
  let fail = false;
  const sources = new SkillSourceManager({ dataDir, checkout: async ({ destination }) => {
    if (fail) throw new Error("private token must not leak");
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "SKILL.md"), `---\nname: review\ndescription: Review changes\n---\n${body}`);
    return { commit: "a".repeat(40) };
  } });
  const skills = new SkillManager({ dataDir, roots: [], sourceCatalog: () => sources.catalog() });
  const { db, seed } = createTestDatabase();
  const app = buildApp({ config: {
    host: "127.0.0.1", port: 3000, apiToken: "test-token", dataDir, databasePath: ":memory:",
    projectEnvironmentsRoot: join(root, "environments"), sessionsRoot: join(root, "sessions"),
    maxConcurrentRuns: 1, maxConcurrentWebhookDeliveries: 1, maxConcurrentEnvironmentBuilds: 1,
    projectEnvironmentCheckIntervalMs: 0, projectPrepareTimeoutMs: 30_000, sessionRetentionMs: 0
  }, db, runtime: createFakeRuntime(), skillSourceManager: sources, skillManager: skills });
  const headers = { authorization: "Bearer test-token" };
  try {
    expect((await app.inject({ url: "/api/skill-sources" })).statusCode).toBe(401);
    const agent = (await app.inject({ method: "POST", url: "/api/agents", headers,
      payload: { name: "Reviewer", provider: "codex", projectEnvironmentId: seed.projectEnvironment.id }
    })).json();
    expect((await app.inject({ method: "POST", url: "/api/skill-sources", headers,
      payload: { name: "Bad", url: "file:///etc" } })).statusCode).toBe(400);
    const created = await app.inject({ method: "POST", url: "/api/skill-sources", headers,
      payload: { name: "Reviews", url: "https://gitlab.example.com/team/skills.git" } });
    expect(created.statusCode).toBe(201);
    const source = created.json();
    const skill = (await app.inject({ url: `/api/agents/${agent.id}/skills`, headers })).json()[0];
    const base = `/api/agents/${agent.id}/skills/${skill.id}`;
    const enabled = (await app.inject({ method: "PUT", url: base, headers, payload: { enabled: true } })).json();
    body = "second";
    expect((await app.inject({ method: "POST", url: `/api/skill-sources/${source.id}/refresh`, headers })).statusCode).toBe(200);
    const history = (await app.inject({ url: `${base}/revisions`, headers })).json();
    expect(history.currentRevision).toBe(enabled.currentRevision);
    expect(history.latestRevision).not.toBe(history.currentRevision);
    const diff = (await app.inject({ url: `${base}/diff?revision=${history.latestRevision}`, headers })).json();
    expect(diff.files[0]).toMatchObject({ path: "SKILL.md", preview: "text" });
    expect(diff.files[0]).not.toHaveProperty("after");
    const fileUrl = `${base}/diff/file?revision=${history.latestRevision}&baseRevision=${diff.baseRevision}&path=SKILL.md`;
    expect((await app.inject({ url: fileUrl })).statusCode).toBe(401);
    const file = await app.inject({ url: fileUrl, headers });
    expect(file.statusCode).toBe(200);
    expect(file.json()).toMatchObject({ path: "SKILL.md", kind: "text", truncated: false, patch: expect.stringContaining("+second") });
    expect((await app.inject({ url: `${base}/diff/file?revision=${history.latestRevision}&path=SKILL.md`, headers })).statusCode).toBe(400);
    expect((await app.inject({ url: fileUrl.replace("path=SKILL.md", "path=..%2Fsecret.txt"), headers })).statusCode).toBe(404);
    expect((await app.inject({ url: fileUrl.replace(diff.baseRevision, "d".repeat(64)), headers })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `${base}/revision`, headers,
      payload: { revision: diff.revision, expectedRevision: diff.expectedRevision, force: true } })).statusCode).toBe(400);
    const applied = await app.inject({ method: "POST", url: `${base}/revision`, headers,
      payload: { revision: diff.revision, expectedRevision: diff.expectedRevision } });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().currentRevision).toBe(history.latestRevision);
    expect((await app.inject({ url: fileUrl, headers })).statusCode).toBe(409);
    const stale = await app.inject({ method: "POST", url: `${base}/revision`, headers,
      payload: { revision: enabled.currentRevision, expectedRevision: enabled.currentRevision } });
    expect(stale.statusCode).toBe(409);
    fail = true;
    const failed = await app.inject({ method: "POST", url: `/api/skill-sources/${source.id}/refresh`, headers });
    expect(failed.statusCode).toBe(502);
    expect(failed.body).not.toContain("private token");
    expect((await app.inject({ url: "/api/skill-sources", headers })).json()[0].status).toBe("failed");
    expect((await app.inject({ method: "DELETE", url: `/api/skill-sources/${source.id}`, headers })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/agents/${agent.id}/skills`, headers })).json()[0]).toMatchObject({ available: false, enabled: true });
    expect((await app.inject({ method: "POST", url: `${base}/revision`, headers,
      payload: { revision: enabled.currentRevision, expectedRevision: history.latestRevision } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: base, headers, payload: { enabled: false } })).statusCode).toBe(200);
  } finally { await app.close(); db.close(); }
});
