import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { isAbsolute, delimiter, join } from "node:path";

import type Database from "better-sqlite3";

import type { SecretStore } from "./secret-store.js";
import type {
  AgentMcpServerDetail,
  AgentMcpServerSummary,
  AgentMcpValueView,
  AgentSessionParameter,
  CreateSessionParameterInput,
  McpCheckResult,
  McpNamedValueInput,
  McpServerWriteInput,
  McpValueInput,
  NormalizedSessionMcpValue,
  ResolvedMcpServer,
  ResolveMcpContext,
  RuntimeMcpKey,
  SessionMcpStatus,
  UpdateSessionParameterInput
} from "./mcp-types.js";

export type McpManagerErrorCode =
  | "agent_not_found"
  | "mcp_server_not_found"
  | "mcp_parameter_not_found"
  | "invalid_mcp_server"
  | "invalid_mcp_value"
  | "duplicate_mcp_name"
  | "duplicate_mcp_parameter"
  | "mcp_parameter_in_use"
  | "missing_session_mcp_parameters"
  | "unknown_session_mcp_parameter"
  | "mcp_check_failed";

export class McpManagerError extends Error {
  constructor(readonly code: McpManagerErrorCode) {
    super(code);
    this.name = "McpManagerError";
  }
}

type McpServerRow = {
  id: string;
  agent_id: string;
  name: string;
  transport: "http" | "stdio";
  enabled: 0 | 1;
  url: string | null;
  command: string | null;
  check_timeout_seconds: number;
  last_checked_at: string | null;
  last_check_status: "passed" | "failed" | null;
  last_check_message: string | null;
  last_tool_count: number | null;
  created_at: string;
  updated_at: string;
};

type McpValueRow = {
  id: string;
  mcp_server_id: string;
  kind: "argument" | "header" | "environment";
  position: number;
  target_name: string | null;
  source_type: "fixed" | "session_parameter" | "runtime";
  plain_value: string | null;
  encrypted_value: string | null;
  secret: 0 | 1;
  session_parameter_id: string | null;
  parameter_key: string | null;
  parameter_secret: 0 | 1 | null;
  runtime_key: RuntimeMcpKey | null;
};

type SessionParameterRow = {
  id: string;
  agent_id: string;
  key: string;
  label: string;
  description: string | null;
  required: 0 | 1;
  secret: 0 | 1;
  created_at: string;
  updated_at: string;
};

type SessionValueRow = {
  parameter_id: string;
  plain_value: string | null;
  encrypted_value: string | null;
};

const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PARAMETER_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const COMMAND_PATTERN = /^[A-Za-z0-9._+-]+$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);
const RUNTIME_KEYS = new Set<RuntimeMcpKey>([
  "agent_id",
  "session_id",
  "run_id",
  "workspace_path",
  "browser_profile_path"
]);

