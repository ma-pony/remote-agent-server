import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type Database from "better-sqlite3";

import type { Provider } from "../domain.js";

export type ProviderExtensionKind = "plugin" | "hook";

export type ProviderExtensionCatalogItem = {
  id: string;
  provider: Extract<Provider, "codex" | "claude_code">;
  kind: ProviderExtensionKind;
  name: string;
  description: string;
  version: string | null;
  enabled: boolean;
  available: boolean;
};

export type DiscoveredProviderExtension = Omit<ProviderExtensionCatalogItem, "enabled"> & {
  sourceFingerprint: string;
  sourcePath: string | null;
  configuration: unknown;
};

type ExtensionRow = {
  agent_id: number;
  provider: "codex" | "claude_code";
  kind: ProviderExtensionKind;
  extension_id: string;
  name: string;
  description: string;
  source_fingerprint: string;
};

type ProviderExtensionManagerOptions = {
  db: Database.Database;
  codexHome?: string;
  claudeHome?: string;
  cacheTtlMs?: number;
};

const fingerprint = (value: unknown): string => createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex");

const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

const pluginParts = (id: string): { name: string; marketplace: string } | undefined => {
  const separator = id.lastIndexOf("@");
  if (separator <= 0 || separator === id.length - 1) return undefined;
  return { name: id.slice(0, separator), marketplace: id.slice(separator + 1) };
};

const latestPluginDirectory = (home: string, id: string): string | undefined => {
  const parts = pluginParts(id);
  if (parts === undefined) return undefined;
  const root = join(home, "plugins", "cache", parts.marketplace, parts.name);
  if (!existsSync(root)) return undefined;
  const versions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  return versions[0] === undefined ? undefined : join(root, versions[0]);
};

const pluginManifest = (
  directory: string,
  provider: "codex" | "claude_code",
  fallbackName: string,
  fallbackVersion: string
): { name: string; description: string; version: string | null } => {
  const manifestPath = join(directory, provider === "codex" ? ".codex-plugin" : ".claude-plugin", "plugin.json");
  const fallback = { name: fallbackName, description: "", version: fallbackVersion };
  if (!existsSync(manifestPath)) return fallback;
  try {
    const value = object(json(manifestPath));
    return {
      name: string(value?.name) ?? fallback.name,
      description: string(value?.description) ?? "",
      version: string(value?.version) ?? null
    };
  } catch {
    return fallback;
  }
};

const hooks = (
  provider: "codex" | "claude_code",
  value: unknown
): DiscoveredProviderExtension[] => {
  const result: DiscoveredProviderExtension[] = [];
  for (const [event, groupsValue] of Object.entries(object(value) ?? {})) {
    if (!Array.isArray(groupsValue)) continue;
    groupsValue.forEach((groupValue, groupIndex) => {
      const group = object(groupValue);
      if (!Array.isArray(group?.hooks)) return;
      group.hooks.forEach((hookValue, hookIndex) => {
        const hook = object(hookValue);
        if (hook === undefined) return;
        const configuration = {
          event,
          ...(typeof group.matcher === "string" ? { matcher: group.matcher } : {}),
          hook
        };
        const sourceFingerprint = fingerprint(configuration);
        result.push({
          id: `hook:${sourceFingerprint.slice(0, 20)}`,
          provider,
          kind: "hook",
          name: `${event} #${groupIndex + hookIndex + 1}`,
          description: `${string(hook.type) ?? "command"} hook`,
          version: null,
          available: true,
          sourceFingerprint,
          sourcePath: null,
          configuration
        });
      });
    });
  }
  return result;
};

