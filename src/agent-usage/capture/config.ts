import { z } from "zod";
export const captureProtocols = ["responses", "chat_completions", "anthropic_messages"] as const;
export type CaptureProtocol = typeof captureProtocols[number];
export type CaptureUpstream = { baseUrl: string; protocol: CaptureProtocol; apiKeyEnv: string; modelProvider?: string };
export type CaptureUpstreams = Partial<Record<"codex" | "claude_code" | "hermes", CaptureUpstream>>;
const upstream = z.object({
  baseUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && !url.search && (url.protocol === "https:"
      || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  }, "Capture upstream must be HTTPS or loopback HTTP without credentials, query or fragment"),
  modelProvider: z.string().trim().min(1).max(100).optional(),
  protocol: z.enum(captureProtocols), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
}).strict();
export const captureUpstreamsSchema = z.object({ codex: upstream.optional(), claude_code: upstream.optional(), hermes: upstream.optional() }).strict()
  .superRefine((value, ctx) => {
    if (value.codex && value.codex.protocol !== "responses") ctx.addIssue({ code: "custom", path: ["codex"], message: "Codex capture requires Responses" });
    if (value.claude_code && value.claude_code.protocol !== "anthropic_messages") ctx.addIssue({ code: "custom", path: ["claude_code"], message: "Claude capture requires Messages" });
    if (value.hermes) ctx.addIssue({ code: "custom", path: ["hermes"], message: "Hermes ACP capture configuration is not supported" });
  });
/** Service-only keys, never serialized into runtime configuration. */
export const captureSecrets = (upstreams: CaptureUpstreams, env: Record<string, string | undefined>): Map<string, string> => {
  const result = new Map<string, string>();
  for (const [runtime, upstream] of Object.entries(upstreams)) {
    const key = env[upstream.apiKeyEnv];
    if (!key?.trim()) throw new Error(`usage_capture_key_missing:${runtime}`);
    result.set(runtime, key);
  }
  return result;
};
/** Take ownership before any Provider, checker, project or MCP children are launched. */
export const takeCaptureSecrets = (upstreams: CaptureUpstreams, env: Record<string, string | undefined>): Map<string, string> => {
  const secrets = captureSecrets(upstreams, env);
  for (const upstream of Object.values(upstreams)) delete env[upstream.apiKeyEnv];
  return secrets;
};
