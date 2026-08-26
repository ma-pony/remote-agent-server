import { constants } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { Provider } from "../domain.js";
import type {
  DiscoveredProviderExtension,
  ProviderExtensionManager
} from "../provider-extensions/provider-extension-manager.js";

type ProjectionInput = {
  agentId: number;
  provider: Provider;
  home: string;
};

type PluginProjection = {
  id: string;
  marketplace: string;
  name: string;
  version: string;
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const readText = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
};

const readJsonObject = async (path: string): Promise<Record<string, unknown>> => {
  const text = await readText(path);
  if (text === "") return {};
  try {
    return object(JSON.parse(text)) ?? {};
  } catch {
    return {};
  }
};

const stripTomlSections = (input: string, roots: Set<string>): string => {
  let omitted = false;
  const output: string[] = [];
  for (const line of input.split(/\r?\n/)) {
    const section = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/)?.[1];
    if (section !== undefined) {
      const root = section.split(".", 1)[0]?.replaceAll('"', "");
      omitted = root !== undefined && roots.has(root);
    }
    if (!omitted) output.push(line);
  }
  return output.join("\n").trim();
};

const pluginParts = (extension: DiscoveredProviderExtension): PluginProjection | undefined => {
  if (extension.kind !== "plugin" || extension.sourcePath === null) return undefined;
  const id = object(extension.configuration)?.pluginId;
  if (typeof id !== "string") return undefined;
  const separator = id.lastIndexOf("@");
  if (separator <= 0 || separator === id.length - 1) return undefined;
  return {
    id,
    name: id.slice(0, separator),
    marketplace: id.slice(separator + 1),
    version: extension.version ?? basename(extension.sourcePath)
  };
};

const copyPlugins = async (
  home: string,
  extensions: DiscoveredProviderExtension[]
): Promise<PluginProjection[]> => {
  const plugins = extensions.map(pluginParts).filter((plugin): plugin is NonNullable<typeof plugin> => plugin !== undefined);
  await rm(join(home, "plugins", "cache"), { recursive: true, force: true });
  await Promise.all(plugins.map(async (plugin) => {
    const extension = extensions.find((candidate) => object(candidate.configuration)?.pluginId === plugin.id)!;
    const destination = join(home, "plugins", "cache", plugin.marketplace, plugin.name, plugin.version);
    await mkdir(dirname(destination), { recursive: true });
    await cp(extension.sourcePath!, destination, {
      recursive: true,
      force: true,
      mode: constants.COPYFILE_FICLONE
    });
  }));
  return plugins;
};

const projectedHooks = (extensions: DiscoveredProviderExtension[]): Record<string, unknown[]> => {
  const hooks: Record<string, unknown[]> = {};
  for (const extension of extensions) {
    if (extension.kind !== "hook") continue;
    const configuration = object(extension.configuration);
    const event = configuration?.event;
    const hook = object(configuration?.hook);
    if (typeof event !== "string" || hook === undefined) continue;
    const group: Record<string, unknown> = { hooks: [hook] };
    const matcher = configuration?.matcher;
    if (typeof matcher === "string") group.matcher = matcher;
    (hooks[event] ??= []).push(group);
  }
  return hooks;
};

const projectCodex = async (home: string, extensions: DiscoveredProviderExtension[]): Promise<void> => {
  const configPath = join(home, "config.toml");
  const base = stripTomlSections(await readText(configPath), new Set(["plugins", "mcp_servers"]));
  const plugins = await copyPlugins(home, extensions);
  const pluginConfig = plugins.map(({ id }) => [
    `[plugins.${JSON.stringify(id)}]`,
    "enabled = true"
  ].join("\n")).join("\n\n");
  const config = [base, pluginConfig].filter((section) => section !== "").join("\n\n");
  await writeFile(configPath, config === "" ? "" : `${config}\n`, { mode: 0o600 });
  await writeFile(
    join(home, "hooks.json"),
    `${JSON.stringify({ hooks: projectedHooks(extensions) }, null, 2)}\n`,
    { mode: 0o600 }
  );
};

const projectClaude = async (home: string, extensions: DiscoveredProviderExtension[]): Promise<void> => {
  const settingsPath = join(home, "settings.json");
  const settings = await readJsonObject(settingsPath);
  delete settings.enabledPlugins;
  delete settings.hooks;
  delete settings.mcpServers;
  const plugins = await copyPlugins(home, extensions);
  settings.enabledPlugins = Object.fromEntries(plugins.map(({ id }) => [id, true]));
  settings.hooks = projectedHooks(extensions);
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

  const installedPlugins = Object.fromEntries(plugins.map((plugin) => [plugin.id, [{
    scope: "user",
    version: plugin.version,
    installPath: join(home, "plugins", "cache", plugin.marketplace, plugin.name, plugin.version)
  }]]));
  const metadataPath = join(home, "plugins", "installed_plugins.json");
  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, `${JSON.stringify({ version: 2, plugins: installedPlugins }, null, 2)}\n`, { mode: 0o600 });

  const globalConfigPath = `${home}.json`;
  const globalConfig = await readJsonObject(globalConfigPath);
  delete globalConfig.mcpServers;
  await writeFile(globalConfigPath, `${JSON.stringify(globalConfig, null, 2)}\n`, { mode: 0o600 });
};

/** Projects only the Provider-native extensions explicitly selected by an Agent. */
export class ProviderExtensionProjector {
  constructor(private readonly manager: ProviderExtensionManager) {}

  async prepare({ agentId, provider, home }: ProjectionInput): Promise<void> {
    if (provider === "hermes") return;
    await mkdir(home, { recursive: true });
    const extensions = this.manager.enabled(agentId);
    if (provider === "codex") await projectCodex(home, extensions);
    else await projectClaude(home, extensions);
  }
}