const codexPluginIds = (config: string): string[] => {
  const ids = new Set<string>();
  for (const match of config.matchAll(/^\s*\[plugins\."([^"]+)"\]\s*$/gm)) ids.add(match[1]!);
  return [...ids];
};

const discoverPlugins = (
  provider: "codex" | "claude_code",
  home: string,
  ids: Iterable<string>
): DiscoveredProviderExtension[] => [...new Set(ids)].flatMap((id) => {
  const parts = pluginParts(id);
  if (parts === undefined) return [];
  const directory = latestPluginDirectory(home, id);
  if (directory === undefined) return [];
  const manifest = pluginManifest(directory, provider, parts.name, basename(directory));
  const sourceFingerprint = fingerprint({ id, directory, manifest });
  return [{
    id: `plugin:${id}`,
    provider,
    kind: "plugin" as const,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    available: true,
    sourceFingerprint,
    sourcePath: directory,
    configuration: { pluginId: id }
  }];
});

const discoverCodex = (home: string): DiscoveredProviderExtension[] => {
  let config = "";
  try {
    config = readFileSync(join(home, "config.toml"), "utf8");
  } catch {
    // An empty Codex home has no extensions.
  }
  let hookConfig: unknown = {};
  try {
    hookConfig = object(json(join(home, "hooks.json")))?.hooks ?? {};
  } catch {
    // An invalid host hook file is not exposed to Agents.
  }
  return [...discoverPlugins("codex", home, codexPluginIds(config)), ...hooks("codex", hookConfig)];
};

const discoverClaude = (home: string): DiscoveredProviderExtension[] => {
  let settings: Record<string, unknown> = {};
  try {
    settings = object(json(join(home, "settings.json"))) ?? {};
  } catch {
    // An invalid host settings file is not exposed to Agents.
  }
  const ids = new Set(Object.keys(object(settings.enabledPlugins) ?? {}));
  try {
    const installed = object(json(join(home, "plugins", "installed_plugins.json")));
    for (const id of Object.keys(object(installed?.plugins) ?? {})) ids.add(id);
  } catch {
    // The enabled plugin list remains usable without installation metadata.
  }
  return [
    ...discoverPlugins("claude_code", home, ids),
    ...hooks("claude_code", settings.hooks)
  ];
};

/** Discovers Provider-native extensions and stores each Agent's explicit selections. */
export class ProviderExtensionManager {
  private readonly codexHome: string;
  private readonly claudeHome: string;
  private readonly cacheTtlMs: number;
  private snapshots = new Map<"codex" | "claude_code", { capturedAt: number; items: DiscoveredProviderExtension[] }>();

  constructor(private readonly options: ProviderExtensionManagerOptions) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.claudeHome = options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
  }

  list(agentId: number): ProviderExtensionCatalogItem[] {
    const provider = this.agentProvider(agentId);
    if (provider === "hermes") return [];
    const discovered = this.discover(provider);
    const assignments = this.assignmentRows(agentId);
    const byId = new Map(discovered.map((item) => [item.id, item]));
    const result: ProviderExtensionCatalogItem[] = discovered.map((item) => ({
      id: item.id,
      provider: item.provider,
      kind: item.kind,
      name: item.name,
      description: item.description,
      version: item.version,
      enabled: assignments.has(item.id),
      available: true
    }));
    for (const row of assignments.values()) {
      if (byId.has(row.extension_id)) continue;
      result.push({
        id: row.extension_id,
        provider: row.provider,
        kind: row.kind,
        name: row.name,
        description: row.description,
        version: null,
        enabled: true,
        available: false
      });
    }
    return result.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "plugin" ? -1 : 1;
      return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
    });
  }

  setEnabled(agentId: number, id: string, enabled: boolean): ProviderExtensionCatalogItem | undefined {
    const provider = this.agentProvider(agentId);
    if (provider === "hermes") return undefined;
    const item = this.discover(provider).find((candidate) => candidate.id === id);
    if (enabled) {
      if (item === undefined) return undefined;
      const now = new Date().toISOString();
      this.options.db.prepare(`
        INSERT INTO agent_provider_extensions
          (agent_id, provider, kind, extension_id, name, description, source_fingerprint, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, extension_id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          source_fingerprint = excluded.source_fingerprint,
          updated_at = excluded.updated_at
      `).run(
        agentId,
        provider,
        item.kind,
        item.id,
        item.name,
        item.description,
        item.sourceFingerprint,
        now,
        now
      );
    } else {
      const deleted = this.options.db.prepare(
        "DELETE FROM agent_provider_extensions WHERE agent_id = ? AND extension_id = ?"
      ).run(agentId, id);
      if (deleted.changes === 0 && item === undefined) return undefined;
    }
    return this.list(agentId).find((candidate) => candidate.id === id);
  }

  enabled(agentId: number): DiscoveredProviderExtension[] {
    const provider = this.agentProvider(agentId);
    if (provider === "hermes") return [];
    const selected = this.assignmentRows(agentId);
    return this.discover(provider).filter((item) => selected.has(item.id));
  }

  revision(agentId: number): string {
    return fingerprint(this.enabled(agentId).map(({ id, sourceFingerprint }) => ({ id, sourceFingerprint })));
  }

  private discover(provider: "codex" | "claude_code"): DiscoveredProviderExtension[] {
    const snapshot = this.snapshots.get(provider);
    if (snapshot !== undefined && Date.now() - snapshot.capturedAt < this.cacheTtlMs) return snapshot.items;
    const items = provider === "codex" ? discoverCodex(this.codexHome) : discoverClaude(this.claudeHome);
    this.snapshots.set(provider, { capturedAt: Date.now(), items });
    return items;
  }

  private agentProvider(agentId: number): Provider {
    const row = this.options.db.prepare("SELECT provider FROM agents WHERE id = ?").get(agentId) as
      | { provider: Provider }
      | undefined;
    if (row === undefined) throw new ProviderExtensionManagerError("agent_not_found");
    return row.provider;
  }

  private assignmentRows(agentId: number): Map<string, ExtensionRow> {
    const rows = this.options.db.prepare(
      "SELECT * FROM agent_provider_extensions WHERE agent_id = ? ORDER BY created_at ASC, extension_id ASC"
    ).all(agentId) as ExtensionRow[];
    return new Map(rows.map((row) => [row.extension_id, row]));
  }
}

export class ProviderExtensionManagerError extends Error {
  constructor(readonly code: "agent_not_found") {
    super(code);
  }
}
