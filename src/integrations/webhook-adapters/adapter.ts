import type { IncomingHttpHeaders } from "node:http";

import { z } from "zod";

import type { WebhookAuthMode, WebhookProviderDefinition } from "../integration-types.js";

export class WebhookIngressError extends Error {
  constructor(readonly code: "invalid_webhook_credentials" | "invalid_webhook_request" | "invalid_webhook_receiver") {
    super(code);
    this.name = "WebhookIngressError";
  }
}

export type WebhookRequest = { headers: IncomingHttpHeaders; body: Buffer };
export type NormalizedWebhook = {
  eventType: string;
  // Undefined only when the provider protocol permits missing IDs; ingress derives one from content.
  deliveryId: string | undefined;
  payload: Record<string, unknown>;
  ignoreReason?: string;
  coalescingKey?: string;
};

/** Provider protocol only: no persistence, Agent configuration, or task scheduling. */
export interface WebhookAdapter {
  definition: WebhookProviderDefinition;
  validateSecret(secret: string, mode: WebhookAuthMode): boolean;
  authenticate(request: WebhookRequest, secret: string, mode: WebhookAuthMode): boolean;
  normalize(request: WebhookRequest): NormalizedWebhook;
}

/** Stable repository identity plus MR/PR number; never group unrelated or incomplete events. */
export const reviewCoalescingKey = (repositoryId: unknown, number: unknown, repositoryUrl: unknown): string | undefined => {
  if (typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) || repositoryId <= 0
    || typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0
    || typeof repositoryUrl !== "string") return undefined;
  try {
    const url = new URL(repositoryUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return JSON.stringify([url.origin, repositoryId, number]);
  } catch { return undefined; }
};

export const webhookRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

const headerSchema = z.string().trim().min(1).max(512);
export const webhookHeader = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const parsed = headerSchema.safeParse(headers[name]);
  return parsed.success ? parsed.data : undefined;
};

export const requiredWebhookHeader = (headers: IncomingHttpHeaders, ...names: string[]): string => {
  for (const name of names) {
    const value = webhookHeader(headers, name);
    if (value !== undefined) return value;
  }
  throw new WebhookIngressError("invalid_webhook_request");
};

const payloadSchema = z.record(z.string(), z.unknown());
export const webhookPayload = ({ body, headers }: WebhookRequest, allowForm = false): Record<string, unknown> => {
  try {
    let json = body.toString("utf8");
    if (headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded") {
      if (!allowForm) throw new Error("unsupported_encoding");
      const form = new URLSearchParams(json);
      if (form.getAll("payload").length !== 1) throw new Error("invalid_form");
      json = form.get("payload")!;
    }
    return payloadSchema.parse(JSON.parse(json));
  } catch {
    throw new WebhookIngressError("invalid_webhook_request");
  }
};
