import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type Database from "better-sqlite3";

import type { Provider } from "../domain.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { AgentMcpServerDetail, McpNamedValueInput, McpServerWriteInput } from "../mcp/mcp-types.js";

type SupportedProvider = Extract<Provider, "codex" | "claude_code">;

type DiscoveredMcp = {
  id: string;
  provider: SupportedProvider;
  name: string;
  transport: "http" | "stdio";
  input: McpServerWriteInput;
};

export type ProviderMcpCatalogItem = Omit<DiscoveredMcp, "input"> & { installed: boolean };

type ProviderMcpCatalogOptions = {
  db: Database.Database;
  mcpManager: McpManager;
  codexHome?: string;
  claudeHome?: string;
  claudeGlobalConfigPath?: string;
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const parseValue = (raw: string): unknown => {
  const value = raw.trim();
  if (value.startsWith('"') || value.startsWith("[") || value === "true" || value === "false" || /^-?\d/.test(value)) {
    try { return JSON.parse(value); } catch { return value; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
};

const fixed = (value: string, secret = false): { source: "fixed"; value: string; secret: boolean } => ({
  source: "fixed",
  value,
  secret
});

const namedValues = (value: unknown, forceSecret = false): McpNamedValueInput[] =>
  Object.entries(object(value) ?? {}).flatMap(([name, raw]) => typeof raw === "string"
    ? [{ name, ...fixed(raw, forceSecret) }]
    : []);

const toInput = (name: string, value: unknown): McpServerWriteInput | undefined => {
  const server = object(value);
  if (server === undefined) return undefined;
  const url = typeof server.url === "string" ? server.url : undefined;
  if (url !== undefined) {
    return {
      name,
      transport: "http",
      enabled: true,
      url,
      headers: namedValues(server.headers ?? server.http_headers, true),
      checkTimeoutSeconds: 30
    };
  }
  if (typeof server.command !== "string" || server.command.trim() === "") return undefined;
  return {
    name,
    transport: "stdio",
    enabled: true,
    command: server.command,
    arguments: Array.isArray(server.args)
      ? server.args.filter((entry): entry is string => typeof entry === "string").map((entry) => fixed(entry))
      : [],
    environment: namedValues(server.env, true),
    checkTimeoutSeconds: 30
  };
};

const codexServers = (path: string): Array<{ name: string; input: McpServerWriteInput }> => {
  let content = "";
  try { content = readFileSync(path, "utf8"); } catch { return []; }
  const servers = new Map<string, Record<string, unknown>>();
  let target: Record<string, unknown> | undefined;
  for (const line of content.split(/\r?\n/)) {
    const header = line.match(/^\s*\[mcp_servers\.(?:"([^"]+)"|([^\.\]]+))(?:\.([^\]]+))?\]\s*$/);
    if (header !== null) {
      const name = header[1] ?? header[2]!;
      const server = servers.get(name) ?? {};
      servers.set(name, server);
      const subsection = header[3];
      if (subsection === undefined) target = server;
      else {
        const key = subsection.replaceAll('"', "");
        target = object(server[key]) ?? {};
        server[key] = target;
      }
      continue;
    }
    if (/^\s*\[/.test(line)) {
      target = undefined;
      continue;
    }
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (target !== undefined && assignment !== null) target[assignment[1]!] = parseValue(assignment[2]!);
  }
  return [...servers.entries()].flatMap(([name, value]) => {
    const input = toInput(name, value);
    return input === undefined ? [] : [{ name, input }];
  });
};

const claudeServers = (path: string): Array<{ name: string; input: McpServerWriteInput }> => {
  try {
    const config = object(JSON.parse(readFileSync(path, "utf8")));
    return Object.entries(object(config?.mcpServers) ?? {}).flatMap(([name, value]) => {
      const input = toInput(name, value);
      return input === undefined ? [] : [{ name, input }];
    });
  } catch {
    return [];
  }
};

const sourceId = (provider: SupportedProvider, name: string, input: McpServerWriteInput): string => createHash("sha256")
  .update(JSON.stringify({ provider, name, input }))
  .digest("hex")
  .slice(0, 24);

/** Discovers provider-global MCP configurations and imports them through the normal Agent MCP model. */
export class ProviderMcpCatalog {
  private readonly codexHome: string;
  private readonly claudeGlobalConfigPath: string;

  constructor(private readonly options: ProviderMcpCatalogOptions) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const claudeHome = options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    this.claudeGlobalConfigPath = options.claudeGlobalConfigPath
      ?? process.env.CLAUDE_GLOBAL_CONFIG_PATH
      ?? `${claudeHome}.json`;
  }

  list(agentId: number): ProviderMcpCatalogItem[] {
    const provider = this.agentProvider(agentId);
    if (provider === "hermes") return [];
    const installedNames = new Set((this.options.db.prepare(
      "SELECT name FROM agent_mcp_servers WHERE agent_id = ?"
    ).all(agentId) as Array<{ name: string }>).map(({ name }) => name));
    return this.discover(provider).map(({ input: _input, ...item }) => ({
      ...item,
      installed: installedNames.has(item.name)
    }));
  }

  install(agentId: number, id: string): AgentMcpServerDetail | undefined {
    const provider = this.agentProvider(agentId);
    if (provider === "hermes") return undefined;
    const source = this.discover(provider).find((item) => item.id === id);
    return source === undefined ? undefined : this.options.mcpManager.createServer(agentId, source.input);
  }

  private discover(provider: SupportedProvider): DiscoveredMcp[] {
    const entries = provider === "codex"
      ? codexServers(join(this.codexHome, "config.toml"))
      : claudeServers(this.claudeGlobalConfigPath);
    return entries.map(({ name, input }) => ({
      id: sourceId(provider, name, input),
      provider,
      name,
      transport: input.transport,
      input
    }));
  }

  private agentProvider(agentId: number): Provider {
    const row = this.options.db.prepare("SELECT provider FROM agents WHERE id = ?").get(agentId) as
      | { provider: Provider }
      | undefined;
    if (row === undefined) throw new ProviderMcpCatalogError("agent_not_found");
    return row.provider;
  }
}

export class ProviderMcpCatalogError extends Error {
  constructor(readonly code: "agent_not_found") {
    super(code);
  }
}
