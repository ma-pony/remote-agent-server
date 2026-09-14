import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SkillSourceError, SkillSourceManager, type SkillSourceCheckout } from "../src/skills/skill-source-manager.js";

const directories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "remote-agent-skill-source-"));
  directories.push(directory);
  return directory;
};

const writeSkill = (directory: string, name: string, description: string): void => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
  mkdirSync(join(directory, "scripts"), { recursive: true });
  writeFileSync(join(directory, "scripts", "run.sh"), "#!/bin/sh\necho ready\n", { mode: 0o755 });
};

const fixtureCheckout = (fixtures: Record<string, string>, commits: Record<string, string> = {}): SkillSourceCheckout =>
  async ({ url, destination }) => {
    const fixture = fixtures[url];
    if (fixture === undefined) throw new Error("fixture_unavailable");
    cpSync(fixture, destination, { recursive: true });
    return { commit: commits[url] ?? "a".repeat(40) };
  };

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
});

describe("SkillSourceManager", () => {
  it("reloads an aggregate catalog larger than one manifest's size limit", async () => {
    const root = temporaryDirectory(); const fixture = join(root, "fixture");
    writeSkill(join(fixture, "first"), "first", "a".repeat(600_000));
    writeSkill(join(fixture, "second"), "second", "b".repeat(600_000));
    const options = { dataDir: join(root, "data"), checkout: fixtureCheckout({ "https://example.test/large.git": fixture }) };
    const manager = new SkillSourceManager(options);
    const source = await manager.add({ name: "Large catalog", url: "https://example.test/large.git" });
    await manager.close();
    const restarted = new SkillSourceManager(options);
    expect(restarted.list().map((item) => item.id)).toEqual([source.id]);
    expect(restarted.catalog().map((item) => item.name)).toEqual(["first", "second"]);
    await restarted.close();
  });

  it("honors explicit Skill selection at a Claude marketplace root", async () => {
    const root = temporaryDirectory(); const fixture = join(root, "fixture");
    writeSkill(join(fixture, "skills", "included"), "included", "Selected Skill");
    writeSkill(join(fixture, "skills", "excluded"), "excluded", "Unselected Skill");
    mkdirSync(join(fixture, ".claude-plugin"));
    writeFileSync(join(fixture, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "team", plugins: [
      { name: "selected", source: "./", skills: ["./skills/included/"] }
    ] }));
    const manager = new SkillSourceManager({ dataDir: join(root, "data"), checkout: fixtureCheckout({ "https://example.test/root.git": fixture }) });
    await manager.add({ name: "Team", url: "https://example.test/root.git" });
    expect(manager.catalog().map((skill) => skill.name)).toEqual(["included"]);
    await manager.close();
  });

  it("uses a standalone Codex plugin manifest instead of scanning tests and unrelated Skills", async () => {
    const root = temporaryDirectory(); const fixture = join(root, "fixture");
    writeSkill(join(fixture, "custom", "included"), "included", "Selected Skill");
    writeSkill(join(fixture, "skills", "excluded"), "excluded", "Unselected Skill");
    writeSkill(join(fixture, "test", "fixture"), "test-fixture", "Test fixture");
    mkdirSync(join(fixture, ".codex-plugin"));
    writeFileSync(join(fixture, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "review", skills: "./custom/" }));
    const manager = new SkillSourceManager({ dataDir: join(root, "data"), checkout: fixtureCheckout({ "https://example.test/plugin.git": fixture }) });
    await manager.add({ name: "Team", url: "https://example.test/plugin.git" });
    expect(manager.catalog().map((skill) => skill.name)).toEqual(["included"]);
    await manager.close();
  });

  it("preserves the old plugin when strict:false conflicts with its own Skill declaration", async () => {
    const root = temporaryDirectory(); const fixture = join(root, "fixture");
    writeSkill(join(fixture, "plugins", "review", "skills", "base"), "base", "Base Skill");
    writeSkill(join(fixture, "plugins", "review", "extra", "extra"), "extra", "Extra Skill");
    mkdirSync(join(fixture, "plugins", "review", ".claude-plugin"));
    writeFileSync(join(fixture, "plugins", "review", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "review", skills: "./skills/" }));
    mkdirSync(join(fixture, ".claude-plugin"));
    const manifest = join(fixture, ".claude-plugin", "marketplace.json");
    writeFileSync(manifest, JSON.stringify({ name: "team", plugins: [{ name: "review", source: "./plugins/review" }] }));
    const manager = new SkillSourceManager({ dataDir: join(root, "data"), checkout: fixtureCheckout({ "https://example.test/plugin.git": fixture }) });
    const source = await manager.add({ name: "Team", url: "https://example.test/plugin.git" });
    const before = manager.catalog();
    writeFileSync(manifest, JSON.stringify({ name: "team", plugins: [{ name: "review", source: "./plugins/review", strict: false, skills: "./extra/" }] }));
    const refreshed = await manager.refresh(source.id);
    expect(refreshed.warnings).toEqual([expect.stringContaining("invalid Skill content")]);
    expect(manager.catalog()).toEqual(before);
    expect(refreshed.skillCount).toBe(before.length);
    await manager.close();
  });

  it("publishes an ordinary repository as an immutable Git catalog", async () => {
    const root = temporaryDirectory();
    const fixture = join(root, "fixture");
    writeSkill(join(fixture, "review"), "review", "Review pull requests");
    const manager = new SkillSourceManager({
      dataDir: join(root, "data"),
      checkout: fixtureCheckout({ "https://example.test/skills.git": fixture }, { "https://example.test/skills.git": "b".repeat(40) })
    });

    const source = await manager.add({ name: "Team skills", url: "https://example.test/skills.git", ref: "main" });
    const [skill] = manager.catalog();

    expect(source).toMatchObject({ name: "Team skills", status: "ready", ref: "main", skillCount: 1, error: null });
    expect(skill).toMatchObject({
      name: "review", sourceId: source.id, packageName: source.id, repositoryUrl: "https://example.test/skills.git",
      ref: "main", commit: "b".repeat(40), skillPath: "review", source: "git", enabled: false, available: true
    });
    expect(readFileSync(join(skill.packageDirectory, "review", "scripts", "run.sh"), "utf8")).toContain("echo ready");
    expect(skill.directory).toBe(join(skill.packageDirectory, "review"));
    await manager.close();
  });

  it("keeps a previously published catalog when refresh cannot fetch", async () => {
    const root = temporaryDirectory();
    const fixture = join(root, "fixture");
    writeSkill(join(fixture, "review"), "review", "Review pull requests");
    let succeeds = true;
    const manager = new SkillSourceManager({
      dataDir: join(root, "data"),
      checkout: async (request) => {
        if (!succeeds) throw new Error("fatal: could not read Username for https://secret@example.test");
        return fixtureCheckout({ "https://example.test/skills.git": fixture })(request);
      }
    });
    const source = await manager.add({ name: "Team skills", url: "https://example.test/skills.git" });
    const before = manager.catalog();
    succeeds = false;

    await expect(manager.refresh(source.id)).rejects.toEqual(expect.objectContaining({ code: "refresh_failed" }));

    expect(manager.list()).toEqual([expect.objectContaining({ id: source.id, status: "failed", error: "refresh_failed" })]);
    expect(manager.catalog()).toEqual(before);
    await manager.close();
  });

  it("loads local marketplace plugins and reports unsupported entries without following paths outside the checkout", async () => {
    const root = temporaryDirectory();
    const fixture = join(root, "fixture");
    writeSkill(join(fixture, "plugins", "review"), "market-review", "Review marketplace changes");
    mkdirSync(join(fixture, ".claude-plugin"), { recursive: true });
    writeFileSync(join(fixture, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "team-marketplace",
      plugins: [
        { name: "review-plugin", source: "./plugins/review" },
        { name: "bad-plugin", source: "../outside" },
        { name: "unsupported-plugin", source: { type: "npm", package: "example" } }
      ]
    }));
    const manager = new SkillSourceManager({
      dataDir: join(root, "data"),
      checkout: fixtureCheckout({ "git@example.test:market.git": fixture })
    });

    const source = await manager.add({ name: "Marketplace", url: "git@example.test:market.git" });

    expect(manager.catalog()).toEqual([expect.objectContaining({ name: "market-review", packageName: "review-plugin", skillPath: "." })]);
    expect(manager.list()[0]).toMatchObject({ id: source.id, warnings: expect.arrayContaining([
      expect.stringContaining("bad-plugin"), expect.stringContaining("unsupported-plugin")
    ]) });
    await manager.close();
  });

  it("publishes an external Git marketplace plugin with its own ref and commit", async () => {
    const root = temporaryDirectory();
    const marketplace = join(root, "marketplace");
    const external = join(root, "external");
    mkdirSync(join(marketplace, ".agents", "plugins"), { recursive: true });
    writeFileSync(join(marketplace, ".agents", "plugins", "marketplace.json"), JSON.stringify({ plugins: [{
      name: "external-plugin", source: { url: "ssh://git@example.test/tools.git", ref: "v2", path: "skill" }
    }] }));
    writeSkill(join(external, "skill"), "external-review", "Review external changes");
    const manager = new SkillSourceManager({
      dataDir: join(root, "data"),
      checkout: fixtureCheckout({
        "https://example.test/marketplace.git": marketplace,
        "ssh://git@example.test/tools.git": external
      }, { "ssh://git@example.test/tools.git": "c".repeat(40) })
    });

    await manager.add({ name: "Marketplace", url: "https://example.test/marketplace.git" });

    expect(manager.catalog()).toEqual([expect.objectContaining({
      name: "external-review", packageName: "external-plugin", repositoryUrl: "ssh://git@example.test/tools.git",
      ref: "v2", commit: "c".repeat(40), skillPath: "."
    })]);
    await manager.close();
  });

  it("normalizes GitHub marketplace shorthand before checking out a plugin", async () => {
    const root = temporaryDirectory();
    const marketplace = join(root, "marketplace");
    const external = join(root, "external");
    mkdirSync(join(marketplace, ".claude-plugin"), { recursive: true });
    writeFileSync(join(marketplace, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [{
      name: "github-plugin", source: { source: "github:example/tools", path: "skill" }
    }] }));
    writeSkill(join(external, "skill"), "github-review", "Review GitHub changes");
    const manager = new SkillSourceManager({
      dataDir: join(root, "data"),
      checkout: fixtureCheckout({
        "https://example.test/marketplace.git": marketplace,
        "https://github.com/example/tools.git": external
      })
    });

    await manager.add({ name: "Marketplace", url: "https://example.test/marketplace.git" });

    expect(manager.catalog()[0]).toMatchObject({ repositoryUrl: "https://github.com/example/tools.git", name: "github-review" });
    await manager.close();
  });

  it("retains a fetched external plugin when a later marketplace refresh cannot fetch it", async () => {
    const root = temporaryDirectory();
    const marketplace = join(root, "marketplace");
    const external = join(root, "external");
    mkdirSync(join(marketplace, ".agents", "plugins"), { recursive: true });
    writeFileSync(join(marketplace, ".agents", "plugins", "marketplace.json"), JSON.stringify({ plugins: [{
      name: "external-plugin", source: { url: "https://example.test/external.git" }
    }] }));
    writeSkill(external, "external-review", "Review external changes");
    let externalAvailable = true;
    const manager = new SkillSourceManager({
      dataDir: join(root, "data"),
      checkout: async (request) => {
        if (request.url === "https://example.test/external.git" && !externalAvailable) throw new Error("network down");
        return fixtureCheckout({
          "https://example.test/marketplace.git": marketplace,
          "https://example.test/external.git": external
        })(request);
      }
    });
    const source = await manager.add({ name: "Marketplace", url: "https://example.test/marketplace.git" });
    const before = manager.catalog();
    externalAvailable = false;

    await manager.refresh(source.id);

    expect(manager.catalog()).toEqual(before);
    expect(manager.list()[0]?.warnings).toContain("Skipped external-plugin: unable to fetch plugin source");
    await manager.close();
  });

  it("reads official local and GitHub plugin sources and only declared plugin Skills", async () => {
    const root = temporaryDirectory();
    const marketplace = join(root, "marketplace");
    const localPlugin = join(marketplace, "plugins", "local-review");
    const external = join(root, "external");
    mkdirSync(join(marketplace, ".claude-plugin"), { recursive: true });
    writeFileSync(join(marketplace, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [
      { name: "local-review", source: { source: "local", path: "./plugins/local-review" } },
      { name: "root-local", source: { source: "local", path: "./" } },
      { name: "github-review", source: { source: "github", repo: "example/tools", ref: "main", sha: "d".repeat(40) } }
    ] }));
    mkdirSync(join(marketplace, ".codex-plugin"), { recursive: true });
    writeFileSync(join(marketplace, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "review", skills: "./skills/" }));
    writeSkill(join(marketplace, "skills", "root"), "root-review", "Root review");
    mkdirSync(join(localPlugin, ".codex-plugin"), { recursive: true });
    writeFileSync(join(localPlugin, ".codex-plugin", "plugin.json"), JSON.stringify({ skills: "skills" }));
    writeSkill(join(localPlugin, "skills", "review"), "local-review", "Local review");
    writeSkill(join(localPlugin, "tests", "fixture"), "must-not-list", "Test fixture");
    writeSkill(join(external, "skills", "review"), "github-review", "GitHub review");
    const calls: Array<{ url: string; ref: string | null }> = [];
    const manager = new SkillSourceManager({
      dataDir: join(root, "data"),
      checkout: async (request) => {
        calls.push({ url: request.url, ref: request.ref });
        return fixtureCheckout({
          "https://example.test/marketplace.git": marketplace,
          "https://github.com/example/tools.git": external
        })(request);
      }
    });

    await manager.add({ name: "Marketplace", url: "https://example.test/marketplace.git" });

    expect(manager.catalog().map((item) => item.name).sort()).toEqual(["github-review", "local-review", "root-review"]);
    expect(calls).toContainEqual({ url: "https://github.com/example/tools.git", ref: "d".repeat(40) });
    await manager.close();
  });

  it("rejects unsafe refs and Git URLs before starting checkout", async () => {
    const root = temporaryDirectory();
    let calls = 0;
    const manager = new SkillSourceManager({ dataDir: join(root, "data"), checkout: async () => { calls += 1; return { commit: "a".repeat(40) }; } });
    await expect(manager.add({ name: "bad", url: "https://user:secret@example.test/repo.git" })).rejects.toMatchObject({ code: "invalid_source" });
    await expect(manager.add({ name: "bad", url: "ssh://git:secret@example.test/repo.git" })).rejects.toMatchObject({ code: "invalid_source" });
    await expect(manager.add({ name: "bad", url: "https://example.test/repo.git?token=secret" })).rejects.toMatchObject({ code: "invalid_source" });
    await expect(manager.add({ name: "bad", url: "https://example.test/repo.git", ref: "--upload-pack=evil" })).rejects.toMatchObject({ code: "invalid_source" });
    expect(calls).toBe(0);
    await manager.close();
  });

  it("aborts an active refresh on close and leaves no staging directory", async () => {
    const root = temporaryDirectory();
    let aborted = false;
    const manager = new SkillSourceManager({ dataDir: join(root, "data"), checkout: async ({ signal }) => await new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true })) });
    const pending = manager.add({ name: "slow", url: "https://example.test/slow.git" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await manager.close();
    await expect(pending).rejects.toMatchObject({ code: "refresh_failed" });
    expect(aborted).toBe(true);
    expect(existsSync(join(root, "data", "skill-sources", ".staging", "git-"))).toBe(false);
  });

  it("uses one deadline for the complete refresh", async () => {
    const root = temporaryDirectory();
    let aborted = false;
    const manager = new SkillSourceManager({ dataDir: join(root, "data"), operationTimeoutMs: 5, checkout: async ({ signal }) => await new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("timeout")); }, { once: true })) });
    await expect(manager.add({ name: "slow", url: "https://example.test/slow.git" })).rejects.toMatchObject({ code: "refresh_failed" });
    expect(aborted).toBe(true);
    await manager.close();
  });

  it("rejects a local plugin path through a symlink ancestor", async () => {
    const root = temporaryDirectory(); const fixture = join(root, "fixture"); const outside = join(root, "outside");
    writeSkill(outside, "escaped", "Must not escape");
    mkdirSync(join(fixture, ".claude-plugin"), { recursive: true });
    writeFileSync(join(fixture, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [{ name: "escaped", source: { source: "local", path: "./link" } }] }));
    symlinkSync(outside, join(fixture, "link"));
    const manager = new SkillSourceManager({ dataDir: join(root, "data"), checkout: fixtureCheckout({ "https://example.test/market.git": fixture }) });
    await manager.add({ name: "market", url: "https://example.test/market.git" });
    expect(manager.catalog()).toEqual([]);
    expect(manager.list()[0]?.warnings[0]).toContain("outside");
    await manager.close();
  });

  it("marks an interrupted syncing source failed and removes stale staging at restart", () => {
    const root = temporaryDirectory(); const sources = join(root, "data", "skill-sources");
    mkdirSync(join(sources, ".staging", "interrupted"), { recursive: true });
    writeFileSync(join(sources, "sources.json"), JSON.stringify({ sources: [{ id: "git-old", name: "old", url: "https://example.test/old.git", ref: null, path: "", status: "syncing", lastSyncedAt: null, error: null, skillCount: 0, warnings: [] }], catalog: [] }));
    const manager = new SkillSourceManager({ dataDir: join(root, "data"), checkout: fixtureCheckout({}) });
    expect(manager.list()).toEqual([expect.objectContaining({ status: "failed", error: "refresh_failed" })]);
    expect(existsSync(join(sources, ".staging", "interrupted"))).toBe(false);
  });

  it("resolves Claude metadata pluginRoot bare names and entry Skill paths", async () => {
    const root = temporaryDirectory(); const fixture = join(root, "fixture"); const external = join(root, "external");
    mkdirSync(join(fixture, ".claude-plugin"), { recursive: true });
    writeFileSync(join(fixture, ".claude-plugin", "marketplace.json"), JSON.stringify({ metadata: { pluginRoot: "./plugins" }, plugins: [
      { name: "local", source: "local", skills: "custom" },
      { name: "external", source: { source: "github", repo: "example/tools" }, skills: ["custom"] }
    ] }));
    writeSkill(join(fixture, "plugins", "local", "custom", "review"), "local-custom", "Local custom");
    writeSkill(join(external, "custom", "review"), "external-custom", "External custom");
    const manager = new SkillSourceManager({ dataDir: join(root, "data"), checkout: fixtureCheckout({ "https://example.test/market.git": fixture, "https://github.com/example/tools.git": external }) });
    await manager.add({ name: "market", url: "https://example.test/market.git" });
    expect(manager.catalog().map((item) => item.name).sort()).toEqual(["external-custom", "local-custom"]);
    await manager.close();
  });

  it("merges Claude strict marketplace and plugin Skill declarations", async () => {
    const root = temporaryDirectory(); const fixture = join(root, "fixture"); const plugin = join(fixture, "plugin");
    mkdirSync(join(fixture, ".claude-plugin"), { recursive: true });
    writeFileSync(join(fixture, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [{ name: "plugin", source: "./plugin", skills: "entry" }] }));
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true }); writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ skills: "manifest" }));
    writeSkill(join(plugin, "skills", "base"), "base", "Base"); writeSkill(join(plugin, "manifest", "one"), "manifest", "Manifest"); writeSkill(join(plugin, "entry", "one"), "entry", "Entry");
    const manager = new SkillSourceManager({ dataDir: join(root, "data"), checkout: fixtureCheckout({ "https://example.test/market.git": fixture }) });
    await manager.add({ name: "market", url: "https://example.test/market.git" });
    expect(manager.catalog().map((item) => item.name).sort()).toEqual(["base", "entry", "manifest"]);
    await manager.close();
  });

  it("rejects unsafe repository transports and overlapping source mutations", async () => {
    const root = temporaryDirectory();
    const fixture = join(root, "fixture");
    writeSkill(join(fixture, "review"), "review", "Review pull requests");
    let releaseCheckout: (() => void) | undefined;
    const manager = new SkillSourceManager({
      dataDir: join(root, "data"),
      checkout: async (request) => {
        await new Promise<void>((resolve) => { releaseCheckout = resolve; });
        return fixtureCheckout({ "https://example.test/skills.git": fixture })(request);
      }
    });
    await expect(manager.add({ name: "unsafe", url: "https://user:password@example.test/skills.git" }))
      .rejects.toEqual(expect.objectContaining({ code: "invalid_source" }));
    const pending = manager.add({ name: "Team skills", url: "https://example.test/skills.git" });
    await expect(manager.add({ name: "other", url: "https://example.test/other.git" }))
      .rejects.toEqual(expect.objectContaining({ code: "busy" }));
    releaseCheckout?.();
    await pending;
    await manager.close();
  });
});
