export type McpTransport = "http" | "stdio";
export type McpSourceType = "fixed" | "session_parameter" | "runtime";
export type RuntimeMcpKey =
  | "agent_id"
  | "session_id"
  | "run_id"
  | "workspace_path"
  | "browser_profile_path";

export type RuntimeMcpServer =
  | {
      type: "http";
      name: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
    }
  | {
      type: "stdio";
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    };

export type ResolvedMcpServer = {
  id: string;
  checkTimeoutMs: number;
  server: RuntimeMcpServer;
};

export type ResolveMcpContext = {
  agentId: string;
  sessionId: string;
  runId: string;
  workspacePath: string;
  browserProfilePath: string;
};

type McpFixedValueInput = {
  id?: string;
  source: "fixed";
  value?: string;
  secret?: boolean;
};

type McpSessionValueInput = {
  id?: string;
  source: "session_parameter";
  parameterKey: string;
};

type McpRuntimeValueInput = {
  id?: string;
  source: "runtime";
  runtimeKey: RuntimeMcpKey;
};

export type McpValueInput = McpFixedValueInput | McpSessionValueInput | McpRuntimeValueInput;
export type McpNamedValueInput = McpValueInput & { name: string };

type McpServerBaseInput = {
  name: string;
  enabled: boolean;
  checkTimeoutSeconds: number;
};

export type McpServerWriteInput =
  | (McpServerBaseInput & {
      transport: "http";
      url: string;
      headers: McpNamedValueInput[];
    })
  | (McpServerBaseInput & {
      transport: "stdio";
      command: string;
      arguments: McpValueInput[];
      environment: McpNamedValueInput[];
    });

export type AgentMcpValueView = {
  id: string;
  source: McpSourceType;
  name?: string;
  value?: string;
  secret?: boolean;
  configured?: boolean;
  parameterKey?: string;
  runtimeKey?: RuntimeMcpKey;
};

export type AgentMcpServerSummary = {
  id: string;
  agentId: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  checkTimeoutSeconds: number;
  lastCheckedAt: string | null;
  lastCheckStatus: "passed" | "failed" | null;
  lastCheckMessage: string | null;
  lastToolCount: number | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentMcpServerDetail = AgentMcpServerSummary & (
  | { transport: "http"; url: string; headers: AgentMcpValueView[] }
  | {
      transport: "stdio";
      command: string;
      arguments: AgentMcpValueView[];
      environment: AgentMcpValueView[];
    }
);

export type AgentSessionParameter = {
  id: string;
  agentId: string;
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  secret: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateSessionParameterInput = {
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  secret: boolean;
};

export type UpdateSessionParameterInput = {
  label: string;
  description: string | null;
  required: boolean;
};

export type NormalizedSessionMcpValue = {
  parameterId: string;
  key: string;
  required: boolean;
  secret: boolean;
  value: string | null;
};

export type SessionMcpParameterStatus = {
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  secret: boolean;
  configured: boolean;
  value?: string;
};

export type SessionMcpStatus = {
  mcpParametersValid: boolean;
  missingMcpParameters: string[];
  mcpParameters: SessionMcpParameterStatus[];
};

export type McpCheckResult =
  | { status: "passed"; toolCount: number; message: string }
  | { status: "failed"; code: "mcp_check_failed"; message: string };
