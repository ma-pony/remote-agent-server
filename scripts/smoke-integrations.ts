import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type SmokeConfig = {
  baseUrl: string;
  apiToken: string;
  agentId: string;
  pollIntervalMs: number;
  taskTimeoutMs: number;
  requestTimeoutMs: number;
};

export type JsonClient = {
  request<T>(path: string, method?: HttpMethod, body?: unknown, timeoutMs?: number): Promise<T>;
};

export type ExternalTask = {
  taskId: string;
  requestId: string;
  conversationKey: string | null;
  sessionId: string;
  runId: string | null;
  status: TaskStatus;
};

type SubmitTaskInput = {
  requestId: string;
  conversationKey: string;
  message: string;
  parameters: Record<string, string>;
};

type EndpointCreation = {
  endpoint: { id: string; slug: string };
  token: string;
};

type WebhookCreation = {
  webhook: { id: string };
  signingSecret: string;
};

type RunEvent = { id: string; seq: number; type: string };
export type WebhookDelivery = {
  id: string;
  eventId: string;
  dispatchOrder: number;
  taskId: string | null;
  eventType: string;
  status: "pending" | "delivering" | "succeeded" | "failed";
  attemptCount: number;
};

type WebhookRequest = {
  body: string;
  eventId: string;
  eventType: string;
  timestamp: string;
  signature: string;
};

export type SmokeTrace = {
  endpointId?: string;
  webhookId?: string;
  taskIds: string[];
  sessionIds: string[];
  runIds: string[];
  deliveryIds: string[];
};

type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };
type FetchImplementation = (url: string, init: RequestInit) => Promise<FetchResponse>;

const TERMINAL = new Set<TaskStatus>(["succeeded", "failed", "cancelled"]);
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TASK_TIMEOUT_MS = 300_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

class HttpError extends Error {
  constructor(method: string, path: string, status: number, responseBody: string) {
    super(`${method} ${path} failed with HTTP ${status}: ${responseBody || "empty response"}`);
    this.name = "HttpError";
  }
}

const required = (env: Record<string, string | undefined>, name: string): string => {
  const value = env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
};

const positiveInteger = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

/** Reads the explicit credentials and deadlines used by the real Integration smoke. */
export const loadSmokeConfig = (env: Record<string, string | undefined>): SmokeConfig => {
  const rawBaseUrl = required(env, "SMOKE_BASE_URL");
  const apiToken = required(env, "SMOKE_API_TOKEN");
  const agentId = required(env, "SMOKE_AGENT_ID");
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch (_error) {
    throw new Error("SMOKE_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("SMOKE_BASE_URL must use HTTP or HTTPS");
  }
  const normalizedPath = parsed.pathname.replace(/\/$/, "").replace(/\/api$/, "");
  parsed.pathname = normalizedPath === "" ? "/" : normalizedPath;
  parsed.search = "";
  parsed.hash = "";
  return {
    baseUrl: parsed.toString().replace(/\/$/, ""),
    apiToken,
    agentId,
    pollIntervalMs: positiveInteger("SMOKE_POLL_INTERVAL_MS", env.SMOKE_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
    taskTimeoutMs: positiveInteger("SMOKE_TASK_TIMEOUT_MS", env.SMOKE_TASK_TIMEOUT_MS, DEFAULT_TASK_TIMEOUT_MS),
    requestTimeoutMs: positiveInteger("SMOKE_REQUEST_TIMEOUT_MS", env.SMOKE_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS)
  };
};

const responseError = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
    if (parsed.error?.message !== undefined) return `${parsed.error.code ?? "error"}: ${parsed.error.message}`;
  } catch (_error) {
    // Preserve non-JSON bodies for diagnostics.
  }
  return body;
};

