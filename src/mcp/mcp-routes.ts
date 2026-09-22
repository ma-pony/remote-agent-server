import { randomUUID } from "node:crypto";
import { isPagedQuery, paginationQuerySchema, pageResult } from "../pagination.js";
import type { McpToolSummary } from "./mcp-types.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { McpChecker } from "./mcp-checker.js";
import { McpManager, McpManagerError } from "./mcp-manager.js";
import { ProviderMcpCatalog, ProviderMcpCatalogError } from "../provider-extensions/provider-mcp-catalog.js";

const fixedSchema = z.object({
  id: z.number().int().positive().optional(), source: z.literal("fixed"), value: z.string().optional(), secret: z.boolean().optional()
}).strict();
const sessionSchema = z.object({
  id: z.number().int().positive().optional(), source: z.literal("session_parameter"), parameterKey: z.string().min(1)
}).strict();
const runtimeSchema = z.object({
  id: z.number().int().positive().optional(), source: z.literal("runtime"),
  runtimeKey: z.enum(["agent_id", "session_id", "run_id", "workspace_path", "browser_profile_path"])
}).strict();
const valueSchema = z.discriminatedUnion("source", [fixedSchema, sessionSchema, runtimeSchema]);
const namedValueSchema = z.discriminatedUnion("source", [
  fixedSchema.extend({ name: z.string().min(1) }),
  sessionSchema.extend({ name: z.string().min(1) }),
  runtimeSchema.extend({ name: z.string().min(1) })
]);
const base = {
  name: z.string().min(1), enabled: z.boolean(), checkTimeoutSeconds: z.number().int().min(1).max(300)
};
const serverSchema = z.discriminatedUnion("transport", [
  z.object({ ...base, transport: z.literal("http"), url: z.string().min(1), headers: z.array(namedValueSchema) }).strict(),
  z.object({
    ...base, transport: z.literal("stdio"), command: z.string().min(1),
    arguments: z.array(valueSchema), environment: z.array(namedValueSchema)
  }).strict()
]);
const createParameterSchema = z.object({
  key: z.string().min(1), label: z.string().min(1), description: z.string().nullable(),
  required: z.boolean(), secret: z.boolean()
}).strict();
const updateParameterSchema = z.object({
  label: z.string().min(1), description: z.string().nullable(), required: z.boolean()
}).strict();
const checkSchema = z.object({ sessionId: z.number().int().positive().optional() }).strict().optional();
const enabledSchema = z.object({ enabled: z.boolean() }).strict();
const allowedToolsSchema = z.object({
  allowedTools: z.array(z.string().min(1)).nullable()
}).strict();
const deleteScopeSchema = z.object({ scope: z.enum(["current", "all"]).default("current") }).strict();
const parseId = (value: string): number | undefined => {
  const parsed = z.coerce.number().int().positive().safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const invalidRequest = (reply: FastifyReply, message: string) =>
  reply.code(400).send({ error: { code: "invalid_request", message } });
const notFound = (reply: FastifyReply, message: string) =>
  reply.code(404).send({ error: { code: "not_found", message } });

const handleMcpError = (reply: FastifyReply, error: unknown) => {
  if (!(error instanceof McpManagerError)) throw error;
  if (error.code === "agent_not_found") return notFound(reply, "Agent not found");
  if (error.code === "mcp_server_not_found") return notFound(reply, "MCP server not found");
  if (error.code === "mcp_parameter_not_found") return notFound(reply, "Session parameter not found");
  if (["duplicate_mcp_name", "duplicate_mcp_parameter", "mcp_parameter_in_use"].includes(error.code)) {
    return reply.code(409).send({
      error: {
        code: error.code,
        message: error.code === "mcp_parameter_in_use"
          ? "Session parameter is used by an MCP or Session"
          : "A value with the same name already exists"
      }
    });
  }
  return reply.code(400).send({ error: { code: error.code, message: "Invalid MCP configuration" } });
};

export type McpRouteDependencies = {
  mcpManager: McpManager;
  mcpChecker: McpChecker;
  providerMcpCatalog: ProviderMcpCatalog;
};

/** Registers Agent MCP and Agent Session parameter routes. */
export const registerMcpRoutes = (
  app: FastifyInstance,
  { mcpManager, mcpChecker, providerMcpCatalog }: McpRouteDependencies
): void => {
  const toolSnapshots = new Map<string, { agentId: number; serverId: number; expires: number; tools: McpToolSummary[] }>();
  const toolsPage = (tools: McpToolSummary[], pagination: ReturnType<typeof paginationQuerySchema.parse>) => {
    const query = pagination.query?.toLowerCase() ?? "";
    const filtered = tools.filter((tool) => `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(query));
    return pageResult(filtered.slice((pagination.page - 1) * pagination.pageSize, pagination.page * pagination.pageSize), filtered.length, pagination);
  };
  app.get<{ Params: { agentId: string } }>("/agents/:agentId/mcp-servers", (request, reply) => {
    const agentId = parseId(request.params.agentId);
    if (agentId === undefined) return notFound(reply, "Agent not found");
    const pagination = paginationQuerySchema.safeParse(request.query);
    if (!pagination.success) return invalidRequest(reply, "Invalid pagination");
    try { return isPagedQuery(request.query) ? mcpManager.listServersPage(agentId, pagination.data) : mcpManager.listServers(agentId); } catch (error) { return handleMcpError(reply, error); }
  });
  app.post<{ Params: { agentId: string } }>("/agents/:agentId/mcp-servers", (request, reply) => {
    const parsed = serverSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, "Invalid MCP server input");
    const agentId = parseId(request.params.agentId);
    if (agentId === undefined) return notFound(reply, "Agent not found");
    try { return reply.code(201).send(mcpManager.createServer(agentId, parsed.data)); }
    catch (error) { return handleMcpError(reply, error); }
  });
  app.get<{ Params: { agentId: string } }>("/agents/:agentId/mcp-catalog", (request, reply) => {
    const agentId = parseId(request.params.agentId);
    if (agentId === undefined) return notFound(reply, "Agent not found");
    const pagination = paginationQuerySchema.safeParse(request.query);
    if (!pagination.success) return invalidRequest(reply, "Invalid pagination");
    try { return isPagedQuery(request.query) ? mcpManager.listCatalogPage(agentId, pagination.data) : mcpManager.listCatalog(agentId); }
    catch (error) { return handleMcpError(reply, error); }
  });
  app.post<{ Params: { agentId: string; sourceId: string } }>(
    "/agents/:agentId/mcp-catalog/:sourceId/install",
    (request, reply) => {
      try {
        const agentId = parseId(request.params.agentId);
        const sourceId = parseId(request.params.sourceId);
        if (agentId === undefined || sourceId === undefined) return notFound(reply, "MCP server not found");
        const server = mcpManager.installFromCatalog(agentId, sourceId);
        return server === undefined ? notFound(reply, "MCP server not found") : reply.code(201).send(server);
      } catch (error) { return handleMcpError(reply, error); }
    }
  );
  app.get<{ Params: { agentId: string } }>("/agents/:agentId/system-mcp-catalog", (request, reply) => {
    const agentId = parseId(request.params.agentId);
    if (agentId === undefined) return notFound(reply, "Agent not found");
    const pagination = paginationQuerySchema.safeParse(request.query);
    if (!pagination.success) return invalidRequest(reply, "Invalid pagination");
    try {
      const items = providerMcpCatalog.list(agentId);
      if (!isPagedQuery(request.query)) return items;
      const filtered = items.filter((item) => item.name.toLowerCase().includes(pagination.data.query?.toLowerCase() ?? ""));
      return pageResult(filtered.slice((pagination.data.page - 1) * pagination.data.pageSize, pagination.data.page * pagination.data.pageSize), filtered.length, pagination.data);
    }
    catch (error) {
      if (error instanceof ProviderMcpCatalogError) return notFound(reply, "Agent not found");
      throw error;
    }
  });
  app.post<{ Params: { agentId: string; sourceId: string } }>(
    "/agents/:agentId/system-mcp-catalog/:sourceId/install",
    (request, reply) => {
      const agentId = parseId(request.params.agentId);
      if (agentId === undefined) return notFound(reply, "MCP server not found");
      try {
        const server = providerMcpCatalog.install(agentId, request.params.sourceId);
        return server === undefined ? notFound(reply, "MCP server not found") : reply.code(201).send(server);
      } catch (error) {
        if (error instanceof ProviderMcpCatalogError) return notFound(reply, "Agent not found");
        return handleMcpError(reply, error);
      }
    }
  );
  app.get<{ Params: { agentId: string; id: string } }>("/agents/:agentId/mcp-servers/:id", (request, reply) => {
    const agentId = parseId(request.params.agentId);
    const id = parseId(request.params.id);
    const server = agentId === undefined || id === undefined ? undefined : mcpManager.getServer(agentId, id);
    return server === undefined ? notFound(reply, "MCP server not found") : server;
  });
  app.patch<{ Params: { agentId: string; id: string } }>("/agents/:agentId/mcp-servers/:id", (request, reply) => {
    const parsed = serverSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, "Invalid MCP server update");
    try {
      const agentId = parseId(request.params.agentId);
      const id = parseId(request.params.id);
      if (agentId === undefined || id === undefined) return notFound(reply, "MCP server not found");
      const server = mcpManager.updateServer(agentId, id, parsed.data);
      return server === undefined ? notFound(reply, "MCP server not found") : server;
    } catch (error) { return handleMcpError(reply, error); }
  });
  app.patch<{ Params: { agentId: string; id: string } }>(
    "/agents/:agentId/mcp-servers/:id/enabled",
    (request, reply) => {
      const parsed = enabledSchema.safeParse(request.body);
      if (!parsed.success) return invalidRequest(reply, "Invalid MCP enabled state");
      const agentId = parseId(request.params.agentId);
      const id = parseId(request.params.id);
      const server = agentId === undefined || id === undefined
        ? undefined
        : mcpManager.setServerEnabled(agentId, id, parsed.data.enabled);
      return server === undefined ? notFound(reply, "MCP server not found") : server;
    }
  );
  app.patch<{ Params: { agentId: string; id: string } }>(
    "/agents/:agentId/mcp-servers/:id/tools",
    (request, reply) => {
      const parsed = allowedToolsSchema.safeParse(request.body);
      if (!parsed.success) return invalidRequest(reply, "Invalid MCP tool access");
      try {
        const agentId = parseId(request.params.agentId);
        const id = parseId(request.params.id);
        const server = agentId === undefined || id === undefined
          ? undefined
          : mcpManager.setAllowedTools(agentId, id, parsed.data.allowedTools);
        return server === undefined ? notFound(reply, "MCP server not found") : server;
      } catch (error) { return handleMcpError(reply, error); }
    }
  );
  app.delete<{ Params: { agentId: string; id: string }; Querystring: { scope?: string } }>("/agents/:agentId/mcp-servers/:id", (request, reply) => {
    const parsed = deleteScopeSchema.safeParse(request.query);
    if (!parsed.success) return invalidRequest(reply, "Invalid MCP delete scope");
    const agentId = parseId(request.params.agentId);
    const id = parseId(request.params.id);
    return agentId !== undefined && id !== undefined && mcpManager.deleteServer(agentId, id, parsed.data.scope)
      ? reply.code(204).send()
      : notFound(reply, "MCP server not found");
  });
  app.post<{ Params: { agentId: string; id: string } }>(
    "/agents/:agentId/mcp-servers/:id/check",
    async (request, reply) => {
      const pagination = paginationQuerySchema.safeParse(request.query);
      if (!pagination.success) return invalidRequest(reply, "Invalid pagination");
      const parsed = checkSchema.safeParse(request.body);
      if (!parsed.success) return invalidRequest(reply, "Invalid MCP check input");
      try {
        const agentId = parseId(request.params.agentId);
        const id = parseId(request.params.id);
        if (agentId === undefined || id === undefined) return notFound(reply, "MCP server not found");
        const resolved = mcpManager.resolveOneForCheck(agentId, id, parsed.data?.sessionId);
        if (resolved === undefined) return notFound(reply, "MCP server not found");
        const result = await mcpChecker.check(resolved.server, resolved.checkTimeoutMs);
        mcpManager.recordCheckResult(resolved.id, result);
        if (!isPagedQuery(request.query) || result.status !== "passed") return result;
        for (const [key, snapshot] of toolSnapshots) if (snapshot.expires <= Date.now()) toolSnapshots.delete(key);
        while (toolSnapshots.size >= 20) toolSnapshots.delete(toolSnapshots.keys().next().value!);
        const snapshotId = randomUUID();
        toolSnapshots.set(snapshotId, { agentId, serverId: id, expires: Date.now() + 10 * 60_000, tools: result.tools ?? [] });
        return { ...result, snapshotId, tools: toolsPage(result.tools ?? [], pagination.data) };
      } catch (error) { return handleMcpError(reply, error); }
    }
  );

  app.get<{ Params: { agentId: string; id: string } }>("/agents/:agentId/mcp-servers/:id/tools", (request, reply) => {
    const pagination = paginationQuerySchema.extend({ snapshotId: z.string().min(1) }).safeParse(request.query);
    if (!pagination.success) return invalidRequest(reply, "Invalid tool snapshot pagination");
    const agentId = parseId(request.params.agentId);
    const serverId = parseId(request.params.id);
    const snapshot = toolSnapshots.get(pagination.data.snapshotId);
    if (snapshot === undefined || snapshot.expires <= Date.now() || snapshot.agentId !== agentId || snapshot.serverId !== serverId
      || mcpManager.getServer(agentId!, serverId!) === undefined) return notFound(reply, "Tool snapshot expired; check MCP again");
    return toolsPage(snapshot.tools, pagination.data);
  });

  app.get<{ Params: { agentId: string } }>("/agents/:agentId/session-parameters", (request, reply) => {
    const agentId = parseId(request.params.agentId);
    if (agentId === undefined) return notFound(reply, "Agent not found");
    const pagination = paginationQuerySchema.safeParse(request.query);
    if (!pagination.success) return invalidRequest(reply, "Invalid pagination");
    try { return isPagedQuery(request.query) ? mcpManager.listParameterDefinitionsPage(agentId, pagination.data) : mcpManager.listParameterDefinitions(agentId); }
    catch (error) { return handleMcpError(reply, error); }
  });
  app.post<{ Params: { agentId: string } }>("/agents/:agentId/session-parameters", (request, reply) => {
    const parsed = createParameterSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, "Invalid Session parameter input");
    const agentId = parseId(request.params.agentId);
    if (agentId === undefined) return notFound(reply, "Agent not found");
    try { return reply.code(201).send(mcpManager.createParameterDefinition(agentId, parsed.data)); }
    catch (error) { return handleMcpError(reply, error); }
  });
  app.patch<{ Params: { agentId: string; id: string } }>("/agents/:agentId/session-parameters/:id", (request, reply) => {
    const parsed = updateParameterSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, "Invalid Session parameter update");
    try {
      const agentId = parseId(request.params.agentId);
      const id = parseId(request.params.id);
      if (agentId === undefined || id === undefined) return notFound(reply, "Session parameter not found");
      const parameter = mcpManager.updateParameterDefinition(agentId, id, parsed.data);
      return parameter === undefined ? notFound(reply, "Session parameter not found") : parameter;
    } catch (error) { return handleMcpError(reply, error); }
  });
  app.delete<{ Params: { agentId: string; id: string } }>("/agents/:agentId/session-parameters/:id", (request, reply) => {
    try {
      const agentId = parseId(request.params.agentId);
      const id = parseId(request.params.id);
      return agentId !== undefined && id !== undefined && mcpManager.deleteParameterDefinition(agentId, id)
        ? reply.code(204).send()
        : notFound(reply, "Session parameter not found");
    } catch (error) { return handleMcpError(reply, error); }
  });
};
