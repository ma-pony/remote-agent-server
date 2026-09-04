import { z } from "zod";

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const AGENT_MODEL_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type AgentModelWeekday = typeof AGENT_MODEL_WEEKDAYS[number];
const weekdaySchema = z.enum(AGENT_MODEL_WEEKDAYS);
const weekdaysSchema = z.array(weekdaySchema).min(1).max(7).refine(
  (days) => new Set(days).size === days.length,
  { message: "Model schedule weekdays must be unique" }
);
const modelWindowSchema = z.object({
  days: weekdaysSchema,
  start: timeSchema,
  end: timeSchema,
  model: z.string().trim().min(1).max(255),
  coreProfileId: z.number().int().positive().optional(),
  maxConcurrentRuns: z.number().int().min(1).max(64).nullable().optional()
}).strict().refine(
  ({ start, end }) => start !== end,
  { message: "Model schedule windows must have different start and end times" }
);

export const agentModelPolicySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("provider_default"),
    coreProfileId: z.number().int().positive().optional()
  }).strict(),
  z.object({
    mode: z.literal("fixed"),
    model: z.string().trim().min(1).max(255),
    coreProfileId: z.number().int().positive().optional()
  }).strict(),
  z.object({
    mode: z.literal("schedule"),
    defaultModel: z.string().trim().min(1).max(255),
    defaultCoreProfileId: z.number().int().positive().optional(),
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
const utcWeekday = (date: Date): AgentModelWeekday => AGENT_MODEL_WEEKDAYS[(date.getUTCDay() + 6) % 7];
const previousWeekday = (weekday: AgentModelWeekday): AgentModelWeekday => {
  const index = AGENT_MODEL_WEEKDAYS.indexOf(weekday);
  return AGENT_MODEL_WEEKDAYS[(index + AGENT_MODEL_WEEKDAYS.length - 1) % AGENT_MODEL_WEEKDAYS.length];
};

const matchesWindow = (window: AgentModelWindow, weekday: AgentModelWeekday, minute: number): boolean => {
  const start = parseTime(window.start);
  const end = parseTime(window.end);
  if (start < end) return window.days.includes(weekday) && minute >= start && minute < end;

  return (window.days.includes(weekday) && minute >= start)
    || (window.days.includes(previousWeekday(weekday)) && minute < end);
};

/** Returns the first matching UTC window, preserving configured overlap priority. */
export const resolveModelWindow = (
  policy: AgentModelPolicy,
  now: Date
): AgentModelWindow | undefined => {
  if (policy.mode !== "schedule") return undefined;
  const currentMinute = minuteOfDay(now);
  const currentWeekday = utcWeekday(now);
  return policy.windows.find((candidate) => matchesWindow(candidate, currentWeekday, currentMinute));
};

/** Resolves the model immediately before a Run starts. All policy times are UTC. */
export const resolveModelPolicy = (policy: AgentModelPolicy, now: Date): string | undefined => {
  if (policy.mode === "provider_default") return undefined;
  if (policy.mode === "fixed") return policy.model;

  const window = resolveModelWindow(policy, now);
  return window?.model ?? policy.defaultModel;
};

export const configuredCoreProfileIds = (policy: AgentModelPolicy): number[] => {
  if (policy.mode === "provider_default" || policy.mode === "fixed") {
    return policy.coreProfileId === undefined ? [] : [policy.coreProfileId];
  }
  return [...new Set([
    ...(policy.defaultCoreProfileId === undefined ? [] : [policy.defaultCoreProfileId]),
    ...policy.windows.flatMap(({ coreProfileId }) => coreProfileId === undefined ? [] : [coreProfileId])
  ])];
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
