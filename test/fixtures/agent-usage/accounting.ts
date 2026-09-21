import type { UsageObservation } from "../../../src/agent-usage/core/types.js";

/** Synthetic accounting inputs, not captured private Provider data. */
export const accountingRequests = (): UsageObservation[] => [
  [1000, 100, 300], [1400, 150, 400], [600, 50, 300], [null, null, null]
].map(([input, output, cache], index) => ({
  eventId: `event-${index + 1}`,
  sourceId: "fixture",
  sourceVersion: "1",
  scope: "model_request",
  semantics: "snapshot",
  coverageId: `request-${index + 1}`,
  invocationId: `request-${index + 1}`,
  executionId: "run-1",
  providerEpochId: "epoch-1",
  occurredAt: `2026-09-20T00:00:0${index}.000Z`,
  finality: "final",
  revision: 1,
  measurement: "reported",
  normalizationProfile: "fixture/input-includes-cache/v1",
  metrics: { inputTotalTokens: input!, outputTotalTokens: output!, cacheReadTokens: cache! }
}));
