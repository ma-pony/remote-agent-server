import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { SkillManager } from "../src/skills/skill-manager.js";
import { createFakeRuntime, createTestDatabase } from "./helpers.js";

const apiToken = "skills-test-token";
const tempDirs: string[] = [];

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "remote-agent-skills-"));
  tempDirs.push(root);
  return root;
};

const writeSkill = (directory: string, name: string, description: string): void => {
  mkdirSync(join(directory, "scripts"), { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  writeFileSync(join(directory, "scripts", "run.sh"), "echo ready\n");
};

const rootsFor = (root: string) => [
  { path: join(root, "codex"), source: "codex" as const },
  { path: join(root, "agents"), source: "agents" as const },
  { path: join(root, "claude"), source: "claude" as const },
  { path: join(root, "plugins"), source: "plugin" as const, recursive: true }
];

afterEach(() => {
  tempDirs.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
});

describe("SkillManager", () => {
  it("扫描主机和插件 Skills，读取描述并按来源优先级去重", () => {
    const root = makeRoot();
    writeSkill(join(root, "codex", "review"), "code-review", "Codex review skill");
    writeSkill(join(root, "agents", "review-copy"), "code-review", "Duplicate skill");
    const browserSkill = join(root, "plugins", "cache", "package", "skills", "browser");
    mkdirSync(browserSkill, { recursive: true });
    writeFileSync(join(browserSkill, "SKILL.md"), "---\nname: browser\ndescription: >-\n  Browser control\n  for local applications\n---\n");
    const manager = new SkillManager({ dataDir: join(root, "data"), roots: rootsFor(root) });

    const skills = manager.list("agent-1");

    expect(skills).toHaveLength(2);
    expect(skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "browser", description: "Browser control for local applications", source: "plugin", enabled: false, available: true }),
      expect.objectContaining({ name: "code-review", description: "Codex review skill", source: "codex", enabled: false, available: true })
    ]));
    expect(manager.hostSkillFiles()).toEqual([
      join(root, "codex", "review", "SKILL.md"),
      join(root, "agents", "review-copy", "SKILL.md"),
      join(root, "plugins", "cache", "package", "skills", "browser", "SKILL.md")
    ]);
  });

  it("在同一进程内复用主机 Skill 目录快照", () => {
    const root = makeRoot();
    const source = join(root, "codex", "review");
    writeSkill(source, "code-review", "Review changes");
    const manager = new SkillManager({ dataDir: join(root, "data"), roots: rootsFor(root) });

    expect(manager.list("agent-1")).toEqual([
      expect.objectContaining({ name: "code-review", source: "codex" })
    ]);
    rmSync(source, { recursive: true });

    expect(manager.hostSkillFiles()).toEqual([join(source, "SKILL.md")]);
    expect(manager.list("agent-1")).toEqual([]);
  });

  it("只按目录扫描生成的 ID 启用完整 Skill，并支持停用和来源移除后停用", () => {
    const root = makeRoot();
    const source = join(root, "codex", "review");
    writeSkill(source, "code-review", "Review changes");
    const dataDir = join(root, "data");
    const manager = new SkillManager({ dataDir, roots: rootsFor(root) });
    const skill = manager.list("agent-1")[0]!;

    expect(manager.setEnabled("agent-1", skill.id, true)).toMatchObject({ id: skill.id, enabled: true });
    expect(readFileSync(join(dataDir, "agents", "agent-1", "skills", skill.id, "scripts", "run.sh"), "utf8"))
      .toBe("echo ready\n");

    rmSync(source, { recursive: true });
    expect(manager.list("agent-1")).toEqual([
      expect.objectContaining({ id: skill.id, name: "code-review", source: "missing", enabled: true, available: false })
    ]);
    expect(manager.setEnabled("agent-1", skill.id, false)).toMatchObject({ id: skill.id, enabled: false });
    expect(existsSync(join(dataDir, "agents", "agent-1", "skills", skill.id))).toBe(false);
    expect(manager.setEnabled("agent-1", "../../outside", true)).toBeUndefined();
  });

  it("安全上传单个 Skill ZIP，并在停用后保留可重新启用的上传源", () => {
    const root = makeRoot();
    const dataDir = join(root, "data");
    const manager = new SkillManager({ dataDir, roots: [] });
    const archive = zipSync({
      "uploaded-review/SKILL.md": strToU8("---\nname: uploaded-review\ndescription: Review uploaded code\n---\n"),
      "uploaded-review/scripts/run.sh": strToU8("echo uploaded\n")
    });

    const uploaded = manager.upload("agent-1", "uploaded-review.zip", archive);

    expect(uploaded).toMatchObject({ name: "uploaded-review", source: "upload", enabled: true, available: true });
    expect(readFileSync(join(dataDir, "agents", "agent-1", "skills", uploaded.id, "scripts", "run.sh"), "utf8"))
      .toBe("echo uploaded\n");
    expect(manager.setEnabled("agent-1", uploaded.id, false)).toMatchObject({ source: "upload", enabled: false });
    expect(manager.list("agent-1")).toEqual([expect.objectContaining({ id: uploaded.id, source: "upload", enabled: false })]);
    expect(manager.setEnabled("agent-1", uploaded.id, true)).toMatchObject({ enabled: true });
  });

  it("允许主 Skill 目录包含嵌套 Skill", () => {
    const root = makeRoot();
    const dataDir = join(root, "data");
    const manager = new SkillManager({ dataDir, roots: [] });
    const archive = zipSync({
      "code-review-gate/SKILL.md": strToU8("---\nname: code-review-gate\ndescription: Review code changes\n---\n"),
      "code-review-gate/references/guide.md": strToU8("# Guide\n"),
      "code-review-gate/pattern-b/SKILL.md": strToU8("---\nname: pattern-b\ndescription: Handle pattern B\n---\n")
    });

    const uploaded = manager.upload("agent-1", "code-review-gate.zip", archive);

    expect(uploaded).toMatchObject({ name: "code-review-gate", source: "upload", enabled: true });
    expect(readFileSync(
      join(dataDir, "agents", "agent-1", "skills", uploaded.id, "pattern-b", "SKILL.md"),
      "utf8"
    )).toContain("name: pattern-b");
  });

  it("上传的 Skill 对所有 Agent 可见，并由每个 Agent 独立启用", () => {
    const root = makeRoot();
    const dataDir = join(root, "data");
    const manager = new SkillManager({ dataDir, roots: [] });
    const archive = zipSync({
      "shared-review/SKILL.md": strToU8("---\nname: shared-review\ndescription: Shared review workflow\n---\n")
    });

    const uploaded = manager.upload("agent-1", "shared-review.zip", archive);

    expect(manager.list("agent-2")).toEqual([
      expect.objectContaining({ id: uploaded.id, name: "shared-review", enabled: false, available: true })
    ]);
    expect(manager.setEnabled("agent-2", uploaded.id, true)).toMatchObject({ enabled: true });
    expect(manager.list("agent-1")[0]).toMatchObject({ id: uploaded.id, enabled: true });
    expect(manager.list("agent-2")[0]).toMatchObject({ id: uploaded.id, enabled: true });

    manager.setEnabled("agent-1", uploaded.id, false);
    expect(manager.list("agent-1")[0]).toMatchObject({ enabled: false });
    expect(manager.list("agent-2")[0]).toMatchObject({ enabled: true });
  });

  it("支持只删除当前 Agent 的 Skill 副本或删除全部上传副本", () => {
    const root = makeRoot();
    const dataDir = join(root, "data");
    const manager = new SkillManager({ dataDir, roots: [] });
    const archive = zipSync({
      "shared-review/SKILL.md": strToU8("---\nname: shared-review\ndescription: Shared review workflow\n---\n")
    });
    const uploaded = manager.upload("agent-1", "shared-review.zip", archive);
    manager.setEnabled("agent-2", uploaded.id, true);

    expect(manager.remove("agent-1", uploaded.id, "current")).toBe("removed");
    expect(manager.list("agent-1")).toEqual([
      expect.objectContaining({ id: uploaded.id, enabled: false, available: true })
    ]);
    expect(manager.list("agent-2")).toEqual([
      expect.objectContaining({ id: uploaded.id, enabled: true, available: true })
    ]);

    expect(manager.remove("agent-2", uploaded.id, "all")).toBe("removed");
    expect(manager.list("agent-1")).toEqual([]);
    expect(manager.list("agent-2")).toEqual([]);
    expect(existsSync(join(dataDir, "skill-library", uploaded.id))).toBe(false);
    expect(existsSync(join(dataDir, "agents", "agent-2", "skills", uploaded.id))).toBe(false);
  });

  it("拒绝路径穿越和缺少 SKILL.md 的上传压缩包", () => {
    const root = makeRoot();
    const manager = new SkillManager({ dataDir: join(root, "data"), roots: [] });
    const traversal = zipSync({ "../outside.txt": strToU8("outside"), "SKILL.md": strToU8("name: bad") });
    const missingManifest = zipSync({ "README.md": strToU8("missing") });

    expect(() => manager.upload("agent-1", "bad.zip", traversal)).toThrowError(expect.objectContaining({
      code: "invalid_skill_archive"
    }));
    expect(() => manager.upload("agent-1", "missing.zip", missingManifest)).toThrowError(expect.objectContaining({
      code: "invalid_skill_archive"
    }));
    expect(existsSync(join(root, "outside.txt"))).toBe(false);
  });
});

