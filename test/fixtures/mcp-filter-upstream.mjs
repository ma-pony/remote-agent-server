import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const pidFile = process.env.MCP_TEST_PID_FILE;
if (pidFile !== undefined) {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    stdio: ["ignore", "inherit", "inherit"]
  });
  await writeFile(pidFile, JSON.stringify({ upstream: process.pid, descendant: descendant.pid }));
}
if (process.env.MCP_TEST_EXIT_AFTER_START === "1") setTimeout(() => process.exit(0), 250);

const server = new Server(
  { name: "filter-test-upstream", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} }, instructions: "测试上游说明" }
);

server.setRequestHandler("tools/list", async () => ({
  tools: [
    { name: "allowed_tool", inputSchema: { type: "object" } },
    { name: "hidden_tool", inputSchema: { type: "object" } }
  ]
}));
server.setRequestHandler("tools/call", async (request) => ({
  content: [{ type: "text", text: request.params.name }]
}));
server.setRequestHandler("resources/list", async () => ({
  resources: [{ uri: "docs://guide", name: "Guide", mimeType: "text/plain" }]
}));
server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: [] }));
server.setRequestHandler("resources/read", async (request) => ({
  contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "guide body" }]
}));

await server.connect(new StdioServerTransport());
