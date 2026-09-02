import { describe, expect, it } from "vitest";

import {
  configuredModels,
  resolveModelPolicy,
  type AgentModelPolicy
} from "../src/agents/model-policy.js";

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
