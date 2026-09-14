import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSkillMetadata, readSkillTree, skillTreeDigest } from "../src/skills/skill-content.js";

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "skill-content-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("Skill content", () => {
  it("hashes every package file and executable permission deterministically", () => {
    const path = root();
    writeFileSync(join(path, "SKILL.md"), "---\nname: review\ndescription: >-\n  Review\n  changes\n---\n");
    mkdirSync(join(path, "scripts"));
    writeFileSync(join(path, "scripts", "review.sh"), "first");
    expect(readSkillMetadata(path)).toEqual({ name: "review", description: "Review changes" });
    const original = skillTreeDigest(path);
    expect(skillTreeDigest(path)).toBe(original);
    writeFileSync(join(path, "scripts", "review.sh"), "second");
    expect(skillTreeDigest(path)).not.toBe(original);
    const edited = skillTreeDigest(path);
    chmodSync(join(path, "scripts", "review.sh"), 0o755);
    expect(skillTreeDigest(path)).not.toBe(edited);
    expect([...readSkillTree(path).keys()]).toEqual(["SKILL.md", "scripts/review.sh"]);
  });

  it("rejects symbolic links and bounds tree size before reading file bytes", () => {
    const path = root();
    symlinkSync("/etc/passwd", join(path, "escaped"));
    expect(() => readSkillTree(path)).toThrow("invalid_skill_content");
  });
});
