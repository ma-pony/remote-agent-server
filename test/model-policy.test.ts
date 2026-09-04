import { describe, expect, it } from "vitest";

import {
  agentModelPolicySchema,
  configuredModels,
  resolveModelPolicy,
  resolveModelWindow,
  type AgentModelPolicy
} from "../src/agents/model-policy.js";
import { resolveRunConcurrency, resolveRunRoute } from "../src/agents/runtime-route.js";
import type { Agent } from "../src/domain.js";

const routedAgent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 1,
  name: "Routing agent",
  provider: "codex",
  enabled: true,
  instructions: "",
  maxConcurrentRuns: 6,
  effectiveMaxConcurrentRuns: 6,
  modelPolicy: { mode: "provider_default" },
  providerDefaultModel: "codex-default",
  coreRoutingMode: "session_sticky",
  defaultCoreProfileId: 10,
  coreProfiles: [
    {
      id: 10, agentId: 1, name: "Codex", provider: "codex", enabled: true,
      maxConcurrentRuns: 4, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z"
    },
    {
      id: 20, agentId: 1, name: "Claude", provider: "claude_code", enabled: true,
      maxConcurrentRuns: 3, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z"
    }
  ],
  projectEnvironmentId: 1,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  ...overrides
});

describe("Agent model policy", () => {
  it("uses the provider default when no model override is configured", () => {
    expect(resolveModelPolicy({ mode: "provider_default" }, new Date("2026-09-01T12:00:00Z")))
      .toBeUndefined();
  });

  it("uses a fixed model for every run", () => {
    expect(resolveModelPolicy(
      { mode: "fixed", model: "glm-4.5" },
      new Date("2026-09-01T12:00:00Z")
    )).toBe("glm-4.5");
  });

  it("routes by UTC time and falls back outside the matching window", () => {
    const policy: AgentModelPolicy = {
      mode: "schedule",
      defaultModel: "deepseek-v4-flash",
      windows: [{
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        start: "08:00",
        end: "20:00",
        model: "glm-4.5"
      }]
    };

    expect(resolveModelPolicy(policy, new Date("2026-09-01T07:59:59Z"))).toBe("deepseek-v4-flash");
    expect(resolveModelPolicy(policy, new Date("2026-09-01T08:00:00Z"))).toBe("glm-4.5");
    expect(resolveModelPolicy(policy, new Date("2026-09-01T19:59:59Z"))).toBe("glm-4.5");
    expect(resolveModelPolicy(policy, new Date("2026-09-01T20:00:00Z"))).toBe("deepseek-v4-flash");
  });

  it("routes by UTC weekday", () => {
    const weekdaysOnly: AgentModelPolicy = {
      mode: "schedule",
      defaultModel: "deepseek-v4-flash",
      windows: [{
        days: ["mon", "tue", "wed", "thu", "fri"],
        start: "08:00",
        end: "20:00",
        model: "glm-4.5"
      }]
    };
    expect(resolveModelPolicy(weekdaysOnly, new Date("2026-09-07T12:00:00Z"))).toBe("glm-4.5");
    expect(resolveModelPolicy(weekdaysOnly, new Date("2026-09-06T12:00:00Z"))).toBe("deepseek-v4-flash");
  });

  it("allows a selected start day to continue across UTC midnight", () => {
    const overnight: AgentModelPolicy = {
      mode: "schedule",
      defaultModel: "deepseek-v4-flash",
      windows: [{
        days: ["mon"],
        start: "20:00",
        end: "02:00",
        model: "glm-4.5"
      }]
    };

    expect(agentModelPolicySchema.safeParse(overnight).success).toBe(true);
    expect(resolveModelPolicy(overnight, new Date("2026-09-07T19:59:00Z"))).toBe("deepseek-v4-flash");
    expect(resolveModelPolicy(overnight, new Date("2026-09-07T20:00:00Z"))).toBe("glm-4.5");
    expect(resolveModelPolicy(overnight, new Date("2026-09-08T01:59:00Z"))).toBe("glm-4.5");
    expect(resolveModelPolicy(overnight, new Date("2026-09-08T02:00:00Z"))).toBe("deepseek-v4-flash");
  });

  it("allows one model to cover multiple windows on the same day", () => {
    const splitWindows: AgentModelPolicy = {
      mode: "schedule",
      defaultModel: "deepseek-v4-flash",
      windows: [
        { days: ["mon"], start: "08:00", end: "10:00", model: "glm-4.5" },
        { days: ["mon"], start: "14:00", end: "16:00", model: "glm-4.5" }
      ]
    };

    expect(resolveModelPolicy(splitWindows, new Date("2026-09-07T09:00:00Z"))).toBe("glm-4.5");
    expect(resolveModelPolicy(splitWindows, new Date("2026-09-07T12:00:00Z"))).toBe("deepseek-v4-flash");
    expect(resolveModelPolicy(splitWindows, new Date("2026-09-07T15:00:00Z"))).toBe("glm-4.5");
  });

  it("resolves the model and concurrency from the same first matching window", () => {
    const policy: AgentModelPolicy = {
      mode: "schedule",
      defaultModel: "deepseek-v4-flash",
      windows: [
        {
          days: ["mon"], start: "08:00", end: "12:00", model: "glm-4.5", maxConcurrentRuns: 2
        },
        {
          days: ["mon"], start: "09:00", end: "10:00", model: "deepseek-v4-flash", maxConcurrentRuns: 8
        }
      ]
    };

    expect(resolveModelWindow(policy, new Date("2026-09-07T09:30:00Z"))).toMatchObject({
      model: "glm-4.5",
      maxConcurrentRuns: 2
    });
    expect(resolveModelPolicy(policy, new Date("2026-09-07T09:30:00Z"))).toBe("glm-4.5");
  });

  it("rejects only an ambiguous zero-length window", () => {
    expect(agentModelPolicySchema.safeParse({
      mode: "schedule",
      defaultModel: "deepseek-v4-flash",
      windows: [{ days: ["mon"], start: "08:00", end: "08:00", model: "glm-4.5" }]
    }).success).toBe(false);
  });

  it("exposes every configured model once", () => {
    const policy: AgentModelPolicy = {
      mode: "schedule",
      defaultModel: "deepseek-v4-flash",
      windows: [
        { days: ["mon"], start: "08:00", end: "20:00", model: "glm-4.5" },
        { days: ["mon"], start: "20:00", end: "23:00", model: "deepseek-v4-flash" }
      ]
    };

    expect(configuredModels(policy)).toEqual(["deepseek-v4-flash", "glm-4.5"]);
  });
});

