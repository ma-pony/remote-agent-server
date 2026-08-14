export type IntegrationTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type IntegrationConversationStatus = "active" | "ended";
export type WebhookDeliveryStatus = "pending" | "delivering" | "succeeded" | "failed";

export type ParameterMapping =
  | { parameterKey: string; source: "request"; requestKey: string }
  | { parameterKey: string; source: "fixed"; configured: boolean };

export type ParameterMappingInput =
  | { parameterKey: string; source: "request"; requestKey: string }
  | { parameterKey: string; source: "fixed"; value: string };

export type IntegrationErrorCode =
  | "endpoint_not_found" | "endpoint_disabled" | "invalid_endpoint_token"
  | "task_not_found" | "idempotency_conflict" | "conversation_busy"
  | "missing_request_parameter" | "unknown_request_parameter" | "invalid_parameter_mapping";

export type IntegrationEndpoint = {
  id: string;
  name: string;
  slug: string;
  agentId: string;
  enabled: boolean;
  promptPrefix: string;
  parameterMappings: ParameterMapping[];
  createdAt: string;
  updatedAt: string;
};

export type IntegrationEndpointSummary = Pick<IntegrationEndpoint,
  "id" | "name" | "slug" | "agentId" | "enabled" | "createdAt" | "updatedAt">;
export type IntegrationEndpointDetail = IntegrationEndpoint;

export type CreateIntegrationEndpointInput = {
  name: string;
  slug: string;
  agentId: string;
  enabled: boolean;
  promptPrefix: string;
  parameterMappings: ParameterMappingInput[];
};

export type UpdateIntegrationEndpointInput = Partial<CreateIntegrationEndpointInput>;
export type ResolvedIntegrationParameters = Record<string, string | null>;

export type IntegrationConversation = {
  id: string;
  endpointId: string;
  conversationKey: string;
  sessionId: string;
  status: IntegrationConversationStatus;
  createdAt: string;
  endedAt: string | null;
};

export type IntegrationTask = {
  id: string;
  endpointId: string;
  conversationId: string | null;
  sessionId: string;
  runId: string | null;
  requestId: string;
  requestFingerprint: string;
  message: string;
  effectivePrompt: string;
  encryptedParameters: string | null;
  status: IntegrationTaskStatus;
  result: string | null;
  error: string | null;
  eventSequence: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type ExternalIntegrationTask = {
  taskId: string;
  requestId: string;
  conversationKey: string | null;
  sessionId: string;
  runId: string | null;
  status: IntegrationTaskStatus;
};

export type WebhookSubscription = {
  id: string;
  endpointId: string;
  name: string;
  url: string;
  enabled: boolean;
  eventsJson: string;
  encryptedHeaders: string | null;
  encryptedSigningSecret: string;
  timeoutSeconds: number;
  createdAt: string;
  updatedAt: string;
};

export type WebhookDelivery = {
  id: string;
  eventId: string;
  eventKey: string;
  sequence: number;
  dispatchOrder: number;
  subscriptionId: string;
  taskId: string | null;
  eventType: string;
  payloadJson: string;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string;
  lastStatusCode: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
