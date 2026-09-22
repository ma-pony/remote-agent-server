import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { Transform } from "node:stream";
import type { CaptureProtocol } from "./config.js";
export type CapturedExchange = { request: Buffer; response: Buffer; requestEncoding: string; responseEncoding: string;
  contentType: string; endpoint: string; status: number; issue: string | null };
export type RelayRoute = { baseUrl: string; credential: string; revoke(): Promise<void> };
type Upstream = { baseUrl: string; protocol: CaptureProtocol; apiKey: string };
type Route = { upstream: Upstream; begin(): unknown; finish(binding: unknown, exchange: CapturedExchange): void | Promise<void> };
const hopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
function headers(input: IncomingHttpHeaders, credentials: boolean): IncomingHttpHeaders {
  const excluded = new Set([...hopHeaders, ...String(input.connection ?? "").toLowerCase().split(",").map((key) => key.trim())]);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !excluded.has(key) && (!credentials || !/auth|api[-_]?key|cookie|token|secret|credential|signature/i.test(key))));
}
/** Transparent loopback HTTP transport. Business bindings and persistence belong to the caller. */
export class UsageHttpRelay {
  private server?: Server;
  private closed = false;
  private starting?: Promise<void>;
  private readonly routes = new Map<string, Route>();
  private readonly sockets = new Set<Socket>();
  private readonly active = new Map<ClientRequest, { token: string; finish(issue: string): void }>();
  private readonly work = new Set<Promise<void>>();
  private observedWork = 0;
  constructor(private readonly limits: { maxBodyBytes?: number; maxObservedRequests?: number } = {}) {}
  async register<T>(upstream: Upstream, begin: () => T, finish: (binding: T, exchange: CapturedExchange) => void | Promise<void>): Promise<RelayRoute> {
    if (this.closed) throw new Error("capture_closed");
    await this.start();
    if (this.closed) throw new Error("capture_closed");
    const token = randomBytes(32).toString("hex");
    this.routes.set(token, { upstream, begin, finish: (binding, exchange) => finish(binding as T, exchange) });
    const port = (this.server!.address() as { port: number }).port;
    return { baseUrl: `http://127.0.0.1:${port}/${token}`, credential: randomBytes(32).toString("hex"), revoke: async () => {
      this.routes.delete(token);
      for (const [request, item] of this.active) {
        if (item.token !== token) continue;
        item.finish("interrupted");
        request.destroy();
      }
      await this.drain();
    } };
  }
  private start(): Promise<void> {
    return this.starting ??= new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => {
        const match = /^\/([a-f0-9]{64})(\/[^#]*)?$/.exec(req.url ?? "");
        const route = match ? this.routes.get(match[1]!) : undefined;
        if (!route) {
          res.writeHead(404).end();
          return;
        }
        const endpoint = match![2] ?? "/";
        const base = new URL(route.upstream.baseUrl);
        const basePath = base.pathname.replace(/\/$/, "");
        // SDKs differ on whether the version suffix is part of baseURL.
        base.pathname = basePath + (basePath.endsWith("/v1") && endpoint.startsWith("/v1/") ? endpoint.slice(3).split("?")[0] : endpoint.split("?")[0]);
        base.search = endpoint.includes("?") ? endpoint.slice(endpoint.indexOf("?")) : "";
        const outbound = headers(req.headers, true);
        if (route.upstream.protocol === "anthropic_messages") outbound["x-api-key"] = route.upstream.apiKey;
        else outbound.authorization = `Bearer ${route.upstream.apiKey}`;
        let binding: unknown;
        let issue: string | null = null;
        try {
          binding = route.begin();
        } catch {
          issue = "binding_unavailable";
        }
        const reserved = issue === null && this.observedWork < (this.limits.maxObservedRequests ?? 64);
        if (reserved) this.observedWork++;
        else issue ??= "capture_capacity";
        const exchange: CapturedExchange = { request: Buffer.alloc(0), response: Buffer.alloc(0), requestEncoding: String(req.headers["content-encoding"] ?? "identity"), responseEncoding: "identity", contentType: "", endpoint: endpoint.split("?")[0]!, status: 0, issue };
        const chunks = { request: [] as Buffer[], response: [] as Buffer[] };
        const sizes = { request: 0, response: 0 };
        const tap = (field: "request" | "response") => new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
          if (exchange.issue === null) {
            if (sizes[field] + chunk.length > (this.limits.maxBodyBytes ?? 2 * 1024 * 1024)) {
              exchange.issue = "body_limit";
              chunks.request = [];
              chunks.response = [];
            } else {
              sizes[field] += chunk.length;
              chunks[field].push(chunk);
            }
          }
          callback(null, chunk);
        } });
        let finished = false;
        const finish = (reason?: string) => {
          if (finished) return;
          finished = true;
          this.active.delete(upstream);
          exchange.issue ??= reason ?? null;
          exchange.request = Buffer.concat(chunks.request);
          exchange.response = Buffer.concat(chunks.response);
          const work = Promise.resolve().then(() => route.finish(binding, exchange)).catch(() => {}).then(() => {
            if (reserved) this.observedWork--;
            this.work.delete(work);
          });
          this.work.add(work);
        };
        const upstream = (base.protocol === "https:" ? httpsRequest : httpRequest)(base, { method: req.method, headers: outbound }, (response) => {
          exchange.status = response.statusCode ?? 502;
          exchange.responseEncoding = String(response.headers["content-encoding"] ?? "identity");
          exchange.contentType = String(response.headers["content-type"] ?? "");
          res.writeHead(exchange.status, headers(response.headers, false));
          response.on("error", () => {
            finish("upstream_aborted");
            res.destroy();
          });
          response.on("end", () => finish());
          response.pipe(tap("response")).pipe(res);
        });
        this.active.set(upstream, { token: match![1]!, finish });
        upstream.on("error", () => {
          finish("upstream_failed");
          if (!res.headersSent) res.writeHead(502).end();
          else res.destroy();
        });
        const abort = () => {
          finish("downstream_aborted");
          upstream.destroy();
        };
        req.on("aborted", abort);
        req.on("error", abort);
        res.on("close", () => {
          if (!res.writableFinished) abort();
        });
        req.pipe(tap("request")).pipe(upstream);
      });
      this.server.on("connection", (socket) => {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
      });
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
  }
  async drain(): Promise<void> {
    while (this.work.size) await Promise.all([...this.work]);
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.starting?.catch(() => undefined);
    this.routes.clear();
    for (const [request, item] of this.active) {
      item.finish("interrupted");
      request.destroy();
    }
    for (const socket of this.sockets) socket.destroy();
    await this.drain();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
