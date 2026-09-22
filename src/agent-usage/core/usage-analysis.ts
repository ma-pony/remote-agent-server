import { metricNames, type UsageFilter, type UsageMetrics, type UsageRecord, type UsageSummary, type UsageTimeseries } from "./types.js";
import { accountingRows, completeUsage, emptyUsage, intervalIntersects, intervalOverlapConflicts, isAccountable,
  isLocated, rangeConflicts, reconcileSources, sumUsage, UsageRangeIndex } from "./usage.js";

const withinPeriod = (filter: UsageFilter): ((row: UsageRecord) => boolean) => {
  if (filter.from === undefined && filter.to === undefined) return () => true;
  const from = filter.from === undefined ? -Infinity : Date.parse(filter.from);
  const to = filter.to === undefined ? Infinity : Date.parse(filter.to);
  return (row) => isLocated(row)
    && Date.parse(row.intervalStart ?? row.occurredAt!) >= from && Date.parse(row.occurredAt!) < to;
};

/** One consistent accounting projection for each query. No retained history cache or database writes. */
export class UsageAnalysis {
  private readonly reconciled: ReturnType<typeof reconcileSources>;
  private readonly ranges: UsageRangeIndex;
  private readonly allBasis: UsageRecord[];
  private readonly datedBasis: UsageRecord[];

  constructor(records: UsageRecord[]) {
    this.reconciled = reconcileSources(records);
    this.ranges = new UsageRangeIndex(this.reconciled.records);
    this.allBasis = accountingRows(this.reconciled.records);
    this.datedBasis = accountingRows(this.reconciled.records.filter(isLocated));
  }

  summary(filter: UsageFilter = {}): UsageSummary {
    const all = this.reconciled;
    const inPeriod = withinPeriod(filter);
    const records = all.records.filter(inPeriod);
    const dated = this.datedBasis.filter(inPeriod);
    const selected = filter.from === undefined && filter.to === undefined ? this.allBasis : dated;
    const ambiguous = this.datedBasis.filter((row) => intervalIntersects(row, filter) && !inPeriod(row));
    const conflicts = all.conflicts + rangeConflicts(all.records, this.ranges) + intervalOverlapConflicts(all.records)
      + all.records.filter((row) => row.issues?.some((issue) => issue !== "cumulative_fields_missing")).length;
    const requests = records.filter((row) => row.scope === "model_request");
    const complete = requests.filter(completeUsage).length;
    const missing = requests.filter((row) => !isAccountable(row) || Object.values(row.metrics).every((value) => value === null)).length;
    const unknown = records.filter((row) => !isAccountable(row)).length;
    const totalRows = selected.filter((row) => row.metrics.totalTokens !== null);
    const scopes = new Set((totalRows.length > 0 ? totalRows : selected).map((row) => row.scope));
    const basis = scopes.size === 0 ? "none" : scopes.size > 1 ? "mixed" : scopes.has("provider_session") ? "range_totals"
      : scopes.has("turn") ? "turn_totals" : scopes.has("interval") ? "interval_totals" : "model_requests";
    return {
      usage: sumUsage(selected),
      locatedUsage: sumUsage(dated),
      unplacedUsage: this.unplacedUsage(ambiguous),
      accountingBasis: basis,
      completeness: conflicts > 0 ? "conflict" : ambiguous.length > 0 ? "partial" : records.length === 0 ? "none"
        : unknown > 0 || complete < requests.length || records.some((row) => !completeUsage(row) || row.finality !== "final"
          || row.issues?.includes("cumulative_fields_missing")) ? "partial" : "complete",
      observedModelRequests: requests.length,
      requestsWithCompleteUsage: complete,
      requestsWithMissingUsage: missing,
      requestsWithPartialUsage: requests.length - complete - missing,
      unverifiedObservations: unknown,
      conflictingRanges: conflicts,
      asOf: new Date().toISOString()
    };
  }

  timeseries(filter: UsageFilter, timezone: string, bucket: "day" | "week" | "month"): UsageTimeseries {
    const inPeriod = withinPeriod(filter);
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    const periodKey = (timestamp: string): string => {
      const parts = formatter.formatToParts(new Date(timestamp));
      const part = (kind: string) => parts.find((item) => item.type === kind)!.value;
      const day = `${part("year")}-${part("month")}-${part("day")}`;
      if (bucket === "day") return day;
      if (bucket === "month") return day.slice(0, 7);
      // Calendar arithmetic follows timezone conversion, including DST boundaries.
      const date = new Date(`${day}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
      return date.toISOString().slice(0, 10);
    };
    const groups = new Map<string, { usage: UsageMetrics; observedRanges: number }>();
    const ambiguous = this.datedBasis.filter((row) => intervalIntersects(row, filter) && !inPeriod(row));
    for (const row of this.datedBasis) {
      if (!inPeriod(row)) continue;
      const key = periodKey(row.occurredAt!);
      if (row.intervalStart !== undefined && periodKey(row.intervalStart) !== key) {
        ambiguous.push(row);
        continue;
      }
      const group = groups.get(key) ?? { usage: emptyUsage(), observedRanges: 0 };
      for (const metric of metricNames) {
        const value = row.metrics[metric];
        if (value !== null) group.usage[metric] = (group.usage[metric] ?? 0) + value;
      }
      group.observedRanges++;
      groups.set(key, group);
    }
    return {
      bucket,
      items: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([period, group]) => ({ period, ...group })),
      unplacedUsage: this.unplacedUsage(ambiguous)
    };
  }

  private unplacedUsage(ambiguous: UsageRecord[]): UsageMetrics {
    const unplaced = this.allBasis.filter((row) => !isLocated(row)).map((parent) => {
      const detail = this.ranges.detailUsage(parent, true);
      const metrics = { ...parent.metrics };
      for (const key of metricNames) {
        if (metrics[key] !== null && detail[key] !== null) {
          const residual = metrics[key]! - detail[key]!;
          metrics[key] = residual >= 0 ? residual : null;
        }
      }
      return { metrics };
    });
    return sumUsage([...unplaced, ...ambiguous]);
  }
}
