const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");

const model = "fixture-model";
const thread = { id: "fixture-codex-session", name: null, turns: [] };
let nextTurn = 0;

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
      respond(id, { config: { model_provider: "openai" }, layers: [] });
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
    case "thread/resume":
      respond(id, { thread, model, modelProvider: "openai", reasoningEffort: "medium" });
      break;
    case "thread/read":
      respond(id, { thread });
      break;
    case "thread/goal/get":
      respond(id, { goal: null });
      break;
    case "thread/unsubscribe":
      respond(id, {});
      break;
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
