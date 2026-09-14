import { cpSync, lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { SkillManager } from "../src/skills/skill-manager.js";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "skill-update-")); roots.push(root);
  const skill = join(root, "host", "review"); mkdirSync(join(skill, "scripts"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: review\ndescription: Review changes\n---\nRead scripts/check.sh");
  writeFileSync(join(skill, "scripts", "check.sh"), "first");
  const manager = new SkillManager({ dataDir: join(root, "data"), roots: [{ path: join(root, "host"), source: "agents" }] });
  return { root, skill, manager, id: manager.list(1)[0]!.id };
};
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("manual Skill updates", () => {
  it("keeps Agent versions independent, previews script-only edits, applies explicitly and rolls back", () => {
    const { manager, skill, id } = fixture();
    const installed = manager.setEnabled(1, id, true)!;
    manager.setEnabled(2, id, true);
    writeFileSync(join(skill, "scripts", "check.sh"), "second");
    const latest = manager.list(1)[0]!;
    expect(latest.updateAvailable).toBe(true);
    expect(manager.setEnabled(1, id, true)!.currentRevision).toBe(installed.currentRevision);
    const preview = manager.diff(1, id, latest.latestRevision!);
    expect(preview.files).toEqual([expect.objectContaining({ path: "scripts/check.sh", status: "modified", before: "first", after: "second" })]);
    const updated = manager.applyRevision(1, id, latest.latestRevision!, installed.currentRevision!);
    expect(updated.currentRevision).toBe(latest.latestRevision);
    expect(manager.list(2)[0]!.currentRevision).toBe(installed.currentRevision);
    expect(() => manager.applyRevision(1, id, installed.currentRevision!, installed.currentRevision!)).toThrow("skill_revision_conflict");
    expect(manager.applyRevision(1, id, installed.currentRevision!, updated.currentRevision!).currentRevision).toBe(installed.currentRevision);
  });

  it("preserves a locally edited installation and rejects an overwrite", () => {
    const { root, manager, skill, id } = fixture();
    const installed = manager.setEnabled(1, id, true)!;
    writeFileSync(join(root, "data", "agents", "1", "skills", id, "scripts", "check.sh"), "local edit");
    writeFileSync(join(skill, "scripts", "check.sh"), "upstream edit");
    const latest = manager.list(1)[0]!;
    expect(latest.locallyModified).toBe(true);
    expect(() => manager.applyRevision(1, id, latest.latestRevision!, installed.currentRevision!)).toThrow("skill_locally_modified");
    expect(readFileSync(join(root, "data", "agents", "1", "skills", id, "scripts", "check.sh"), "utf8")).toBe("local edit");
  });

  it("publishes a same-name ZIP version without changing enabled Agents", () => {
    const { manager } = fixture();
    const archive = (body: string) => zipSync({ "SKILL.md": strToU8(`---\nname: uploaded\ndescription: ZIP review\n---\n${body}`) });
    const original = manager.upload(1, "review.zip", archive("first"));
    const next = manager.upload(1, "review.zip", archive("second"), original.id);
    expect(next.currentRevision).toBe(original.currentRevision);
    expect(next.updateAvailable).toBe(true);
    expect(() => manager.upload(1, "review.zip", archive("third"))).toThrow("skill_name_conflict");
  });

  it("lets an operator disable a locally damaged installation without losing access to the catalog", () => {
    const { root, manager, id } = fixture();
    manager.setEnabled(1, id, true);
    symlinkSync("/etc/passwd", join(root, "data", "agents", "1", "skills", id, "unsafe-link"));
    expect(manager.list(1)[0]).toMatchObject({ enabled: true, locallyModified: true });
    expect(manager.setEnabled(1, id, false)).toMatchObject({ enabled: false });
  });

  it("checks name conflicts against selected contents even when upstream renames a Skill", () => {
    const { root, skill, manager, id } = fixture();
    manager.setEnabled(1, id, true);
    writeFileSync(join(skill, "SKILL.md"), "---\nname: new-review\ndescription: Renamed\n---\n");
    const second = join(root, "second"); mkdirSync(second);
    writeFileSync(join(second, "SKILL.md"), "---\nname: review\ndescription: Another review\n---\n");
    const fresh = new SkillManager({ dataDir: join(root, "data"), roots: [{ path: join(root, "host"), source: "agents" }],
      sourceCatalog: () => [{ id: "second", name: "review", description: "Another review", source: "git", directory: second, enabled: false, available: true }] });
    expect(fresh.list(1).find((item) => item.id === id)?.name).toBe("review");
    expect(() => fresh.setEnabled(1, "second", true)).toThrow("skill_name_conflict");
    const current = fresh.list(1).find((item) => item.id === id)!;
    fresh.applyRevision(1, id, current.latestRevision!, current.currentRevision!);
    expect(fresh.setEnabled(1, "second", true)?.enabled).toBe(true);
  });

  it("installs a host Skill linked by a package installer as an independent content copy", () => {
    const { root, skill } = fixture();
    const linked = join(root, "linked"); mkdirSync(linked);
    symlinkSync(skill, join(linked, "review"), "dir");
    const manager = new SkillManager({ dataDir: join(root, "linked-data"), roots: [{ path: linked, source: "agents" }] });
    const id = manager.list(1)[0]!.id;
    const installed = manager.setEnabled(1, id, true)!;
    writeFileSync(join(skill, "scripts", "check.sh"), "new source contents");
    expect(readFileSync(join(root, "linked-data", "agents", "1", "skills", id, "scripts", "check.sh"), "utf8")).toBe("first");
    expect(manager.list(1)[0]).toMatchObject({ currentRevision: installed.currentRevision, updateAvailable: true });
  });

  it("previews and migrates an existing linked installation while retaining its rollback contents", () => {
    const { root, skill, manager, id } = fixture();
    const previous = join(root, "legacy-package"); cpSync(skill, previous, { recursive: true });
    const installation = join(root, "data", "agents", "1", "skills", id);
    mkdirSync(join(root, "data", "agents", "1", "skills"), { recursive: true });
    symlinkSync(previous, installation, "dir");
    writeFileSync(join(skill, "scripts", "check.sh"), "next version");
    const current = manager.list(1)[0]!;
    expect(manager.diff(1, id, current.latestRevision!).files).toEqual([
      expect.objectContaining({ path: "scripts/check.sh", before: "first", after: "next version" })
    ]);
    manager.applyRevision(1, id, current.latestRevision!, current.currentRevision!);
    expect(lstatSync(installation).isDirectory()).toBe(true);
    writeFileSync(join(previous, "scripts", "check.sh"), "changed legacy source");
    manager.applyRevision(1, id, current.currentRevision!, current.latestRevision!);
    expect(readFileSync(join(installation, "scripts", "check.sh"), "utf8")).toBe("first");
  });
});
