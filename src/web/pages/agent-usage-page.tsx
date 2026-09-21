import { useEffect, useMemo, useState } from "react";
import { Database, RefreshCw, SearchX, TriangleAlert } from "lucide-react";
import { useSearchParams } from "react-router";

import { api, errorMessage, type Agent, type Page, type SessionListItem } from "@/api";
import { EmptyState, PageContainer, PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n";
import type {
  AttributionDetail, AttributionInvocation, AttributionRankRow, Capability, CapabilityKind, ContextEvidence, ContextEvidenceDetail, TokenEstimate
} from "../../agent-usage/core/context-types.js";
import type { UsageMetrics, UsageSummary } from "../../agent-usage/core/types.js";

const formatNumber = (value: number | null | undefined, unknown = "—") => value == null ? unknown : new Intl.NumberFormat().format(value);

type AnalysisStatus = "ready" | "collecting" | "partial" | "empty";
type UsageMetadata = {
  asOf: string;
  timezone: string;
  from: string | null;
  to: string | null;
  analysisStatus: AnalysisStatus;
  captureHealth?: Array<{ sessionId: string; runtimeKind: string; status: string; observed: number; incomplete: number; errorCode: string | null }>;
  collectionFailures?: Array<{ sessionId: string; status: string; errorCode: string | null }>;
};
type SummaryResponse = UsageSummary & UsageMetadata;
type RankingResponse = UsageMetadata & {
  measurement: "estimated";
  dimension: CapabilityKind;
  sort: SortKey;
  total: number;
  items: AttributionRankRow[];
  stages?: Array<{ capability: Capability; stage: "catalog_visible" | "body_read" | "reference_read" | "script_executed"; count: number }>;
};
type TimeseriesResponse = UsageMetadata & {
  items: Array<{ period: string; usage: UsageMetrics; observedRanges: number }>;
};
type InvocationOriginFilter = "counted" | "context";
type InvocationPage = UsageMetadata & { origin?: "counted" | "execution" | "context"; items: Array<AttributionInvocation | ContextEvidence>; nextCursor: string | null };
type InvocationDetail = (AttributionDetail | ContextEvidenceDetail) & { bodyStatus: "not_retained"; usageEvidence?: unknown[]; asOf?: string };
type UsageSource = {
  id: string;
  sourceKey: string;
  kind: "codex_log" | "claude_log" | "context_snapshot";
  status: string;
  errorCode: string | null;
  rejectedRecords: number;
  lastSuccessAt: string | null;
  mappings: Array<{ sessionId: string; state: string }>;
};
type SortKey = "totalInputTokens" | "inputBytes" | "calls" | "definitionInputTokens" | "firstResultInputTokens" | "repeatedResultInputTokens" | "failures" | "latencyMsP95";
type RangeKey = "7d" | "30d" | "all";

const PAGE_SIZE = 50;
const invocationPageSize = 50;
const sourcePollIntervalMs = 1_000;
const maxSourcePollAttempts = 60;
const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const dimensions: CapabilityKind[] = ["mcp_tool", "builtin_tool", "cli", "skill", "plugin", "hook", "unknown"];
const sorts: SortKey[] = ["inputBytes", "totalInputTokens", "calls", "definitionInputTokens", "firstResultInputTokens", "repeatedResultInputTokens", "failures", "latencyMsP95"];

const zonedDateParts = (instant: Date, timezone: string) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
  timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
}).formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));

const zonedMidnight = (date: string, timezone: string): Date => {
  const [year, month, day] = date.split("-").map(Number);
  const nominal = Date.UTC(year!, month! - 1, day!);
  let instant = nominal;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedDateParts(new Date(instant), timezone);
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    instant -= represented - nominal;
  }
  return new Date(instant);
};

