import { Client, StreamableHTTPClientTransport, type Transport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import type { McpCheckResult, RuntimeMcpServer } from "./mcp-types.js";

type ProbeClient = {
  connect(transport: unknown, options: { timeout: number }): Promise<void>;
  listTools(
    params: undefined,
    options: { timeout: number; cacheMode: "bypass" }
  ): Promise<{ tools: Array<{ name: string; description?: string }> }>;
  close(): Promise<void>;
};

type McpCheckerDependencies = {
  createClient: () => ProbeClient;
  createTransport: (server: RuntimeMcpServer) => unknown;
};

const createSdkClient = (): ProbeClient => {
  const client = new Client({ name: "remote-agent-server", version: "1.0.0" });
  return {
    connect: (transport, options) => client.connect(transport as Transport, options),
    listTools: (params, options) => client.listTools(params, options),
    close: () => client.close()
  };
};

const createSdkTransport = (server: RuntimeMcpServer): Transport => {
  if (server.type === "http") {
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) }
    });
  }
  return new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: {
      ...getDefaultEnvironment(),
      ...Object.fromEntries(server.env.map(({ name, value }) => [name, value]))
    },
    stderr: "pipe"
  });
};

export type McpChecker = {
  check(server: RuntimeMcpServer, timeoutMs: number): Promise<McpCheckResult>;
};

/** Probes an MCP server with the official SDK and returns a redacted result. */
export class SdkMcpChecker implements McpChecker {
  private readonly dependencies: McpCheckerDependencies;

  constructor(dependencies: Partial<McpCheckerDependencies> = {}) {
    this.dependencies = {
      createClient: dependencies.createClient ?? createSdkClient,
      createTransport: dependencies.createTransport ?? createSdkTransport
    };
  }

  async check(server: RuntimeMcpServer, timeoutMs: number): Promise<McpCheckResult> {
    const client = this.dependencies.createClient();
    try {
      const transport = this.dependencies.createTransport(server);
      await client.connect(transport, { timeout: timeoutMs });
      const { tools } = await client.listTools(undefined, { timeout: timeoutMs, cacheMode: "bypass" });
      return {
        status: "passed",
        toolCount: tools.length,
        message: `${tools.length} tools available`,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description?.trim() ? tool.description : null
        }))
      };
    } catch (_error) {
      return { status: "failed", code: "mcp_check_failed", message: `MCP ${server.name} check failed` };
    } finally {
      try {
        await client.close();
      } catch (_error) {
        // The probe result remains authoritative; close details may contain secrets.
      }
    }
  }
}
