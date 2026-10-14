import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BarChart3, RefreshCw, SearchX, TriangleAlert } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { api, errorMessage, type Agent } from "@/api";
import { EmptyState, PageContainer, PageHeader } from "@/components/page-header";
import { PagedResourceSelect } from "@/components/paged-resource-select";
import { ListPagination } from "@/components/list-pagination";
import { UsageTrendChart, type TrendPoint } from "@/components/usage-trend-chart";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n";
import type { DashboardSnapshot, UsageDashboard, UsageSessionTrend } from "../../agent-usage/dashboard-types.js";
import type { UsageSummary } from "../../agent-usage/core/types.js";

const pageSize = 50;
const ranges = [7, 30, 90, 365];
const rangeBounds = (days: number) => {
  const to = new Date();
  to.setUTCHours(0, 0, 0, 0); to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(to); from.setUTCDate(from.getUTCDate() - days);
  return { from: from.toISOString(), to: to.toISOString() };
};

const useDashboardData = <T,>(url: string, refresh: number) => {
  const key = `${url}:${refresh}`;
  const [state, setState] = useState<{ key: string; data: T | null; error: string }>({ key, data: null, error: "" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ key, data: null, error: "" });
    void api<T>(url, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ key, data, error: "" });
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setState({ key, data: null, error: errorMessage(reason) });
    });
    return () => controller.abort();
  }, [key, url]);
  return state.key === key ? state : { key, data: null, error: "" };
};

const qualityLabel = (quality: UsageSummary["completeness"], text: (zh: string, en: string) => string) => ({
  complete: text("已采集记录完整", "Collected records complete"),
  partial: text("仅已知部分", "Known portion only"),
  none: text("未上报", "Not reported"),
  conflict: text("来源冲突", "Conflicting sources")
})[quality];

const TrendPanel = ({ title, description, points, series, columns, rows, footer }: {
  title: string; description: string; points: TrendPoint[]; series: string[];
  columns: string[]; rows: Array<{ key: string; cells: ReactNode[] }>; footer?: ReactNode;
}) => {
  const { text } = useI18n();
  return <Card className="min-w-0" role="region" aria-label={title}>
    <CardHeader><CardTitle role="heading" aria-level={2}>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-3">
      <Tabs defaultValue="chart">
        <TabsList aria-label={text(`${title}展示方式`, `${title} view`)}>
          <TabsTrigger value="chart">{text("图表", "Chart")}</TabsTrigger><TabsTrigger value="data">{text("明细", "Data")}</TabsTrigger>
        </TabsList>
        <TabsContent value="chart" className="pt-3"><UsageTrendChart label={title} points={points} series={series} /></TabsContent>
        <TabsContent value="data"><div className="max-h-96 overflow-y-auto"><Table>
          <TableCaption className="sr-only">{title}</TableCaption>
          <TableHeader><TableRow>{columns.map(column => <TableHead key={column}>{column}</TableHead>)}</TableRow></TableHeader>
          <TableBody>{rows.map(row => <TableRow key={row.key}>{row.cells.map((cell, index) => <TableCell key={index} className={index === 0 ? undefined : "tabular-nums"}>{cell}</TableCell>)}</TableRow>)}</TableBody>
        </Table></div></TabsContent>
      </Tabs>
      {footer}
    </CardContent>
  </Card>;
};

const LoadError = ({ title, error, retry }: { title: string; error: string; retry(): void }) => {
  const { text } = useI18n();
  return <Alert variant="destructive"><TriangleAlert /><AlertTitle>{title}</AlertTitle><AlertDescription>
    <p>{error}</p><Button variant="outline" size="sm" onClick={retry}>{text("重试", "Retry")}</Button>
  </AlertDescription></Alert>;
};

