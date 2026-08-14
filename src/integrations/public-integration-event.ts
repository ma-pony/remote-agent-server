import type { Event } from "../domain.js";
import type { IntegrationTask } from "./integration-types.js";

export type PublicIntegrationEvent = Omit<Event, "type"> & {
  type: Event["type"] | "message.system.notice";
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const publicToolContent = (content: Record<string, unknown>): Record<string, unknown> => {
  const projected: Record<string, unknown> = {};
  for (const key of ["toolCallId", "title", "kind", "status"] as const) {
    const value = stringValue(content[key]);
    if (value !== undefined) projected[key] = value;
  }
  return projected;
};

const publicContent = (event: Event): Record<string, unknown> => {
  const content = record(JSON.parse(event.contentJson));
  if (content === undefined) return {};

  if (event.type === "message") {
    const stream = content.stream === "output" || content.stream === "thought" ? content.stream : undefined;
    if (stream === undefined) return {};
    if (stream === "thought") return { stream };
    return { stream, text: typeof content.text === "string" ? content.text : "" };
  }
  if (event.type === "tool") return publicToolContent(content);
  if (event.type === "status") {
    return typeof content.status === "string" ? { status: content.status } : {};
  }
  return { code: "agent_run_error" };
};

/** Returns the explicit public projection of one internal Run Event. */
export const toPublicIntegrationEvent = (
  event: Event,
  task?: IntegrationTask
): PublicIntegrationEvent => {
  if (task?.publicNoticeEventSeq === event.seq
    && task.publicNoticeCode !== null
    && task.publicNoticeMessage !== null) {
    return {
      ...event,
      type: "message.system.notice",
      contentJson: JSON.stringify({ code: task.publicNoticeCode, message: task.publicNoticeMessage })
    };
  }
  return { ...event, contentJson: JSON.stringify(publicContent(event)) };
};
