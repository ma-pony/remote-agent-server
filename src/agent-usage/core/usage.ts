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
    // A cumulative snapshot can lag behind later request observations. Keep the
    // larger verified detail basis for that metric instead of hiding newer usage.
    const detailRows = ordered.some((row) => row.scope === "provider_session")
      ? accountingRows(ordered.filter((row) => row.scope !== "provider_session")) : [];
    const detailTotals = sumUsage(detailRows);
    const selected = new Map<UsageRecord, UsageRecord>();
    const select = (row: UsageRecord, metric: typeof metricNames[number]) => {
      const masked = selected.get(row) ?? { ...row, metrics: emptyUsage() };
      masked.metrics[metric] = row.metrics[metric];
      selected.set(row, masked);
    };
    for (const metric of metricNames) {
      const known = ordered.filter((row) => row.metrics[metric] !== null);
      const range = known.find((row) => row.scope === "provider_session");
      if (range) {
        if (detailTotals[metric] !== null && detailTotals[metric]! > range.metrics[metric]!) {
          for (const detail of detailRows) if (detail.metrics[metric] !== null) select(detail, metric);
        } else select(range, metric);
        continue;
      }
      const requests = known.filter((row) => row.scope === "model_request");
      const nativeIntervals = known.filter((row) => row.scope === "interval");
      // Explicitly higher-priority direct request evidence is a known-subset dated basis.
      // Pick one basis before date filtering; never add intervals to captured requests.
      const preferRequests = requests.length > 0 && nativeIntervals.length > 0
        && requests.reduce((min, row) => Math.min(min, row.sourcePriority ?? 100), Infinity)
          < nativeIntervals.reduce((min, row) => Math.min(min, row.sourcePriority ?? 100), Infinity);
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

export const isLocated = (row: UsageRecord): boolean => row.occurredAt !== null && row.scope !== "provider_session";
const epochKey = (row: UsageRecord): string => JSON.stringify([row.namespace, row.sessionId, row.providerEpochId]);

type EpochRanges = {
  details: UsageRecord[];
  requestsByExecution: Map<string, UsageRecord[]>;
  providerParents: number;
  turnParents: Map<string, number>;
  unidentifiedRequests: boolean;
  totals: Map<string, UsageMetrics>;
};

/** Query-local containment index; each request is indexed once instead of scanning the ledger per parent. */
export class UsageRangeIndex {
  private readonly epochs = new Map<string, EpochRanges>();

  constructor(records: UsageRecord[]) {
    for (const row of records) {
      const key = epochKey(row);
      let epoch = this.epochs.get(key);
      if (!epoch) {
        epoch = { details: [], requestsByExecution: new Map(), providerParents: 0,
          turnParents: new Map(), unidentifiedRequests: false, totals: new Map() };
        this.epochs.set(key, epoch);
      }
      if (row.scope === "provider_session") epoch.providerParents++;
      else epoch.details.push(row);
      if (row.scope === "turn" && row.executionId !== null) {
        epoch.turnParents.set(row.executionId, (epoch.turnParents.get(row.executionId) ?? 0) + 1);
      }
      if (row.scope !== "model_request") continue;
      if (row.executionId === null) {
        if (isAccountable(row)) epoch.unidentifiedRequests = true;
      } else {
        const requests = epoch.requestsByExecution.get(row.executionId) ?? [];
        requests.push(row);
        epoch.requestsByExecution.set(row.executionId, requests);
      }
    }
  }

  detailUsage(parent: UsageRecord, locatedOnly = false): UsageMetrics {
    const epoch = this.epochs.get(epochKey(parent));
    if (!epoch) return emptyUsage();
    const key = JSON.stringify([parent.scope, parent.scope === "turn" ? parent.executionId : null, locatedOnly]);
    const cached = epoch.totals.get(key);
    if (cached) return cached;
    const details = parent.scope === "provider_session" ? epoch.details
      : parent.scope === "turn" && parent.executionId !== null ? epoch.requestsByExecution.get(parent.executionId) ?? [] : [];
    const totals = sumUsage(accountingRows(locatedOnly ? details.filter(isLocated) : details));
    epoch.totals.set(key, totals);
    return totals;
  }

  ambiguous(parent: UsageRecord): boolean {
    const epoch = this.epochs.get(epochKey(parent));
    if (!epoch) return false;
    if (parent.scope === "provider_session") return epoch.providerParents > 1;
    return parent.scope === "turn" && (epoch.unidentifiedRequests
      || parent.executionId !== null && (epoch.turnParents.get(parent.executionId) ?? 0) > 1);
  }
}

export const rangeConflicts = (records: UsageRecord[], ranges = new UsageRangeIndex(records)): number => {
  let count = 0;
  for (const parent of records) {
    if (!isAccountable(parent) || parent.scope !== "provider_session" && parent.scope !== "turn") continue;
    const detail = ranges.detailUsage(parent);
    const contradicts = metricNames.some((key) => parent.metrics[key] !== null && detail[key] !== null
      && parent.metrics[key]! < detail[key]!);
    if (contradicts || ranges.ambiguous(parent)) count++;
  }
  return count;
};

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