/** Creates a JSON client whose connection and body read share one Abort deadline. */
export const createJsonClient = (
  baseUrl: string,
  token: string,
  requestTimeoutMs: number,
  fetchImplementation: FetchImplementation = fetch as unknown as FetchImplementation
): JsonClient => ({
  async request<T>(path: string, method: HttpMethod = "GET", body?: unknown, timeoutMs = requestTimeoutMs): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImplementation(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new HttpError(method, path, response.status, responseError(text));
      if (text === "") return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch (_error) {
        throw new Error(`${method} ${path} returned invalid JSON`);
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new Error(`${method} ${path} timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
});

/** Submits one external Task through the Endpoint-scoped API. */
export const submitTask = (
  client: JsonClient,
  endpointSlug: string,
  input: SubmitTaskInput
): Promise<ExternalTask> => client.request(
  `/integration/v1/endpoints/${encodeURIComponent(endpointSlug)}/tasks`,
  "POST",
  input
);

/** Checks that an idempotent retry identifies the original durable Task and Run. */
export const assertIdempotentTask = (first: ExternalTask, duplicate: ExternalTask): void => {
  if (duplicate.taskId !== first.taskId || duplicate.runId !== first.runId) {
    throw new Error(`requestId retry created a different Task or Run (${first.taskId}/${first.runId} -> ${duplicate.taskId}/${duplicate.runId})`);
  }
};

/** Verifies the exact HMAC contract used by WebhookDispatcher. */
export const verifyWebhookSignature = (
  request: Pick<WebhookRequest, "body" | "timestamp" | "signature">,
  signingSecret: string
): boolean => {
  if (!request.timestamp || !request.signature.startsWith("v1=")) return false;
  const expected = createHmac("sha256", signingSecret)
    .update(`${request.timestamp}.${request.body}`)
    .digest("hex");
  const actual = request.signature.slice(3);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"));
};

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  timer.unref?.();
});

const remaining = (deadline: number, label: string): number => {
  const value = deadline - Date.now();
  if (value <= 0) throw new Error(`${label} timed out`);
  return value;
};

const waitForTask = async (
  client: JsonClient,
  config: SmokeConfig,
  taskId: string
): Promise<ExternalTask> => {
  const deadline = Date.now() + config.taskTimeoutMs;
  while (true) {
    const task = await client.request<ExternalTask>(
      `/integration/v1/tasks/${encodeURIComponent(taskId)}`,
      "GET",
      undefined,
      Math.min(config.requestTimeoutMs, remaining(deadline, `Task ${taskId}`))
    );
    if (TERMINAL.has(task.status)) {
      return task;
    }
    await sleep(Math.min(config.pollIntervalMs, remaining(deadline, `Task ${taskId}`)));
  }
};

const assertContiguousEvents = (events: RunEvent[], firstSeq = 1): void => {
  if (events.length === 0) throw new Error("Task succeeded without Event history");
  for (const [index, event] of events.entries()) {
    if (!Number.isInteger(event.seq) || event.seq !== firstSeq + index) {
      throw new Error(`Event history has a gap, duplicate or reorder at seq ${event.seq}`);
    }
  }
};

const readSseSuffix = async (
  config: SmokeConfig,
  endpointToken: string,
  taskId: string,
  afterSeq: number
): Promise<RunEvent[]> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  timer.unref?.();
  const path = `/integration/v1/tasks/${encodeURIComponent(taskId)}/events/stream?afterSeq=${afterSeq}`;
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${endpointToken}`, accept: "text/event-stream" },
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) throw new HttpError("GET", path, response.status, responseError(body));
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      throw new Error("Integration Event stream did not return text/event-stream");
    }
    const events: RunEvent[] = [];
    for (const frame of body.split("\n\n")) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (data === undefined) continue;
      const parsed = JSON.parse(data) as Partial<RunEvent>;
      if (typeof parsed.id === "string" && typeof parsed.seq === "number" && typeof parsed.type === "string") {
        events.push(parsed as RunEvent);
      }
    }
    return events;
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new Error(`GET ${path} timed out after ${config.requestTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const startReceiver = async (): Promise<{
  server: Server;
  url: string;
  requests: WebhookRequest[];
}> => {
  const requests: WebhookRequest[] = [];
  let failedFirstReply = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const eventType = request.headers["x-remote-agent-event"] ?? "";
      const record: WebhookRequest = {
        body: Buffer.concat(chunks).toString("utf8"),
        eventId: String(request.headers["x-remote-agent-event-id"] ?? ""),
        eventType: String(eventType),
        timestamp: String(request.headers["x-remote-agent-timestamp"] ?? ""),
        signature: String(request.headers["x-remote-agent-signature"] ?? "")
      };
      requests.push(record);
      if (record.eventType === "message.agent.reply" && !failedFirstReply) {
        failedFirstReply = true;
        response.writeHead(500).end();
        return;
      }
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not start local Webhook receiver");
  return { server, url: `http://127.0.0.1:${address.port}/webhook`, requests };
};

const stopReceiver = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
};

