import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export class SkillContentError extends Error {
  constructor(readonly code: "invalid_skill_content" | "skill_content_too_large") { super(code); }
}

const frontmatterValue = (header: string, field: string): string | undefined => {
  const lines = header.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${field}:`));
  if (index === -1) return undefined;
  const value = lines[index]!.slice(field.length + 1).trim();
  if (![">", ">-", "|", "|-"].includes(value)) {
    return /^(".*"|'.*')$/.test(value) ? value.slice(1, -1) : value;
  }
  const continuation: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (line !== "" && !/^\s/.test(line)) break;
    if (line.trim() !== "") continuation.push(line.trim());
  }
  return continuation.join(value.startsWith("|") ? "\n" : " ");
};

export const readSkillMetadata = (directory: string): { name: string; description: string } => {
  const path = join(directory, "SKILL.md");
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new SkillContentError("invalid_skill_content");
  if (stat.size > 1024 * 1024) throw new SkillContentError("skill_content_too_large");
  const contents = readFileSync(path, "utf8");
  const header = contents.startsWith("---") ? contents.split(/^---\s*$/m)[1] ?? "" : "";
  return { name: frontmatterValue(header, "name") ?? basename(directory), description: frontmatterValue(header, "description") ?? "" };
};

export type SkillFile = { contents: Buffer; mode: number };

/** A bounded, deterministic package tree. Links and special files are not distributable. */
export const readSkillTree = (directory: string, ignoreInstallation = false): Map<string, SkillFile> => {
  const result = new Map<string, SkillFile>();
  let bytes = 0;
  let entries = 0;
  const visit = (relative: string, depth: number): void => {
    if (depth > 32) throw new SkillContentError("skill_content_too_large");
    const path = join(directory, relative);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        if (entry === ".git" || entry === ".DS_Store") continue;
        if (relative === "" && ignoreInstallation && entry === ".remote-agent-revision.json") continue;
        if (++entries > 10_000) throw new SkillContentError("skill_content_too_large");
        visit(relative === "" ? entry : `${relative}/${entry}`, depth + 1);
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 50 * 1024 * 1024) throw new SkillContentError("skill_content_too_large");
      result.set(relative, { contents: readFileSync(path), mode: stat.mode & 0o111 ? 0o755 : 0o644 });
    } else {
      throw new SkillContentError("invalid_skill_content");
    }
  };
  visit("", 0);
  return result;
};

export const skillTreeDigest = (directory: string, ignoreInstallation = false): string => {
  const hash = createHash("sha256");
  for (const [path, file] of readSkillTree(directory, ignoreInstallation)) {
    hash.update(JSON.stringify([path, file.mode, file.contents.length])).update("\0").update(file.contents);
  }
  return hash.digest("hex");
};
