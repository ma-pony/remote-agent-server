import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { SkillContentError, readSkillTree, skillTreeDigest } from "./skill-content.js";

export const installationFile = ".remote-agent-revision.json";

export type SkillRevision = {
  id: string;
  revision: string;
  createdAt: string;
  name: string;
  description: string;
  source: string;
  skillPath: string;
  sourceId?: string;
  packageName?: string;
  repositoryUrl?: string;
  ref?: string | null;
  commit?: string;
};

export type SkillPackage = {
  id: string; name: string; description: string; source: string; directory: string;
  packageDirectory?: string; skillPath?: string;
  sourceId?: string; packageName?: string; repositoryUrl?: string; ref?: string | null; commit?: string;
};

const validId = (value: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const validRevision = (value: string) => /^[a-f0-9]{64}$/.test(value);

export const readInstallation = (directory: string): SkillRevision | undefined => {
  const path = join(directory, installationFile);
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as SkillRevision;
  if (!validId(value.id) || !validRevision(value.revision) || typeof value.skillPath !== "string"
    || isAbsolute(value.skillPath) || value.skillPath.includes("\\")
    || value.skillPath.split("/").some((part) => part === "..")
    || typeof value.name !== "string" || typeof value.description !== "string") throw new Error("invalid_skill_installation");
  return value;
};

export const installedSkillDirectory = (directory: string): string => join(directory, readInstallation(directory)?.skillPath ?? ".");

/** Immutable, complete package snapshots shared by Agent selections. */
export class SkillRevisions {
  private readonly root: string;
  constructor(dataDir: string) { this.root = join(dataDir, "skill-revisions"); }

  describe(skill: SkillPackage): SkillRevision {
    return {
      id: skill.id, revision: skillTreeDigest(skill.packageDirectory ?? skill.directory, true),
      createdAt: new Date().toISOString(), name: skill.name, description: skill.description,
      source: skill.source, skillPath: skill.skillPath ?? ".",
      ...(skill.sourceId === undefined ? {} : { sourceId: skill.sourceId }),
      ...(skill.packageName === undefined ? {} : { packageName: skill.packageName }),
      ...(skill.repositoryUrl === undefined ? {} : { repositoryUrl: skill.repositoryUrl }),
      ...(skill.ref === undefined ? {} : { ref: skill.ref }),
      ...(skill.commit === undefined ? {} : { commit: skill.commit })
    };
  }

  save(skill: SkillPackage): SkillRevision {
    const details = this.describe(skill);
    const destination = this.path(skill.id, details.revision);
    if (existsSync(destination)) return this.get(skill.id, details.revision)!;
    const temporary = `${destination}.tmp-${randomUUID()}`;
    mkdirSync(join(temporary, "content"), { recursive: true });
    try {
      for (const [name, file] of readSkillTree(skill.packageDirectory ?? skill.directory, true)) {
        const path = join(temporary, "content", name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.contents, { mode: file.mode });
      }
      if (skillTreeDigest(join(temporary, "content")) !== details.revision) throw new SkillContentError("invalid_skill_content");
      writeFileSync(join(temporary, installationFile), JSON.stringify(details), { mode: 0o600 });
      renameSync(temporary, destination);
      return details;
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }

  get(id: string, revision: string): SkillRevision | undefined {
    if (!validId(id) || !validRevision(revision)) return undefined;
    return readInstallation(this.path(id, revision));
  }

  list(id: string): SkillRevision[] {
    if (!validId(id) || !existsSync(join(this.root, id))) return [];
    return readdirSync(join(this.root, id)).filter(validRevision)
      .flatMap((revision) => this.get(id, revision) ?? [])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  content(id: string, revision: string): string {
    return join(this.path(id, revision), "content");
  }

  private path(id: string, revision: string): string {
    if (!validId(id) || !validRevision(revision)) throw new Error("invalid_skill_revision");
    return join(this.root, id, revision);
  }
}