const waitForReplyDeliveries = async (
  management: JsonClient,
  config: SmokeConfig,
  endpointId: string,
  taskIds: string[]
): Promise<WebhookDelivery[]> => {
  const deadline = Date.now() + config.taskTimeoutMs;
  while (true) {
    const deliveries = await management.request<WebhookDelivery[]>(
      `/api/integration-endpoints/${encodeURIComponent(endpointId)}/webhook-deliveries`,
      "GET",
      undefined,
      Math.min(config.requestTimeoutMs, remaining(deadline, "Webhook delivery"))
    );
    const replies = deliveries.filter((delivery) =>
      delivery.eventType === "message.agent.reply" && delivery.taskId !== null && taskIds.includes(delivery.taskId));
    if (replies.length === taskIds.length && replies.every((delivery) => delivery.status === "succeeded")) {
      return replies;
    }
    if (replies.some((delivery) => delivery.status === "failed")) {
      throw new Error(`Webhook delivery exhausted retries: ${replies.find((delivery) => delivery.status === "failed")!.id}`);
    }
    await sleep(Math.min(config.pollIntervalMs, remaining(deadline, "Webhook delivery")));
  }
};

/** Validates durable Delivery order and the order observed by the local receiver against Task submission order. */
export const assertReplyDeliveryOrder = (
  taskIds: string[],
  deliveries: WebhookDelivery[],
  receivedEventIds: string[]
): WebhookDelivery[] => {
  const ordered = taskIds.map((taskId) => {
    const matches = deliveries.filter((delivery) =>
      delivery.eventType === "message.agent.reply" && delivery.taskId === taskId);
    if (matches.length !== 1) {
      throw new Error(`Expected one Agent reply Delivery for Task ${taskId}, found ${matches.length}`);
    }
    return matches[0]!;
  });
  if (ordered.some((delivery, index) =>
    index > 0 && delivery.dispatchOrder <= ordered[index - 1]!.dispatchOrder)) {
    throw new Error("Agent reply Delivery dispatchOrder does not follow Task submission order");
  }

  const expectedEventIds = ordered.map((delivery) => delivery.eventId);
  const observed = new Set<string>();
  let previousIndex = -1;
  for (const eventId of receivedEventIds) {
    const index = expectedEventIds.indexOf(eventId);
    if (index === -1 || index < previousIndex) {
      throw new Error("Local receiver order does not match Agent reply Delivery order");
    }
    previousIndex = index;
    observed.add(eventId);
  }
  if (expectedEventIds.some((eventId) => !observed.has(eventId))) {
    throw new Error("Local receiver order is missing an Agent reply Delivery event");
  }
  return ordered;
};

const traceOutput = (outcome: "succeeded" | "failed", trace: SmokeTrace): void => {
  console.log(JSON.stringify({ outcome, ...trace }));
};

const recordTaskIdentity = (trace: SmokeTrace, task: ExternalTask): void => {
  if (!trace.taskIds.includes(task.taskId)) trace.taskIds.push(task.taskId);
  if (!trace.sessionIds.includes(task.sessionId)) trace.sessionIds.push(task.sessionId);
  if (task.runId !== null && !trace.runIds.includes(task.runId)) trace.runIds.push(task.runId);
};

type ManagementTaskIdentity = { id: string; sessionId: string; runId: string | null };

/** Best-effort refreshes durable IDs without including credentials or message contents in diagnostics. */
export const refreshFailureTrace = async (management: JsonClient, trace: SmokeTrace): Promise<void> => {
  for (const taskId of trace.taskIds) {
    try {
      const task = await management.request<ManagementTaskIdentity>(
        `/api/integration-tasks/${encodeURIComponent(taskId)}`
      );
      if (!trace.sessionIds.includes(task.sessionId)) trace.sessionIds.push(task.sessionId);
      if (task.runId !== null && !trace.runIds.includes(task.runId)) trace.runIds.push(task.runId);
    } catch (_taskLookupError) {
      // Continue collecting the remaining known IDs; the original smoke failure stays primary.
    }
  }
  if (trace.endpointId === undefined) return;
  try {
    const deliveries = await management.request<WebhookDelivery[]>(
      `/api/integration-endpoints/${encodeURIComponent(trace.endpointId)}/webhook-deliveries`
    );
    for (const delivery of deliveries) {
      if (!trace.deliveryIds.includes(delivery.id)) trace.deliveryIds.push(delivery.id);
    }
  } catch (_deliveryLookupError) {
    // IDs already collected above are still useful when management diagnostics also fail.
  }
};