export const UsageDashboardPage = () => {
  const { text, locale, formatDate } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const agentId = searchParams.get("agentId") ?? "";
  const requestedRange = Number(searchParams.get("range"));
  const range = ranges.includes(requestedRange) ? requestedRange : 30;
  const requestedPage = Number(searchParams.get("page") ?? "1");
  const page = Number.isInteger(requestedPage) && requestedPage >= 1 && requestedPage <= 2001 ? requestedPage : 1;
  const [refresh, setRefresh] = useState(0);
  const bounds = useMemo(() => rangeBounds(range), [range, refresh]);
  const query = new URLSearchParams(bounds);
  if (agentId) query.set("agentId", agentId);
  const scope = query.toString();
  const dashboard = useDashboardData<DashboardSnapshot<UsageDashboard>>(`/usage/dashboard?${scope}`, refresh);
  const sessions = useDashboardData<DashboardSnapshot<UsageSessionTrend>>(`/usage/session-trend?${scope}&limit=${pageSize}&offset=${(page - 1) * pageSize}`, refresh);
  const reload = () => setRefresh(value => value + 1);
  const loading = (!dashboard.data && !dashboard.error) || (!sessions.data && !sessions.error);
  const changeFilter = (key: string, value: string) => setSearchParams(previous => {
    const next = new URLSearchParams(previous);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== "page") next.delete("page");
    return next;
  });
  const number = (value: number | null) => value === null ? text("未上报", "Not reported")
    : new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  const tokenSeries = [text("总 token", "Total tokens"), text("输入", "Input"), text("输出", "Output")];
  const tokenValues = (usage: UsageSummary["usage"]) => [usage.totalTokens, usage.inputTotalTokens, usage.outputTotalTokens];
  const data = dashboard.data;
  const endDay = new Date(Date.parse(bounds.to) - 1).toISOString().slice(0, 10);
  const analysisLink = `/usage?${new URLSearchParams({ ...(agentId ? { agentId } : {}), range: "all" })}`;

  return <PageContainer width="wide">
    <PageHeader eyebrow={text("用量与会话", "USAGE & SESSIONS")} title={text("用量看板", "Usage dashboard")}
      description={text("查看每日 token、会话平均用量与会话数量，比较每个会话的累计用量。", "Track daily tokens, average usage per session and session counts, and compare lifetime usage across sessions.")}
      action={<><Button variant="outline" asChild><Link to={analysisLink}><BarChart3 data-icon="inline-start" />{text("用量分析", "Usage analysis")}</Link></Button>
        <Button variant="outline" onClick={reload} disabled={loading}><RefreshCw data-icon="inline-start" />{text("刷新统计", "Refresh statistics")}</Button></>} />
    <div className="flex flex-col gap-6">
      <Card><CardHeader><CardTitle>{text("统计范围", "Scope")}</CardTitle><CardDescription>{bounds.from.slice(0, 10)} — {endDay} · UTC</CardDescription></CardHeader>
        <CardContent><FieldGroup className="grid items-start gap-4 sm:grid-cols-2">
          <Field><FieldLabel htmlFor="dashboard-agent">{text("智能体", "Agent")}</FieldLabel>
            <PagedResourceSelect<Agent> id="dashboard-agent" ariaLabel={text("智能体", "Agent")} endpoint="/agents" value={agentId}
              emptyLabel={text("全部智能体", "All agents")} onValueChange={value => changeFilter("agentId", value)}
              getOption={agent => ({ value: String(agent.id), label: agent.name })} />
          </Field>
          <Field><FieldLabel htmlFor="dashboard-range">{text("日期范围", "Date range")}</FieldLabel>
            <NativeSelect id="dashboard-range" value={String(range)} onChange={event => changeFilter("range", event.target.value)}>
              {ranges.map(days => <NativeSelectOption key={days} value={String(days)}>{text(`最近 ${days} 天（含今天）`, `Last ${days} days (including today)`)}</NativeSelectOption>)}
            </NativeSelect><p className="text-xs text-muted-foreground">{text("所有日期按 UTC 自然日统计。", "All dates use UTC calendar days.")}</p>
          </Field>
        </FieldGroup></CardContent>
      </Card>

      {dashboard.error ? <LoadError title={text("每日统计加载失败", "Failed to load daily statistics")} error={dashboard.error} retry={reload} /> : data ? <>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            [text("区间 token 总量", "Tokens in period"), number(data.summary.usage.totalTokens), qualityLabel(data.summary.completeness, text)],
            [text("新建会话", "New sessions"), number(data.counts.newSessions), text("在所选日期内创建", "Created within the selected dates")],
            [text("活跃会话", "Active sessions"), number(data.counts.activeSessions), text("区间内开始过执行，按会话去重", "Started a run in the period, deduplicated by session")],
            [text("执行轮次", "Runs started"), number(data.counts.runs), text("包含成功、失败及开始后取消的执行", "Includes successful, failed and cancelled runs that started")]
          ].map(([label, value, description]) => <Card key={label}><CardHeader><CardDescription>{label}</CardDescription></CardHeader>
            <CardContent><p className="font-mono text-2xl font-semibold tabular-nums">{value}</p><p className="mt-2 text-xs text-muted-foreground">{description}</p></CardContent></Card>)}
        </div>
        <p className="text-xs text-muted-foreground">{text("每日统计截至：", "Daily statistics as of: ")}{formatDate(data.asOf)} · {text("缺失用量保留为未上报；今天的数据仍在累积。", "Missing usage stays unreported; today's data is still accumulating.")}</p>
        {data.summary.completeness === "conflict" || Object.values(data.unplacedUsage).some(value => value !== null && value > 0) ?
          <Alert><TriangleAlert /><AlertTitle>{text("部分用量需要单独核对", "Some usage needs separate verification")}</AlertTitle><AlertDescription>
            {data.summary.completeness === "conflict" ? <p>{text("来源存在冲突，图表展示当前账本的对账结果。", "Sources conflict; charts show the ledger's current reconciliation.")}</p> : null}
            {Object.values(data.unplacedUsage).some(value => value !== null && value > 0) ? <p>{text(`无法归入单日的已知 token：${number(data.unplacedUsage.totalTokens)}。缺少时间或跨日范围的用量不分摊到每日图表及平均值。`, `Known tokens not assignable to a day: ${number(data.unplacedUsage.totalTokens)}. Undated or cross-day usage is not distributed into daily charts or averages.`)}</p> : null}
          </AlertDescription></Alert> : null}
      </> : <div role="status" aria-label={text("正在加载每日统计", "Loading daily statistics")} className="grid gap-4 sm:grid-cols-2"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-72" /><Skeleton className="h-72" /></div>}

      <div className="grid items-start gap-6 xl:grid-cols-2">
        {data ? <>
          <TrendPanel key={`tokens:${scope}:${refresh}`} title={text("每日 token 用量", "Daily token usage")}
            description={text("按用量发生日期统计已对账的输入、输出和总量。", "Reconciled input, output and total tokens by usage date.")}
            series={tokenSeries} points={data.daily.map(day => ({ label: day.day.slice(5), detail: `${day.day} · UTC`, values: tokenValues(day.usage) }))}
            columns={[text("日期（UTC）", "Date (UTC)"), ...tokenSeries]}
            rows={data.daily.map(day => ({ key: day.day, cells: [day.day, ...tokenValues(day.usage).map(number)] }))} />
          <TrendPanel key={`average:${scope}:${refresh}`} title={text("每日每会话平均 token", "Daily average tokens per session")}
            description={text("当天 token 总量 ÷ 有总量上报的去重会话数；未上报会话不计入分母。", "Daily tokens divided by distinct sessions with a reported total; unreported sessions are excluded.")}
            series={[text("平均 token", "Average tokens")]}
            points={data.daily.map(day => ({ label: day.day.slice(5), detail: text(`${day.day} · ${day.reportedSessions} 个会话参与计算`, `${day.day} · ${day.reportedSessions} sessions measured`), values: [day.averageTokensPerSession] }))}
            columns={[text("日期（UTC）", "Date (UTC)"), text("平均 token", "Average tokens"), text("有上报的会话数", "Sessions measured")]}
            rows={data.daily.map(day => ({ key: day.day, cells: [day.day, number(day.averageTokensPerSession), number(day.reportedSessions)] }))} />
          <TrendPanel key={`counts:${scope}:${refresh}`} title={text("每日会话数量", "Daily session counts")}
            description={text("新建按创建日期统计；活跃按当天开始过执行的会话去重，排队中不计入。", "New sessions use their creation date; active sessions started a run that day. Queued runs are excluded.")}
            series={[text("新建会话", "New sessions"), text("活跃会话", "Active sessions")]}
            points={data.daily.map(day => ({ label: day.day.slice(5), detail: `${day.day} · UTC`, values: [day.newSessions, day.activeSessions] }))}
            columns={[text("日期（UTC）", "Date (UTC)"), text("新建会话", "New sessions"), text("活跃会话", "Active sessions"), text("执行轮次", "Runs started")]}
            rows={data.daily.map(day => ({ key: day.day, cells: [day.day, number(day.newSessions), number(day.activeSessions), number(day.runs)] }))} />
        </> : null}

      {sessions.error ? <LoadError title={text("会话用量加载失败", "Failed to load session usage")} error={sessions.error} retry={reload} /> : sessions.data ? <>
        {sessions.data.items.length === 0 ? <EmptyState icon={SearchX} title={text("没有匹配的会话", "No matching sessions")}
          description={text("会话图按创建日期筛选。可以调整智能体、日期范围或返回第一页。", "The session chart filters by creation date. Change the Agent or date range, or return to the first page.")}
          action={page > 1 ? <Button variant="outline" onClick={() => changeFilter("page", "1")}>{text("返回第一页", "First page")}</Button> : undefined} /> :
          <TrendPanel key={`sessions:${scope}:${page}:${refresh}`} title={text("每次会话 token 总量", "Total tokens per session")}
            description={text("所选日期内创建的会话，按创建时间从早到晚排列。每个点为该会话完整历史的累计用量，可能包含日期范围外的用量；每页 50 个会话。", "Sessions created in the selected period, ordered chronologically. Each point is a lifetime total and may include usage outside the period. 50 sessions per page.")}
            series={tokenSeries}
            points={sessions.data.items.map(item => ({ label: `${item.createdAt.slice(5, 10)} #${item.sessionId}`, detail: `${item.createdAt.slice(0, 10)} · ${item.title} · ${item.agentName} · ${qualityLabel(item.summary.completeness, text)}`, values: tokenValues(item.summary.usage) }))}
            columns={[text("会话", "Session"), text("智能体", "Agent"), text("创建时间（UTC）", "Created (UTC)"), ...tokenSeries, text("数据状态", "Data quality")]}
            rows={sessions.data.items.map(item => ({ key: String(item.sessionId), cells: [
              <Button variant="link" asChild><Link to={`/sessions/${item.sessionId}`}>{item.title || `#${item.sessionId}`}</Link></Button>,
              item.agentName, item.createdAt.replace("T", " ").slice(0, 19), ...tokenValues(item.summary.usage).map(number),
              <Badge variant={item.summary.completeness === "conflict" ? "destructive" : "outline"}>{qualityLabel(item.summary.completeness, text)}</Badge>
            ] }))}
            footer={<><ListPagination page={page} pageSize={pageSize} total={sessions.data.total} totalPages={Math.ceil(sessions.data.total / pageSize)} onPageChange={value => changeFilter("page", String(value))} />
              <p className="text-xs text-muted-foreground">{text(`共 ${sessions.data.total} 个会话 · 会话统计截至：`, `${sessions.data.total} sessions · Session statistics as of: `)}{formatDate(sessions.data.asOf)}</p></>} />}
      </> : <Skeleton className="h-80" aria-label={text("正在加载会话用量", "Loading session usage")} />}
      </div>
    </div>
  </PageContainer>;
};
