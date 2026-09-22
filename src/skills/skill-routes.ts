import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { paginationQuerySchema, isPagedQuery, pageResult } from "../pagination.js";
import type { AgentManager } from "../agents/agent-manager.js";
import { SkillContentError } from "./skill-content.js";
import { SkillManagerError, type SkillManager } from "./skill-manager.js";
import { SkillSourceError, type SkillSourceManager } from "./skill-source-manager.js";

const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().min(1).max(2_000),
  ref: z.string().trim().min(1).max(255).optional(),
  path: z.string().trim().max(1_024).optional()
}).strict();
export const skillUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255).regex(/\.zip$/i),
  contentBase64: z.string().min(1).max(14_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/)
}).strict();

const invalid = (reply: FastifyReply) => reply.code(400).send({ error: { code: "invalid_request", message: "Invalid Skill management input" } });

export const handleSkillError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof SkillManagerError || error instanceof SkillContentError) {
    const messages: Record<string, string> = {
      skill_not_found: "Skill not found", skill_revision_not_found: "Skill revision not found; refresh the preview",
      skill_file_not_found: "File not found in the Skill comparison",
      skill_preview_failed: "File preview failed; retry or check Git availability",
      skill_not_enabled: "Enable the Skill before changing its revision",
      skill_revision_conflict: "The selected version has changed; refresh the preview",
      skill_locally_modified: "The installed Skill has local changes. Preserve them before disabling and enabling the Skill again.",
      skill_name_conflict: "Another Skill uses this name", invalid_skill_archive: "Skill ZIP is invalid or does not match the selected Skill",
      skill_archive_too_large: "Skill ZIP exceeds the upload limit", invalid_skill_content: "Skill package contains unsupported files",
      skill_content_too_large: "Skill package exceeds the content limit"
    };
    const status = error.code === "skill_preview_failed" ? 503 : error.code.endsWith("not_found") ? 404
      : ["skill_revision_conflict", "skill_locally_modified", "skill_not_enabled", "skill_name_conflict"].includes(error.code) ? 409 : 400;
    return reply.code(status).send({ error: { code: error.code, message: messages[error.code] ?? "Skill operation failed" } });
  }
  if (error instanceof SkillSourceError) {
    const status = error.code === "not_found" ? 404 : error.code === "busy" ? 409
      : error.code === "source_closed" ? 503 : error.code === "refresh_failed" ? 502 : 400;
    return reply.code(status).send({ error: {
      code: `skill_source_${error.code}`,
      message: error.code === "busy" ? "A Skill source operation is already running"
        : error.code === "invalid_source" ? "Invalid or duplicate Git source"
          : error.code === "not_found" ? "Skill source not found" : "Skill source refresh failed; check its status and Git access"
    } });
  }
  throw error;
};

