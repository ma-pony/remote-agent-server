import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillManager } from "../src/skills/skill-manager.js";
import * as commands from "../src/project-environments/project-environment-commands.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = (files: Record<string, string | Buffer>, next: Record<string, string | Buffer | null>) => {
  const root = mkdtempSync(join(tmpdir(), "skill-preview-")); roots.push(root);
  const source = join(root, "host", "review"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: review\n---\nReview changes\n");
  for (const [path, body] of Object.entries(files)) writeFileSync(join(source, path), body);
  const manager = new SkillManager({ dataDir: join(root, "data"), roots: [{ path: join(root, "host"), source: "agents" }] });
  const id = manager.list(1)[0]!.id;
  manager.setEnabled(1, id, true);
  for (const [path, body] of Object.entries(next)) {
    if (body === null) rmSync(join(source, path)); else writeFileSync(join(source, path), body);
  }
  const revision = manager.list(1)[0]!.latestRevision!;
  const diff = manager.diff(1, id, revision);
  const preview = (path: string) => manager.previewFile(1, id, revision, path, diff.baseRevision);
  return { root, source, manager, id, revision, diff, preview };
};

describe("per-file Skill diff preview", () => {
  it("returns metadata without inline contents or a shared preview quota, then shows changes near the end of a large text", async () => {
    const prefix = Array.from({ length: 3_000 }, (_, index) => `unchanged line ${index}\n`).join("");
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`file-${index}.md`, prefix + "old ending\n"]));
    const next = Object.fromEntries(Object.keys(files).map((path) => [path, prefix + "new ending\n"]));
    const { diff, preview } = fixture(files, next);
    expect(diff.files).toHaveLength(12);
    for (const file of diff.files) {
      expect(file).toMatchObject({ preview: "text", beforeBytes: Buffer.byteLength(prefix + "old ending\n"), afterBytes: Buffer.byteLength(prefix + "new ending\n") });
      expect(file).not.toHaveProperty("before"); expect(file).not.toHaveProperty("after");
    }
    expect(JSON.stringify(diff).length).toBeLessThan(5_000);
    const result = await preview("file-9.md");
    expect(result).toMatchObject({ kind: "text", truncated: false });
    if (result.kind !== "text") throw new Error("expected text");
    expect(result.patch).toContain("-old ending\n+new ending");
    expect(result.patch).toContain("@@ -2998,4 +2998,4 @@");
    expect(result.patch).not.toContain("unchanged line 0\n");
  });

  it("distinguishes binary, unsupported encoding and the per-file input limit", async () => {
    const { diff, preview } = fixture({}, { "image.bin": Buffer.from([0, 1, 2]), "legacy.txt": Buffer.from([0xff, 0xfe, 65]), "huge.txt": "a".repeat(1024 * 1024 + 1) });
    expect(diff.files.map(({ path, preview: kind }) => [path, kind])).toEqual([
      ["huge.txt", "too_large"], ["image.bin", "binary"], ["legacy.txt", "unsupported_encoding"]
    ]);
    expect(await preview("image.bin")).toMatchObject({ kind: "binary" });
    expect(await preview("legacy.txt")).toMatchObject({ kind: "unsupported_encoding" });
    expect(await preview("huge.txt")).toMatchObject({ kind: "too_large", limitBytes: 1024 * 1024 });
  });

  it("bounds a large patch by UTF-8 bytes and explicitly reports truncation", async () => {
    const { preview } = fixture({ "many.md": "原内容\n".repeat(20_000) }, { "many.md": "新内容\n".repeat(20_000) });
    const result = await preview("many.md");
    expect(result).toMatchObject({ kind: "text", truncated: true });
    if (result.kind !== "text") throw new Error("expected text");
    expect(Buffer.byteLength(result.patch)).toBeLessThanOrEqual(64 * 1024);
    expect(result.patch).not.toContain("\uFFFD");
    expect(result.patch).toContain("@@");
  });

  it("handles additions, removals, empty files, permission-only edits and missing final newlines", async () => {
    const { source, manager, id, preview } = fixture({ "remove.txt": "removed", "mode.sh": "same\n" }, { "remove.txt": null, "add.txt": "added", "empty.txt": "" });
    expect(await preview("add.txt")).toMatchObject({ kind: "text", patch: expect.stringContaining("+added") });
    expect(await preview("remove.txt")).toMatchObject({ kind: "text", patch: expect.stringContaining("-removed") });
    expect(await preview("empty.txt")).toMatchObject({ kind: "text", patch: "", truncated: false });
    chmodSync(join(source, "mode.sh"), 0o755);
    const revision = manager.list(1)[0]!.latestRevision!;
    const diff = manager.diff(1, id, revision);
    expect(diff.files.find((file) => file.path === "mode.sh")).toMatchObject({ beforeMode: 0o644, afterMode: 0o755 });
    expect(await manager.previewFile(1, id, revision, "mode.sh", diff.baseRevision)).toMatchObject({ kind: "text", patch: "" });
  });

  it("rejects paths outside the package and changed comparison bases", async () => {
    const { root, manager, id, revision, diff, preview } = fixture({ "file.md": "before" }, { "file.md": "after" });
    await expect(preview("../secret.txt")).rejects.toThrow("skill_file_not_found");
    await expect(preview("/etc/passwd")).rejects.toThrow("skill_file_not_found");
    await expect(preview("missing.md")).rejects.toThrow("skill_file_not_found");
    writeFileSync(join(root, "data", "agents", "1", "skills", id, "file.md"), "local edits since the list was loaded");
    await expect(preview("file.md")).rejects.toThrow("skill_revision_conflict");
    const fresh = manager.diff(1, id, revision);
    expect(fresh.baseRevision).not.toBe(diff.baseRevision);
    expect(fresh.locallyModified).toBe(true);
    expect(await manager.previewFile(1, id, revision, "file.md", fresh.baseRevision)).toMatchObject({ kind: "text", patch: expect.stringContaining("-local edits since the list was loaded") });
  });

  it("cleans temporary contents after command failures and redacts private command errors", async () => {
    const { preview } = fixture({ "file.md": "before" }, { "file.md": "after" });
    let directory: string | undefined;
    let invocation: Parameters<typeof commands.runProcess> | undefined;
    let inputExisted = false;
    vi.stubEnv("GIT_EXTERNAL_DIFF", "untrusted-diff");
    vi.spyOn(commands, "runProcess").mockImplementation(async (...args) => {
      invocation = args;
      const options = args[2];
      directory = options.cwd;
      inputExisted = existsSync(join(directory!, "before"));
      throw new Error("private command path and credential");
    });
    await expect(preview("file.md")).rejects.toThrow(/^skill_preview_failed$/);
    expect(inputExisted).toBe(true);
    expect(invocation![2].timeoutMs).toBe(5_000);
    expect(invocation![2].environment.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect(invocation![1]).toContain("--no-ext-diff");
    expect(invocation![1]).toContain("--no-textconv");
    expect(directory).toBeDefined();
    expect(existsSync(directory!)).toBe(false);
  });
});
