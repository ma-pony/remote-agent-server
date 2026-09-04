import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { AgentManager, AgentManagerError } from "./agent-manager.js";
import { agentModelPolicySchema } from "./model-policy.js";
import type { RunRepository } from "../runs/run-repository.js";
import { SkillManagerError, type SkillManager } from "../skills/skill-manager.js";
import type { ProviderExtensionManager } from "../provider-extensions/provider-extension-manager.js";

const createAgentSchema = z.object({
  name: z.string().trim().min(1),
  provider: z.enum(["claude_code", "codex", "hermes"]),
  projectEnvironmentId: z.number().int().positive(),
  instructions: z.string().max(20_000).default(""),
  maxConcurrentRuns: z.number().int().min(1).max(64).nullable().optional()
}).strict();

const updateAgentSchema = z.object({
  name: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  projectEnvironmentId: z.number().int().positive().optional(),
  instructions: z.string().max(20_000).optional(),
  maxConcurrentRuns: z.number().int().min(1).max(64).nullable().optional(),
  modelPolicy: agentModelPolicySchema.optional(),
  coreRoutingMode: z.enum(["session_sticky", "scheduled_handoff"]).optional(),
  defaultCoreProfileId: z.number().int().positive().optional()
}).strict().refine(
  (input) => input.name !== undefined || input.enabled !== undefined
    || input.projectEnvironmentId !== undefined || input.instructions !== undefined
    || input.maxConcurrentRuns !== undefined || input.modelPolicy !== undefined
    || input.coreRoutingMode !== undefined || input.defaultCoreProfileId !== undefined,
  {
  message: "At least one field must be provided"
  }
);
const cloneAgentSchema = z.object({
  name: z.string().trim().min(1)
}).strict();
const createCoreProfileSchema = z.object({
  name: z.string().trim().min(1).max(100),
  provider: z.enum(["claude_code", "codex", "hermes"]),
  maxConcurrentRuns: z.number().int().min(1).max(64).nullable().optional()
}).strict();
const updateCoreProfileSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  maxConcurrentRuns: z.number().int().min(1).max(64).nullable().optional()
}).strict().refine((input) => Object.keys(input).length > 0, { message: "At least one field must be provided" });

const updateSkillSchema = z.object({ enabled: z.boolean() }).strict();
const extensionProviderSchema = z.enum(["codex", "claude_code"]);
const extensionQuerySchema = z.object({ provider: extensionProviderSchema.optional() }).strict();
const updateExtensionSchema = z.object({
  enabled: z.boolean(),
  provider: extensionProviderSchema.optional()
}).strict();
const deleteSkillQuerySchema = z.object({ scope: z.enum(["current", "all"]).default("current") }).strict();
const uploadSkillSchema = z.object({
  fileName: z.string().trim().min(1).max(255).regex(/\.zip$/i),
  contentBase64: z.string().min(1).max(14_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/)
}).strict();
const parseId = (value: string): number | undefined => {
  const parsed = z.coerce.number().int().positive().safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const badRequest = (reply: FastifyReply, message: string) =>
  reply.code(400).send({ error: { code: "invalid_request", message } });

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: { code: "not_found", message: "Agent not found" } });