const requireSucceeded = (task: ExternalTask): void => {
  if (task.status !== "succeeded") throw new Error(`Task ${task.taskId} ended ${task.status}`);
  if (task.runId === null) throw new Error(`Task ${task.taskId} succeeded without a Run ID`);
};

const closeWithDeadline = async (server: Server): Promise<void> => {
  await Promise.race([
    stopReceiver(server),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref?.();
    })
  ]);
};

/** Executes a real local-receiver Integration acceptance flow and preserves all audit records. */
export const runIntegrationSmoke = async (config: SmokeConfig): Promise<void> => {
  const trace: SmokeTrace = { taskIds: [], sessionIds: [], runIds: [], deliveryIds: [] };
  const management = createJsonClient(config.baseUrl, config.apiToken, config.requestTimeoutMs);
  const receiver = await startReceiver();
  try {
    const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const endpointCreation = await management.request<EndpointCreation>("/api/integration-endpoints", "POST", {
      name: `Integration smoke ${suffix}`,
      slug: `integration-smoke-${suffix}`,
      agentId: config.agentId,
      enabled: true,
      promptPrefix: "",
      parameterMappings: []
    });
    trace.endpointId = endpointCreation.endpoint.id;
    const external = createJsonClient(config.baseUrl, endpointCreation.token, config.requestTimeoutMs);
    const webhookCreation = await management.request<WebhookCreation>(
      `/api/integration-endpoints/${encodeURIComponent(endpointCreation.endpoint.id)}/webhooks`,
      "POST",
      {
        name: "Integration smoke reply receiver",
        url: receiver.url,
        enabled: true,
        events: ["message.agent.reply"],
        headers: {},
        timeoutSeconds: 10
      }
    );
    trace.webhookId = webhookCreation.webhook.id;

    const conversationKey = `smoke-conversation-${suffix}`;
    const firstInput: SubmitTaskInput = {
      requestId: `smoke-first-${suffix}`,
      conversationKey,
      message: "这是外部接入 smoke 第一轮。只回复：integration smoke first",
      parameters: {}
    };
    const firstSubmitted = await submitTask(external, endpointCreation.endpoint.slug, firstInput);
    recordTaskIdentity(trace, firstSubmitted);
    const first = await waitForTask(external, config, firstSubmitted.taskId);
    recordTaskIdentity(trace, first);
    requireSucceeded(first);

    const allEvents = await external.request<RunEvent[]>(
      `/integration/v1/tasks/${encodeURIComponent(first.taskId)}/events?afterSeq=0`
    );
    assertContiguousEvents(allEvents);
    const afterSeq = Math.max(0, allEvents.at(-1)!.seq - 1);
    const queriedSuffix = await external.request<RunEvent[]>(
      `/integration/v1/tasks/${encodeURIComponent(first.taskId)}/events?afterSeq=${afterSeq}`
    );
    const streamedSuffix = await readSseSuffix(config, endpointCreation.token, first.taskId, afterSeq);
    if (queriedSuffix.map((event) => event.id).join(",") !== streamedSuffix.map((event) => event.id).join(",")) {
      throw new Error("SSE afterSeq suffix differs from the authoritative Event query");
    }
    assertContiguousEvents(streamedSuffix, afterSeq + 1);

    const duplicate = await submitTask(external, endpointCreation.endpoint.slug, firstInput);
    assertIdempotentTask(first, duplicate);

    const secondSubmitted = await submitTask(external, endpointCreation.endpoint.slug, {
      requestId: `smoke-second-${suffix}`,
      conversationKey,
      message: "这是同一 Conversation 的第二轮。只回复：integration smoke second",
      parameters: {}
    });
    recordTaskIdentity(trace, secondSubmitted);
    const second = await waitForTask(external, config, secondSubmitted.taskId);
    recordTaskIdentity(trace, second);
    requireSucceeded(second);
    if (second.sessionId !== first.sessionId) throw new Error("Second Task did not reuse the first Session");
    if (second.runId === first.runId) throw new Error("Second Task reused the first Run");

    const deliveries = await waitForReplyDeliveries(management, config, endpointCreation.endpoint.id, [first.taskId, second.taskId]);
    const replyRequests = receiver.requests.filter((request) => request.eventType === "message.agent.reply");
    const orderedDeliveries = assertReplyDeliveryOrder(
      [first.taskId, second.taskId],
      deliveries,
      replyRequests.map((request) => request.eventId)
    );
    trace.deliveryIds.push(...orderedDeliveries.map((delivery) => delivery.id));
    if (orderedDeliveries[0]!.attemptCount < 2) throw new Error("First Agent reply Webhook was not retried after HTTP 500");
    if (replyRequests.length < 3 || replyRequests[0]!.eventId !== replyRequests[1]!.eventId) {
      throw new Error("Local receiver did not observe the first Agent reply failure and retry");
    }
    if (replyRequests.some((request) => !verifyWebhookSignature(request, webhookCreation.signingSecret))) {
      throw new Error("Local receiver observed an invalid Webhook signature");
    }

    await external.request(
      `/integration/v1/endpoints/${encodeURIComponent(endpointCreation.endpoint.slug)}/conversations/${encodeURIComponent(conversationKey)}/end`,
      "POST"
    );
    const thirdSubmitted = await submitTask(external, endpointCreation.endpoint.slug, {
      requestId: `smoke-third-${suffix}`,
      conversationKey,
      message: "这是结束 Conversation 后的新一轮。只回复：integration smoke new session",
      parameters: {}
    });
    recordTaskIdentity(trace, thirdSubmitted);
    const third = await waitForTask(external, config, thirdSubmitted.taskId);
    recordTaskIdentity(trace, third);
    requireSucceeded(third);
    if (third.sessionId === first.sessionId) throw new Error("Ended Conversation reused its old Session");

    const finalDeliveries = await waitForReplyDeliveries(
      management,
      config,
      endpointCreation.endpoint.id,
      [first.taskId, second.taskId, third.taskId]
    );
    for (const delivery of finalDeliveries) {
      if (!trace.deliveryIds.includes(delivery.id)) trace.deliveryIds.push(delivery.id);
    }
    const finalReplyRequests = receiver.requests.filter((request) => request.eventType === "message.agent.reply");
    assertReplyDeliveryOrder(
      [first.taskId, second.taskId, third.taskId],
      finalDeliveries,
      finalReplyRequests.map((request) => request.eventId)
    );
    if (finalReplyRequests.some((request) => !verifyWebhookSignature(request, webhookCreation.signingSecret))) {
      throw new Error("Local receiver observed an invalid final Webhook signature");
    }

    traceOutput("succeeded", trace);
  } catch (error) {
    await refreshFailureTrace(management, trace);
    traceOutput("failed", trace);
    throw error;
  } finally {
    await closeWithDeadline(receiver.server);
  }
};

const usage = (): void => {
  console.log(`Usage: pnpm smoke:integrations

Required environment:
  SMOKE_BASE_URL=http://127.0.0.1:3000
  SMOKE_API_TOKEN=<management API token>
  SMOKE_AGENT_ID=<enabled, ready Agent ID>

Optional deadlines:
  SMOKE_POLL_INTERVAL_MS=1000
  SMOKE_TASK_TIMEOUT_MS=300000
  SMOKE_REQUEST_TIMEOUT_MS=30000

Run this command on the same host as Remote Agent Server. It creates durable audit records and a local temporary Webhook receiver; it does not delete the records by default.`);
};

export const main = async (env: Record<string, string | undefined> = process.env): Promise<void> => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) return usage();
  if (process.argv.slice(2).length > 0) throw new Error(`Unknown argument: ${process.argv.slice(2)[0]}`);
  await runIntegrationSmoke(loadSmokeConfig(env));
};

const isEntrypoint = process.argv[1]?.endsWith("smoke-integrations.ts") ?? false;
if (isEntrypoint) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
