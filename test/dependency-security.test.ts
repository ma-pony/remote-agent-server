import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fromShadcn = createRequire(require.resolve("shadcn"));
const fromMcpSdk = createRequire(fromShadcn.resolve("@modelcontextprotocol/sdk/server/index.js"));
const fromExpress = createRequire(fromMcpSdk.resolve("express"));
const fromConcurrently = createRequire(require.resolve("concurrently"));

const shellQuote: { quote(tokens: Array<string | { comment: string }>): string } = fromConcurrently("shell-quote");
const proxyAddr: {
  (request: { socket: { remoteAddress: string }; headers: Record<string, string> }, trust: unknown): string;
  compile(subnet: string): unknown;
} = fromExpress("proxy-addr");

describe("dependency security regressions", () => {
  it("rejects a newline after a shell comment token before constructing a command", () => {
    expect(() => shellQuote.quote(["echo", "ok", { comment: "note" }, "first\nprintf unexpected;#"]))
      .toThrow(TypeError);
    expect(shellQuote.quote(["echo", "two words"])).toBe("echo 'two words'");
  });

  it("does not trust an arbitrary IPv4 peer through an IPv6 subnet with a short prefix", () => {
    const request = { socket: { remoteAddress: "203.0.113.7" }, headers: { "x-forwarded-for": "10.1.2.3" } };
    expect(proxyAddr(request, proxyAddr.compile("::ffff:10.0.0.0/8"))).toBe("203.0.113.7");
    for (const subnet of ["10.0.0.0/8", "::ffff:10.0.0.0/104"]) {
      expect(proxyAddr({ ...request, socket: { remoteAddress: "10.20.30.40" } }, proxyAddr.compile(subnet)))
        .toBe("10.1.2.3");
    }
  });
});