describe("Agent Skills API", () => {
  it("通过删除范围只移除当前 Skill 副本或移除全部上传副本", async () => {
    const root = makeRoot();
    const dataDir = join(root, "data");
    const { db, seed } = createTestDatabase();
    const app = buildApp({
      config: {
        host: "127.0.0.1", port: 3000, apiToken, dataDir, databasePath: ":memory:",
        projectEnvironmentsRoot: "/unused/environments", sessionsRoot: "/unused/sessions",
        maxConcurrentRuns: 1, projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000,
        projectPrepareTimeoutMs: 30 * 60 * 1000
      },
      db,
      runtime: createFakeRuntime(),
      skillManager: new SkillManager({ dataDir, roots: [] })
    });
    await app.ready();
    try {
      const createAgent = async (name: string) => (await app.inject({
        method: "POST", url: "/api/agents", headers: { authorization: `Bearer ${apiToken}` },
        payload: { name, provider: "codex", projectEnvironmentId: seed.projectEnvironment.id }
      })).json() as { id: number };
      const first = await createAgent("First");
      const second = await createAgent("Second");
      const archive = zipSync({
        "shared-review/SKILL.md": strToU8("---\nname: shared-review\ndescription: Shared review workflow\n---\n")
      });
      const uploaded = await app.inject({
        method: "POST", url: `/api/agents/${first.id}/skills/upload`,
        headers: { authorization: `Bearer ${apiToken}` },
        payload: { fileName: "shared-review.zip", contentBase64: Buffer.from(archive).toString("base64") }
      });
      const skillId = (uploaded.json() as { id: string }).id;
      await app.inject({
        method: "PUT", url: `/api/agents/${second.id}/skills/${skillId}`,
        headers: { authorization: `Bearer ${apiToken}` }, payload: { enabled: true }
      });

      const currentOnly = await app.inject({
        method: "DELETE", url: `/api/agents/${first.id}/skills/${skillId}?scope=current`,
        headers: { authorization: `Bearer ${apiToken}` }
      });
      expect(currentOnly.statusCode).toBe(204);
      expect((await app.inject({
        method: "GET", url: `/api/agents/${first.id}/skills`, headers: { authorization: `Bearer ${apiToken}` }
      })).json()).toEqual([expect.objectContaining({ id: skillId, enabled: false })]);
      expect((await app.inject({
        method: "GET", url: `/api/agents/${second.id}/skills`, headers: { authorization: `Bearer ${apiToken}` }
      })).json()).toEqual([expect.objectContaining({ id: skillId, enabled: true })]);

      const deleteAll = await app.inject({
        method: "DELETE", url: `/api/agents/${second.id}/skills/${skillId}?scope=all`,
        headers: { authorization: `Bearer ${apiToken}` }
      });
      expect(deleteAll.statusCode).toBe(204);
      expect((await app.inject({
        method: "GET", url: `/api/agents/${first.id}/skills`, headers: { authorization: `Bearer ${apiToken}` }
      })).json()).toEqual([]);
      expect((await app.inject({
        method: "GET", url: `/api/agents/${second.id}/skills`, headers: { authorization: `Bearer ${apiToken}` }
      })).json()).toEqual([]);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("经过鉴权列出和启停 Agent Skills，并拒绝未知 Agent 或 Skill", async () => {
    const root = makeRoot();
    writeSkill(join(root, "codex", "review"), "code-review", "Review changes");
    const dataDir = join(root, "data");
    const skillManager = new SkillManager({ dataDir, roots: rootsFor(root) });
    const { db, seed } = createTestDatabase();
    const app = buildApp({
      config: {
        host: "127.0.0.1",
        port: 3000,
        apiToken,
        dataDir,
        databasePath: ":memory:",
        projectEnvironmentsRoot: "/unused/environments",
        sessionsRoot: "/unused/sessions",
        maxConcurrentRuns: 1,
        projectEnvironmentCheckIntervalMs: 3 * 60 * 60 * 1000,
        projectPrepareTimeoutMs: 30 * 60 * 1000
      },
      db,
      runtime: createFakeRuntime(),
      skillManager
    });
    await app.ready();

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { authorization: `Bearer ${apiToken}` },
        payload: { name: "Codex", provider: "codex", projectEnvironmentId: seed.projectEnvironment.id }
      });
      const { id } = created.json() as { id: string };
      const unauthorized = await app.inject({ method: "GET", url: `/api/agents/${id}/skills` });
      const listed = await app.inject({
        method: "GET",
        url: `/api/agents/${id}/skills`,
        headers: { authorization: `Bearer ${apiToken}` }
      });
      const skill = (listed.json() as Array<{ id: string }>)[0]!;
      const enabled = await app.inject({
        method: "PUT",
        url: `/api/agents/${id}/skills/${skill.id}`,
        headers: { authorization: `Bearer ${apiToken}` },
        payload: { enabled: true }
      });
      const unknownSkill = await app.inject({
        method: "PUT",
        url: `/api/agents/${id}/skills/not-found`,
        headers: { authorization: `Bearer ${apiToken}` },
        payload: { enabled: true }
      });
      const unknownAgent = await app.inject({
        method: "GET",
        url: "/api/agents/not-found/skills",
        headers: { authorization: `Bearer ${apiToken}` }
      });
      const archive = zipSync({
        "uploaded/SKILL.md": strToU8("---\nname: uploaded\ndescription: Uploaded Skill\n---\n")
      });
      const uploaded = await app.inject({
        method: "POST",
        url: `/api/agents/${id}/skills/upload`,
        headers: { authorization: `Bearer ${apiToken}` },
        payload: { fileName: "uploaded.zip", contentBase64: Buffer.from(archive).toString("base64") }
      });
      const invalidArchive = await app.inject({
        method: "POST",
        url: `/api/agents/${id}/skills/upload`,
        headers: { authorization: `Bearer ${apiToken}` },
        payload: { fileName: "broken.zip", contentBase64: Buffer.from("not zip").toString("base64") }
      });

      expect(unauthorized.statusCode).toBe(401);
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual([expect.objectContaining({ name: "code-review", enabled: false })]);
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json()).toMatchObject({ id: skill.id, enabled: true });
      expect(unknownSkill.statusCode).toBe(404);
      expect(unknownSkill.json()).toMatchObject({ error: { code: "skill_not_found" } });
      expect(unknownAgent.statusCode).toBe(404);
      expect(uploaded.statusCode).toBe(201);
      expect(uploaded.json()).toMatchObject({ name: "uploaded", source: "upload", enabled: true });
      expect(invalidArchive.statusCode).toBe(400);
      expect(invalidArchive.json()).toMatchObject({ error: { code: "invalid_skill_archive" } });
    } finally {
      await app.close();
      db.close();
    }
  });
});
