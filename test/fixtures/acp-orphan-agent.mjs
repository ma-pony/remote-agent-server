import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const pidFile = process.env.ACP_TEST_PID_FILE;
const mode = process.env.ACP_TEST_MODE;
if (pidFile === undefined) throw new Error("Missing ACP_TEST_PID_FILE");

let descendant;
const startDescendant = async () => {
  if (descendant !== undefined) return;
  descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    detached: true,
    stdio: "ignore"
  });
  descendant.unref();
  await writeFile(pidFile, JSON.stringify({ agent: process.pid, descendant: descendant.pid }));
};
if (mode !== "crash-after-session") await startDescendant();

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line);
    if (request.method === "session/new") {
      await startDescendant();
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { sessionId: "test-session" }
      })}\n`);
      setTimeout(() => process.exit(1), 250);
      continue;
    }
    if (request.method !== "initialize") continue;
    if (mode === "fail-initialize") {
      setTimeout(() => process.exit(1), 250);
      continue;
    }
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params.protocolVersion,
        agentCapabilities: {},
        authMethods: []
      }
    })}\n`);
  }
});
process.stdin.on("end", () => process.exit(0));
