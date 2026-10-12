import { metricNames, type UsageFilter, type UsageMetrics, type UsageRecord, type UsageSummary, type UsageTimeseries } from "./types.js";
import { accountingRows, completeUsage, emptyUsage, intervalIntersects, intervalOverlapConflicts, isAccountable,
  isLocated, rangeConflicts, reconcileSources, sumUsage, UsageRangeIndex } from "./usage.js";

type BasisRow = Pick<UsageRecord, "scope" | "occurredAt" | "intervalStart" | "metrics">;
type QualityRow = Pick<UsageRecord, "scope" | "occurredAt" | "intervalStart"> & {
  complete: boolean; missing: boolean; unknown: boolean; partial: boolean;
};
export type UsageAnalysisProjection = {
  allBasis: BasisRow[]; datedBasis: BasisRow[]; quality: QualityRow[];
  unplacedUsage: UsageMetrics; conflicts: number;
};
const withinPeriod = (filter: UsageFilter): ((row: Pick<UsageRecord, "scope" | "occurredAt" | "intervalStart">) => boolean) => {
  if (filter.from === undefined && filter.to === undefined) return () => true;
  const from = filter.from === undefined ? -Infinity : Date.parse(filter.from);
  const to = filter.to === undefined ? Infinity : Date.parse(filter.to);
  return (row) => isLocated(row)
    && Date.parse(row.intervalStart ?? row.occurredAt!) >= from && Date.parse(row.occurredAt!) < to;
};

/** One consistent accounting projection for each query. No retained history cache or database writes. */
export class UsageAnalysis {
  private readonly projection: UsageAnalysisProjection;

  constructor(input: UsageRecord[] | UsageAnalysisProjection) {
    if (!Array.isArray(input)) { this.projection = input; return; }
    const reconciled = reconcileSources(input), records = reconciled.records;
    const ranges = new UsageRangeIndex(records), allBasis = accountingRows(records);
    const basis = (row: UsageRecord): BasisRow => ({ scope: row.scope, occurredAt: row.occurredAt,
      ...(row.intervalStart === undefined ? {} : { intervalStart: row.intervalStart }), metrics: row.metrics });
    const unplaced = allBasis.filter(row => !isLocated(row)).map(parent => {
      const detail = ranges.detailUsage(parent, true), metrics = { ...parent.metrics };
      for (const key of metricNames) if (metrics[key] !== null && detail[key] !== null) {
        const residual = metrics[key]! - detail[key]!;
        metrics[key] = residual >= 0 ? residual : null;
      }
      return { metrics };
    });
    this.projection = {
      allBasis: allBasis.map(basis), datedBasis: accountingRows(records.filter(isLocated)).map(basis),
      quality: records.map(row => ({ scope: row.scope, occurredAt: row.occurredAt,
        ...(row.intervalStart === undefined ? {} : { intervalStart: row.intervalStart }),
        complete: completeUsage(row), unknown: !isAccountable(row),
        missing: !isAccountable(row) || Object.values(row.metrics).every(value => value === null),
        partial: !completeUsage(row) || row.finality !== "final" || !!row.issues?.includes("cumulative_fields_missing") })),
      unplacedUsage: sumUsage(unplaced),
      conflicts: reconciled.conflicts + rangeConflicts(records, ranges) + intervalOverlapConflicts(records)
        + records.filter(row => row.issues?.some(issue => issue !== "cumulative_fields_missing")).length
    };
  }

  project(): UsageAnalysisProjection { return this.projection; }

  /** Epochs are independent accounting domains; their reconciled facts can be combined. */
  static combine(projections: UsageAnalysisProjection[]): UsageAnalysis {
    return new UsageAnalysis({ allBasis: projections.flatMap(row => row.allBasis),
      datedBasis: projections.flatMap(row => row.datedBasis), quality: projections.flatMap(row => row.quality),
      unplacedUsage: sumUsage(projections.map(row => ({ metrics: row.unplacedUsage }))),
      conflicts: projections.reduce((sum, row) => sum + row.conflicts, 0) });
  }

  summary(filter: UsageFilter = {}): UsageSummary {
    const all = this.projection;
    const inPeriod = withinPeriod(filter);
    const records = all.quality.filter(inPeriod);
    const dated = all.datedBasis.filter(inPeriod);
    const selected = filter.from === undefined && filter.to === undefined ? all.allBasis : dated;
    const ambiguous = all.datedBasis.filter((row) => intervalIntersects(row, filter) && !inPeriod(row));
    const conflicts = all.conflicts;
    const requests = records.filter((row) => row.scope === "model_request");
    const complete = requests.filter(row => row.complete).length;
    const missing = requests.filter(row => row.missing).length;
    const unknown = records.filter(row => row.unknown).length;
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
        : unknown > 0 || complete < requests.length || records.some(row => row.partial) ? "partial" : "complete",
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
    const ambiguous = this.projection.datedBasis.filter((row) => intervalIntersects(row, filter) && !inPeriod(row));
    for (const row of this.projection.datedBasis) {
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

  private unplacedUsage(ambiguous: BasisRow[]): UsageMetrics {
    return sumUsage([{ metrics: this.projection.unplacedUsage }, ...ambiguous]);
  }
}
