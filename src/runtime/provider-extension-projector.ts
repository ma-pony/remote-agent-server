import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

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
  sourcePath: string;
  sourceFingerprint: string;
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
    version: extension.version ?? basename(extension.sourcePath),
    sourcePath: extension.sourcePath,
    sourceFingerprint: extension.sourceFingerprint
  };
};

const pluginsFrom = (extensions: DiscoveredProviderExtension[]): PluginProjection[] =>
  extensions.map(pluginParts).filter((plugin): plugin is PluginProjection => plugin !== undefined);

const safePathPart = (part: string): boolean => part !== "" && part !== "." && part !== ".." && basename(part) === part
  && !part.includes("\\");

const existingDirectory = async (path: string): Promise<boolean> => {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error("invalid_shared_plugin_path");
    return true;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const marketplacePublications = new Map<string, Promise<string>>();
const cachePublications = new Map<string, Promise<void>>();
const lastCodexCachePrune = new Map<string, number>();
const pendingCodexCachePrunes = new Set<string>();
const queuedCodexCachePrunes = new Set<string>();
const publicationTemporaryName = /^([0-9a-f]{20})\.tmp-[0-9a-f-]{36}$/;

/** Retires snapshots no Session can still reference, leaving new publications time to become visible. */
const pruneCodexPluginCaches = async (agentHome: string, force = false): Promise<void> => {
  if (!force && Date.now() - (lastCodexCachePrune.get(agentHome) ?? 0) < 10 * 60_000) return;
  const sharedRoot = join(agentHome, "shared-plugins");
  const cachesRoot = join(agentHome, "plugin-caches");
  let marketplaces: Array<{ name: string; isDirectory(): boolean }>;
  try { marketplaces = await readdir(sharedRoot, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    marketplaces = [];
  }
  const snapshotCandidates: string[] = [];
  const stalePublications: string[] = [];
  for (const marketplace of marketplaces.filter((entry) => entry.isDirectory())) {
    const marketRoot = join(sharedRoot, marketplace.name);
    for (const revision of await readdir(marketRoot, { withFileTypes: true })) {
      if (!revision.isDirectory()) continue;
      const path = join(marketRoot, revision.name);
      const temporary = revision.name.match(publicationTemporaryName);
      if (temporary !== null) {
        if (!marketplacePublications.has(join(marketRoot, temporary[1]!))
          && Date.now() - (await lstat(path)).mtimeMs > 60 * 60_000) stalePublications.push(path);
      } else if (/^[0-9a-f]{20}$/.test(revision.name)
        && Date.now() - (await lstat(path)).mtimeMs > 60 * 60_000) snapshotCandidates.push(path);
    }
  }
  const cacheCandidates: string[] = [];
  for (const entry of await readdir(cachesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(cachesRoot, entry.name);
    const temporary = entry.name.match(publicationTemporaryName);
    if (temporary !== null) {
      if (!cachePublications.has(join(cachesRoot, temporary[1]!))
        && Date.now() - (await lstat(path)).mtimeMs > 60 * 60_000) stalePublications.push(path);
    } else if (/^[0-9a-f]{20}$/.test(entry.name)
      && Date.now() - (await lstat(path)).mtimeMs > 60 * 60_000) cacheCandidates.push(path);
  }
  for (const path of stalePublications) await rm(path, { recursive: true, force: true });
  if (snapshotCandidates.length === 0 && cacheCandidates.length === 0) {
    lastCodexCachePrune.set(agentHome, Date.now());
    return;
  }
  const referencedSnapshots = new Set<string>();
  const referencedCaches = new Set<string>();
  const sessionsRoot = join(agentHome, "sessions");
  let sessions: Array<{ name: string; isDirectory(): boolean }>;
  try { sessions = await readdir(sessionsRoot, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    sessions = [];
  }
  for (const session of sessions.filter((entry) => entry.isDirectory())) {
    // Session 0 belongs to model-catalog and doctor probes, not a retained business Session.
    if (session.name === "0") continue;
    const home = join(sessionsRoot, session.name);
    const config = await readText(join(home, "config.toml"));
    for (const path of snapshotCandidates) {
      if (config.includes(`source = ${JSON.stringify(path)}`)) referencedSnapshots.add(path);
    }
    try { referencedCaches.add(await readlink(join(home, "plugins", "cache"))); }
    catch (error) {
      if (!["ENOENT", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  for (const path of snapshotCandidates) {
    if (!referencedSnapshots.has(path)) await rm(path, { recursive: true, force: true });
  }
  for (const path of cacheCandidates) {
    if (!referencedCaches.has(path)) await rm(path, { recursive: true, force: true });
  }
  lastCodexCachePrune.set(agentHome, Date.now());
};

const scheduleCodexCachePrune = (agentHome: string): void => {
  if (pendingCodexCachePrunes.has(agentHome)) {
    queuedCodexCachePrunes.add(agentHome);
    return;
  }
  pendingCodexCachePrunes.add(agentHome);
  void (async () => {
    let force = false;
    try {
      do {
        queuedCodexCachePrunes.delete(agentHome);
        try { await pruneCodexPluginCaches(agentHome, force); }
        catch { console.error("codex_plugin_snapshot_prune_failed"); }
        force = true;
      } while (queuedCodexCachePrunes.has(agentHome));
    } finally {
      pendingCodexCachePrunes.delete(agentHome);
    }
  })();
};

const publishMarketplaceSnapshot = async (
  marketplace: string, plugins: PluginProjection[], destination: string
): Promise<string> => {
  if (await existingDirectory(destination)) return destination;
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    await mkdir(join(temporary, "plugins"), { recursive: true });
    await Promise.all(plugins.map(async (plugin) => {
      const packageRoot = join(temporary, "plugins", plugin.name);
      await cp(plugin.sourcePath, packageRoot, { recursive: true, mode: constants.COPYFILE_FICLONE });
      const legacyManifest = join(packageRoot, ".codex-plugin", "plugin.json");
      const agentManifest = join(packageRoot, "plugin.json");
      const manifestPath = await readText(agentManifest) === "" ? legacyManifest : agentManifest;
      const manifest = await readJsonObject(manifestPath);
      // Codex refreshes an installed local plugin only when its manifest version changes.
      manifest.name ??= plugin.name;
      manifest.version = `ras-${plugin.sourceFingerprint.slice(0, 20)}`;
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    }));
    const manifest = {
      name: marketplace,
      plugins: plugins.map(({ name }) => ({
        name,
        source: { source: "local", path: `./plugins/${name}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity"
      }))
    };
    const manifestPath = join(temporary, ".agents", "plugins", "marketplace.json");
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    try { await rename(temporary, destination); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")
        || !(await existingDirectory(destination))) throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return destination;
};

const publishMarketplace = (
  marketplace: string, plugins: PluginProjection[], sharedRoot: string
): Promise<string> => {
  if (![marketplace, ...plugins.map(({ name }) => name)].every(safePathPart)) throw new Error("invalid_plugin_path");
  const revision = createHash("sha256").update(JSON.stringify(plugins.map(({ id, version, sourceFingerprint }) => [
    id, version, sourceFingerprint
  ]))).digest("hex").slice(0, 20);
  const destination = join(sharedRoot, marketplace, revision);
  const pending = marketplacePublications.get(destination);
  if (pending !== undefined) return pending;
  const publication = publishMarketplaceSnapshot(marketplace, plugins, destination);
  marketplacePublications.set(destination, publication);
  return publication.finally(() => marketplacePublications.delete(destination));
};

const publishPluginCache = (
  plugins: PluginProjection[], marketplaces: Array<{ name: string; root: string }>, destination: string
): Promise<void> => {
  const pending = cachePublications.get(destination);
  if (pending !== undefined) return pending;
  const publication = (async () => {
    if (await existingDirectory(destination)) return;
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp-${randomUUID()}`;
    try {
      await mkdir(temporary, { recursive: true });
      await Promise.all(plugins.map(async (plugin) => {
        const marketplaceRoot = marketplaces.find(({ name }) => name === plugin.marketplace)!.root;
        const version = `ras-${plugin.sourceFingerprint.slice(0, 20)}`;
        const target = join(temporary, plugin.marketplace, plugin.name, version);
        await mkdir(dirname(target), { recursive: true });
        await cp(join(marketplaceRoot, "plugins", plugin.name), target, {
          recursive: true, mode: constants.COPYFILE_FICLONE
        });
      }));
      try { await rename(temporary, destination); }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")
          || !(await existingDirectory(destination))) throw error;
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  })();
  cachePublications.set(destination, publication);
  return publication.finally(() => cachePublications.delete(destination));
};

const linkCodexPlugins = async (
  home: string, agentHome: string, extensions: DiscoveredProviderExtension[], compressionEnabled: boolean
): Promise<{ plugins: PluginProjection[]; marketplaces: Array<{ name: string; root: string }> }> => {
  const plugins = pluginsFrom(extensions);
  const grouped = Map.groupBy(plugins, ({ marketplace }) => marketplace);
  const marketplaces = await Promise.all([...grouped].map(async ([name, selected]) => ({
    name,
    root: await publishMarketplace(name, selected.sort((left, right) => left.name.localeCompare(right.name)),
      join(agentHome, "shared-plugins"))
  })));
  const cacheRevision = createHash("sha256").update(JSON.stringify(plugins.map(({ id, sourceFingerprint }) => [
    id, sourceFingerprint
  ]).sort(([left], [right]) => left.localeCompare(right)))).digest("hex").slice(0, 20);
  const sharedCache = join(agentHome, "plugin-caches", cacheRevision);
  const sharedTemporary = join(agentHome, ".tmp");
  const sessionTemporary = join(home, ".tmp");
  await Promise.all([publishPluginCache(plugins, marketplaces, sharedCache),
    mkdir(sharedTemporary, { recursive: true })]);
  await rm(join(home, "plugins", "cache"), { recursive: true, force: true });
  await mkdir(join(home, "plugins"), { recursive: true });
  if (compressionEnabled) {
    try {
      if (!(await lstat(sessionTemporary)).isDirectory()) await rm(sessionTemporary, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(sessionTemporary, { recursive: true });
  } else {
    await rm(sessionTemporary, { recursive: true, force: true });
    await symlink(sharedTemporary, sessionTemporary, "dir");
  }
  await symlink(sharedCache, join(home, "plugins", "cache"), "dir");
  return { plugins, marketplaces };
};

const copyPlugins = async (
  home: string,
  extensions: DiscoveredProviderExtension[]
): Promise<PluginProjection[]> => {
  const plugins = pluginsFrom(extensions);
  await rm(join(home, "plugins", "cache"), { recursive: true, force: true });
  await Promise.all(plugins.map(async (plugin) => {
    const destination = join(home, "plugins", "cache", plugin.marketplace, plugin.name, plugin.version);
    await mkdir(dirname(destination), { recursive: true });
    await cp(plugin.sourcePath, destination, {
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

const projectCodex = async (home: string, agentHome: string, extensions: DiscoveredProviderExtension[]): Promise<void> => {
  const configPath = join(home, "config.toml");
  const existingConfig = await readText(configPath);
  const base = stripTomlSections(existingConfig, new Set(["plugins", "mcp_servers", "marketplaces"]));
  const compressionEnabled = /^\s*(?:features\.)?local_thread_store_compression\s*=\s*true\s*(?:#.*)?$/m.test(existingConfig);
  const { plugins, marketplaces } = await linkCodexPlugins(home, agentHome, extensions, compressionEnabled);
  const marketplaceConfig = marketplaces.map(({ name, root }) => [
    `[marketplaces.${JSON.stringify(name)}]`,
    "source_type = \"local\"",
    `source = ${JSON.stringify(root)}`
  ].join("\n")).join("\n\n");
  const pluginConfig = plugins.map(({ id }) => [
    `[plugins.${JSON.stringify(id)}]`,
    "enabled = true"
  ].join("\n")).join("\n\n");
  const config = [base, marketplaceConfig, pluginConfig].filter((section) => section !== "").join("\n\n");
  await writeFile(configPath, config === "" ? "" : `${config}\n`, { mode: 0o600 });
  await writeFile(
    join(home, "hooks.json"),
    `${JSON.stringify({ hooks: projectedHooks(extensions) }, null, 2)}\n`,
    { mode: 0o600 }
  );
  scheduleCodexCachePrune(agentHome);
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
  constructor(private readonly manager: ProviderExtensionManager, private readonly dataDir: string) {}

  async prepare({ agentId, provider, home }: ProjectionInput): Promise<void> {
    if (provider === "hermes") return;
    await mkdir(home, { recursive: true });
    const extensions = await this.manager.enabledWithContentFingerprints(agentId);
    if (provider === "codex") await projectCodex(home,
      resolve(this.dataDir, "agents", String(agentId), "provider-home", "codex"), extensions);
    else await projectClaude(home, extensions);
  }
}
