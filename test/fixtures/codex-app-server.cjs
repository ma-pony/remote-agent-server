const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");

const model = "fixture-model";
const thread = { id: "fixture-codex-session", name: null, turns: [] };
let nextTurn = 0;
let mcpPolls = 0;
const state = () => process.env.CODEX_TEST_STATE_PATH
  ? JSON.parse(readFileSync(process.env.CODEX_TEST_STATE_PATH, "utf8"))
  : {};
if (process.env.CODEX_TEST_PID_PATH) writeFileSync(process.env.CODEX_TEST_PID_PATH, String(process.pid));

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ id, result });

createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  appendFileSync(process.env.CODEX_TEST_REQUESTS_PATH, `${JSON.stringify({ method, params })}\n`);
  switch (method) {
    case "initialize":
      respond(id, { userAgent: "fixture-codex", codexHome: process.env.CODEX_HOME });
      break;
    case "account/read":
      respond(id, { account: { type: "apiKey" }, requiresOpenaiAuth: false });
      break;
    case "config/read":
      respond(id, { config: {
        model_provider: "openai",
        mcp_servers: Object.fromEntries((state().configuredServers ?? []).map(name => [name, { command: "config-fixture-mcp" }]))
      }, layers: [] });
      break;
    case "skills/list":
      respond(id, { data: [] });
      break;
    case "model/list":
      respond(id, {
        data: [{
          id: model,
          model,
          displayName: "Fixture",
          description: "Local test model",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Fixture" }]
        }],
        nextCursor: null
      });
      break;
    case "thread/start":
    case "thread/resume": {
      const sessionThread = params.ephemeral ? { ...thread, id: "fixture-title-session" } : thread;
      respond(id, { thread: sessionThread, model, modelProvider: "openai", reasoningEffort: "medium" });
      for (const event of state().startupEvents ?? []) {
        send({ method: "mcpServer/startupStatus/updated", params: {
          threadId: sessionThread.id, name: "docs", error: null, ...event
        } });
      }
      break;
    }
    case "thread/read":
      respond(id, { thread });
      break;
    case "thread/turns/list":
      respond(id, { data: [], nextCursor: null });
      break;
    case "thread/goal/get":
      respond(id, { goal: null });
      break;
    case "thread/unsubscribe":
    case "thread/name/set":
      respond(id, {});
      break;
    case "mcpServerStatus/list": {
      const settings = state();
      if (settings.hangMcpList) break;
      if (settings.exitOnMcpList) process.exit(2);
      if (!params.cursor) mcpPolls += 1;
      const all = (settings.servers ?? []).map(server => {
        const runtimeStatus = server.readyAfterPolls && mcpPolls >= server.readyAfterPolls
          ? "connected" : server.runtimeStatus;
        return {
          name: server.name, runtimeStatus,
          // A failed/disconnected server can still have cached metadata.
          serverInfo: server.serverInfo ?? (runtimeStatus === "connected" ? { name: server.name, version: "1" } : null),
          tools: {}, resources: [], resourceTemplates: [], authStatus: "notLoggedIn",
          pluginId: null, httpOrigin: null, serverCapabilities: null, toolsError: null
        };
      });
      const offset = Number(params.cursor ?? 0);
      const size = settings.pageSize ?? all.length;
      const data = all.slice(offset, offset + size);
      appendFileSync(process.env.CODEX_TEST_REQUESTS_PATH, `${JSON.stringify({
        method: "fixture/mcp-status", params: { threadId: params.threadId, data }
      })}\n`);
      respond(id, { data, nextCursor: offset + size < all.length ? String(offset + size) : null });
      break;
    }
    case "turn/start": {
      const turn = { id: `fixture-turn-${++nextTurn}`, status: "completed", items: [], error: null };
      respond(id, { turn });
      send({ method: "turn/completed", params: { threadId: params.threadId, turn } });
      break;
    }
    default:
      send({ id, error: { code: -32601, message: `Unexpected fixture method: ${method}` } });
  }
});