describe("Agent Core runtime routing", () => {
  it("pins a sticky Session to its first Core while still resolving the current model", () => {
    const agent = routedAgent({
      modelPolicy: {
        mode: "schedule",
        defaultModel: "codex-default",
        windows: [{ days: ["tue"], start: "08:00", end: "20:00", model: "codex-fast" }]
      }
    });

    const first = resolveRunRoute({
      agent,
      pinnedCoreProfileId: null,
      globalConcurrency: 8,
      now: new Date("2026-09-01T09:00:00Z")
    });
    const resumed = resolveRunRoute({
      agent,
      pinnedCoreProfileId: 10,
      globalConcurrency: 8,
      now: new Date("2026-09-01T21:00:00Z")
    });

    expect(first).toMatchObject({ coreProfileId: 10, provider: "codex", model: "codex-fast", pinSessionCore: true });
    expect(resumed).toMatchObject({ coreProfileId: 10, provider: "codex", model: "codex-default", pinSessionCore: false });
  });

  it("selects Core, model and concurrency from the same schedule snapshot", () => {
    const agent = routedAgent({
      coreRoutingMode: "scheduled_handoff",
      modelPolicy: {
        mode: "schedule",
        defaultCoreProfileId: 10,
        defaultModel: "codex-default",
        windows: [{
          days: ["tue"], start: "08:00", end: "20:00", coreProfileId: 20,
          model: "claude-sonnet", maxConcurrentRuns: 2
        }]
      }
    });

    expect(resolveRunRoute({
      agent,
      pinnedCoreProfileId: null,
      globalConcurrency: 8,
      now: new Date("2026-09-01T09:00:00Z")
    })).toMatchObject({
      coreProfileId: 20,
      provider: "claude_code",
      model: "claude-sonnet",
      ruleIndex: 0,
      effectiveConcurrency: 2,
      pinSessionCore: false
    });
  });

  it("lets a schedule override the Agent default while retaining the selected Core limit", () => {
    const agent = routedAgent({
      maxConcurrentRuns: 1,
      coreRoutingMode: "scheduled_handoff",
      modelPolicy: {
        mode: "schedule",
        defaultCoreProfileId: 10,
        defaultModel: "codex-default",
        windows: [{
          days: ["tue"], start: "08:00", end: "20:00", coreProfileId: 20,
          model: "claude-sonnet", maxConcurrentRuns: 6
        }]
      }
    });
    const now = new Date("2026-09-01T09:00:00Z");

    expect(resolveRunConcurrency({ agent, coreProfileId: 20, globalConcurrency: 8, now }))
      .toEqual({ agent: 6, coreProfile: 3, effective: 3 });
    expect(resolveRunRoute({ agent, pinnedCoreProfileId: null, globalConcurrency: 8, now }))
      .toMatchObject({ effectiveConcurrency: 3 });
  });
});