const dateKeyInZone = (instant: Date, timezone: string): string => {
  const parts = zonedDateParts(instant, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const shiftDateKey = (date: string, days: number): string => {
  const instant = new Date(`${date}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
};

const rangeBounds = (range: RangeKey, timezone: string): { from?: string; to?: string } => {
  if (range === "all") return {};
  const today = dateKeyInZone(new Date(), timezone);
  const days = range === "30d" ? 30 : 7;
  return {
    from: zonedMidnight(shiftDateKey(today, -(days - 1)), timezone).toISOString(),
    to: zonedMidnight(shiftDateKey(today, 1), timezone).toISOString()
  };
};

const queryString = (values: Record<string, string | undefined>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") params.set(key, value);
  return params.toString();
};

const statusVariant = (status: string): "default" | "secondary" | "destructive" | "outline" =>
  status === "completed" || status === "ready" ? "default" : status === "failed" ? "destructive" : status === "collecting" ? "secondary" : "outline";

export const AgentUsagePage = () => {
  const { text, formatDate } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const agentId = searchParams.get("agentId") ?? "";
  const sessionId = searchParams.get("sessionId") ?? "";
  const range = (["7d", "30d", "all"].includes(searchParams.get("range") ?? "") ? searchParams.get("range") : "7d") as RangeKey;
  const timezone = searchParams.get("timezone") || browserTimezone;
  const requestedRuntimeKind = searchParams.get("runtimeKind") ?? "";
  const runtimeKind = requestedRuntimeKind === "claude-code" ? "claude_code" : requestedRuntimeKind;
  const dimension = (dimensions.includes(searchParams.get("dimension") as CapabilityKind) ? searchParams.get("dimension") : "mcp_tool") as CapabilityKind;
  const sort = (sorts.includes(searchParams.get("sort") as SortKey) ? searchParams.get("sort") : "totalInputTokens") as SortKey;
  const offset = Math.max(0, Number.parseInt(searchParams.get("offset") ?? "0", 10) || 0);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [ranking, setRanking] = useState<RankingResponse | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesResponse | null>(null);
  const [sources, setSources] = useState<UsageSource[] | null>(null);
  const [error, setError] = useState("");
  const [rankingError, setRankingError] = useState("");
  const [reload, setReload] = useState(0);
  const [guideOpen, setGuideOpen] = useState(false);
  const [selectedCapability, setSelectedCapability] = useState<Capability | null>(null);

  const updateFilter = (key: string, value: string, resetOffset = true) => {
    const next = new URLSearchParams(searchParams);
    if (value === "") next.delete(key); else next.set(key, value);
    if (resetOffset) next.delete("offset");
    if (key === "agentId") next.delete("sessionId");
    setSearchParams(next);
  };

  useEffect(() => {
    if (requestedRuntimeKind !== "claude-code") return;
    const next = new URLSearchParams(searchParams);
    next.set("runtimeKind", "claude_code");
    setSearchParams(next, { replace: true });
  }, [requestedRuntimeKind, searchParams, setSearchParams]);

  useEffect(() => {
    const controller = new AbortController();
    void api<Agent[]>("/agents", { signal: controller.signal }).then(setAgents).catch(() => {
      if (!controller.signal.aborted) setAgents([]);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setSessions(null);
    const query = queryString({ agentId: agentId || undefined, page: "1", pageSize: "100" });
    void api<Page<SessionListItem>>(`/sessions?${query}`, { signal: controller.signal }).then((page) => setSessions(page.items)).catch(() => {
      if (!controller.signal.aborted) setSessions([]);
    });
    return () => controller.abort();
  }, [agentId]);

  const scopeQuery = useMemo(() => {
    const bounds = rangeBounds(range, timezone);
    return queryString({
      agentId: agentId || undefined,
      sessionId: sessionId || undefined,
      timezone,
      runtimeKind: runtimeKind || undefined,
      ...bounds
    });
  }, [agentId, range, runtimeKind, sessionId, timezone]);
  const requestQuery = useMemo(() => [scopeQuery, queryString({ dimension, sort, offset: String(offset), limit: String(PAGE_SIZE) })]
    .filter(Boolean).join("&"), [scopeQuery, dimension, sort, offset]);

  const collectingSourceIds = (sources ?? [])
    .filter((source) => source.status === "collecting" || source.status === "failed")
    .map((source) => source.id)
    .sort()
    .join(",");

  useEffect(() => {
    const controller = new AbortController();
    setSummary(null); setTimeseries(null); setSources(null); setError("");
    const sourcePromise = api<UsageSource[]>("/usage/sources", { signal: controller.signal });
    void Promise.all([
      api<SummaryResponse>(`/usage/summary?${scopeQuery}`, { signal: controller.signal }),
      api<TimeseriesResponse>(`/usage/timeseries?${scopeQuery}`, { signal: controller.signal }),
      sourcePromise
    ]).then(([nextSummary, nextTimeseries, nextSources]) => {
      setSummary(nextSummary); setTimeseries(nextTimeseries);
      setSources(sessionId === "" ? nextSources : nextSources.filter((source) => source.mappings.some((mapping) => mapping.sessionId === sessionId)));
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    });
    return () => controller.abort();
  }, [reload, scopeQuery, sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    setRanking(null); setRankingError("");
    void api<RankingResponse>(`/usage/capabilities?${requestQuery}`, { signal: controller.signal })
      .then(setRanking).catch((reason: unknown) => { if (!controller.signal.aborted) setRankingError(errorMessage(reason)); });
    return () => controller.abort();
  }, [reload, requestQuery]);

  const recoveryPending = (summary?.collectionFailures?.length ?? 0) > 0
    || (summary?.captureHealth ?? []).some((item) => item.status === "waiting" || item.status === "pending");

  useEffect(() => {
    if (collectingSourceIds === "" && !recoveryPending) return;
    const controller = new AbortController();
    const trackedIds = new Set(collectingSourceIds.split(","));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    const poll = async (): Promise<void> => {
      let visibleSources: UsageSource[] | null = null;
      try {
        const nextSources = await api<UsageSource[]>("/usage/sources", { signal: controller.signal });
        if (controller.signal.aborted) return;
        visibleSources = sessionId === "" ? nextSources
          : nextSources.filter((source) => source.mappings.some((mapping) => mapping.sessionId === sessionId));
        const nextById = new Map(visibleSources.map((source) => [source.id, source]));
        const reachedTerminal = [...trackedIds].some((id) => nextById.get(id)?.status !== "collecting");
        const stillCollecting = visibleSources.some((source) => trackedIds.has(source.id) && (source.status === "collecting" || source.status === "failed"));

        let stillRecovering = recoveryPending;
        let waitingOnly = false;
        if (reachedTerminal || recoveryPending) {
          const [nextSummary, nextRanking, nextTimeseries] = await Promise.all([
            api<SummaryResponse>(`/usage/summary?${scopeQuery}`, { signal: controller.signal }),
            api<RankingResponse>(`/usage/capabilities?${requestQuery}`, { signal: controller.signal }),
            api<TimeseriesResponse>(`/usage/timeseries?${scopeQuery}`, { signal: controller.signal })
          ]);
          if (controller.signal.aborted) return;
          waitingOnly = (nextSummary.collectionFailures?.length ?? 0) === 0
            && !(nextSummary.captureHealth ?? []).some((item) => item.status === "pending");
          stillRecovering = (nextSummary.collectionFailures?.length ?? 0) > 0
            || (nextSummary.captureHealth ?? []).some((item) => item.status === "waiting" || item.status === "pending");
          setSummary(nextSummary);
          setRanking(nextRanking);
          setTimeseries(nextTimeseries);
        }
        setSources(visibleSources);
        if (!stillCollecting && !stillRecovering) return;
        attempts += 1;
        if (attempts >= maxSourcePollAttempts) {
          if (!waitingOnly || stillCollecting) setError(text("采集状态刷新超时，请重试。", "Collection status refresh timed out. Please retry."));
          return;
        }
        timeout = setTimeout(() => void poll(), sourcePollIntervalMs);
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (visibleSources !== null) setSources(visibleSources);
        setError(errorMessage(reason));
      }
    };

    void poll();
    return () => {
      controller.abort();
      if (timeout !== undefined) clearTimeout(timeout);
    };
  }, [collectingSourceIds, recoveryPending, requestQuery, scopeQuery, sessionId, text]);

  const collectSource = async (source: UsageSource) => {
    setError("");
    try {
      const updated = await api<UsageSource>(`/usage/sources/${source.id}/collect`, { method: "POST" });
      setSources((current) => current?.map((item) => item.id === updated.id ? updated : item) ?? null);
    } catch (reason) { setError(errorMessage(reason)); }
  };

  const clearDataFilters = () => {
    const next = new URLSearchParams(searchParams);
    for (const key of ["agentId", "sessionId", "runtimeKind", "offset"]) next.delete(key);
    next.set("range", "all");
    setSearchParams(next);
  };

  const dimensionLabel = (kind: CapabilityKind) => ({
    mcp_tool: text("MCP 工具", "MCP tools"), builtin_tool: text("内置工具", "Built-in tools"), cli: "CLI",
    skill: text("技能", "Skills"), plugin: text("插件", "Plugins"), hook: "Hooks", unknown: text("未知", "Unknown")
  })[kind];
  const sortLabel = (value: SortKey) => ({
    totalInputTokens: text("估算输入", "Estimated input"), inputBytes: text("输入字节数", "Input bytes"), calls: text("调用次数", "Calls"),
    definitionInputTokens: text("定义输入", "Definition input"), firstResultInputTokens: text("首次结果输入", "First result input"),
    repeatedResultInputTokens: text("重复结果输入", "Repeated result input"), failures: text("失败次数", "Failures"),
    latencyMsP95: text("P95 延迟", "P95 latency")
  })[value];
  const estimate = (value: number | null | undefined) => formatNumber(value, text("未采集模型输入", "Model input not collected"));
  const hasModelEvidence = summary !== null && (summary.analysisStatus !== "empty"
    || summary.observedModelRequests > 0 || Object.values(summary.usage).some((value) => value !== null));
  const hasCapabilityEvidence = ranking !== null
    && (ranking.items.length > 0 || (ranking.stages?.length ?? 0) > 0);
  const empty = !hasModelEvidence && !hasCapabilityEvidence;
  const filteredEmpty = empty && (range !== "all" || agentId !== "" || sessionId !== "" || runtimeKind !== "");
  const timezoneOptions = [...new Set([browserTimezone, "UTC", timezone])];
  const runtimeOptions = [...new Set(["codex", "claude_code", "hermes", runtimeKind].filter(Boolean))];

  return <PageContainer width="wide">
    <PageHeader eyebrow={text("可核验用量台账", "VERIFIABLE USAGE LEDGER")} title={text("用量分析", "Usage analysis")}
      description={text("核对模型实际报告的 Token，并估算工具、技能与插件进入模型上下文的输入成本。", "Reconcile model-reported tokens and estimate the model-input cost of tools, skills, and plugins.")} />

    <Card className="mb-5"><CardHeader><CardTitle>{text("分析范围", "Analysis scope")}</CardTitle><CardDescription>{text("日期按所选时区的自然日换算；结束时间为下一日零点，不假设每天固定 24 小时。", "Dates use calendar boundaries in the selected timezone; the end is the next local midnight without assuming a fixed 24-hour day.")}</CardDescription></CardHeader><CardContent><FieldGroup className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
      <Field><FieldLabel htmlFor="usage-agent">{text("智能体", "Agent")}</FieldLabel><NativeSelect id="usage-agent" size="sm" aria-label={text("智能体筛选", "Agent filter")} value={agentId} onChange={(event) => updateFilter("agentId", event.target.value)}><NativeSelectOption value="">{text("全部智能体", "All agents")}</NativeSelectOption>{(agents ?? []).map((agent) => <NativeSelectOption key={agent.id} value={agent.id}>{agent.name}</NativeSelectOption>)}</NativeSelect></Field>
      <Field><FieldLabel htmlFor="usage-session">{text("会话", "Session")}</FieldLabel><NativeSelect id="usage-session" size="sm" aria-label={text("会话筛选", "Session filter")} value={sessionId} disabled={sessions === null} onChange={(event) => updateFilter("sessionId", event.target.value)}><NativeSelectOption value="">{text("全部会话", "All sessions")}</NativeSelectOption>{(sessions ?? []).map((session) => <NativeSelectOption key={session.id} value={session.id}>{session.title}</NativeSelectOption>)}</NativeSelect></Field>
      <Field><FieldLabel htmlFor="usage-range">{text("日期范围", "Date range")}</FieldLabel><NativeSelect id="usage-range" size="sm" value={range} onChange={(event) => updateFilter("range", event.target.value)}><NativeSelectOption value="7d">{text("最近 7 天", "Recent 7 days")}</NativeSelectOption><NativeSelectOption value="30d">{text("最近 30 天", "Recent 30 days")}</NativeSelectOption><NativeSelectOption value="all">{text("全部时间", "All time")}</NativeSelectOption></NativeSelect></Field>
      <Field><FieldLabel htmlFor="usage-timezone">{text("时区", "Timezone")}</FieldLabel><NativeSelect id="usage-timezone" size="sm" value={timezone} onChange={(event) => updateFilter("timezone", event.target.value)}>{timezoneOptions.map((value) => <NativeSelectOption key={value} value={value}>{value}{value === browserTimezone ? text("（浏览器）", " (browser)") : ""}</NativeSelectOption>)}</NativeSelect></Field>
      <Field><FieldLabel htmlFor="usage-runtime">{text("运行时", "Runtime")}</FieldLabel><NativeSelect id="usage-runtime" size="sm" value={runtimeKind} onChange={(event) => updateFilter("runtimeKind", event.target.value)}><NativeSelectOption value="">{text("全部运行时", "All runtimes")}</NativeSelectOption>{runtimeOptions.map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}</NativeSelect></Field>
      <Field><FieldLabel htmlFor="usage-dimension">{text("能力维度", "Capability dimension")}</FieldLabel><NativeSelect id="usage-dimension" size="sm" aria-label={text("能力维度", "Capability dimension")} value={dimension} onChange={(event) => updateFilter("dimension", event.target.value)}>{dimensions.map((value) => <NativeSelectOption key={value} value={value}>{dimensionLabel(value)}</NativeSelectOption>)}</NativeSelect></Field>
      <Field><FieldLabel htmlFor="usage-sort">{text("排序", "Sort")}</FieldLabel><NativeSelect id="usage-sort" size="sm" value={sort} onChange={(event) => updateFilter("sort", event.target.value)}>{sorts.map((value) => <NativeSelectOption key={value} value={value}>{sortLabel(value)}</NativeSelectOption>)}</NativeSelect></Field>
    </FieldGroup></CardContent></Card>

    {error !== "" || rankingError !== "" ? <Alert variant="destructive" className="mb-5"><TriangleAlert /><AlertTitle>{text("用量分析加载失败", "Usage analysis failed to load")}</AlertTitle><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span>{error || rankingError}</span><Button type="button" size="sm" variant="outline" onClick={() => setReload((value) => value + 1)}>{text("重试", "Retry")}</Button></AlertDescription></Alert> : null}

    {summary === null ? error === "" ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" role="status" aria-label={text("正在加载用量分析", "Loading usage analysis")}>{[0, 1, 2, 3].map((item) => <Skeleton key={item} className="h-32" />)}</div> : null : <div className="flex flex-col gap-5">
      {summary.completeness === "partial" || summary.completeness === "conflict" || summary.analysisStatus === "partial" ? <Alert><TriangleAlert /><AlertTitle>{text("数据不完整", "Incomplete data")}</AlertTitle><AlertDescription>{text(`缺失 ${summary.requestsWithMissingUsage} 个模型请求，部分上报 ${summary.requestsWithPartialUsage} 个；另有 ${summary.unverifiedObservations} 条未核验观测与 ${summary.conflictingRanges} 个冲突范围。页面不会把缺失值当作 0。`, `${summary.requestsWithMissingUsage} model requests are missing usage and ${summary.requestsWithPartialUsage} are partial; ${summary.unverifiedObservations} observations are unverified and ${summary.conflictingRanges} ranges conflict. Missing values are never treated as zero.`)}</AlertDescription></Alert> : null}

      {(summary?.captureHealth?.length ?? 0) > 0 && <Alert>
        <Database className="size-4" />
        <AlertTitle>{text("自动模型请求采集", "Automatic model request capture")}</AlertTitle>
        <AlertDescription><div className="flex flex-col gap-2">{summary!.captureHealth!.map((item, index) =>
          <div key={`${item.sessionId}:${index}`} className="flex flex-wrap items-center gap-2">
            <span>{text(`会话 ${item.sessionId}`, `Session ${item.sessionId}`)} · {item.runtimeKind}</span>
            <Badge variant={item.status === "incomplete" ? "destructive" : "outline"}>{item.status === "waiting"
              ? text("等待请求，覆盖尚未验证", "Waiting for requests; coverage unverified") : item.status === "pending"
              ? text("采集中", "Capturing") : text(`已观察 ${item.observed} 次请求`, `${item.observed} requests observed`)}</Badge>
            {item.incomplete > 0 && <span>{text(`${item.incomplete} 次采集不完整`, `${item.incomplete} incomplete captures`)} · {item.errorCode}</span>}
          </div>)}<Button type="button" size="sm" variant="outline" className="self-start" onClick={() => setReload((value) => value + 1)}><RefreshCw />{text("刷新采集状态", "Refresh capture status")}</Button></div></AlertDescription>
      </Alert>}
      {(summary.collectionFailures?.length ?? 0) > 0 ? <Alert><TriangleAlert /><AlertTitle>{text("采集尚未完成", "Collection is incomplete")}</AlertTitle><AlertDescription><p>{text("后台会继续处理待采集会话并重试失败来源。", "Background recovery continues pending sessions and retries failed sources.")}</p><div className="mt-2 flex flex-wrap gap-2">{summary.collectionFailures?.map((failure) => <Badge variant="outline" key={failure.sessionId}>{text(`会话 ${failure.sessionId}`, `Session ${failure.sessionId}`)} · {failure.status === "failed" ? text("采集失败，等待重试", "Collection failed; retry pending") : text("等待采集", "Collection pending")}</Badge>)}</div></AlertDescription></Alert> : null}

      <section aria-labelledby="reported-usage-title"><div className="mb-3 flex flex-wrap items-end justify-between gap-3"><div><h2 id="reported-usage-title" className="font-heading text-lg font-medium">{text("模型上报用量", "Model-reported usage")}</h2><p className="mt-1 text-sm text-muted-foreground">{text("来自模型请求、轮次或 Provider 范围总量的去重台账；与下方估算值不是同一口径。", "A reconciled ledger reported by model requests, turns, or provider ranges; it is separate from the estimates below.")}</p></div><Badge variant={summary.analysisStatus === "collecting" ? "secondary" : summary.completeness === "complete" ? "default" : "outline"}>{summary.analysisStatus === "collecting" ? text("采集中", "Collecting") : summary.completeness === "complete" ? text("完整", "Complete") : text("部分", "Partial")}</Badge></div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label={text("总 Token", "Total tokens")} value={formatNumber(summary.usage.totalTokens, text("未上报", "Not reported"))} />
          <MetricCard label={text("输入 Token", "Input tokens")} value={formatNumber(summary.usage.inputTotalTokens, text("未上报", "Not reported"))} />
          <MetricCard label={text("输出 Token", "Output tokens")} value={formatNumber(summary.usage.outputTotalTokens, text("未上报", "Not reported"))} />
          <MetricCard label={text("未归位 Token", "Unplaced tokens")} value={formatNumber(summary.unplacedUsage.totalTokens, text("未上报", "Not reported"))} description={text("已报告但不能安全归到具体请求。", "Reported but not safely attributable to a request.")} />
        </div>
        {summary.accountingBasis === "interval_totals" ? <p className="mt-2 text-sm text-muted-foreground">{text("累计增量区间", "Cumulative usage intervals")}</p> : null}
      </section>

      {timeseries !== null && timeseries.items.length > 1 ? <Card><CardHeader><CardTitle>{text("每日已上报总量", "Daily reported totals")}</CardTitle><CardDescription>{text("仅展示有来源时间戳且落在当前日期范围内的记录。", "Only records with a source timestamp inside the current date range are shown.")}</CardDescription></CardHeader><CardContent className="overflow-x-auto"><table className="w-full min-w-[32rem] text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="pb-3 font-medium">{text("日期", "Date")}</th><th className="pb-3 text-right font-medium">{text("总 Token", "Total tokens")}</th><th className="pb-3 text-right font-medium">{text("观测范围", "Observed ranges")}</th></tr></thead><tbody className="divide-y">{timeseries.items.map((item) => <tr key={item.period}><td className="py-3 font-mono">{item.period}</td><td className="py-3 text-right font-mono tabular-nums">{formatNumber(item.usage.totalTokens, text("未上报", "Not reported"))}</td><td className="py-3 text-right font-mono tabular-nums">{item.observedRanges}</td></tr>)}</tbody></table></CardContent></Card> : null}

      {ranking === null ? <Skeleton className="h-48" aria-label={text("正在加载排名", "Loading rankings")} /> : empty ? filteredEmpty
        ? <EmptyState icon={SearchX} title={text("当前筛选没有记录", "No records match these filters")} description={text("已选范围内没有模型用量或能力活动；清除 Agent、会话、运行时与日期筛选可查看全部历史。", "The selected scope has no model usage or capability activity. Clear the Agent, Session, Runtime, and date filters to view all history.")} action={<Button type="button" variant="outline" onClick={clearDataFilters}>{text("清除筛选", "Clear filters")}</Button>} />
        : <EmptyState icon={SearchX} title={text("尚无用量记录", "No usage records yet")} description={text("受管会话会自动发现 Provider 日志。启用自动模型请求采集后，可核对工具输入估算；也可导入上下文快照。", "Managed sessions discover provider logs automatically. Enable automatic model request capture for tool input estimates, or import a Context Snapshot.")} action={<Button type="button" onClick={() => setGuideOpen(true)}>{text("查看接入方法", "View setup guide")}</Button>} />
        : <CapabilityTable ranking={ranking} estimate={estimate} dimensionLabel={dimensionLabel} onOpen={setSelectedCapability} />}
      {ranking !== null && ranking.total > PAGE_SIZE ? <div className="flex items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{text(`第 ${offset + 1}–${Math.min(offset + PAGE_SIZE, ranking.total)} 项，共 ${ranking.total} 项`, `${offset + 1}–${Math.min(offset + PAGE_SIZE, ranking.total)} of ${ranking.total}`)}</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={offset === 0} onClick={() => updateFilter("offset", String(Math.max(0, offset - PAGE_SIZE)), false)}>{text("上一页", "Previous")}</Button><Button size="sm" variant="outline" disabled={offset + PAGE_SIZE >= ranking.total} onClick={() => updateFilter("offset", String(offset + PAGE_SIZE), false)}>{text("下一页", "Next")}</Button></div></div> : null}
      <SourceList sources={sources ?? []} onCollect={collectSource} formatDate={formatDate} />
    </div>}

    <InvocationSheet capability={selectedCapability} onClose={() => setSelectedCapability(null)} baseQuery={requestQuery} sessionSelected={sessionId !== ""} />
    <GuideSheet open={guideOpen} onOpenChange={setGuideOpen} />
  </PageContainer>;
};

const MetricCard = ({ label, value, description }: { label: string; value: string; description?: string }) => <Card><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="font-mono text-2xl tabular-nums">{value}</CardTitle>{description === undefined ? null : <CardDescription>{description}</CardDescription>}</CardHeader></Card>;

const CapabilityTable = ({ ranking, estimate, dimensionLabel, onOpen }: {
  ranking: RankingResponse;
  estimate(value: number | null | undefined): string;
  dimensionLabel(kind: CapabilityKind): string;
  onOpen(capability: Capability): void;
}) => {
  const { text } = useI18n();
  const stageLabel = (stage: NonNullable<RankingResponse["stages"]>[number]["stage"]) => ({
    catalog_visible: text("目录可见", "Catalog visible"),
    body_read: text("正文读取", "Body read"),
    reference_read: text("引用读取", "Reference read"),
    script_executed: text("脚本执行", "Script executed")
  })[stage];
  const estimateNotice = (row: AttributionRankRow): string | null => {
    const incompleteContext = row.contextCoverage.partial + row.contextCoverage.opaque + row.contextCoverage.none;
    if (row.estimateCompleteness === "complete" && row.missingExposureCount === 0 && incompleteContext === 0) return null;
    const zhCoverage = ([[row.contextCoverage.full, "完整"], [row.contextCoverage.partial, "部分"],
      [row.contextCoverage.opaque, "不透明"], [row.contextCoverage.none, "未知"]] as Array<[number, string]>)
      .filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`).join(" / ");
    const enCoverage = ([[row.contextCoverage.full, "full"], [row.contextCoverage.partial, "partial"],
      [row.contextCoverage.opaque, "opaque"], [row.contextCoverage.none, "unknown"]] as Array<[number, string]>)
      .filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`).join(" / ");
    const zh = [row.estimateCompleteness === "none" ? "输入未知" : row.estimateCompleteness === "partial" ? "部分估算" : null,
      row.missingExposureCount > 0 ? `${row.missingExposureCount} 项输入未知` : null,
      incompleteContext > 0 ? `上下文：${zhCoverage}` : null]
      .filter((item) => item !== null).join(" · ");
    const en = [row.estimateCompleteness === "none" ? "Input unknown" : row.estimateCompleteness === "partial" ? "Partial estimate" : null,
      row.missingExposureCount > 0 ? `${row.missingExposureCount} input exposure${row.missingExposureCount === 1 ? "" : "s"} unknown` : null,
      incompleteContext > 0 ? `Context: ${enCoverage}` : null]
      .filter((item) => item !== null).join(" · ");
    return text(zh, en);
  };
  return <Card>
    <CardHeader><CardTitle>{text("能力输入估算", "Capability input estimates")}</CardTitle><CardDescription>{text("基于已持久化的定义、参数与结果暴露估算；它不是 Provider 上报的 Token。MCP 工具按服务器身份分别排名。", "Estimated from persisted definition, argument, and result exposure; this is not provider-reported usage. MCP tools are ranked by server identity.")}</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-5 overflow-x-auto">
      {ranking.items.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">{text("当前维度没有可排名的能力。", "No capabilities can be ranked for this dimension.")}</p> : <table className="w-full min-w-[58rem] text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="pb-3 font-medium">{text("能力", "Capability")}</th><th className="pb-3 text-right font-medium">{text("调用 / 失败", "Calls / failures")}</th><th className="pb-3 text-right font-medium">{text("输入字节数", "Input bytes")}</th><th className="pb-3 text-right font-medium">{text("定义输入", "Definition input")}</th><th className="pb-3 text-right font-medium">{text("首次结果", "First result")}</th><th className="pb-3 text-right font-medium">{text("重复结果", "Repeated result")}</th><th className="pb-3 text-right font-medium">{text("估算总输入", "Estimated total input")}</th><th className="pb-3 text-right font-medium"><span className="sr-only">{text("操作", "Actions")}</span></th></tr></thead><tbody className="divide-y">{ranking.items.map((row) => {
        const notice = estimateNotice(row);
        const count = (value: number | null) => value !== null ? estimate(value)
          : row.tokenizationStatus === "mixed" ? text("分项显示", "See breakdown")
          : row.exposureCount > 0 ? text("无法估算", "Unavailable") : estimate(null);
        return <tr key={`${row.capability.kind}:${row.capability.serverId ?? ""}:${row.capability.id}`}><td className="py-3"><p className="font-medium">{row.capability.name}</p><p className="mt-1 text-xs text-muted-foreground">{dimensionLabel(row.capability.kind)}{row.capability.serverId === undefined ? "" : ` · ${text("服务器", "Server")} ${row.capability.serverId}`}</p>{row.tokenEstimates.map((item, index) => <div key={index} className="mt-2"><TokenMeasurement estimate={item} /><p className="text-xs text-muted-foreground">{item.totalInputTokens === null ? text("Token 未知", "Tokens unknown") : text(`${item.totalInputTokens} 估算 Token`, `${item.totalInputTokens} estimated tokens`)}</p></div>)}</td><td className="py-3 text-right font-mono tabular-nums"><span>{row.calls} / {row.failures}</span>{row.contextOnlyCalls > 0 ? <p className="mt-1 text-xs text-muted-foreground">{text(`上下文证据：${row.contextOnlyCalls}`, `Context evidence: ${row.contextOnlyCalls}`)}</p> : null}</td><td className="py-3 text-right font-mono tabular-nums">{formatNumber(row.inputBytes, text("未知", "Unknown"))}</td><td className="py-3 text-right font-mono tabular-nums">{count(row.definitionInputTokens)}</td><td className="py-3 text-right font-mono tabular-nums">{count(row.firstResultInputTokens)}</td><td className="py-3 text-right font-mono tabular-nums">{count(row.repeatedResultInputTokens)}</td><td className="py-3 text-right"><div className="flex flex-col items-end gap-1"><span className="font-mono tabular-nums">{count(row.totalInputTokens)}</span>{row.tokenizationStatus === "mixed" ? <Badge variant="outline">{text("混合估算，明细见各模型", "Mixed estimates; see model breakdown")}</Badge> : null}{notice === null ? null : <Badge variant="outline">{notice}</Badge>}</div></td><td className="py-3 text-right"><Button type="button" size="sm" variant="outline" aria-label={text(`查看 ${row.capability.name} 的调用`, `View calls for ${row.capability.name}`)} onClick={() => onOpen(row.capability)}>{text("查看调用", "View calls")}</Button></td></tr>;
      })}</tbody></table>}
      {(ranking.stages ?? []).length === 0 ? null : <section aria-labelledby="runtime-stage-evidence-title"><h3 id="runtime-stage-evidence-title" className="font-medium">{text("运行时阶段证据", "Runtime stage evidence")}</h3><p className="mt-1 text-sm text-muted-foreground">{text("读取、引用和脚本阶段是独立活动证据，不计入调用次数。", "Read, reference, and script stages are independent activity evidence and are not added to call counts.")}</p><div className="mt-3 flex flex-wrap gap-2">{ranking.stages?.map((item) => <Badge key={`${item.capability.kind}:${item.capability.id}:${item.stage}`} variant="outline">{item.capability.name} · {stageLabel(item.stage)} · {item.count}</Badge>)}</div></section>}
    </CardContent>
  </Card>;
};

const SourceList = ({ sources, onCollect, formatDate }: { sources: UsageSource[]; onCollect(source: UsageSource): void; formatDate(value: string | null): string }) => {
  const { text } = useI18n();
  const kindLabel = (kind: UsageSource["kind"]) => kind === "context_snapshot" ? text("上下文快照", "Context Snapshot") : kind === "codex_log" ? "Codex log" : "Claude log";
  const statusLabel = (status: string) => ({
    idle: text("待采集", "Idle"), collecting: text("采集中", "Collecting"),
    completed: text("已完成", "Completed"), failed: text("失败", "Failed")
  })[status as "idle" | "collecting" | "completed" | "failed"] ?? status;
  return <Card><CardHeader><CardTitle>{text("数据来源", "Data sources")}</CardTitle><CardDescription>{text("这里的采集状态决定分析是否可能完整；选择会话时只显示映射到该会话的来源。", "Collection status determines whether analysis can be complete; selecting a session limits this list to mapped sources.")}</CardDescription></CardHeader><CardContent>{sources.length === 0 ? <p className="text-sm text-muted-foreground">{text("当前范围没有已注册来源。", "No registered sources match this scope.")}</p> : <div className="divide-y rounded-lg border">{sources.map((source) => <div key={source.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="truncate font-medium">{source.sourceKey}</p><Badge variant="outline">{kindLabel(source.kind)}</Badge><Badge variant={statusVariant(source.status)}>{statusLabel(source.status)}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{text("最近成功：", "Last success: ")}{formatDate(source.lastSuccessAt)} · {text(`拒绝 ${source.rejectedRecords} 条`, `${source.rejectedRecords} rejected`)}</p>{source.errorCode === null ? null : <p className="mt-1 font-mono text-xs text-destructive">{source.errorCode}</p>}</div><Button type="button" size="sm" variant="outline" disabled={source.status === "collecting"} onClick={() => void onCollect(source)}><RefreshCw className={source.status === "collecting" ? "animate-spin" : ""} />{source.status === "collecting" ? text("采集中", "Collecting") : text("重新采集", "Collect")}</Button></div>)}</div>}</CardContent></Card>;
};

const TokenMeasurement = ({ estimate }: { estimate: TokenEstimate }) => {
  const { text } = useI18n();
  const reasons = {
    model_missing: text("缺少模型身份", "Model identity missing"),
    model_unmapped: text("未配置模型词表", "No tokenizer configured for this model"),
    unsupported_content: text("不支持此内容类型", "Unsupported content type"),
    size_limit: text("超过估算大小限制", "Estimation size limit exceeded"),
    tokenization_failed: text("分词失败", "Tokenization failed"),
    legacy_unavailable: text("历史估算缺失", "Historical estimate unavailable")
  };
  const label = estimate.method === "legacy_reference" ? text("历史参考估算", "Historical reference estimate")
    : estimate.method === "model_tokenizer" ? text("模型词表估算", "Model tokenizer estimate")
      : estimate.method === "text_heuristic" ? text("兜底估算（按字符类型加权）", "Fallback estimate (weighted character types)") : text("无法估算", "Unavailable");
  return <p className="mt-1 max-w-sm break-words text-xs text-muted-foreground">{[
    estimate.model ?? text("模型未知", "Unknown model"), estimate.modelProvider,
    label, estimate.heuristicVersion, estimate.tokenizerId, estimate.tokenizer ? `${estimate.tokenizer}@${estimate.tokenizerVersion}` : null,
    estimate.tokenizerRevision?.slice(0, 12), estimate.reason ? reasons[estimate.reason] : null
  ].filter(Boolean).join(" · ")}</p>;
};

const InvocationSheet = ({ capability, onClose, baseQuery, sessionSelected }: {
  capability: Capability | null;
  onClose(): void;
  baseQuery: string;
  sessionSelected: boolean;
}) => {
  const { text, formatDate } = useI18n();
  const [origin, setOrigin] = useState<InvocationOriginFilter>("counted");
  const [scope, setScope] = useState<"range" | "session">("range");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [page, setPage] = useState<InvocationPage | null>(null);
  const [detail, setDetail] = useState<InvocationDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setOrigin("counted");
    setScope("range");
    setCursor(null);
    setCursorHistory([]);
    setPage(null);
    setDetail(null);
    setError("");
  }, [capability?.id, capability?.kind, capability?.serverId]);

  useEffect(() => {
    if (capability === null) return;
    const controller = new AbortController();
    setPage(null);
    setDetail(null);
    setError("");
    const original = new URLSearchParams(baseQuery);
    original.set("capabilityId", capability.id);
    if (capability.serverId !== undefined) original.set("capabilityServerId", capability.serverId);
    original.set("origin", origin);
    original.set("capabilityKind", capability.kind);
    original.set("limit", String(invocationPageSize));
    original.delete("offset");
    original.delete("dimension");
    original.delete("sort");
    if (scope === "session") {
      original.delete("from");
      original.delete("to");
    }
    if (cursor !== null) original.set("cursor", cursor);
    void api<InvocationPage>(`/usage/${origin === "context" ? "context-evidence" : "invocations"}?${original.toString()}`, { signal: controller.signal })
      .then(setPage)
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [baseQuery, capability, cursor, origin, scope]);

  const openDetail = async (id: string) => {
    setDetail(null);
    setError("");
    try { setDetail(await api<InvocationDetail>(`/usage/${origin === "context" ? "context-evidence" : "invocations"}/${encodeURIComponent(id)}`)); }
    catch (reason) { setError(errorMessage(reason)); }
  };

  const changeOrigin = (value: string) => {
    setOrigin(value as InvocationOriginFilter);
    setCursor(null);
    setCursorHistory([]);
    setDetail(null);
  };
  const invocationStatusLabel = (status: AttributionInvocation["status"]) => ({
    running: text("运行中", "Running"), succeeded: text("成功", "Succeeded"),
    tool_error: text("工具错误", "Tool error"), transport_error: text("传输错误", "Transport error"),
    cancelled: text("已取消", "Cancelled")
  })[status];
  const originLabel = (value: AttributionInvocation["origin"]) => value === "execution" ? text("实际执行", "Execution") : text("上下文证据", "Context evidence");
  const executionEvidenceLabel = (value: AttributionInvocation["executionEvidence"]) => ({
    direct: text("直接", "Direct"), inferred: text("推断", "Inferred"), unknown: text("未知", "Unknown")
  })[value];
  const exposureKindLabel = (value: InvocationDetail["exposures"][number]["kind"]) => ({
    definition: text("定义", "Definition"), arguments: text("参数", "Arguments"), result: text("结果", "Result"),
    skill: text("技能", "Skill"), other: text("其他", "Other")
  })[value];

  return <Sheet open={capability !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <SheetContent className="overflow-y-auto sm:max-w-2xl">
      <SheetHeader>
        <SheetTitle>{capability === null ? text("调用证据", "Invocation evidence") : text(`${capability.name} 调用证据`, `${capability.name} invocation evidence`)}</SheetTitle>
        <SheetDescription>{text("实际调用与模型输入证据使用独立记录；输入证据不会增加调用次数。调用正文不会被保留。", "Actual calls and model-input evidence use independent records; input evidence never increases call counts. Call bodies are not retained.")}</SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-4 px-4 pb-6">
        <Tabs value={origin} onValueChange={changeOrigin}>
          <TabsList className="w-full" aria-label={text("证据类型", "Evidence type")}>
            <TabsTrigger className="flex-1" value="counted" onClick={() => changeOrigin("counted")}>{text("实际调用", "Actual calls")}</TabsTrigger>
            <TabsTrigger className="flex-1" value="context" onClick={() => changeOrigin("context")}>{text("模型输入证据", "Model-input evidence")}</TabsTrigger>
          </TabsList>
          <TabsContent value="counted"><p className="text-sm text-muted-foreground">{text("这里的记录与排名中的调用次数一致；上下文快照不会被重复算作执行。", "These records match the ranking call count; context snapshots are not counted again as executions.")}</p></TabsContent>
          <TabsContent value="context"><Alert><Database /><AlertTitle>{text("独立输入证据", "Independent input evidence")}</AlertTitle><AlertDescription>{text("这些记录来自模型上下文，不代表第二次工具执行。日期筛选使用模型请求时间，包含定义、标签及未归因内容。", "These records come from model context and do not represent another tool execution. Date filtering uses model-request time, including definitions, tags and unattributed content.")}</AlertDescription></Alert></TabsContent>
        </Tabs>
        {sessionSelected ? <Alert><Database /><AlertTitle>{scope === "range" ? text("按排名日期范围筛选", "Filtered by ranking date range") : text("显示全部会话记录", "Showing all Session records")}</AlertTitle><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span>{scope === "range" ? text("没有任何可用时间证据的记录可能不会出现。排名筛选保持不变。", "Records without any usable time evidence may be absent. The ranking filter remains unchanged.") : text("列表忽略日期范围，以包含无时间证据的记录；能力排名仍使用原日期范围。", "The list ignores the date range to include records without time evidence; capability ranking still uses the original range.")}</span><Button type="button" size="sm" variant="outline" onClick={() => { setScope((value) => value === "range" ? "session" : "range"); setCursor(null); setCursorHistory([]); }}>{scope === "range" ? text("显示全部会话记录", "Show all Session records") : text("恢复日期筛选", "Restore date filter")}</Button></AlertDescription></Alert> : null}
        {error !== "" ? <Alert variant="destructive"><TriangleAlert /><AlertTitle>{text("调用证据加载失败", "Invocation evidence failed to load")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
        {page === null && error === "" ? <Skeleton className="h-36" /> : page?.items.length === 0
          ? <p className="py-8 text-center text-sm text-muted-foreground">{origin === "counted" ? text("没有匹配的实际调用。", "No matching actual calls.") : text("没有匹配的模型输入证据。", "No matching model-input evidence.")}</p>
          : <div className="divide-y rounded-lg border">{page?.items.map((invocation) => <div key={invocation.id} className="flex items-center justify-between gap-3 p-3"><div className="min-w-0"><p className="truncate font-mono text-xs">{"modelInvocationId" in invocation ? invocation.modelInvocationId : invocation.id}</p><p className="mt-1 text-xs text-muted-foreground">{"status" in invocation ? invocationStatusLabel(invocation.status) : text("输入证据", "Input evidence")} · {formatDate("occurredAt" in invocation ? invocation.occurredAt : invocation.startedAt)}</p></div><Button type="button" size="sm" variant="outline" aria-label={origin === "counted" ? text(`打开调用 ${invocation.id}`, `Open invocation ${invocation.id}`) : text(`打开输入证据 ${invocation.id}`, `Open input evidence ${invocation.id}`)} onClick={() => void openDetail(invocation.id)}>{origin === "counted" ? text("打开调用", "Open invocation") : text("打开证据", "Open evidence")}</Button></div>)}</div>}
        {page !== null && (cursorHistory.length > 0 || page.nextCursor !== null) ? <div className="flex justify-end gap-2"><Button size="sm" variant="outline" disabled={cursorHistory.length === 0} onClick={() => { const previous = cursorHistory.at(-1) ?? null; setCursorHistory((history) => history.slice(0, -1)); setCursor(previous); }}>{text("上一页", "Previous")}</Button><Button size="sm" variant="outline" disabled={page.nextCursor === null} onClick={() => { setCursorHistory((history) => [...history, cursor]); setCursor(page.nextCursor); }}>{text("下一页", "Next")}</Button></div> : null}
        {detail === null ? null : <Card>
          <CardHeader><CardTitle>{text("持久化证据", "Persisted evidence")}</CardTitle><CardDescription>{text("正文未保留；以下为持久化的计数和关联证据。", "Bodies are not retained; the following counts and linkage evidence are persisted.")}</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-4">
            {"invocation" in detail ? <div className="grid gap-3 sm:grid-cols-2"><Evidence label={text("状态", "Status")} value={invocationStatusLabel(detail.invocation.status)} /><Evidence label={text("记录来源", "Record origin")} value={originLabel(detail.invocation.origin)} /><Evidence label={text("执行证据", "Execution evidence")} value={executionEvidenceLabel(detail.invocation.executionEvidence)} /><Evidence label={text("执行 ID", "Execution ID")} value={detail.invocation.executionId ?? "—"} /><Evidence label={text("原始结果字节", "Raw result bytes")} value={detail.invocation.rawResultBytes == null ? "—" : new Intl.NumberFormat().format(detail.invocation.rawResultBytes)} /><Evidence label={text("关联模型请求", "Linked model invocations")} value={String(detail.subsequentModelInvocationIds.length)} /></div> : <div className="grid gap-3 sm:grid-cols-2"><Evidence label={text("模型请求", "Model request")} value={detail.context.modelInvocationId} /><Evidence label={text("Provider 上下文", "Provider epoch")} value={detail.context.providerEpochId} /><Evidence label={text("会话", "Session")} value={detail.context.sessionId} /></div>}
            <div><p className="mb-2 text-xs font-medium text-muted-foreground">{text("上下文暴露", "Context exposures")}</p>{detail.exposures.length === 0 ? <p className="text-sm text-muted-foreground">{origin === "counted" ? text("这次实际调用没有关联到持久化的模型输入证据；可切换到“模型输入证据”查看独立记录。", "This actual call is not linked to persisted model-input evidence; switch to Model-input evidence to inspect independent records.") : text("没有已持久化的暴露。", "No persisted exposures.")}</p> : <div className="divide-y rounded-lg border">{detail.exposures.map((exposure, index) => <div key={`${exposure.modelInvocationId}:${exposure.position}:${index}`} className="p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-xs">{exposure.modelInvocationId}</span><Badge variant={exposure.resultFirstUse === "repeat" ? "secondary" : "outline"}>{exposure.resultFirstUse === "first" ? text("首次", "First") : exposure.resultFirstUse === "repeat" ? text("重复", "Repeat") : text("未知", "Unknown")}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{"toolInvocationId" in exposure && typeof exposure.toolInvocationId === "string" ? `${exposure.toolInvocationId} · ` : ""}{exposureKindLabel(exposure.kind)} · {text("位置", "position")} {exposure.position} · {exposure.tokens == null ? text("Token 无法估算", "Token estimate unavailable") : text(`${exposure.tokens} 估算 Token`, `${exposure.tokens} estimated tokens`)}</p><TokenMeasurement estimate={exposure} /></div>)}</div>}</div>
          </CardContent>
        </Card>}
      </div>
    </SheetContent>
  </Sheet>;
};

const Evidence = ({ label, value }: { label: string; value: string }) => <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 break-all font-mono text-xs">{value}</p></div>;

const GuideSheet = ({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) => {
  const { text } = useI18n();
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent className="overflow-y-auto sm:max-w-lg"><SheetHeader><SheetTitle>{text("接入用量来源", "Connect a usage source")}</SheetTitle><SheetDescription>{text("管理员可配置 USAGE_CAPTURE_UPSTREAMS，为 Codex 和 Claude 启用 API Key 模式的自动采集。日志自动发现，手动导入仍可用。", "Administrators can configure USAGE_CAPTURE_UPSTREAMS for API-key automatic capture with Codex and Claude. Logs are discovered automatically; manual imports remain available.")}</SheetDescription></SheetHeader><div className="flex flex-col gap-4 px-4 pb-6"><Card><CardHeader><CardTitle>{text("可用来源", "Available sources")}</CardTitle><CardDescription>{text("自动模型请求采集提供实际输入暴露与上报用量；Provider 日志补充核对，上下文快照支持手动导入。", "Automatic request capture provides observed input exposure and reported usage; provider logs support reconciliation and Context Snapshots support manual imports.")}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3 text-sm"><p><Badge variant="outline">Codex log</Badge> <code>codex_log</code></p><p><Badge variant="outline">Claude log</Badge> <code>claude_log</code></p><p><Badge variant="outline">{text("上下文快照", "Context Snapshot")}</Badge> <code>context_snapshot</code> · <code>context-snapshot-v1</code></p></CardContent></Card><Alert><Database /><AlertTitle>{text("采集后再核验", "Verify after collection")}</AlertTitle><AlertDescription>{text("注册来源后，在数据来源列表点击“重新采集”。完整状态需要模型请求用量和上下文暴露都被来源覆盖。", "After registering a source, select Collect in the data source list. Complete analysis requires source coverage for both model-request usage and context exposure.")}</AlertDescription></Alert></div></SheetContent></Sheet>;
};
