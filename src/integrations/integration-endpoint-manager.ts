import { createHash, randomBytes } from "node:crypto";

import type Database from "better-sqlite3";

import { constantTimeTokenEqual } from "../auth.js";
import type { SecretStore } from "../mcp/secret-store.js";
import {
  IntegrationStore,
  type EndpointPersistenceInput
} from "./integration-store.js";
import type {
  CreateIntegrationEndpointInput,
  IntegrationEndpoint,
  IntegrationEndpointDetail,
  IntegrationEndpointSummary,
  ParameterMapping,
  ParameterMappingInput,
  ResolvedIntegrationParameters,
  UpdateIntegrationEndpointInput
} from "./integration-types.js";

type ParameterDefinitionRow = {
  key: string;
  required: 0 | 1;
};

type EndpointManagerErrorCode =
  | "agent_not_found"
  | "endpoint_not_found"
  | "endpoint_in_use"
  | "conversation_busy"
  | "missing_request_parameter"
  | "unknown_request_parameter"
  | "invalid_endpoint";

export class IntegrationEndpointManagerError extends Error {
  constructor(readonly code: EndpointManagerErrorCode) {
    super(code);
    this.name = "IntegrationEndpointManagerError";
  }
}

const endpointToken = (): string => `ras_${randomBytes(32).toString("base64url")}`;
const tokenHash = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/** Manages external Integration endpoints without exposing their credentials. */
export class IntegrationEndpointManager {
  constructor(private readonly dependencies: {
    db: Database.Database;
    store: IntegrationStore;
    secrets: SecretStore;
  }) {}

  private get db(): Database.Database {
    return this.dependencies.db;
  }

  private get store(): IntegrationStore {
    return this.dependencies.store;
  }

  private get secrets(): SecretStore {
    return this.dependencies.secrets;
  }

  list(): IntegrationEndpointSummary[] {
    return this.store.listEndpoints().map(({ promptPrefix: _promptPrefix, parameterMappings: _parameterMappings, ...summary }) => summary);
  }

  get(id: string): IntegrationEndpointDetail | undefined {
    return this.store.getEndpoint(id);
  }

  create(input: CreateIntegrationEndpointInput): { endpoint: IntegrationEndpointDetail; token: string } {
    const token = endpointToken();
    const record = this.toPersistenceInput(input, tokenHash(token));
    return { endpoint: this.store.createEndpoint(record), token };
  }

  update(id: string, input: UpdateIntegrationEndpointInput): IntegrationEndpointDetail {
    const existing = this.store.getEndpoint(id);
    if (existing === undefined) throw new IntegrationEndpointManagerError("endpoint_not_found");
    const nextAgentId = input.agentId ?? existing.agentId;
    if (nextAgentId !== existing.agentId && this.store.endpointHasActiveWork(id)) {
      throw new IntegrationEndpointManagerError("conversation_busy");
    }

    const fixedValues = input.parameterMappings === undefined
      ? this.fixedValues(existing.id)
      : this.fixedValuesFromInput(input.parameterMappings);
    const parameterMappings = input.parameterMappings === undefined
      ? existing.parameterMappings
      : this.publicMappings(input.parameterMappings);
    const record = this.toPersistenceInput({
      name: input.name ?? existing.name,
      slug: input.slug ?? existing.slug,
      agentId: nextAgentId,
      enabled: input.enabled ?? existing.enabled,
      promptPrefix: input.promptPrefix ?? existing.promptPrefix,
      parameterMappings: input.parameterMappings ?? this.toInputMappings(existing.parameterMappings, fixedValues)
    }, this.store.endpointTokenHash(id)!, parameterMappings, fixedValues);
    return this.store.updateEndpoint(id, record)!;
  }

  rotateToken(id: string): { endpoint: IntegrationEndpointDetail; token: string } {
    if (this.store.getEndpoint(id) === undefined) throw new IntegrationEndpointManagerError("endpoint_not_found");
    const token = endpointToken();
    return { endpoint: this.store.rotateEndpointToken(id, tokenHash(token))!, token };
  }

  delete(id: string): void {
    if (this.store.getEndpoint(id) === undefined) throw new IntegrationEndpointManagerError("endpoint_not_found");
    if (this.store.endpointHasHistory(id)) throw new IntegrationEndpointManagerError("endpoint_in_use");
    this.store.deleteEndpoint(id);
  }

  authenticate(slug: string, token: string): IntegrationEndpoint | undefined {
    const stored = this.store.endpointBySlugWithTokenHash(slug);
    if (stored === undefined || !constantTimeTokenEqual(stored.tokenHash, tokenHash(token))) return undefined;
    return stored.endpoint;
  }

