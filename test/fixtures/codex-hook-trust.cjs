const { appendFileSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const home = process.env.CODEX_HOME;
const log = process.env.CODEX_TRUST_TEST_LOG;
const statePath = join(home, "fixture-trust.json");
writeFileSync(process.env.CODEX_TRUST_TEST_PID, String(process.pid));
const mode = process.env.CODEX_TRUST_TEST_MODE;
const hash = process.env.CODEX_TRUST_TEST_HASH ?? "a".repeat(64);
const readState = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const send = (id, result) => {
  const frame = Buffer.from(JSON.stringify({ id, result }) + "\n");
  const split = mode === "chunked_utf8" ? frame.lastIndexOf(Buffer.from("私有目录")) + 1 : 0;
  if (split > 0) {
    process.stdout.write(frame.subarray(0, split));
    setTimeout(() => process.stdout.write(frame.subarray(split)), 10);
  } else process.stdout.write(frame);
};
const hooks = () => {
  if (mode === "disabled_feature" && readState()._hooksFeature !== true) return [];
  const config = JSON.parse(readFileSync(join(home, "hooks.json"), "utf8"));
  const trusted = readState();
  return (config.hooks.PreToolUse ?? []).flatMap((group, i) => group.hooks.map((hook, j) => {
    const key = `${join(home, "hooks.json")}:pre_tool_use:${i}:${j}`;
    return { key: mode === "wrong_key" ? "unrelated-key" : key,
      sourcePath: mode === "wrong_path" ? join(home, "foreign-hooks.json") : join(home, "hooks.json"), source: "user", eventName: "preToolUse", handlerType: "command",
      command: mode === "wrong_command" ? "foreign-command" : hook.command, matcher: group.matcher,
      enabled: mode !== "disabled_feature" || trusted._hooksFeature === true, async: false,
      currentHash: mode === "changed_during_write" && trusted[key] ? "b".repeat(64) : hash, trustStatus: trusted[key] === hash ? "trusted" : "untrusted" };
  }));
};
createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  appendFileSync(log, JSON.stringify({ method, params }) + "\n");
  if (mode === "oversized" && method === "hooks/list") { process.stdout.write("x".repeat(1024 * 1024 + 1)); return; }
  if (mode === "hang_tree" && method === "hooks/list") {
    const child = require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    writeFileSync(process.env.CODEX_TRUST_TEST_CHILD_PID, String(child.pid)); return;
  }
  if (mode === "hang" && method === "hooks/list") return;
  if (mode === "error" && method === "hooks/list") {
    process.stdout.write(JSON.stringify({ id, error: { code: -1, message: "private fixture diagnostic" } }) + "\n"); return;
  }
  if (method === "initialize") send(id, {});
  else if (method === "config/read") send(id, { config: { features: { hooks: mode !== "disabled_feature" || readState()._hooksFeature === true } } });
  else if (method === "hooks/list") send(id, { data: [{ cwd: params.cwds[0], hooks: hooks(), errors: [], warnings: [] }] });
  else if (method === "config/batchWrite") {
    const state = readState();
    for (const edit of params.edits) {
      if (edit.keyPath === "features.hooks") { state._hooksFeature = edit.value; continue; }
      const key = JSON.parse(edit.keyPath.slice("hooks.state.".length, -".trusted_hash".length));
      state[key] = edit.value;
    }
    if (mode !== "ignore_write") writeFileSync(statePath, JSON.stringify(state));
    send(id, {});
  }
});
