import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import type { Provider } from "../domain.js";
import { readInstallation } from "../skills/skill-revisions.js";
import { skillTreeDigest } from "../skills/skill-content.js";

export type SkillProjectionAgent = {
  id: number;
  provider: Provider;
};

export type SkillProjectionSession = {
  id: number;
  workspacePath: string;
};

export type SkillProjection = {
  memory: string;
  revision: string;
  projectedSkills?: ProjectedSkill[];
};

export type ProjectedSkill = {
  id: string;
  name: string;
  revision: string;
  source: string;
  sourceId?: string;
  packageName?: string;
  pluginId?: string;
  pluginName?: string;
  pluginVersion?: string;
  skillMdPath: string;
  directoryAliases: string[];
};

const managedPrefix = "_remote-agent-managed-";
const packagePrefix = ".remote-agent-package-";

export type SkillProjectorFileSystem = {
  exists(path: string): boolean;
  read(path: string): string;
  mkdir(path: string): void;
  list(path: string): string[];
  copy(source: string, destination: string): void;
  rename(source: string, destination: string): void;
  remove(path: string): void;
  link(target: string, path: string): void;
};

const nodeFileSystem: SkillProjectorFileSystem = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  list: (path) => readdirSync(path).sort(),
  copy: (source, destination) => cpSync(source, destination, { recursive: true }),
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true, recursive: true }),
  link: (target, path) => symlinkSync(target, path, "dir")
};

/**
 * Projects an Agent's managed Skills without touching project-owned Skills.
 */
export class SkillProjector {
  private readonly fileSystem: SkillProjectorFileSystem;

  constructor(private readonly dataDir: string, fileSystem: Partial<SkillProjectorFileSystem> = {}) {
    this.fileSystem = { ...nodeFileSystem, ...fileSystem };
  }

  prepare(agent: SkillProjectionAgent, session: SkillProjectionSession): SkillProjection {
    const agentDirectory = join(this.dataDir, "agents", String(agent.id));
    const memoryPath = join(agentDirectory, "MEMORY.md");
    const memory = this.fileSystem.exists(memoryPath) ? this.fileSystem.read(memoryPath) : "";
    const source = join(agentDirectory, "skills");
    const skillsRoot = this.skillsRoot(agent, session);
    const token = randomUUID();
    const temporary = join(skillsRoot, `.remote-agent-skills.tmp-${token}`);
    const backup = join(skillsRoot, `.remote-agent-skills.backup-${token}`);
    const movedExisting: string[] = [];
    const installed: string[] = [];
    const fingerprints: [string, string, string][] = [];
    const projected: Array<{
      projectionName: string;
      skill: Omit<ProjectedSkill, "skillMdPath" | "directoryAliases">;
    }> = [];
    const enabledSkills = this.fileSystem.exists(source)
      ? this.fileSystem.list(source).filter((entry) => !entry.startsWith("."))
      : [];

    this.fileSystem.mkdir(skillsRoot);
    this.fileSystem.mkdir(temporary);
    this.fileSystem.mkdir(backup);
    try {
      for (const name of enabledSkills) {
        const sourceDirectory = join(source, name);
        const record = readInstallation(sourceDirectory);
        const skillPath = record?.skillPath ?? ".";
        if (skillPath === ".") {
          const destination = join(temporary, `${managedPrefix}${name}`);
          this.fileSystem.copy(realpathSync(sourceDirectory), destination);
          const revision = skillTreeDigest(destination, true);
          fingerprints.push([name, skillPath, revision]);
          projected.push({ projectionName: name, skill: this.projectedSkill(name, record, revision) });
        } else {
          const packageName = `${packagePrefix}${name}-${token}`;
          const destination = join(temporary, packageName);
          this.fileSystem.copy(realpathSync(sourceDirectory), destination);
          const revision = skillTreeDigest(destination, true);
          fingerprints.push([name, skillPath, revision]);
          projected.push({ projectionName: name, skill: this.projectedSkill(name, record, revision) });
          this.fileSystem.link(`${packageName}/${skillPath}`, join(temporary, `${managedPrefix}${name}`));
        }
      }

      const existingManaged = this.fileSystem.list(skillsRoot).filter((name) => name.startsWith(managedPrefix) || name.startsWith(packagePrefix));
      for (const name of existingManaged) {
        this.fileSystem.rename(join(skillsRoot, name), join(backup, name));
        movedExisting.push(name);
      }
      for (const name of this.fileSystem.list(temporary)) {
        this.fileSystem.rename(join(temporary, name), join(skillsRoot, name));
        installed.push(name);
      }
    } catch (error) {
      for (const name of installed) {
        this.fileSystem.remove(join(skillsRoot, name));
      }
      for (const name of movedExisting) {
        this.fileSystem.rename(join(backup, name), join(skillsRoot, name));
      }
      throw error;
    } finally {
      if (this.fileSystem.exists(temporary)) this.fileSystem.remove(temporary);
      if (this.fileSystem.exists(backup)) this.fileSystem.remove(backup);
    }

    const projectedSkills = projected.map(({ projectionName, skill }) => {
      const alias = join(skillsRoot, `${managedPrefix}${projectionName}`);
      const actual = realpathSync(alias);
      return {
        ...skill,
        skillMdPath: join(actual, "SKILL.md"),
        directoryAliases: [...new Set([alias, actual])]
      };
    });
    return {
      memory,
      revision: createHash("sha256").update(JSON.stringify(fingerprints)).digest("hex"),
      projectedSkills
    };
  }

  private projectedSkill(
    id: string,
    record: ReturnType<typeof readInstallation>,
    revision: string
  ): Omit<ProjectedSkill, "skillMdPath" | "directoryAliases"> {
    const pluginId = record?.source === "plugin"
      ? record.sourceId ?? record.packageName ?? record.id
      : undefined;
    return {
      id: record?.id ?? id,
      name: record?.name ?? id,
      revision,
      source: record?.source ?? "managed",
      ...(record?.sourceId === undefined ? {} : { sourceId: record.sourceId }),
      ...(record?.packageName === undefined ? {} : { packageName: record.packageName }),
      ...(pluginId === undefined ? {} : {
        pluginId,
        pluginName: record?.packageName ?? record?.sourceId ?? pluginId
      })
    };
  }

  private skillsRoot(agent: SkillProjectionAgent, session: SkillProjectionSession): string {
    if (agent.provider === "claude_code") return join(session.workspacePath, ".claude", "skills");
    if (agent.provider === "codex") return join(session.workspacePath, ".agents", "skills");
    if (!Number.isSafeInteger(session.id) || session.id <= 0) throw new Error("invalid_skill_projection_session");
    return join(this.dataDir, "agents", String(agent.id), "provider-home", "hermes", "sessions", String(session.id), "skills");
  }
}
