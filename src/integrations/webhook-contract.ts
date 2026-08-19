const taskStatuses = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);
const taskEvents = new Set([
  "task.queued", "task.started", "task.succeeded", "task.failed", "task.cancelled"
]);
const toolEvents = new Set(["tool.started", "tool.completed", "tool.failed"]);
const managedHeaders = new Set([
  "content-type",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "proxy-authorization",
  "proxy-authenticate",
  "upgrade",
  "trailer",
  "te",
  "keep-alive",
  "expect",
  "forwarded",
  "via",
  "x-remote-agent-event",
  "x-remote-agent-event-id",
  "x-remote-agent-timestamp",
  "x-remote-agent-signature"
]);

type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : undefined;

const hasExactKeys = (value: RecordValue, required: string[], optional: string[] = []): boolean => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableString = (value: unknown): boolean => value === null || typeof value === "string";
const positiveInteger = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0;
const nullablePositiveInteger = (value: unknown): boolean => value === null || positiveInteger(value);

const validEndpoint = (value: unknown, endpointId: number): boolean => {
  const endpoint = record(value);
  return endpoint !== undefined
    && hasExactKeys(endpoint, ["id", "slug"])
    && endpoint.id === endpointId
    && nonEmptyString(endpoint.slug);
};

const validTask = (value: unknown): boolean => {
  const task = record(value);
  return task !== undefined
    && hasExactKeys(task, ["id", "requestId", "conversationKey", "sessionId", "runId", "status"])
    && positiveInteger(task.id)
    && nonEmptyString(task.requestId)
    && nullableString(task.conversationKey)
    && positiveInteger(task.sessionId)
    && nullablePositiveInteger(task.runId)
    && typeof task.status === "string"
    && taskStatuses.has(task.status);
};

const validMessage = (value: unknown, role: "user" | "agent"): boolean => {
  const message = record(value);
  return message !== undefined
    && hasExactKeys(message, ["role", "content", "runStatus"])
    && message.role === role
    && typeof message.content === "string"
    && typeof message.runStatus === "string"
    && taskStatuses.has(message.runStatus);
};

const validNotice = (value: unknown): boolean => {
  const notice = record(value);
  return notice !== undefined
    && hasExactKeys(notice, ["code", "message"])
    && nonEmptyString(notice.code)
    && typeof notice.message === "string";
};

const validTool = (value: unknown, status: string): boolean => {
  const tool = record(value);
  return tool !== undefined
    && hasExactKeys(tool, ["toolCallId", "status"], ["kind"])
    && nonEmptyString(tool.toolCallId)
    && tool.status === status
    && (tool.kind === undefined || typeof tool.kind === "string");
};

export const isManagedWebhookHeader = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return managedHeaders.has(normalized)
    || normalized.startsWith("proxy")
    || normalized.startsWith("x-forwarded");
};

export const isCurrentWebhookPayload = (
  serialized: string,
  expected: { eventId: string; eventType: string; sequence: number; endpointId: number }
): boolean => {
  let payload: RecordValue | undefined;
  try {
    payload = record(JSON.parse(serialized));
  } catch (_error) {
    return false;
  }
  if (payload === undefined) return false;
  const baseKeys = ["eventId", "eventType", "sequence", "occurredAt", "endpoint", "task"];
  if (payload.eventId !== expected.eventId
    || payload.eventType !== expected.eventType
    || payload.sequence !== expected.sequence
    || !nonEmptyString(payload.occurredAt)
    || !validEndpoint(payload.endpoint, expected.endpointId)) return false;

  if (expected.eventType === "webhook.test") {
    return hasExactKeys(payload, [...baseKeys, "notice"])
      && payload.task === null
      && validNotice(payload.notice);
  }
  if (!validTask(payload.task)) return false;
  if (taskEvents.has(expected.eventType)) return hasExactKeys(payload, baseKeys);
  if (expected.eventType === "message.user.received") {
    return hasExactKeys(payload, [...baseKeys, "message"]) && validMessage(payload.message, "user");
  }
  if (expected.eventType === "message.agent.reply") {
    return hasExactKeys(payload, [...baseKeys, "message"]) && validMessage(payload.message, "agent");
  }
  if (expected.eventType === "message.system.notice") {
    return hasExactKeys(payload, [...baseKeys, "notice"]) && validNotice(payload.notice);
  }
  return toolEvents.has(expected.eventType)
    && hasExactKeys(payload, [...baseKeys, "tool"])
    && validTool(payload.tool, expected.eventType.slice("tool.".length));
};
