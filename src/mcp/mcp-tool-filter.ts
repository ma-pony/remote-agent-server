import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type { RuntimeMcpServer } from "./mcp-types.js";

export const MCP_FILTER_CONFIG_ENV = "REMOTE_AGENT_MCP_FILTER_CONFIG";

export type McpToolFilterConfig = {
  upstream: RuntimeMcpServer;
  allowedTools: string[];
};

export const filterListedTools = <T extends { tools: Array<{ name: string }> }>(
  result: T,
  allowedTools: ReadonlySet<string>
): T => ({ ...result, tools: result.tools.filter((tool) => allowedTools.has(tool.name)) });

export const requireAllowedTool = (name: string, allowedTools: ReadonlySet<string>): void => {
  if (!allowedTools.has(name)) throw new Error(`MCP tool "${name}" is not allowed`);
};

const processEntry = (): { command: string; args: string[] } => {
  const sourceMode = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(`./mcp-tool-filter-process.${sourceMode ? "ts" : "js"}`, import.meta.url));
  return {
    command: process.execPath,
    args: sourceMode ? ["--import", createRequire(import.meta.url).resolve("tsx"), entry] : [entry]
  };
};

export const wrapMcpServerWithToolFilter = (
  upstream: RuntimeMcpServer,
  allowedTools: string[],
  startupTimeoutSeconds: number
): RuntimeMcpServer => {
  const entry = processEntry();
  const config: McpToolFilterConfig = { upstream, allowedTools };
  return {
    type: "stdio",
    name: upstream.name,
    command: entry.command,
    args: entry.args,
    env: [{ name: MCP_FILTER_CONFIG_ENV, value: JSON.stringify(config) }],
    startupTimeoutSeconds
  };
};
