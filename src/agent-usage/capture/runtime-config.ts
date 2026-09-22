import { UsageError } from "../core/errors.js";
import type { Provider } from "../../domain.js";
import type { RelayRoute } from "./http-relay.js";
/** Only local opaque credentials enter the child. Routing overrides remain ephemeral. */
export function captureRuntimeEnvironment(provider: Provider, route: RelayRoute): { unset: string[]; values: Record<string, string> } {
  if (provider === "codex") return { unset: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_CONFIG"], values: {
    REMOTE_AGENT_CAPTURE_KEY: route.credential,
    CODEX_CONFIG: JSON.stringify({ model_provider: "remote_agent_capture", model_providers: { remote_agent_capture: {
      name: "Managed usage capture", base_url: route.baseUrl + "/v1", env_key: "REMOTE_AGENT_CAPTURE_KEY", wire_api: "responses",
      supports_websockets: false, requires_openai_auth: false
    } } })
  } };
  if (provider === "claude_code") return { unset: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL"],
    values: { ANTHROPIC_API_KEY: route.credential, ANTHROPIC_BASE_URL: route.baseUrl } };
  throw new UsageError("usage_capture_runtime_unsupported");
}