const toSummary = (row: McpServerRow): AgentMcpServerSummary => ({
  id: row.id,
  agentId: row.agent_id,
  name: row.name,
  transport: row.transport,
  enabled: row.enabled === 1,
  checkTimeoutSeconds: row.check_timeout_seconds,
  lastCheckedAt: row.last_checked_at,
  lastCheckStatus: row.last_check_status,
  lastCheckMessage: row.last_check_message,
  lastToolCount: row.last_tool_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const toParameter = (row: SessionParameterRow): AgentSessionParameter => ({
  id: row.id,
  agentId: row.agent_id,
  key: row.key,
  label: row.label,
  description: row.description,
  required: row.required === 1,
  secret: row.secret === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const nonEmpty = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

/** Stores Agent MCP definitions and resolves them for one Session Run. */
export class McpManager {
  constructor(private readonly dependencies: { db: Database.Database; secrets: SecretStore }) {}

  private get db(): Database.Database {
    return this.dependencies.db;
  }

  private get secrets(): SecretStore {
    return this.dependencies.secrets;
  }

  listServers(agentId: string): AgentMcpServerSummary[] {
    this.requireAgent(agentId);
    return (this.db.prepare(
      "SELECT * FROM agent_mcp_servers WHERE agent_id = ? ORDER BY created_at ASC, id ASC"
    ).all(agentId) as McpServerRow[]).map(toSummary);
  }

  getServer(agentId: string, id: string): AgentMcpServerDetail | undefined {
    const row = this.getServerRow(agentId, id);
    if (row === undefined) return undefined;
    const summary = toSummary(row);
    const values = this.listValueRows(row.id).map((value) => this.toValueView(value));
    if (row.transport === "http") {
      return { ...summary, transport: "http", url: row.url!, headers: values };
    }
    return {
      ...summary,
      transport: "stdio",
      command: row.command!,
      arguments: values.filter((value) => value.name === undefined),
      environment: values.filter((value) => value.name !== undefined)
    };
  }

  createServer(agentId: string, input: McpServerWriteInput): AgentMcpServerDetail {
    this.requireAgent(agentId);
    this.validateServerInput(agentId, input);
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      this.db.transaction(() => {
        this.db.prepare(`
          INSERT INTO agent_mcp_servers
            (id, agent_id, name, transport, enabled, url, command, check_timeout_seconds, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          agentId,
          input.name,
          input.transport,
          input.enabled ? 1 : 0,
          input.transport === "http" ? input.url : null,
          input.transport === "stdio" ? input.command : null,
          input.checkTimeoutSeconds,
          now,
          now
        );
        this.insertValues(agentId, id, input, new Map());
      }).immediate();
    } catch (error) {
      if (error instanceof Error && error.message.includes("agent_mcp_servers.agent_id, agent_mcp_servers.name")) {
        throw new McpManagerError("duplicate_mcp_name");
      }
      throw error;
    }
    return this.getServer(agentId, id)!;
  }

  updateServer(agentId: string, id: string, input: McpServerWriteInput): AgentMcpServerDetail | undefined {
    const existing = this.getServerRow(agentId, id);
    if (existing === undefined) return undefined;
    if (existing.transport !== input.transport) throw new McpManagerError("invalid_mcp_server");
    this.validateServerInput(agentId, input);
    const existingValues = new Map(this.listValueRows(id).map((row) => [row.id, row]));
    const now = new Date().toISOString();
    try {
      this.db.transaction(() => {
        this.db.prepare(`
          UPDATE agent_mcp_servers SET
            name = ?, enabled = ?, url = ?, command = ?, check_timeout_seconds = ?,
            last_checked_at = NULL, last_check_status = NULL, last_check_message = NULL,
            last_tool_count = NULL, updated_at = ?
          WHERE id = ? AND agent_id = ?
        `).run(
          input.name,
          input.enabled ? 1 : 0,
          input.transport === "http" ? input.url : null,
          input.transport === "stdio" ? input.command : null,
          input.checkTimeoutSeconds,
          now,
          id,
          agentId
        );
        this.db.prepare("DELETE FROM agent_mcp_values WHERE mcp_server_id = ?").run(id);
        this.insertValues(agentId, id, input, existingValues);
      }).immediate();
    } catch (error) {
      if (error instanceof Error && error.message.includes("agent_mcp_servers.agent_id, agent_mcp_servers.name")) {
        throw new McpManagerError("duplicate_mcp_name");
      }
      throw error;
    }
    return this.getServer(agentId, id)!;
  }

  deleteServer(agentId: string, id: string): boolean {
    return this.db.prepare("DELETE FROM agent_mcp_servers WHERE id = ? AND agent_id = ?").run(id, agentId).changes === 1;
  }

  listParameterDefinitions(agentId: string): AgentSessionParameter[] {
    this.requireAgent(agentId);
    return (this.db.prepare(
      "SELECT * FROM agent_session_parameters WHERE agent_id = ? ORDER BY created_at ASC, id ASC"
    ).all(agentId) as SessionParameterRow[]).map(toParameter);
  }

  createParameterDefinition(agentId: string, input: CreateSessionParameterInput): AgentSessionParameter {
    this.requireAgent(agentId);
    this.validateParameterInput(input.key, input.label);
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      this.db.prepare(`
        INSERT INTO agent_session_parameters
          (id, agent_id, key, label, description, required, secret, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, agentId, input.key, input.label.trim(), input.description, input.required ? 1 : 0, input.secret ? 1 : 0, now, now);
    } catch (error) {
      if (error instanceof Error && error.message.includes("agent_session_parameters.agent_id, agent_session_parameters.key")) {
        throw new McpManagerError("duplicate_mcp_parameter");
      }
      throw error;
    }
    return toParameter(this.requireParameterRow(agentId, id));
  }

  updateParameterDefinition(
    agentId: string,
    id: string,
    input: UpdateSessionParameterInput
  ): AgentSessionParameter | undefined {
    if (!nonEmpty(input.label)) throw new McpManagerError("invalid_mcp_value");
    const result = this.db.prepare(`
      UPDATE agent_session_parameters
      SET label = ?, description = ?, required = ?, updated_at = ?
      WHERE id = ? AND agent_id = ?
    `).run(input.label.trim(), input.description, input.required ? 1 : 0, new Date().toISOString(), id, agentId);
    if (result.changes !== 1) return undefined;
    return toParameter(this.requireParameterRow(agentId, id));
  }

  deleteParameterDefinition(agentId: string, id: string): boolean {
    const used = this.db.prepare(`
      SELECT 1 FROM agent_mcp_values WHERE session_parameter_id = ?
      UNION ALL
      SELECT 1 FROM session_mcp_parameter_values WHERE parameter_id = ?
      LIMIT 1
    `).get(id, id);
    if (used !== undefined) throw new McpManagerError("mcp_parameter_in_use");
    return this.db.prepare("DELETE FROM agent_session_parameters WHERE id = ? AND agent_id = ?").run(id, agentId).changes === 1;
  }

  normalizeSessionValues(
    agentId: string,
    values: Record<string, string | null>,
    requireAll: boolean
  ): NormalizedSessionMcpValue[] {
    const definitions = this.listParameterDefinitions(agentId);
    const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
    for (const key of Object.keys(values)) {
      if (!byKey.has(key)) throw new McpManagerError("unknown_session_mcp_parameter");
    }
    if (requireAll) {
      const missing = definitions.some((definition) => definition.required && !nonEmpty(values[definition.key] ?? undefined));
      if (missing) throw new McpManagerError("missing_session_mcp_parameters");
    }
    return Object.entries(values).map(([key, value]) => {
      const definition = byKey.get(key)!;
      if (value === null) {
        if (definition.required) throw new McpManagerError("missing_session_mcp_parameters");
      } else if (!nonEmpty(value)) {
        throw new McpManagerError("invalid_mcp_value");
      }
      return {
        parameterId: definition.id,
        key,
        required: definition.required,
        secret: definition.secret,
        value
      };
    });
  }

  insertSessionValuesInTransaction(sessionId: string, values: NormalizedSessionMcpValue[]): void {
    const now = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT INTO session_mcp_parameter_values
        (session_id, parameter_id, plain_value, encrypted_value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const value of values) {
      if (value.value === null) continue;
      insert.run(
        sessionId,
        value.parameterId,
        value.secret ? null : value.value,
        value.secret ? this.secrets.encrypt(value.value) : null,
        now,
        now
      );
    }
  }

  applySessionValuePatchInTransaction(sessionId: string, values: NormalizedSessionMcpValue[]): void {
    const now = new Date().toISOString();
    for (const value of values) {
      if (value.value === null) {
        this.db.prepare(
          "DELETE FROM session_mcp_parameter_values WHERE session_id = ? AND parameter_id = ?"
        ).run(sessionId, value.parameterId);
        continue;
      }
      this.db.prepare(`
        INSERT INTO session_mcp_parameter_values
          (session_id, parameter_id, plain_value, encrypted_value, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, parameter_id) DO UPDATE SET
          plain_value = excluded.plain_value,
          encrypted_value = excluded.encrypted_value,
          updated_at = excluded.updated_at
      `).run(
        sessionId,
        value.parameterId,
        value.secret ? null : value.value,
        value.secret ? this.secrets.encrypt(value.value) : null,
        now,
        now
      );
    }
  }

  getSessionStatus(sessionId: string): SessionMcpStatus {
    const session = this.db.prepare("SELECT agent_id FROM sessions WHERE id = ?").get(sessionId) as { agent_id: string } | undefined;
    if (session === undefined) throw new McpManagerError("missing_session_mcp_parameters");
    const definitions = this.listParameterDefinitions(session.agent_id);
    const rows = this.db.prepare(
      "SELECT parameter_id, plain_value, encrypted_value FROM session_mcp_parameter_values WHERE session_id = ?"
    ).all(sessionId) as SessionValueRow[];
    const values = new Map(rows.map((row) => [row.parameter_id, row]));
    const parameters = definitions.map((definition) => {
      const row = values.get(definition.id);
      const configured = row !== undefined;
      return {
        key: definition.key,
        label: definition.label,
        description: definition.description,
        required: definition.required,
        secret: definition.secret,
        configured,
        ...(!definition.secret && row?.plain_value !== null && row?.plain_value !== undefined
          ? { value: row.plain_value }
          : {})
      };
    });
    const missingMcpParameters = parameters
      .filter((parameter) => parameter.required && !parameter.configured)
      .map((parameter) => parameter.key);
    return {
      mcpParametersValid: missingMcpParameters.length === 0,
      missingMcpParameters,
      mcpParameters: parameters
    };
  }

  resolveEnabledForRun(context: ResolveMcpContext): ResolvedMcpServer[] {
    const session = this.db.prepare("SELECT agent_id FROM sessions WHERE id = ?").get(context.sessionId) as { agent_id: string } | undefined;
    if (session?.agent_id !== context.agentId) throw new McpManagerError("missing_session_mcp_parameters");
    const values = this.sessionValues(context.sessionId);
    const rows = this.db.prepare(
      "SELECT * FROM agent_mcp_servers WHERE agent_id = ? AND enabled = 1 ORDER BY created_at ASC, id ASC"
    ).all(context.agentId) as McpServerRow[];
    return rows.map((row) => this.resolveServer(row, context, values));
  }

  resolveOneForCheck(agentId: string, serverId: string, sessionId?: string): ResolvedMcpServer | undefined {
    const row = this.getServerRow(agentId, serverId);
    if (row === undefined) return undefined;
    const valueRows = this.listValueRows(serverId);
    const requiresSession = valueRows.some((value) =>
      value.source_type === "session_parameter"
      || (value.source_type === "runtime"
        && value.runtime_key !== "agent_id"
        && value.runtime_key !== "run_id")
    );
    if (requiresSession && sessionId === undefined) throw new McpManagerError("missing_session_mcp_parameters");
    const session = sessionId === undefined
      ? undefined
      : this.db.prepare("SELECT agent_id, workspace_path FROM sessions WHERE id = ?").get(sessionId) as
        | { agent_id: string; workspace_path: string }
        | undefined;
    if (sessionId !== undefined && session?.agent_id !== agentId) throw new McpManagerError("missing_session_mcp_parameters");
    const workspacePath = session?.workspace_path ?? "";
    return this.resolveServer(row, {
      agentId,
      sessionId: sessionId ?? "",
      runId: randomUUID(),
      workspacePath,
      browserProfilePath: workspacePath === "" ? "" : join(workspacePath, "..", "browser")
    }, sessionId === undefined ? new Map() : this.sessionValues(sessionId));
  }

  recordCheckResult(serverId: string, result: McpCheckResult): void {
    this.db.prepare(`
      UPDATE agent_mcp_servers SET
        last_checked_at = ?, last_check_status = ?, last_check_message = ?, last_tool_count = ?, updated_at = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      result.status,
      result.message,
      result.status === "passed" ? result.toolCount : null,
      new Date().toISOString(),
      serverId
    );
  }

  private requireAgent(agentId: string): void {
    if (this.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(agentId) === undefined) {
      throw new McpManagerError("agent_not_found");
    }
  }

  private getServerRow(agentId: string, id: string): McpServerRow | undefined {
    return this.db.prepare("SELECT * FROM agent_mcp_servers WHERE id = ? AND agent_id = ?").get(id, agentId) as
      | McpServerRow
      | undefined;
  }

  private requireParameterRow(agentId: string, id: string): SessionParameterRow {
    const row = this.db.prepare("SELECT * FROM agent_session_parameters WHERE id = ? AND agent_id = ?").get(id, agentId) as
      | SessionParameterRow
      | undefined;
    if (row === undefined) throw new McpManagerError("mcp_parameter_not_found");
    return row;
  }

  private listValueRows(serverId: string): McpValueRow[] {
    return this.db.prepare(`
      SELECT mcp_value.*, parameters.key AS parameter_key, parameters.secret AS parameter_secret
      FROM agent_mcp_values mcp_value
      LEFT JOIN agent_session_parameters parameters ON parameters.id = mcp_value.session_parameter_id
      WHERE mcp_value.mcp_server_id = ?
      ORDER BY mcp_value.kind ASC, mcp_value.position ASC
    `).all(serverId) as McpValueRow[];
  }

  private toValueView(row: McpValueRow): AgentMcpValueView {
    const base = {
      id: row.id,
      source: row.source_type,
      ...(row.target_name === null ? {} : { name: row.target_name })
    };
    if (row.source_type === "fixed") {
      return row.secret === 1
        ? { ...base, secret: true, configured: row.encrypted_value !== null }
        : { ...base, secret: false, value: row.plain_value ?? "" };
    }
    if (row.source_type === "session_parameter") return { ...base, parameterKey: row.parameter_key! };
    return { ...base, runtimeKey: row.runtime_key! };
  }

  private validateServerInput(agentId: string, input: McpServerWriteInput): void {
    if (!MCP_NAME_PATTERN.test(input.name) || !Number.isInteger(input.checkTimeoutSeconds)
      || input.checkTimeoutSeconds < 1 || input.checkTimeoutSeconds > 300) {
      throw new McpManagerError("invalid_mcp_server");
    }
    if (input.transport === "http") {
      try {
        const url = new URL(input.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
      } catch {
        throw new McpManagerError("invalid_mcp_server");
      }
      const names = new Set<string>();
      for (const header of input.headers) {
        const name = header.name.toLowerCase();
        if (!HEADER_NAME_PATTERN.test(header.name) || RESERVED_HEADERS.has(name) || names.has(name)) {
          throw new McpManagerError("invalid_mcp_value");
        }
        names.add(name);
        this.validateValueInput(header, "header", agentId);
      }
      return;
    }
    if ((!isAbsolute(input.command) && !COMMAND_PATTERN.test(input.command)) || input.command.trim() === "") {
      throw new McpManagerError("invalid_mcp_server");
    }
    input.arguments.forEach((argument) => this.validateValueInput(argument, "argument", agentId));
    const names = new Set<string>();
    for (const item of input.environment) {
      if (!ENVIRONMENT_NAME_PATTERN.test(item.name) || names.has(item.name)) {
        throw new McpManagerError("invalid_mcp_value");
      }
      names.add(item.name);
      this.validateValueInput(item, "environment", agentId);
    }
  }

  private validateValueInput(input: McpValueInput, kind: McpValueRow["kind"], agentId: string): void {
    if (input.source === "fixed") {
      if (!nonEmpty(input.value) && input.id === undefined) throw new McpManagerError("invalid_mcp_value");
      if (kind === "argument" && input.secret === true) throw new McpManagerError("invalid_mcp_value");
      return;
    }
    if (input.source === "runtime") {
      if (!RUNTIME_KEYS.has(input.runtimeKey)) throw new McpManagerError("invalid_mcp_value");
      return;
    }
    const parameter = this.db.prepare(
      "SELECT * FROM agent_session_parameters WHERE agent_id = ? AND key = ?"
    ).get(agentId, input.parameterKey) as SessionParameterRow | undefined;
    if (parameter === undefined) throw new McpManagerError("invalid_mcp_value");
    if (kind === "argument" && parameter.secret === 1) throw new McpManagerError("invalid_mcp_value");
  }

  private validateParameterInput(key: string, label: string): void {
    if (!PARAMETER_KEY_PATTERN.test(key) || !nonEmpty(label)) throw new McpManagerError("invalid_mcp_value");
  }

  private insertValues(
    agentId: string,
    serverId: string,
    input: McpServerWriteInput,
    existing: Map<string, McpValueRow>
  ): void {
    const groups = input.transport === "http"
      ? [{ kind: "header" as const, values: input.headers }]
      : [
          { kind: "argument" as const, values: input.arguments },
          { kind: "environment" as const, values: input.environment }
        ];
    for (const group of groups) {
      group.values.forEach((value, position) => this.insertValue(agentId, serverId, group.kind, position, value, existing));
    }
  }

  private insertValue(
    agentId: string,
    serverId: string,
    kind: McpValueRow["kind"],
    position: number,
    input: McpValueInput | McpNamedValueInput,
    existing: Map<string, McpValueRow>
  ): void {
    const previous = input.id === undefined ? undefined : existing.get(input.id);
    const parameter = input.source === "session_parameter"
      ? this.db.prepare("SELECT * FROM agent_session_parameters WHERE agent_id = ? AND key = ?")
          .get(agentId, input.parameterKey) as SessionParameterRow | undefined
      : undefined;
    if (input.source === "session_parameter" && parameter === undefined) {
      throw new McpManagerError("invalid_mcp_value");
    }
    const secret = input.source === "fixed" && input.secret === true;
    const plainValue = input.source === "fixed" && !secret ? input.value ?? previous?.plain_value ?? null : null;
    const encryptedValue = input.source === "fixed" && secret
      ? (nonEmpty(input.value) ? this.secrets.encrypt(input.value) : previous?.encrypted_value ?? null)
      : null;
    if (input.source === "fixed" && plainValue === null && encryptedValue === null) {
      throw new McpManagerError("invalid_mcp_value");
    }
    this.db.prepare(`
      INSERT INTO agent_mcp_values
        (id, mcp_server_id, kind, position, target_name, source_type, plain_value,
         encrypted_value, secret, session_parameter_id, runtime_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      serverId,
      kind,
      position,
      "name" in input ? input.name : null,
      input.source,
      plainValue,
      encryptedValue,
      secret ? 1 : 0,
      parameter?.id ?? null,
      input.source === "runtime" ? input.runtimeKey : null
    );
  }

  private sessionValues(sessionId: string): Map<string, SessionValueRow> {
    const rows = this.db.prepare(
      "SELECT parameter_id, plain_value, encrypted_value FROM session_mcp_parameter_values WHERE session_id = ?"
    ).all(sessionId) as SessionValueRow[];
    return new Map(rows.map((row) => [row.parameter_id, row]));
  }

  private resolveServer(
    row: McpServerRow,
    context: ResolveMcpContext,
    sessionValues: Map<string, SessionValueRow>
  ): ResolvedMcpServer {
    const values = this.listValueRows(row.id);
    if (row.transport === "http") {
      return {
        id: row.id,
        checkTimeoutMs: row.check_timeout_seconds * 1000,
        server: {
          type: "http",
          name: row.name,
          url: row.url!,
          headers: values.map((value) => ({
            name: value.target_name!,
            value: this.resolveValue(value, context, sessionValues)
          }))
        }
      };
    }
    return {
      id: row.id,
      checkTimeoutMs: row.check_timeout_seconds * 1000,
      server: {
        type: "stdio",
        name: row.name,
        command: this.resolveCommand(row.command!),
        args: values.filter((value) => value.kind === "argument")
          .map((value) => this.resolveValue(value, context, sessionValues)),
        env: values.filter((value) => value.kind === "environment").map((value) => ({
          name: value.target_name!,
          value: this.resolveValue(value, context, sessionValues)
        }))
      }
    };
  }

  private resolveValue(
    row: McpValueRow,
    context: ResolveMcpContext,
    sessionValues: Map<string, SessionValueRow>
  ): string {
    if (row.source_type === "fixed") {
      if (row.secret === 1 && row.encrypted_value !== null) return this.secrets.decrypt(row.encrypted_value);
      if (row.plain_value !== null) return row.plain_value;
      throw new McpManagerError("mcp_check_failed");
    }
    if (row.source_type === "runtime") {
      const values: Record<RuntimeMcpKey, string> = {
        agent_id: context.agentId,
        session_id: context.sessionId,
        run_id: context.runId,
        workspace_path: context.workspacePath,
        browser_profile_path: context.browserProfilePath
      };
      return values[row.runtime_key!];
    }
    const value = sessionValues.get(row.session_parameter_id!);
    if (value?.encrypted_value !== null && value?.encrypted_value !== undefined) {
      return this.secrets.decrypt(value.encrypted_value);
    }
    if (value?.plain_value !== null && value?.plain_value !== undefined) return value.plain_value;
    throw new McpManagerError("missing_session_mcp_parameters");
  }

  private resolveCommand(command: string): string {
    if (isAbsolute(command)) {
      try {
        accessSync(command, constants.X_OK);
        return command;
      } catch {
        throw new McpManagerError("mcp_check_failed");
      }
    }
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      if (directory === "") continue;
      const candidate = join(directory, command);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue through PATH.
      }
    }
    throw new McpManagerError("mcp_check_failed");
  }
}
