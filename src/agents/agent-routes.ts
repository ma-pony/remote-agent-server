import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { AgentManager, AgentManagerError } from "./agent-manager.js";
import { SkillManagerError, type SkillManager } from "../skills/skill-manager.js";

const createAgentSchema = z.object({
  name: z.string().trim().min(1),
  provider: z.enum(["claude_code", "codex", "hermes"]),
  projectEnvironmentId: z.string().uuid()
}).strict();

const updateAgentSchema = z.object({
  name: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  projectEnvironmentId: z.string().uuid().optional()
}).strict().refine(
  (input) => input.name !== undefined || input.enabled !== undefined || input.projectEnvironmentId !== undefined,
  {
  message: "At least one field must be provided"
  }
);

const updateSkillSchema = z.object({ enabled: z.boolean() }).strict();
const uploadSkillSchema = z.object({
  fileName: z.string().trim().min(1).max(255).regex(/\.zip$/i),
  contentBase64: z.string().min(1).max(14_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/)
}).strict();

const badRequest = (reply: FastifyReply, message: string) =>
  reply.code(400).send({ error: { code: "invalid_request", message } });

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: { code: "not_found", message: "Agent not found" } });

const handleAgentError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof AgentManagerError) {
    if (error.code === "agent_has_sessions" || error.code === "agent_has_integration_endpoints") {
      return reply.code(409).send({
        error: {
          code: error.code,
          message: error.code === "agent_has_sessions"
            ? "Agent has Sessions and cannot be deleted; disable it instead"
            : "Agent has Integration Endpoints and cannot be deleted; delete or reassign them first"
        }
      });
    }
    return reply.code(400).send({
      error: { code: error.code, message: "Project environment has no ready revision" }
    });
  }
  throw error;
};

/**
 * Registers the authenticated Agent management routes.
 */
export const registerAgentRoutes = (
  app: FastifyInstance,
  agentManager: AgentManager,
  skillManager: SkillManager
): void => {
  app.get("/agents", () => agentManager.list());

  app.get<{ Params: { id: string } }>("/agents/:id", (request, reply) => {
    const agent = agentManager.get(request.params.id);
    return agent === undefined ? notFound(reply) : agent;
  });

  app.post("/agents", (request, reply) => {
    const parsed = createAgentSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "Invalid Agent input");

    try {
      return reply.code(201).send(agentManager.create(parsed.data));
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/agents/:id", (request, reply) => {
    const parsed = updateAgentSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "Invalid Agent update");

    try {
      const agent = agentManager.update(request.params.id, parsed.data);
      return agent === undefined ? notFound(reply) : agent;
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/agents/:id", (request, reply) => {
    try {
      const result = agentManager.delete(request.params.id);
      return result === "not_found" ? notFound(reply) : reply.code(204).send();
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/agents/:id/doctor", async (request, reply) => {
    const result = await agentManager.doctor(request.params.id);
    return result === undefined ? notFound(reply) : result;
  });

  app.get<{ Params: { id: string } }>("/agents/:id/skills", (request, reply) => {
    if (agentManager.get(request.params.id) === undefined) return notFound(reply);
    return skillManager.list(request.params.id);
  });

  app.put<{ Params: { id: string; skillId: string } }>("/agents/:id/skills/:skillId", (request, reply) => {
    if (agentManager.get(request.params.id) === undefined) return notFound(reply);
    const parsed = updateSkillSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "Invalid Skill update");
    const skill = skillManager.setEnabled(request.params.id, request.params.skillId, parsed.data.enabled);
    return skill === undefined
      ? reply.code(404).send({ error: { code: "skill_not_found", message: "Skill not found" } })
      : skill;
  });

  app.post<{ Params: { id: string } }>(
    "/agents/:id/skills/upload",
    { bodyLimit: 14 * 1024 * 1024 },
    (request, reply) => {
      if (agentManager.get(request.params.id) === undefined) return notFound(reply);
      const parsed = uploadSkillSchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, "Invalid Skill ZIP upload");
      try {
        const skill = skillManager.upload(
          request.params.id,
          parsed.data.fileName,
          Buffer.from(parsed.data.contentBase64, "base64")
        );
        return reply.code(201).send(skill);
      } catch (error) {
        if (error instanceof SkillManagerError) {
          const message = error.code === "skill_archive_too_large"
            ? "Skill ZIP exceeds the upload limit"
            : error.code === "skill_name_conflict"
              ? "A host Skill already uses this name"
              : "Skill ZIP is invalid";
          return reply.code(400).send({ error: { code: error.code, message } });
        }
        throw error;
      }
    }
  );
};