  resolveRequest(endpointId: string, parameters: Record<string, string>): ResolvedIntegrationParameters {
    const endpoint = this.store.getEndpoint(endpointId);
    if (endpoint === undefined) throw new IntegrationEndpointManagerError("endpoint_not_found");
    const definitions = this.parameterDefinitions(endpoint.agentId);
    const requestMappings = endpoint.parameterMappings.filter((mapping) => mapping.source === "request");
    const allowedRequestKeys = new Set(requestMappings.map((mapping) => mapping.requestKey));
    if (Object.keys(parameters).some((key) => !allowedRequestKeys.has(key))) {
      throw new IntegrationEndpointManagerError("unknown_request_parameter");
    }
    const fixedValues = this.fixedValues(endpoint.id);
    const resolved: ResolvedIntegrationParameters = {};
    for (const mapping of endpoint.parameterMappings) {
      if (mapping.source === "fixed") {
        resolved[mapping.parameterKey] = fixedValues[mapping.parameterKey] ?? null;
        continue;
      }
      const value = parameters[mapping.requestKey];
      if (value === undefined && definitions.get(mapping.parameterKey)?.required) {
        throw new IntegrationEndpointManagerError("missing_request_parameter");
      }
      resolved[mapping.parameterKey] = value ?? null;
    }
    return resolved;
  }

  private toPersistenceInput(
    input: CreateIntegrationEndpointInput,
    tokenHashValue: string,
    mappings = this.publicMappings(input.parameterMappings),
    fixedValues = this.fixedValuesFromInput(input.parameterMappings)
  ): EndpointPersistenceInput {
    this.validateInput(input, mappings);
    return {
      name: input.name.trim(),
      slug: input.slug.trim(),
      agentId: input.agentId,
      enabled: input.enabled,
      tokenHash: tokenHashValue,
      promptPrefix: input.promptPrefix,
      parameterMappings: mappings,
      encryptedFixedValues: Object.keys(fixedValues).length === 0 ? null : this.secrets.encrypt(JSON.stringify(fixedValues))
    };
  }

  private validateInput(input: CreateIntegrationEndpointInput, mappings: ParameterMapping[]): void {
    if (input.name.trim() === "" || input.slug.trim() === "" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.slug)) {
      throw new IntegrationEndpointManagerError("invalid_endpoint");
    }
    if (this.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(input.agentId) === undefined) {
      throw new IntegrationEndpointManagerError("agent_not_found");
    }
    const definitions = this.parameterDefinitions(input.agentId);
    const targetKeys = new Set<string>();
    const requestKeys = new Set<string>();
    for (const mapping of mappings) {
      if (!definitions.has(mapping.parameterKey) || targetKeys.has(mapping.parameterKey)) {
        throw new IntegrationEndpointManagerError("invalid_endpoint");
      }
      targetKeys.add(mapping.parameterKey);
      if (mapping.source === "request" && (mapping.requestKey.trim() === "" || requestKeys.has(mapping.requestKey))) {
        throw new IntegrationEndpointManagerError("invalid_endpoint");
      }
      if (mapping.source === "request") requestKeys.add(mapping.requestKey);
    }
    if (input.enabled && [...definitions.values()].some(({ key, required }) => required && !targetKeys.has(key))) {
      throw new IntegrationEndpointManagerError("invalid_endpoint");
    }
  }

  private parameterDefinitions(agentId: string): Map<string, { key: string; required: boolean }> {
    const rows = this.db.prepare("SELECT key, required FROM agent_session_parameters WHERE agent_id = ?")
      .all(agentId) as ParameterDefinitionRow[];
    return new Map(rows.map((row) => [row.key, { key: row.key, required: row.required === 1 }]));
  }

  private publicMappings(mappings: ParameterMappingInput[]): ParameterMapping[] {
    return mappings.map((mapping) => mapping.source === "request"
      ? { parameterKey: mapping.parameterKey, source: "request", requestKey: mapping.requestKey }
      : { parameterKey: mapping.parameterKey, source: "fixed", configured: true });
  }

  private fixedValuesFromInput(mappings: ParameterMappingInput[]): Record<string, string> {
    return Object.fromEntries(mappings.flatMap((mapping) => mapping.source === "fixed"
      ? [[mapping.parameterKey, mapping.value] as const]
      : []));
  }

  private fixedValues(endpointId: string): Record<string, string> {
    const encrypted = this.store.endpointEncryptedFixedValues(endpointId);
    return encrypted === null || encrypted === undefined ? {} : JSON.parse(this.secrets.decrypt(encrypted)) as Record<string, string>;
  }

  private toInputMappings(mappings: ParameterMapping[], fixedValues: Record<string, string>): ParameterMappingInput[] {
    return mappings.map((mapping) => mapping.source === "request"
      ? mapping
      : { parameterKey: mapping.parameterKey, source: "fixed", value: fixedValues[mapping.parameterKey] ?? "" });
  }
}
