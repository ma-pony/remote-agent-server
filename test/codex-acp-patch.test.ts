import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const codexAcpSource = (): string => readFileSync(require.resolve("@agentclientprotocol/codex-acp"), "utf8");

describe("Codex ACP MCP startup patch", () => {
  it("uses thread-scoped server info instead of transient cancelled notifications", () => {
    const source = codexAcpSource();

    expect(source).toContain("async waitForMcpServerReadiness(sessionId, requestedServers)");
    expect(source).toContain("listMcpServers(sessionId)");
    expect(source).toContain("server !== undefined && server.serverInfo !== null");
    expect(source).not.toContain("runtimeStatus");
    expect(source).not.toContain("...mcpStartup.cancelled\n    ].filter");
  });
});