/** Authenticated catalog operations and explicit Agent version selection. */
export const registerSkillRoutes = (
  app: FastifyInstance, agents: AgentManager, skills: SkillManager, sources: SkillSourceManager
): void => {
  app.get("/skill-sources", (request, reply) => {
    if (!isPagedQuery(request.query)) return sources.list();
    const parsed = paginationQuerySchema.strict().safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const items = sources.list().filter(item => `${item.name} ${item.url} ${item.path}`.toLowerCase().includes(parsed.data.query?.toLowerCase() ?? ""));
    const offset = (parsed.data.page - 1) * parsed.data.pageSize;
    return pageResult(items.slice(offset, offset + parsed.data.pageSize).map(({warnings, ...item}) => ({...item, warningCount: warnings.length})), items.length, parsed.data);
  });
  app.get<{Params: {id: string}}>("/skill-sources/:id/warnings", (request, reply) => {
    const parsed = paginationQuerySchema.strict().safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const source = sources.list().find(item => item.id === request.params.id);
    if (source === undefined) return reply.code(404).send({error: {code: "not_found", message: "Skill source not found"}});
    const warnings = source.warnings.filter(item => item.toLowerCase().includes(parsed.data.query?.toLowerCase() ?? ""));
    const offset = (parsed.data.page - 1) * parsed.data.pageSize;
    return pageResult(warnings.slice(offset, offset + parsed.data.pageSize), warnings.length, parsed.data);
  });
  app.post("/skill-sources", async (request, reply) => {
    const input = sourceSchema.safeParse(request.body);
    if (!input.success) return invalid(reply);
    try { const source = await sources.add(input.data); skills.invalidatePaginationSnapshots(); return reply.code(201).send(source); }
    catch (error) { return handleSkillError(reply, error); }
  });
  app.post<{ Params: { id: string } }>("/skill-sources/:id/refresh", async (request, reply) => {
    try { const source = await sources.refresh(request.params.id); skills.invalidatePaginationSnapshots(); return source; }
    catch (error) { return handleSkillError(reply, error); }
  });
  app.delete<{ Params: { id: string } }>("/skill-sources/:id", async (request, reply) => {
    try { await sources.remove(request.params.id); skills.invalidatePaginationSnapshots(); return reply.code(204).send(); }
    catch (error) { return handleSkillError(reply, error); }
  });

  type Params = { id: string; skillId: string };
  const agentId = (params: Params, reply: FastifyReply): number | undefined => {
    const id = z.coerce.number().int().positive().safeParse(params.id);
    if (!id.success || agents.get(id.data) === undefined) {
      reply.code(404).send({ error: { code: "not_found", message: "Agent not found" } });
      return undefined;
    }
    return id.data;
  };
  app.get<{ Params: Params }>("/agents/:id/skills/:skillId/revisions", (request, reply) => {
    const id = agentId(request.params, reply); if (id === undefined) return reply;
    const parsed = paginationQuerySchema.strict().safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    try {
      return isPagedQuery(request.query) ? skills.revisionHistoryPage(id, request.params.skillId, parsed.data)
        : skills.revisionHistory(id, request.params.skillId);
    }
    catch (error) { return handleSkillError(reply, error); }
  });
  app.get<{ Params: Params }>("/agents/:id/skills/:skillId/diff", (request, reply) => {
    const id = agentId(request.params, reply); if (id === undefined) return reply;
    const query = paginationQuerySchema.extend({ revision: revisionSchema }).strict().safeParse(request.query);
    if (!query.success) return invalid(reply);
    try {
      return isPagedQuery(request.query) ? skills.diffPage(id, request.params.skillId, query.data.revision, query.data)
        : skills.diff(id, request.params.skillId, query.data.revision);
    }
    catch (error) { return handleSkillError(reply, error); }
  });
  app.get<{ Params: Params }>("/agents/:id/skills/:skillId/diff/file", async (request, reply) => {
    const id = agentId(request.params, reply); if (id === undefined) return reply;
    const query = z.object({ revision: revisionSchema, baseRevision: revisionSchema, path: z.string().min(1).max(4_096) }).strict().safeParse(request.query);
    if (!query.success) return invalid(reply);
    const controller = new AbortController();
    const abort = () => controller.abort();
    reply.raw.once("close", abort);
    try { return await skills.previewFile(id, request.params.skillId, query.data.revision, query.data.path, query.data.baseRevision, controller.signal); }
    catch (error) { return handleSkillError(reply, error); }
    finally { reply.raw.off("close", abort); }
  });
  app.post<{ Params: Params }>("/agents/:id/skills/:skillId/revision", (request, reply) => {
    const id = agentId(request.params, reply); if (id === undefined) return reply;
    const input = z.object({ revision: revisionSchema, expectedRevision: revisionSchema }).strict().safeParse(request.body);
    if (!input.success) return invalid(reply);
    try { return skills.applyRevision(id, request.params.skillId, input.data.revision, input.data.expectedRevision); }
    catch (error) { return handleSkillError(reply, error); }
  });
  app.post<{ Params: Params }>("/agents/:id/skills/:skillId/upload", { bodyLimit: 14 * 1024 * 1024 }, (request, reply) => {
    const id = agentId(request.params, reply); if (id === undefined) return reply;
    const input = skillUploadSchema.safeParse(request.body); if (!input.success) return invalid(reply);
    try {
      return reply.code(201).send(skills.upload(id, input.data.fileName, Buffer.from(input.data.contentBase64, "base64"), request.params.skillId));
    } catch (error) { return handleSkillError(reply, error); }
  });
};
