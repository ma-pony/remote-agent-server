import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";
import { z } from "zod";

const legacySections = z.record(z.string(), z.record(z.string(), z.unknown()));
const legacyEntryIds = new Map([
  ["ui-developer-tools", "ui-settings"],
  ["ui-onboarding", "ui-settings-general"],
  ["shell", process.platform === "win32" ? "pwsh-sandbox" : "bash-sandbox"]
]);

const readOptional = async (path: string): Promise<string | undefined> => {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const mergeSettings = (target: YAMLMap, values: Record<string, unknown>): void => {
  for (const [key, value] of Object.entries(values)) {
    const current = target.get(key, true);
    if (isMap(current) && value !== null && typeof value === "object" && !Array.isArray(value)) {
      mergeSettings(current, value as Record<string, unknown>);
    } else target.set(key, value);
  }
};

/** Migrate legacy sections before ACP advertises models; never modify the host's configuration. */
export const prepareDeepSeekSettings = async (hostHome: string, home: string): Promise<void> => {
  // Native DSH imports this file asynchronously, after its first ACP Session can already exist.
  await rm(join(home, "settings.yaml"), { force: true });
  const content = await readOptional(join(hostHome, "settings.yaml"));
  if (content === undefined) return;
  const legacy = parseDocument(content, { logLevel: "silent" });
  if (legacy.errors.length > 0) throw new Error("Invalid DeepSeek Harness settings.yaml");
  const settings = legacySections.safeParse(legacy.toJS() ?? {});
  if (!settings.success) throw new Error("Invalid DeepSeek Harness settings.yaml");
  const profile = join(home, "profiles", "acp");
  const source = await readOptional(join(hostHome, "profiles", "acp", "cordis.patch.yml"));
  const patches = parseDocument(source ?? "[]", { logLevel: "silent" });
  if (patches.errors.length > 0 || !isSeq(patches.contents)) throw new Error("Invalid DeepSeek Harness ACP profile patch");
  for (const [section, config] of Object.entries(settings.data)) {
    const id = legacyEntryIds.get(section) ?? section;
    const entry = patches.contents.items.findLast(node => {
      if (!isMap(node) || !node.has("config")) return false;
      const entryId = node.get("id", true);
      return isScalar(entryId) && entryId.toString() === id;
    });
    const current = isMap(entry) ? entry.get("config", true) : undefined;
    // Cordis replaces config wholesale; merge legacy edits into the existing Profile config first.
    if (isMap(current)) mergeSettings(current, config);
    else patches.add({ id, config });
  }
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await writeFile(join(profile, "cordis.patch.yml"), patches.toString(), { mode: 0o600 });
};

// Use DSH's literal prompt section API: Agent instructions may contain {{templates}}.
const INSTRUCTIONS_PLUGIN = `module.exports = {
  name: "remote-agent-instructions",
  inject: ["systemPrompt"],
  apply(ctx, config) {
    ctx.systemPrompt.section({
      name: "remote-agent:instructions",
      order: -500,
      text: config.text,
      interpolate: false
    });
  }
};
`;

/** Appends service-managed instructions and limits Skill discovery to this Workspace. */
export const writeDeepSeekPatch = async (home: string, workspacePath: string, prompt: string): Promise<string> => {
  const pluginPath = join(home, "remote-agent-instructions.cjs");
  const patchPath = join(home, "remote-agent.patch.json");
  await writeFile(pluginPath, INSTRUCTIONS_PLUGIN, { mode: 0o600 });
  await writeFile(patchPath, `${JSON.stringify([
    {
      insert: [{
        id: "remote-agent-instructions",
        name: pluginPath,
        config: { text: prompt }
      }]
    },
    {
      id: "skill-filesystem",
      config: {
        includeDefaultRoots: false,
        customSkillDirs: [join(workspacePath, ".dsh", "skills"), join(workspacePath, ".agents", "skills")],
        watch: false
      }
    }
  ], null, 2)}\n`, { mode: 0o600 });
  return patchPath;
};
