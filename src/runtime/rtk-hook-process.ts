import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pinRtkCommand } from "./rtk-command.js";

export { pinRtkCommand } from "./rtk-command.js";

/** Runs inside the Provider's owned process tree; never starts a detached process. */
export const runRtkHook = async (agent: string): Promise<void> => {
  if (process.env.REMOTE_AGENT_RTK_ENABLED !== "1") { process.stdin.resume(); return; }
  const binary = process.env.REMOTE_AGENT_RTK_BINARY;
  if (!binary || !["claude", "codex", "hermes"].includes(agent)) { process.stdin.resume(); return; }
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 1024 * 1024) return;
  }
  const child = spawn(binary, agent === "hermes" ? ["rewrite", input] : ["hook", agent], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let excessive = false;
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  child.stdout.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(output) + chunk.length > 1024 * 1024) { excessive = true; child.kill("SIGKILL"); }
    else output += chunk.toString();
  });
  // Keep diagnostics out of hook JSON and avoid exposing commands in service logs.
  child.stderr.resume();
  child.stdin.on("error", () => undefined);
  child.stdin.end(agent === "hermes" ? undefined : input);
  await new Promise<void>((done) => {
    child.once("error", () => { clearTimeout(timer); done(); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!excessive && (code === 0 || (agent === "hermes" && code === 3))) {
        if (agent === "hermes") {
          const rewritten = pinRtkCommand(output.trim(), binary);
          if (rewritten) process.stdout.write(rewritten);
        } else try {
          const response = JSON.parse(output);
          const command = response?.hookSpecificOutput?.updatedInput?.command;
          const rewritten = typeof command === "string" ? pinRtkCommand(command, binary) : null;
          if (response?.hookSpecificOutput?.permissionDecision === "deny") {
            process.stdout.write(JSON.stringify(response)); done(); return;
          }
          if (rewritten) {
            response.hookSpecificOutput.updatedInput.command = rewritten;
            process.stdout.write(JSON.stringify(response));
          } else if (response?.hookSpecificOutput?.permissionDecision === "ask") {
            // Keep the permission request, but never forward an unpinned rewrite.
            delete response.hookSpecificOutput.updatedInput;
            process.stdout.write(JSON.stringify(response));
          }
        } catch { /* Unsupported hook input or output leaves the original command intact. */ }
      }
      done();
    });
  });
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void runRtkHook(process.argv[2] ?? "").catch(() => undefined);
