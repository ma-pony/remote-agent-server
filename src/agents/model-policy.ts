import { z } from "zod";

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const modelWindowSchema = z.object({
  start: timeSchema,
  end: timeSchema,
  model: z.string().trim().min(1).max(255)
}).strict().refine(
  ({ start, end }) => start < end,
  { message: "Model schedule windows must end after they start" }
);

export const agentModelPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("provider_default") }).strict(),
  z.object({
    mode: z.literal("fixed"),
    model: z.string().trim().min(1).max(255)
  }).strict(),
  z.object({
    mode: z.literal("schedule"),
    defaultModel: z.string().trim().min(1).max(255),
    windows: z.array(modelWindowSchema).min(1).max(16)
  }).strict()
]);

export type AgentModelPolicy = z.infer<typeof agentModelPolicySchema>;
export type AgentModelWindow = Extract<AgentModelPolicy, { mode: "schedule" }>["windows"][number];

export const PROVIDER_DEFAULT_MODEL_POLICY: AgentModelPolicy = Object.freeze({ mode: "provider_default" });

const minuteOfDay = (date: Date): number => date.getUTCHours() * 60 + date.getUTCMinutes();
const parseTime = (value: string): number => {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};

/** Resolves the model immediately before a Run starts. All policy times are UTC. */
export const resolveModelPolicy = (policy: AgentModelPolicy, now: Date): string | undefined => {
  if (policy.mode === "provider_default") return undefined;
  if (policy.mode === "fixed") return policy.model;

  const currentMinute = minuteOfDay(now);
  const window = policy.windows.find((candidate) => currentMinute >= parseTime(candidate.start)
    && currentMinute < parseTime(candidate.end));
  return window?.model ?? policy.defaultModel;
};

/** Returns every model ID referenced by a policy, preserving first-use order. */
export const configuredModels = (policy: AgentModelPolicy): string[] => {
  if (policy.mode === "provider_default") return [];
  if (policy.mode === "fixed") return [policy.model];
  return [...new Set([policy.defaultModel, ...policy.windows.map(({ model }) => model)])];
};

export const parseStoredModelPolicy = (value: string | null | undefined): AgentModelPolicy => {
  if (value === null || value === undefined || value === "") return PROVIDER_DEFAULT_MODEL_POLICY;
  try {
    return agentModelPolicySchema.parse(JSON.parse(value));
  } catch (_error) {
    return PROVIDER_DEFAULT_MODEL_POLICY;
  }
};
