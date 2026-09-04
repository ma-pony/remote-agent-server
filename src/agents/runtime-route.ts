import { createHash } from "node:crypto";

import type { Agent, AgentCoreProfile, Provider } from "../domain.js";
import { resolveModelPolicy, resolveModelWindow } from "./model-policy.js";

export type ResolvedRunRoute = {
  resolvedAt: string;
  policyRevision: string;
  ruleIndex: number | null;
  coreProfileId: number;
  provider: Provider;
  model: string | null;
  effectiveConcurrency: number;
  pinSessionCore: boolean;
};

export type ResolvedRunConcurrency = {
  agent: number;
  coreProfile: number;
  effective: number;
};

export class RuntimeRouteError extends Error {
  constructor(readonly code: "core_profile_not_found" | "core_profile_disabled") {
    super(code);
  }
}

const configuredProfileId = (agent: Agent, now: Date): number => {
  const policy = agent.modelPolicy;
  if (policy.mode === "schedule") {
    return resolveModelWindow(policy, now)?.coreProfileId
      ?? policy.defaultCoreProfileId
      ?? agent.defaultCoreProfileId;
  }
  return policy.coreProfileId ?? agent.defaultCoreProfileId;
};

const requireProfile = (agent: Agent, id: number): AgentCoreProfile => {
  const profile = agent.coreProfiles.find((candidate) => candidate.id === id);
  if (profile === undefined) throw new RuntimeRouteError("core_profile_not_found");
  if (!profile.enabled) throw new RuntimeRouteError("core_profile_disabled");
  return profile;
};

/** Resolves the independent Agent and Core limits for one UTC snapshot. */
export const resolveRunConcurrency = (input: {
  agent: Agent;
  coreProfileId: number;
  globalConcurrency: number;
  now: Date;
}): ResolvedRunConcurrency => {
  const profile = requireProfile(input.agent, input.coreProfileId);
  const globalConcurrency = Math.max(1, Math.min(64, input.globalConcurrency));
  const windowConcurrency = resolveModelWindow(input.agent.modelPolicy, input.now)?.maxConcurrentRuns ?? null;
  const agent = Math.min(
    globalConcurrency,
    windowConcurrency ?? input.agent.maxConcurrentRuns ?? globalConcurrency
  );
  const coreProfile = Math.min(globalConcurrency, profile.maxConcurrentRuns ?? globalConcurrency);
  return { agent, coreProfile, effective: Math.min(agent, coreProfile) };
};

/** Resolves Core, model and concurrency from one UTC snapshot. */
export const resolveRunRoute = (input: {
  agent: Agent;
  pinnedCoreProfileId: number | null;
  globalConcurrency: number;
  now: Date;
}): ResolvedRunRoute => {
  const configuredId = configuredProfileId(input.agent, input.now);
  const coreProfileId = input.agent.coreRoutingMode === "session_sticky"
    ? input.pinnedCoreProfileId ?? input.agent.defaultCoreProfileId
    : configuredId;
  const profile = requireProfile(input.agent, coreProfileId);
  const window = resolveModelWindow(input.agent.modelPolicy, input.now);
  const ruleIndex = input.agent.modelPolicy.mode === "schedule" && window !== undefined
    ? input.agent.modelPolicy.windows.indexOf(window)
    : null;
  const model = resolveModelPolicy(input.agent.modelPolicy, input.now)
    ?? (coreProfileId === input.agent.defaultCoreProfileId ? input.agent.providerDefaultModel : null)
    ?? null;
  const effectiveConcurrency = resolveRunConcurrency({
    agent: input.agent,
    coreProfileId,
    globalConcurrency: input.globalConcurrency,
    now: input.now
  }).effective;
  const policyRevision = createHash("sha256").update(JSON.stringify({
    coreRoutingMode: input.agent.coreRoutingMode,
    defaultCoreProfileId: input.agent.defaultCoreProfileId,
    modelPolicy: input.agent.modelPolicy,
    profiles: input.agent.coreProfiles.map(({ id, enabled, maxConcurrentRuns }) => ({
      id,
      enabled,
      maxConcurrentRuns
    }))
  })).digest("hex");

  return {
    resolvedAt: input.now.toISOString(),
    policyRevision,
    ruleIndex,
    coreProfileId,
    provider: profile.provider,
    model,
    effectiveConcurrency,
    pinSessionCore: input.agent.coreRoutingMode === "session_sticky" && input.pinnedCoreProfileId === null
  };
};
