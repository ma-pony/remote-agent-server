import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { UsageError } from "./core/errors.js";
import type { HostUsageCollector } from "./host-collector.js";
import type { UsageBinding } from "./core/types.js";
import { stableHash } from "./core/context.js";
import type { ToolContentEstimate } from "./core/context-types.js";
import { ModelTokenizers } from "./core/tokenizers.js";

export type McpObserverConfig = { socketPath: string; token: string };
type ContentSample = Pick<ToolContentEstimate, "tokens" | "byteLength" | "partial"> & {
  reason?: "model_missing" | "unsupported_content" | "size_limit" | "tokenization_failed" | null;
};
export type McpObservation = { invocationId: string; toolName: string; phase: "start" | "end"; occurredAt: string;
  status?: "succeeded" | "tool_error" | "transport_error" | "cancelled"; resultBytes?: number;
  argumentContent?: ContentSample; resultContent?: ContentSample };
const contentSchema = z.object({ tokens: z.number().int().nonnegative().safe().nullable(),
  byteLength: z.number().int().nonnegative().safe(), partial: z.boolean(),
  reason: z.enum(["model_missing", "unsupported_content", "size_limit", "tokenization_failed"]).nullable().optional() }).strict();
const observationSchema = z.object({ invocationId: z.string().uuid(), toolName: z.string().min(1).max(512), phase: z.enum(["start", "end"]),
  occurredAt: z.string().datetime({ offset: true }), status: z.enum(["succeeded", "tool_error", "transport_error", "cancelled"]).optional(),
  resultBytes: z.number().int().nonnegative().safe().optional(),
  argumentContent: contentSchema.optional(), resultContent: contentSchema.optional() }).strict();
// MCP wrappers measure locally; no tool body or model credential crosses this channel.
const fallbackEstimate = new ModelTokenizers().describe(null);
const estimate = (value: ContentSample | undefined): ToolContentEstimate | undefined => {
  if (value === undefined) return undefined;
  const { reason, ...content } = value;
  return { ...content, estimate: { ...fallbackEstimate, method: content.tokens === null ? "unavailable" : "text_heuristic",
    reason: reason ?? fallbackEstimate.reason } };
};
type Ticket = { binding: UsageBinding; epoch: string; serverId: string; runtimeKind: string };

/** Local metadata channel. The host owns SQLite and freezes Run association on call start. */
export class McpUsageObserver {
  private readonly tickets = new Map<string, Ticket>();
  private readonly ticketKeys = new Map<number, Map<string, string>>();
  private readonly connections = new Set<Socket>();
  private server: Server | undefined;
  private directory: string | undefined;
  private ready: Promise<string> | undefined;
  constructor(private readonly collector: HostUsageCollector) { collector.observer = this; }

  issueTicket(sessionId: number, serverId: number): string {
    const binding = this.collector.binding(sessionId);
    const epoch = this.collector.epoch(sessionId);
    const key = `${serverId}:${epoch}`;
    const sessionKeys = this.ticketKeys.get(sessionId) ?? new Map<string, string>();
    const existing = sessionKeys.get(key);
    if (existing) return existing;
    const row = this.collector.db.prepare("SELECT provider FROM agents WHERE id = ?").get(Number(binding.agentId)) as { provider: string };
    const token = randomUUID();
    this.tickets.set(token, { binding, epoch, serverId: String(serverId), runtimeKind: row.provider });
    sessionKeys.set(key, token);
    this.ticketKeys.set(sessionId, sessionKeys);
    return token;
  }

  async configuration(sessionId: number, serverId: number): Promise<McpObserverConfig> {
    const token = this.issueTicket(sessionId, serverId);
    this.ready ??= this.listen();
    return { token, socketPath: await this.ready };
  }

  record(token: string, value: unknown): void {
    const ticket = this.tickets.get(token);
    if (!ticket) throw new UsageError("usage_observer_unauthorized");
    this.collector.store.assertBinding(ticket.binding);
    const event = observationSchema.parse(value);
    const id = stableHash(ticket.binding.namespace, ticket.binding.sessionId, ticket.epoch, event.invocationId);
    if (event.phase === "start") {
      if (ticket.epoch !== this.collector.epoch(Number(ticket.binding.sessionId))) throw new UsageError("usage_binding_stale");
      const run = this.collector.db.prepare("SELECT id FROM runs WHERE session_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
        .get(Number(ticket.binding.sessionId)) as { id: number } | undefined;
      this.collector.attribution.observeInvocation(ticket.binding, { invocationId: event.invocationId, providerEpochId: ticket.epoch,
        executionId: run ? String(run.id) : null, executionEvidence: run ? "inferred" : "unknown", runtimeKind: ticket.runtimeKind,
        capability: { id: `mcp:${ticket.serverId}:${event.toolName}`, kind: "mcp_tool", name: event.toolName, serverId: ticket.serverId },
        startedAt: event.occurredAt, endedAt: null, status: "running", sourceId: `mcp-observer:${ticket.serverId}`,
        revision: 1, rawResultBytes: null, origin: "execution", argumentEstimate: estimate(event.argumentContent) });
    } else {
      const previous = this.collector.attribution.invocation(ticket.binding.namespace, id);
      if (!previous || previous.capability.name !== event.toolName || !event.status) throw new UsageError("usage_invocation_not_found");
      this.collector.attribution.observeInvocation(ticket.binding, { ...previous, endedAt: event.occurredAt,
        status: event.status, revision: 2, rawResultBytes: event.resultBytes ?? null,
        argumentEstimate: previous.argumentEstimate ?? undefined, resultEstimate: estimate(event.resultContent) });
    }
  }

  /** Called after producer draining, or between serialized Runs when MCP selection changes. */
  revokeSession(sessionId: number, retainServerIds: ReadonlySet<number> = new Set()): void {
    const keys = this.ticketKeys.get(sessionId);
    if (!keys) return;
    for (const [key, token] of keys) {
      if (retainServerIds.has(Number(this.tickets.get(token)?.serverId))) continue;
      this.tickets.delete(token); keys.delete(key);
    }
    if (keys.size === 0) this.ticketKeys.delete(sessionId);
  }

  async close(): Promise<void> {
    if (this.ready) await this.ready.catch(() => undefined);
    for (const socket of this.connections) socket.destroy();
    if (this.server?.listening) await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.tickets.clear(); this.ticketKeys.clear();
    if (this.collector.observer === this) this.collector.observer = undefined;
  }

  private async listen(): Promise<string> {
    this.directory = await mkdtemp(join(tmpdir(), "ras-usage-"));
    await chmod(this.directory, 0o700);
    const path = join(this.directory, "observer.sock");
    this.server = createServer((socket) => {
      this.connections.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => this.connections.delete(socket));
      socket.setTimeout(1000, () => socket.destroy());
      let body = "";
      socket.on("data", (data: Buffer) => {
        body += data.toString();
        if (body.length > 8192) { socket.destroy(); return; }
        const end = body.indexOf("\n");
        if (end < 0) return;
        try {
          const message = JSON.parse(body.slice(0, end)) as { token: string; event: unknown };
          this.record(message.token, message.event);
          socket.end('{"ok":true}\n');
        } catch { socket.end('{"ok":false}\n'); }
        body = "";
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(path, () => { this.server!.off("error", reject); resolve(); });
    });
    await chmod(path, 0o600);
    this.server.on("error", () => { /* Request clients observe unavailable capture; business MCP traffic is independent. */ });
    return path;
  }
}
