import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Provider } from "../domain.js";

export type SkillProjectionAgent = {
  id: string;
  provider: Provider;
};

export type SkillProjectionSession = {
  workspacePath: string;
};

const managedDirectory = "_remote-agent-managed";

export type SkillProjectorFileSystem = {
  exists(path: string): boolean;
  read(path: string): string;
  mkdir(path: string): void;
  copy(source: string, destination: string): void;
  rename(source: string, destination: string): void;
  remove(path: string): void;
};

const nodeFileSystem: SkillProjectorFileSystem = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  copy: (source, destination) => cpSync(source, destination, { recursive: true }),
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true, recursive: true })
};

/**
 * Projects an Agent's managed Skills without touching template-owned Skills.
 */
export class SkillProjector {
  private readonly fileSystem: SkillProjectorFileSystem;

  constructor(private readonly dataDir: string, fileSystem: Partial<SkillProjectorFileSystem> = {}) {
    this.fileSystem = { ...nodeFileSystem, ...fileSystem };
  }

  prepare(agent: SkillProjectionAgent, session: SkillProjectionSession): string {
    const agentDirectory = join(this.dataDir, "agents", agent.id);
    const memoryPath = join(agentDirectory, "MEMORY.md");
    const memory = this.fileSystem.exists(memoryPath) ? this.fileSystem.read(memoryPath) : "";
    const source = join(agentDirectory, "skills");
    const skillsRoot = this.skillsRoot(agent, session);
    const managed = join(skillsRoot, managedDirectory);
    const token = randomUUID();
    const temporary = join(skillsRoot, `.${managedDirectory}.tmp-${token}`);
    const backup = join(skillsRoot, `.${managedDirectory}.backup-${token}`);
    let movedExisting = false;
    let installed = false;

    this.fileSystem.mkdir(skillsRoot);
    try {
      if (this.fileSystem.exists(source)) {
        this.fileSystem.copy(source, temporary);
      } else {
        this.fileSystem.mkdir(temporary);
      }

      if (this.fileSystem.exists(managed)) {
        this.fileSystem.rename(managed, backup);
        movedExisting = true;
      }
      this.fileSystem.rename(temporary, managed);
      installed = true;
      if (movedExisting) this.fileSystem.remove(backup);
    } catch (error) {
      if (installed && this.fileSystem.exists(managed)) this.fileSystem.remove(managed);
      if (movedExisting && this.fileSystem.exists(backup)) this.fileSystem.rename(backup, managed);
      throw error;
    } finally {
      if (this.fileSystem.exists(temporary)) this.fileSystem.remove(temporary);
    }

    return memory;
  }

  private skillsRoot(agent: SkillProjectionAgent, session: SkillProjectionSession): string {
    if (agent.provider === "claude_code") return join(session.workspacePath, ".claude", "skills");
    if (agent.provider === "codex") return join(session.workspacePath, ".agents", "skills");
    return join(this.dataDir, "agents", agent.id, "provider-home", "hermes", "skills");
  }
}