const handleAgentError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof AgentManagerError) {
    if (error.code === "agent_instructions_unsupported") {
      return reply.code(400).send({
        error: { code: error.code, message: "Hermes 当前不支持智能体指令" }
      });
    }
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
    if (error.code === "agent_model_selection_unsupported" || error.code === "agent_model_unavailable") {
      return reply.code(400).send({
        error: {
          code: error.code,
          message: error.code === "agent_model_selection_unsupported"
            ? "Agent Core does not expose selectable models"
            : "Model is not configured by Agent Core"
        }
      });
    }
    if (error.code === "agent_core_profile_unavailable" || error.code === "agent_core_profile_conflict") {
      return reply.code(400).send({
        error: {
          code: error.code,
          message: error.code === "agent_core_profile_unavailable"
            ? "Agent Core profile is unavailable"
            : "Session-sticky routing can only use the default Core profile"
        }
      });
    }
    if (error.code === "agent_default_core_profile_required" || error.code === "agent_core_profile_in_use") {
      return reply.code(409).send({
        error: {
          code: error.code,
          message: error.code === "agent_default_core_profile_required"
            ? "The default Agent Core profile cannot be disabled or deleted"
            : "Agent Core profile is used by a Session and cannot be deleted"
        }
      });
    }
    if (error.code === "agent_core_profile_name_conflict") {
      return reply.code(409).send({
        error: { code: error.code, message: "Agent Core profile name already exists" }
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
  skillManager: SkillManager,
  runRepository: RunRepository,
  providerExtensionManager: ProviderExtensionManager
): void => {
  app.get("/agents", () => agentManager.list());

  app.get<{ Params: { id: string } }>("/agents/:id", (request, reply) => {
    const id = parseId(request.params.id);
    if (id === undefined) return notFound(reply);
    const agent = agentManager.get(id);
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

  app.post<{ Params: { id: string } }>("/agents/:id/clone", (request, reply) => {
    const parsed = cloneAgentSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "Invalid Agent clone input");
    try {
      const id = parseId(request.params.id);
      if (id === undefined) return notFound(reply);
      const agent = agentManager.clone(id, parsed.data);
      return agent === undefined ? notFound(reply) : reply.code(201).send(agent);
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/agents/:id", async (request, reply) => {
    const parsed = updateAgentSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "Invalid Agent update");

    try {
      const id = parseId(request.params.id);
      if (id === undefined) return notFound(reply);
      const agent = await agentManager.update(id, parsed.data);
      return agent === undefined ? notFound(reply) : agent;
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/agents/:id", (request, reply) => {
    try {
      const id = parseId(request.params.id);
      if (id === undefined) return notFound(reply);
      const result = agentManager.delete(id);
      return result === "not_found" ? notFound(reply) : reply.code(204).send();
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/agents/:id/doctor", async (request, reply) => {
    const id = parseId(request.params.id);
    if (id === undefined) return notFound(reply);
    const result = await agentManager.doctor(id);
    return result === undefined ? notFound(reply) : result;
  });

  app.get<{ Params: { id: string } }>("/agents/:id/models", async (request, reply) => {
    const id = parseId(request.params.id);
    if (id === undefined) return notFound(reply);
    try {
      const catalog = await agentManager.models(id);
      return catalog === undefined ? notFound(reply) : catalog;
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/agents/:id/core-profiles", (request, reply) => {
    const id = parseId(request.params.id);
    if (id === undefined) return notFound(reply);
    const agent = agentManager.get(id);
    return agent === undefined ? notFound(reply) : agent.coreProfiles;
  });

  app.post<{ Params: { id: string } }>("/agents/:id/core-profiles", (request, reply) => {
    const id = parseId(request.params.id);
    if (id === undefined) return notFound(reply);
    const parsed = createCoreProfileSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "Invalid Agent Core profile input");
    try {
      const profile = agentManager.createCoreProfile(id, parsed.data);
      return profile === undefined ? notFound(reply) : reply.code(201).send(profile);
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.patch<{ Params: { id: string; profileId: string } }>(
    "/agents/:id/core-profiles/:profileId",
    (request, reply) => {
      const id = parseId(request.params.id);
      const profileId = parseId(request.params.profileId);
      if (id === undefined || profileId === undefined) return notFound(reply);
      const parsed = updateCoreProfileSchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, "Invalid Agent Core profile update");
      try {
        const profile = agentManager.updateCoreProfile(id, profileId, parsed.data);
        return profile === undefined ? notFound(reply) : profile;
      } catch (error) {
        return handleAgentError(reply, error);
      }
    }
  );

  app.delete<{ Params: { id: string; profileId: string } }>(
    "/agents/:id/core-profiles/:profileId",
    (request, reply) => {
      const id = parseId(request.params.id);
      const profileId = parseId(request.params.profileId);
      if (id === undefined || profileId === undefined) return notFound(reply);
      try {
        const result = agentManager.deleteCoreProfile(id, profileId);
        return result === "not_found" ? notFound(reply) : reply.code(204).send();
      } catch (error) {
        return handleAgentError(reply, error);
      }
    }
  );

  app.get<{ Params: { id: string; profileId: string } }>(
    "/agents/:id/core-profiles/:profileId/models",
    async (request, reply) => {
      const id = parseId(request.params.id);
      const profileId = parseId(request.params.profileId);
      if (id === undefined || profileId === undefined) return notFound(reply);
      try {
        const catalog = await agentManager.models(id, profileId);
        return catalog === undefined ? notFound(reply) : catalog;
      } catch (error) {
        return handleAgentError(reply, error);
      }
    }
  );

  app.get<{ Params: { id: string } }>("/agents/:id/usage", (request, reply) => {
    const id = parseId(request.params.id);
    if (id === undefined || agentManager.get(id) === undefined) return notFound(reply);
    return runRepository.summarizeByAgent(id);
  });

  app.get<{ Params: { id: string } }>("/agents/:id/skills", (request, reply) => {
    const id = parseId(request.params.id);
    if (id === undefined || agentManager.get(id) === undefined) return notFound(reply);
    return skillManager.list(id);
  });

  app.get<{ Params: { id: string }; Querystring: { provider?: string } }>("/agents/:id/extensions", (request, reply) => {
    const id = parseId(request.params.id);
    if (id === undefined || agentManager.get(id) === undefined) return notFound(reply);
    const parsed = extensionQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, "Invalid Provider extension query");
    try {
      return providerExtensionManager.list(id, parsed.data.provider);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "agent_provider_unavailable") {
        return badRequest(reply, "Provider is not assigned to this Agent");
      }
      throw error;
    }
  });

  app.put<{ Params: { id: string; extensionId: string } }>(
    "/agents/:id/extensions/:extensionId",
    (request, reply) => {
      const id = parseId(request.params.id);
      if (id === undefined || agentManager.get(id) === undefined) return notFound(reply);
      const parsed = updateExtensionSchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, "Invalid Provider extension update");
      let extension;
      try {
        extension = providerExtensionManager.setEnabled(
          id,
          request.params.extensionId,
          parsed.data.enabled,
          parsed.data.provider
        );
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "agent_provider_unavailable") {
          return badRequest(reply, "Provider is not assigned to this Agent");
        }
        throw error;
      }
      return extension === undefined
        ? reply.code(404).send({ error: { code: "provider_extension_not_found", message: "Provider extension not found" } })
        : extension;
    }
  );

  app.put<{ Params: { id: string; skillId: string } }>("/agents/:id/skills/:skillId", (request, reply) => {
    const id = parseId(request.params.id);
    if (id === undefined || agentManager.get(id) === undefined) return notFound(reply);
    const parsed = updateSkillSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, "Invalid Skill update");
    const skill = skillManager.setEnabled(id, request.params.skillId, parsed.data.enabled);
    return skill === undefined
      ? reply.code(404).send({ error: { code: "skill_not_found", message: "Skill not found" } })
      : skill;
  });

  app.delete<{ Params: { id: string; skillId: string }; Querystring: { scope?: string } }>(
    "/agents/:id/skills/:skillId",
    (request, reply) => {
      const id = parseId(request.params.id);
      if (id === undefined || agentManager.get(id) === undefined) return notFound(reply);
      const parsed = deleteSkillQuerySchema.safeParse(request.query);
      if (!parsed.success) return badRequest(reply, "Invalid Skill delete scope");
      const result = skillManager.remove(id, request.params.skillId, parsed.data.scope);
      if (result === "not_found") {
        return reply.code(404).send({ error: { code: "skill_not_found", message: "Skill not found" } });
      }
      if (result === "global_delete_unsupported") {
        return reply.code(409).send({
          error: { code: result, message: "Host Skills cannot be deleted globally" }
        });
      }
      return reply.code(204).send();
    }
  );

  app.post<{ Params: { id: string } }>(
    "/agents/:id/skills/upload",
    { bodyLimit: 14 * 1024 * 1024 },
    (request, reply) => {
      const id = parseId(request.params.id);
      if (id === undefined || agentManager.get(id) === undefined) return notFound(reply);
      const parsed = uploadSkillSchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, "Invalid Skill ZIP upload");
      try {
        const skill = skillManager.upload(
          id,
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
