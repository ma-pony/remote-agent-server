import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Provider } from "../domain.js";
import { parseSkillMetadata } from "../skills/skill-content.js";
import type { SkillCatalogItem } from "../skills/skill-manager.js";
import type { SkillRevision } from "../skills/skill-revisions.js";

export type PluginSkill = {
  id: string;
  name: string;
  description: string;
  skillMdPath: string;
  directoryAliases: string[];
};

export const isPluginSkillId = (id: string): boolean => id.startsWith("plugin-skill:");

export const pluginSkillTakeoverPath = (dataDir: string, agentId: number, id: string): string =>
  join(dataDir, "agents", String(agentId), "skills", ".plugin-managed", id);

/** Legacy copies without a recorded owner must not be replaced by a same-name plugin. */
export const pluginSkillReplacement = (
  record: SkillRevision | undefined, skills: readonly SkillCatalogItem[]
): SkillCatalogItem | undefined => {
  if (record?.source !== "plugin" || typeof record.sourceId !== "string" || !record.sourceId) return undefined;
  const sourceId = record.sourceId.replace(/^plugin:/, "");
  const matches = skills.filter(skill => skill.managedByPlugin && skill.available
    && skill.sourceId === sourceId && skill.name === record.name);
  return matches.length === 1 && matches[0]!.enabled ? matches[0] : undefined;
};

/** Read host and projected plugin packages with the same declarations and stable identities. */
export const readPluginSkills = async (
  root: string, provider: Exclude<Provider, "hermes">, pluginId: string, limit = 512
): Promise<PluginSkill[]> => {
  let manifest: Record<string, unknown> = {};
  const manifestPaths = provider === "codex" ? ["plugin.json", ".codex-plugin/plugin.json"] : [".claude-plugin/plugin.json"];
  for (const path of manifestPaths) {
    try {
      if ((await stat(join(root, path))).size > 1024 * 1024) return [];
      const value: unknown = JSON.parse(await readFile(join(root, path), "utf8"));
      if (value !== null && typeof value === "object" && !Array.isArray(value)) manifest = value as Record<string, unknown>;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof SyntaxError) break;
      throw error;
    }
  }
  const declared = typeof manifest.skills === "string" ? [manifest.skills]
    : Array.isArray(manifest.skills) ? manifest.skills.filter((path): path is string => typeof path === "string") : [];
  const roots = provider === "claude_code" || declared.length === 0 ? ["skills", ...declared] : declared;
  const skills = new Map<string, PluginSkill>();
  let visited = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 32 || ++visited > 10_000 || skills.size >= limit) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (entries.some(entry => entry.name === "SKILL.md" && entry.isFile())) {
      const path = join(directory, "SKILL.md");
      if ((await lstat(path)).size > 1024 * 1024) return;
      const metadata = parseSkillMetadata(await readFile(path, "utf8"), basename(directory));
      const actual = await realpath(directory);
      const id = `plugin-skill:${provider}:${pluginId}:${relative(root, directory)}`;
      skills.set(id, {
        id, ...metadata, skillMdPath: join(actual, "SKILL.md"), directoryAliases: [...new Set([directory, actual])]
      });
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) await visit(join(directory, entry.name), depth + 1);
    }
  };
  for (const path of new Set(roots)) {
    const directory = resolve(root, path);
    const fromRoot = relative(root, directory);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) continue;
    await visit(directory, 0);
  }
  return [...skills.values()];
};
