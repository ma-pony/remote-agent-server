import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Provider } from "../domain.js";

export type SkillProjectionAgent = {
  id: number;
  provider: Provider;
};

export type SkillProjectionSession = {
  workspacePath: string;
};

const managedPrefix = "_remote-agent-managed-";

export type SkillProjectorFileSystem = {
  exists(path: string): boolean;
  read(path: string): string;
  mkdir(path: string): void;
  list(path: string): string[];
  copy(source: string, destination: string): void;
  rename(source: string, destination: string): void;
  remove(path: string): void;
};

const nodeFileSystem: SkillProjectorFileSystem = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  list: (path) => readdirSync(path).sort(),
  copy: (source, destination) => cpSync(source, destination, { recursive: true }),
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true, recursive: true })
};

/**
 * Projects an Agent's managed Skills without touching project-owned Skills.
 */
export class SkillProjector {
  private readonly fileSystem: SkillProjectorFileSystem;

  constructor(private readonly dataDir: string, fileSystem: Partial<SkillProjectorFileSystem> = {}) {
    this.fileSystem = { ...nodeFileSystem, ...fileSystem };
  }

  prepare(agent: SkillProjectionAgent, session: SkillProjectionSession): string {
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

    this.fileSystem.mkdir(skillsRoot);
    this.fileSystem.mkdir(temporary);
    this.fileSystem.mkdir(backup);
    try {
      if (this.fileSystem.exists(source)) {
        for (const name of this.fileSystem.list(source).filter((entry) => !entry.startsWith("."))) {
          this.fileSystem.copy(join(source, name), join(temporary, `${managedPrefix}${name}`));
        }
      }

      const existingManaged = this.fileSystem.list(skillsRoot).filter((name) => name.startsWith(managedPrefix));
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
        const path = join(skillsRoot, name);
        if (this.fileSystem.exists(path)) this.fileSystem.remove(path);
      }
      for (const name of movedExisting) {
        const path = join(backup, name);
        if (this.fileSystem.exists(path)) this.fileSystem.rename(path, join(skillsRoot, name));
      }
      throw error;
    } finally {
      if (this.fileSystem.exists(temporary)) this.fileSystem.remove(temporary);
      if (this.fileSystem.exists(backup)) this.fileSystem.remove(backup);
    }

    return memory;
  }

  private skillsRoot(agent: SkillProjectionAgent, session: SkillProjectionSession): string {
    if (agent.provider === "claude_code") return join(session.workspacePath, ".claude", "skills");
    if (agent.provider === "codex") return join(session.workspacePath, ".agents", "skills");
    return join(this.dataDir, "agents", String(agent.id), "provider-home", "hermes", "skills");
  }
}
