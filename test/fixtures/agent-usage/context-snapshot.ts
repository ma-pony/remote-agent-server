export const snapshotFixture = (revision = 1) => ({
  format: "context-snapshot-v1", revision, historyComplete: true,
  capabilities: [{ runtimeName: "mcp_search", capability: { id: "mcp:server-1:search", kind: "mcp_tool", name: "search", serverId: "server-1" } }],
  requests: [
    { id: "capture-1", session_id: "capture-session", timestamp: "2026-09-21T01:00:00", provider: "openai", endpoint: "/v1/responses", agent: "codex",
      context_fidelity: "complete", response_complete: true,
      canonical_request_body: JSON.stringify({ model: "gpt-4.1", tools: [{ type: "function", name: "mcp_search", parameters: { type: "object" } }], input: [] }),
      canonical_response_body: JSON.stringify({ id: "response-1", output: [{ type: "function_call", call_id: "call-1", name: "mcp_search", arguments: "{}" }], usage: { input_tokens: 100, output_tokens: 20 } }) },
    { id: "capture-2", session_id: "capture-session", timestamp: "2026-09-21T01:01:00Z", provider: "openai", endpoint: "/v1/responses", agent: "codex",
      context_fidelity: "complete", response_complete: true,
      canonical_request_body: JSON.stringify({ model: "gpt-4.1", input: [{ type: "function_call_output", call_id: "call-1", output: "hello world" }] }),
      canonical_response_body: JSON.stringify({ id: "response-2", output: [], tools: [{ name: "echoed-config" }], usage: { input_tokens: 150, output_tokens: 10 } }) }
  ]
});
