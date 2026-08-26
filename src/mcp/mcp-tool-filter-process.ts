import { pathToFileURL } from "node:url";

import {
  Client,
  StreamableHTTPClientTransport,
  type RequestOptions,
  type ServerCapabilities,
  type Transport as ClientTransport
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { INVALID_PARAMS, ProtocolError, Server, type Transport as ServerTransport } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import {
  filterListedTools,
  MCP_FILTER_CONFIG_ENV,
  requireAllowedTool,
  type McpToolFilterConfig
} from "./mcp-tool-filter.js";
import { ManagedStdioClientTransport } from "./managed-stdio-client-transport.js";

type ForwardingMcpClient = Pick<Client, "listTools" | "callTool"> & Partial<Pick<Client,
  | "getServerCapabilities"
  | "getInstructions"
  | "listResources"
  | "listResourceTemplates"
  | "readResource"
  | "subscribeResource"
  | "unsubscribeResource"
  | "listPrompts"
  | "getPrompt"
  | "complete"
  | "setLoggingLevel"
  | "setNotificationHandler"
>>;

// The downstream MCP client owns the request deadline. This upper bound only
// satisfies the SDK's required timer while the propagated signal handles the
// normal timeout and cancellation path.
const FORWARDED_REQUEST_TIMEOUT_MS = 0x7fffffff;

const requestOptions = (signal: AbortSignal): RequestOptions => ({
  signal,
  timeout: FORWARDED_REQUEST_TIMEOUT_MS
});

const forwardedCapabilities = (client: ForwardingMcpClient): ServerCapabilities => {
  const upstream = client.getServerCapabilities?.();
  return {
    tools: upstream?.tools ?? {},
    ...(upstream?.resources === undefined ? {} : { resources: upstream.resources }),
    ...(upstream?.prompts === undefined ? {} : { prompts: upstream.prompts }),
    ...(upstream?.completions === undefined ? {} : { completions: upstream.completions }),
    ...(upstream?.logging === undefined ? {} : { logging: upstream.logging })
  };
};

const upstreamTransport = (config: McpToolFilterConfig): ClientTransport => {
  const server = config.upstream;
  if (server.type === "http") {
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) }
    });
  }
  return new ManagedStdioClientTransport({
    command: server.command,
    args: server.args,
    env: {
      ...getDefaultEnvironment(),
      ...Object.fromEntries(server.env.map(({ name, value }) => [name, value]))
    },
    stderr: "inherit"
  });
};

export const createMcpToolFilterServer = (
  name: string,
  toolNames: string[],
  client: ForwardingMcpClient
): Server => {
  const allowedTools = new Set(toolNames);
  const capabilities = forwardedCapabilities(client);
  const server = new Server(
    { name, version: "1.0.0" },
    { capabilities, instructions: client.getInstructions?.() }
  );
  server.setRequestHandler("tools/list", async (request, context) =>
    filterListedTools(await client.listTools(request.params, {
      ...requestOptions(context.mcpReq.signal),
      cacheMode: "bypass"
    }), allowedTools));
  server.setRequestHandler("tools/call", async (request, context) => {
    try {
      requireAllowedTool(request.params.name, allowedTools);
    } catch (error) {
      throw new ProtocolError(INVALID_PARAMS, error instanceof Error ? error.message : "MCP tool is not allowed");
    }
    return client.callTool(request.params, requestOptions(context.mcpReq.signal));
  });

  if (capabilities.resources !== undefined) {
    server.setRequestHandler("resources/list", async (request, context) =>
      client.listResources!(request.params, {
        ...requestOptions(context.mcpReq.signal),
        cacheMode: "bypass"
      }));
    server.setRequestHandler("resources/templates/list", async (request, context) =>
      client.listResourceTemplates!(request.params, {
        ...requestOptions(context.mcpReq.signal),
        cacheMode: "bypass"
      }));
    server.setRequestHandler("resources/read", async (request, context) =>
      client.readResource!(request.params, {
        ...requestOptions(context.mcpReq.signal),
        cacheMode: "bypass"
      }));
    if (capabilities.resources.subscribe === true) {
      server.setRequestHandler("resources/subscribe", async (request, context) =>
        client.subscribeResource!(request.params, requestOptions(context.mcpReq.signal)));
      server.setRequestHandler("resources/unsubscribe", async (request, context) =>
        client.unsubscribeResource!(request.params, requestOptions(context.mcpReq.signal)));
    }
  }
  if (capabilities.prompts !== undefined) {
    server.setRequestHandler("prompts/list", async (request, context) =>
      client.listPrompts!(request.params, {
        ...requestOptions(context.mcpReq.signal),
        cacheMode: "bypass"
      }));
    server.setRequestHandler("prompts/get", async (request, context) =>
      client.getPrompt!(request.params, requestOptions(context.mcpReq.signal)));
  }
  if (capabilities.completions !== undefined) {
    server.setRequestHandler("completion/complete", async (request, context) =>
      client.complete!(request.params, requestOptions(context.mcpReq.signal)));
  }
  if (capabilities.logging !== undefined) {
    server.setRequestHandler("logging/setLevel", async (request, context) =>
      client.setLoggingLevel!(request.params.level, requestOptions(context.mcpReq.signal)));
  }
  if (client.setNotificationHandler !== undefined) {
    if (capabilities.tools?.listChanged === true) {
      client.setNotificationHandler("notifications/tools/list_changed", async (notification) =>
        server.notification(notification));
    }
    if (capabilities.resources?.listChanged === true) {
      client.setNotificationHandler("notifications/resources/list_changed", async (notification) =>
        server.notification(notification));
    }
    if (capabilities.resources?.subscribe === true) {
      client.setNotificationHandler("notifications/resources/updated", async (notification) =>
        server.notification(notification));
    }
    if (capabilities.prompts?.listChanged === true) {
      client.setNotificationHandler("notifications/prompts/list_changed", async (notification) =>
        server.notification(notification));
    }
    if (capabilities.logging !== undefined) {
      client.setNotificationHandler("notifications/message", async (notification) =>
        server.notification(notification));
    }
  }
  return server;
};

export const runMcpToolFilter = async (config: McpToolFilterConfig): Promise<void> => {
  const client = new Client({ name: "remote-agent-mcp-filter", version: "1.0.0" });
  await client.connect(upstreamTransport(config));
  const server = createMcpToolFilterServer(config.upstream.name, config.allowedTools, client);
  const downstream = new StdioServerTransport() as ServerTransport;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= Promise.resolve().then(async () => {
      process.stdin.off("end", requestShutdown);
      process.stdin.off("close", requestShutdown);
      process.off("SIGINT", requestShutdown);
      process.off("SIGTERM", requestShutdown);
      const results = await Promise.allSettled([server.close(), client.close()]);
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(({ reason }) => reason);
      if (errors.length > 0) throw new AggregateError(errors, "Failed to close MCP tool filter");
    });
    return shutdownPromise;
  };
  const requestShutdown = (): void => {
    void shutdown().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  };
  process.stdin.once("end", requestShutdown);
  process.stdin.once("close", requestShutdown);
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  server.onclose = requestShutdown;
  server.onerror = (error) => { console.error(error.message); };
  await server.connect(downstream);
};

const rawConfig = process.env[MCP_FILTER_CONFIG_ENV];
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (rawConfig === undefined) throw new Error("Missing MCP tool filter configuration");
  await runMcpToolFilter(JSON.parse(rawConfig) as McpToolFilterConfig);
}
