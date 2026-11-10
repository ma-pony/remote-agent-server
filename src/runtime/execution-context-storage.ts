/**
 * Names for Provider-owned state intentionally differ from business Session
 * identifiers.  A business Session may have several retired native contexts.
 */
export const executionContextStorageKey = (executionContextId: number): string => `context-${executionContextId}`;

export const executionContextAcpSessionKey = (executionContextId: number): string =>
  `remote-agent:context:${executionContextId}`;
