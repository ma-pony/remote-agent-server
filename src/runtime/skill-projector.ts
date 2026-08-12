import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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

/**
 * Projects an Agent's managed Skills without touching template-owned Skills.
 */
export class SkillProjector {
  constructor(private readonly dataDir: string) {}

  prepare(agent: SkillProjectionAgent, session: SkillProjectionSession): string {
    const agentDirectory = join(this.dataDir, "agents", agent.id);
    const source = join(agentDirectory, "skills");
    const skillsRoot = this.skillsRoot(agent, session);
    const managed = join(skillsRoot, managedDirectory);

    mkdirSync(skillsRoot, { recursive: true });
    rmSync(managed, { force: true, recursive: true });
    if (existsSync(source)) {
      cpSync(source, managed, { recursive: true });
    } else {
      mkdirSync(managed, { recursive: true });
    }

    const memoryPath = join(agentDirectory, "MEMORY.md");
    return existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
  }

  private skillsRoot(agent: SkillProjectionAgent, session: SkillProjectionSession): string {
    if (agent.provider === "claude_code") return join(session.workspacePath, ".claude", "skills");
    if (agent.provider === "codex") return join(session.workspacePath, ".agents", "skills");
    return join(this.dataDir, "agents", agent.id, "provider-home", "hermes", "skills");
  }
}
