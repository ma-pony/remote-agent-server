import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SkillProjector } from "../src/runtime/skill-projector.js";
import { SkillManager } from "../src/skills/skill-manager.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("projects an entire selected package while preserving sibling resources and active Session copies", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-projection-")); roots.push(root);
  const packageDirectory = join(root, "package");
  const directory = join(packageDirectory, "skills", "review");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), "---\nname: review\ndescription: Review\n---\nRead ../../shared.txt");
  writeFileSync(join(packageDirectory, "shared.txt"), "first");
  const dataDir = join(root, "data");
  const manager = new SkillManager({ dataDir, roots: [], sourceCatalog: () => [{
    id: "repository-review", name: "review", description: "Review", source: "git", enabled: false, available: true,
    directory, packageDirectory, skillPath: "skills/review", sourceId: "example", packageName: "review-package"
  }] });
  const first = manager.setEnabled(1, "repository-review", true)!;
  const projector = new SkillProjector(dataDir);
  const oldSession = join(root, "old"); const newSession = join(root, "new");
  const projected = projector.prepare({ id: 1, provider: "codex" }, { id: 1, workspacePath: oldSession });
  const linked = realpathSync(join(oldSession, ".agents", "skills", "_remote-agent-managed-repository-review"));
  expect(projected.projectedSkills).toEqual([expect.objectContaining({
    id: "repository-review",
    name: "review",
    source: "git",
    sourceId: "example",
    packageName: "review-package",
    skillMdPath: join(linked, "SKILL.md"),
    directoryAliases: [
      join(oldSession, ".agents", "skills", "_remote-agent-managed-repository-review"),
      linked
    ]
  })]);
  const shared = join(dirname(dirname(linked)), "shared.txt");
  expect(readFileSync(shared, "utf8")).toBe("first");
  writeFileSync(join(packageDirectory, "shared.txt"), "second");
  const latest = manager.list(1)[0]!;
  manager.applyRevision(1, latest.id, latest.latestRevision!, first.currentRevision!);
  const next = projector.prepare({ id: 1, provider: "codex" }, { id: 2, workspacePath: newSession });
  expect(next.revision).not.toBe(projected.revision);
  expect(readFileSync(shared, "utf8")).toBe("first");
  const updated = realpathSync(join(newSession, ".agents", "skills", "_remote-agent-managed-repository-review"));
  expect(readFileSync(join(dirname(dirname(updated)), "shared.txt"), "utf8")).toBe("second");
});

it("changes the runtime fingerprint for same-name script-only edits", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-projection-")); roots.push(root);
  const dataDir = join(root, "data");
  const skill = join(dataDir, "agents", "1", "skills", "review");
  mkdirSync(skill, { recursive: true }); writeFileSync(join(skill, "SKILL.md"), "review");
  writeFileSync(join(skill, "run.sh"), "first");
  const projector = new SkillProjector(dataDir);
  const first = projector.prepare({ id: 1, provider: "codex" }, { id: 1, workspacePath: root });
  writeFileSync(join(skill, "run.sh"), "second");
  const next = projector.prepare({ id: 1, provider: "codex" }, { id: 1, workspacePath: root });
  expect(next.revision).not.toBe(first.revision);
});

it("projects Hermes Skills into the Session home", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-projection-")); roots.push(root);
  const dataDir = join(root, "data"); const source = join(dataDir, "agents", "1", "skills", "review");
  mkdirSync(source, { recursive: true }); writeFileSync(join(source, "SKILL.md"), "first");
  const projector = new SkillProjector(dataDir);
  projector.prepare({ id: 1, provider: "hermes" }, { id: 11, workspacePath: join(root, "one") });
  writeFileSync(join(source, "SKILL.md"), "second");
  projector.prepare({ id: 1, provider: "hermes" }, { id: 12, workspacePath: join(root, "two") });
  const homes = join(dataDir, "agents", "1", "provider-home", "hermes", "sessions");
  expect(readFileSync(join(homes, "11", "skills", "_remote-agent-managed-review", "SKILL.md"), "utf8")).toBe("first");
  expect(readFileSync(join(homes, "12", "skills", "_remote-agent-managed-review", "SKILL.md"), "utf8")).toBe("second");
});
