import { metricNames, type UsageMetrics, type UsageRecord } from "./types.js";

export const emptyUsage = (): UsageMetrics => Object.fromEntries(metricNames.map((name) => [name, null])) as UsageMetrics;

/** Canonical input totals already include cache subsets; unknown fields stay null. */
export const normalizeUsage = (input: Record<string, unknown>): UsageMetrics => {
  const result = emptyUsage();
  for (const name of metricNames) {
    const value = input[name];
    if (value === null || value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid_usage_metric");
    result[name] = value;
  }
  if (result.totalTokens === null && result.inputTotalTokens !== null && result.outputTotalTokens !== null) {
    const total = result.inputTotalTokens + result.outputTotalTokens;
    if (!Number.isSafeInteger(total)) throw new Error("invalid_usage_metric");
    result.totalTokens = total;
  }
  if (result.inputUncachedTokens === null && result.inputTotalTokens !== null && result.cacheReadTokens !== null && result.cacheWriteTokens !== null) {
    const uncached = result.inputTotalTokens - result.cacheReadTokens - result.cacheWriteTokens;
    if (uncached >= 0) result.inputUncachedTokens = uncached;
  }
  return result;
};

export const sumUsage = (records: Array<{ metrics: UsageMetrics }>): UsageMetrics => {
  const result = emptyUsage();
  for (const record of records) for (const name of metricNames) {
    const value = record.metrics[name];
    if (value !== null) result[name] = (result[name] ?? 0) + value;
  }
  return result;
};

export const isAccountable = (row: UsageRecord): boolean => row.scope !== "unknown" && row.semantics !== "unknown"
  && row.normalizationProfile !== null && row.measurement !== "estimated";

export const completeUsage = (row: UsageRecord): boolean => isAccountable(row)
  && row.metrics.inputTotalTokens !== null && row.metrics.outputTotalTokens !== null && row.metrics.totalTokens !== null;

const identity = (row: UsageRecord): string => JSON.stringify([
  row.namespace, row.sessionId, row.providerEpochId, row.scope,
  row.scope === "model_request" ? row.invocationId ?? [row.sourceId, row.coverageId] : row.coverageId
]);

/** Select one source per explicit identity. Conflicting evidence is retained, not maximized. */
export const reconcileSources = (rows: UsageRecord[]): { records: UsageRecord[]; conflicts: number } => {
  const groups = new Map<string, UsageRecord[]>();
  for (const row of rows) {
    const key = identity(row);
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  let conflicts = 0;
  const records = [...groups.values()].map((group) => {
    group.sort((a, b) => Number(isAccountable(b)) - Number(isAccountable(a))
      || Number(b.finality === "final") - Number(a.finality === "final")
      || (a.sourcePriority ?? 100) - (b.sourcePriority ?? 100) || a.sourceId.localeCompare(b.sourceId));
    const selected = group[0]!;
    if (group.slice(1).some((other) => isAccountable(other) && isAccountable(selected) && metricNames.some((key) =>
      selected.metrics[key] !== null && other.metrics[key] !== null && selected.metrics[key] !== other.metrics[key]))) conflicts++;
    return selected;
  });
  return { records, conflicts };
};

/** Select a non-overlapping basis independently for each metric; absent parent fields do not erase detail. */
export const accountingRows = (records: UsageRecord[]): UsageRecord[] => {
  const epochs = new Map<string, UsageRecord[]>();
  for (const row of records.filter(isAccountable)) {
    const key = JSON.stringify([row.namespace, row.sessionId, row.providerEpochId]);
    const group = epochs.get(key) ?? []; group.push(row); epochs.set(key, group);
  }
  return [...epochs.values()].flatMap((rows) => {
    const ordered = rows.slice().sort((a, b) => (a.sourcePriority ?? 100) - (b.sourcePriority ?? 100)
      || a.coverageId.localeCompare(b.coverageId) || a.sourceId.localeCompare(b.sourceId));
    const selected = new Map<UsageRecord, UsageRecord>();
    const select = (row: UsageRecord, metric: typeof metricNames[number]) => {
      const masked = selected.get(row) ?? { ...row, metrics: emptyUsage() };
      masked.metrics[metric] = row.metrics[metric];
      selected.set(row, masked);
    };
    for (const metric of metricNames) {
      const known = ordered.filter((row) => row.metrics[metric] !== null);
      const range = known.find((row) => row.scope === "provider_session");
      if (range) { select(range, metric); continue; }
      const requests = known.filter((row) => row.scope === "model_request");
      const nativeIntervals = known.filter((row) => row.scope === "interval");
      // Explicitly higher-priority direct request evidence is a known-subset dated basis.
      // Pick one basis before date filtering; never add intervals to captured requests.
      const preferRequests = requests.length > 0 && nativeIntervals.length > 0
        && Math.min(...requests.map((row) => row.sourcePriority ?? 100)) < Math.min(...nativeIntervals.map((row) => row.sourcePriority ?? 100));
      const intervals = preferRequests ? [] : nativeIntervals;
      for (const interval of intervals) select(interval, metric);
      const covered = new Set<string>();
      const turns = known.filter((row) => row.scope === "turn" && intervals.length === 0);
      for (const turn of turns) {
        const key = turn.executionId ?? `coverage:${turn.coverageId}`;
        if (!covered.has(key)) select(turn, metric);
        covered.add(key);
      }
      for (const request of known.filter((row) => row.scope === "model_request")) {
        // With unidentified containment, adding both levels could double-count the same request.
        if (intervals.length > 0) continue;
        if (request.executionId === null ? turns.length === 0 : !covered.has(request.executionId)) select(request, metric);
      }
    }
    return [...selected.values()];
  });
};

export const sameEpoch = (a: UsageRecord, b: UsageRecord): boolean => a.namespace === b.namespace
  && a.sessionId === b.sessionId && a.providerEpochId === b.providerEpochId;

export const containedDetail = (parent: UsageRecord, records: UsageRecord[]): UsageRecord[] => records.filter((row) =>
  sameEpoch(parent, row) && (parent.scope === "provider_session" ? row.scope !== "provider_session"
    : parent.scope === "turn" && row.scope === "model_request" && row.executionId !== null && row.executionId === parent.executionId));

export const rangeConflicts = (records: UsageRecord[]): number => records.filter((row) => isAccountable(row) &&
  (row.scope === "provider_session" || row.scope === "turn")).reduce((count, parent) => {
  const detail = sumUsage(accountingRows(containedDetail(parent, records)));
  const contradicts = metricNames.some((key) => parent.metrics[key] !== null && detail[key] !== null && parent.metrics[key]! < detail[key]!);
  const ambiguous = records.some((row) => row !== parent && sameEpoch(row, parent) && row.scope === parent.scope
    && (parent.scope === "provider_session" || (parent.executionId !== null && parent.executionId === row.executionId)))
    || (parent.scope === "turn" && records.some((row) => isAccountable(row) && sameEpoch(row, parent)
      && row.scope === "model_request" && row.executionId === null));
  return count + Number(contradicts || ambiguous);
}, 0);

/** Point request timestamps cannot prove disjoint coverage from cumulative native intervals. */
export const intervalOverlapConflicts = (records: UsageRecord[]): number => {
  const epochs = new Set(records.filter((row) => row.scope === "interval" && isAccountable(row))
    .map((row) => JSON.stringify([row.namespace, row.sessionId, row.providerEpochId])));
  return new Set(records.filter((row) => row.scope === "model_request" && isAccountable(row)
    && epochs.has(JSON.stringify([row.namespace, row.sessionId, row.providerEpochId])))
    .map((row) => JSON.stringify([row.namespace, row.sessionId, row.providerEpochId]))).size;
};

export const intervalIntersects = (row: UsageRecord, filter: import("./types.js").UsageFilter): boolean =>
  row.scope === "interval" && row.intervalStart !== undefined && row.occurredAt !== null
  && (filter.from === undefined || Date.parse(row.occurredAt) >= Date.parse(filter.from))
  && (filter.to === undefined || Date.parse(row.intervalStart) < Date.parse(filter.to));
