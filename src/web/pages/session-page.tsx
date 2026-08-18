import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Send, Settings2, Square, XCircle } from "lucide-react";
import { Link, useNavigate } from "react-router";

import { api, errorMessage, isRunStreamPermanentError, streamRunEvents, type Agent, type Run, type RunEvent, type RunStatus, type SessionDetail } from "../api.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldLabel } from "@/components/ui/field";
import { PageHeader } from "@/components/page-header";
import { SessionDeleteDialog } from "./session-pages.js";
import { useI18n } from "@/i18n";

type RunView = { run: Run; events: RunEvent[]; historyError: string | null };
const activeStatuses = new Set<RunStatus>(["queued", "running"]);
const terminalStatuses = new Set<RunStatus>(["succeeded", "failed", "cancelled"]);
const streamRetryDelays = [500, 1_000, 2_000, 4_000, 5_000] as const;
const canonicalPollIntervalMs = 5_000;

const eventContent = (item: RunEvent): Record<string, unknown> => {
  try {
    const value = JSON.parse(item.contentJson) as unknown;
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  } catch (_error) {
    return {};
  }
};

const eventStatus = (item: RunEvent): RunStatus | undefined => {
  if (item.type !== "status") return undefined;
  const status = eventContent(item).status;
  return typeof status === "string" && ["queued", "running", "succeeded", "failed", "cancelled"].includes(status)
    ? status as RunStatus
    : undefined;
};

const foldHistoricalStatus = (run: Run, events: RunEvent[]): Run => {
  let status = run.status;
  for (const item of events.toSorted((left, right) => left.seq - right.seq)) {
    const historicalStatus = eventStatus(item);
    if (historicalStatus !== undefined && terminalStatuses.has(historicalStatus)) status = historicalStatus;
  }
  return status === run.status ? run : { ...run, status };
};

const mergeEvent = (views: RunView[], runId: string, item: RunEvent): RunView[] => views.map((view) => {
  if (view.run.id !== runId || view.events.some((event) => event.seq === item.seq)) return view;
  const status = eventStatus(item);
  return {
    run: status === undefined
      ? view.run.status === "queued" ? { ...view.run, status: "running" } : view.run
      : { ...view.run, status },
    events: [...view.events, item].sort((left, right) => left.seq - right.seq),
    historyError: view.historyError
  };
});

export const SessionPage = ({ sessionId }: { sessionId: string }) => {
  const { text } = useI18n();
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [agentName, setAgentName] = useState("");
  const [views, setViews] = useState<RunView[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [streamError, setStreamError] = useState("");
  const [streamReconnectGeneration, setStreamReconnectGeneration] = useState(0);
  const loadGeneration = useRef(0);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    const controller = new AbortController();
    setInitialLoading(true);
    setLoadError("");
    setSession(null);
    setAgentName("");
    setViews([]);
    void Promise.all([
      api<SessionDetail>(`/sessions/${sessionId}`, { signal: controller.signal }),
      api<Agent[]>("/agents", { signal: controller.signal })
    ]).then(async ([detail, agents]) => {
      const histories = await Promise.allSettled(detail.runs.map((run) =>
        api<RunEvent[]>(`/runs/${run.id}/events?afterSeq=0`, { signal: controller.signal })
      ));
      if (controller.signal.aborted || generation !== loadGeneration.current) return;
      setSession(detail);
      setAgentName(agents.find((agent) => agent.id === detail.agentId)?.name ?? detail.agentId);
      setViews(detail.runs.map((run, index) => {
        const history = histories[index];
        if (history?.status === "fulfilled") {
          return { run: foldHistoricalStatus(run, history.value), events: history.value, historyError: null };
        }
        return {
          run,
          events: [],
          historyError: text(`历史加载失败：${errorMessage(history?.reason)}`, `Failed to load history: ${errorMessage(history?.reason)}`)
        };
      }));
      setInitialLoading(false);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted && generation === loadGeneration.current) {
        setLoadError(errorMessage(reason));
        setInitialLoading(false);
      }
    });
    return () => controller.abort();
  }, [sessionId, reloadGeneration]);

  const activeRunId = useMemo(() => views.findLast((view) => activeStatuses.has(view.run.status))?.run.id ?? null, [views]);
  const mcpParametersValid = session?.mcpParametersValid ?? true;
  const missingMcpParameters = session?.missingMcpParameters ?? [];

  useEffect(() => {
    if (activeRunId === null) return;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let canonicalPollTimer: ReturnType<typeof setTimeout> | undefined;
    let canonicalRefresh: Promise<boolean> | undefined;
    let cursor = views.find((view) => view.run.id === activeRunId)?.events.at(-1)?.seq ?? 0;
    let consecutiveFailures = 0;
    setStreamError("");

    const clearCanonicalPoll = (): void => {
      if (canonicalPollTimer !== undefined) clearTimeout(canonicalPollTimer);
      canonicalPollTimer = undefined;
    };
    const finishTerminal = (): void => {
      clearCanonicalPoll();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      setStreamError("");
      controller.abort();
    };
    const refreshCanonicalRun = (): Promise<boolean> => {
      if (canonicalRefresh !== undefined) return canonicalRefresh;
      canonicalRefresh = (async () => {
        try {
          const canonical = await api<Run>(`/runs/${activeRunId}`, { signal: controller.signal });
          if (controller.signal.aborted) return true;
          setViews((current) => current.map((view) =>
            view.run.id === canonical.id ? { ...view, run: canonical } : view
          ));
          if (terminalStatuses.has(canonical.status)) {
            finishTerminal();
            return true;
          }
        } catch (_error) {
          if (controller.signal.aborted) return true;
        }
        return false;
      })().finally(() => { canonicalRefresh = undefined; });
      return canonicalRefresh;
    };
    const scheduleCanonicalPoll = (): void => {
      if (controller.signal.aborted || canonicalPollTimer !== undefined) return;
      canonicalPollTimer = setTimeout(() => {
        canonicalPollTimer = undefined;
        void refreshCanonicalRun().then((terminal) => {
          if (!terminal) scheduleCanonicalPoll();
        });
      }, canonicalPollIntervalMs);
    };

    const connect = async (): Promise<void> => {
      scheduleCanonicalPoll();
      try {
        await streamRunEvents(activeRunId, cursor, (item) => {
          cursor = Math.max(cursor, item.seq);
          consecutiveFailures = 0;
          setStreamError("");
          setViews((current) => mergeEvent(current, activeRunId, item));
          const status = eventStatus(item);
          if (status !== undefined && terminalStatuses.has(status)) finishTerminal();
        }, controller.signal);
      } catch (reason) {
        clearCanonicalPoll();
        if (controller.signal.aborted || await refreshCanonicalRun()) return;
        if (isRunStreamPermanentError(reason)) {
          setStreamError(text(`实时连接失败：${errorMessage(reason)}`, `Live connection failed: ${errorMessage(reason)}`));
          return;
        }
        const delay = streamRetryDelays[consecutiveFailures];
        if (delay === undefined) {
          setStreamError(text(`实时连接已中断：${errorMessage(reason)}。自动重连已停止。`, `Live connection interrupted: ${errorMessage(reason)}. Automatic reconnection stopped.`));
          return;
        }
        consecutiveFailures += 1;
        setStreamError(text(`实时连接中断：${errorMessage(reason)}，将在 ${delay / 1_000} 秒后重连`, `Live connection interrupted: ${errorMessage(reason)}. Reconnecting in ${delay / 1_000} seconds.`));
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void connect();
        }, delay);
      }
    };
    void connect();
    return () => {
      controller.abort();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      clearCanonicalPoll();
    };
  }, [activeRunId, streamReconnectGeneration, text]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (text === "" || activeRunId !== null || initialLoading || loadError !== "" || session === null || !mcpParametersValid) return;
    setSubmitting(true);
    setError("");
    try {
      const run = await api<Run>(`/sessions/${sessionId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input: text })
      });
      setViews((current) => [...current, { run, events: [], historyError: null }]);
      setInput("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (activeRunId === null || initialLoading || loadError !== "") return;
    setError("");
    try {
      const run = await api<Run>(`/runs/${activeRunId}/cancel`, { method: "POST", body: "{}" });
      setViews((current) => current.map((view) => view.run.id === run.id ? { ...view, run } : view));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const composerDisabled = initialLoading || loadError !== "" || session === null || activeRunId !== null || submitting || !mcpParametersValid;

  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <Button asChild variant="ghost" className="mb-4"><Link to="/sessions"><ArrowLeft />{text("返回会话", "Back to sessions")}</Link></Button>
      <PageHeader eyebrow={text(`会话 / ${initialLoading ? "加载中" : activeRunId !== null ? "运行中" : "空闲"}`, `SESSION / ${initialLoading ? "LOADING" : activeRunId !== null ? "RUNNING" : "IDLE"}`)} title={session?.title ?? text("加载会话…", "Loading session…")} description={agentName === "" ? text("正在读取智能体…", "Loading agent…") : text(`智能体 · ${agentName}`, `Agent · ${agentName}`)} action={<div className="flex items-center gap-2">{session === null ? null : <Button asChild size="sm" variant="outline"><Link to={`/sessions/${session.id}/settings`}><Settings2 />{text("设置", "Settings")}</Link></Button>}<Badge variant={activeRunId === null ? "secondary" : "default"}>{activeRunId === null ? text("空闲", "Idle") : text("活动中", "Active")}</Badge>{session === null ? null : <SessionDeleteDialog session={activeRunId === null ? session : { ...session, status: "running" }} onDeleted={() => navigate("/sessions")} onError={setError} />}</div>} />
      <div className="flex flex-col gap-4">
        {loadError !== "" ? <Alert variant="destructive" role="alert"><XCircle /><AlertTitle>{text("会话加载失败", "Session failed to load")}</AlertTitle><AlertDescription className="flex items-center justify-between gap-3"><span>{loadError}</span><Button size="sm" variant="outline" type="button" onClick={() => setReloadGeneration((current) => current + 1)}>{text("重试加载", "Retry")}</Button></AlertDescription></Alert> : error !== "" ? <Alert variant="destructive" role="alert"><XCircle /><AlertTitle>{text("操作失败", "Operation failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
        {streamError !== "" ? <Alert variant="destructive" role="alert"><XCircle /><AlertTitle>{text("实时连接异常", "Live connection error")}</AlertTitle><AlertDescription className="flex items-center justify-between gap-3"><span>{streamError}</span>{streamError.includes("自动重连已停止") || streamError.includes("Automatic reconnection stopped") ? <Button size="sm" variant="outline" type="button" onClick={() => setStreamReconnectGeneration((current) => current + 1)}>{text("重新连接实时事件", "Reconnect live events")}</Button> : null}</AlertDescription></Alert> : null}
      </div>
      <section className="mt-6 flex flex-col gap-5" aria-label={text("运行历史", "Run history")} aria-live="polite">
        {views.length === 0 && session !== null ? <Card className="border-dashed"><CardContent className="py-14 text-center text-muted-foreground">{text("还没有消息，输入任务开始第一轮。", "No messages yet. Enter a task to start the first turn.")}</CardContent></Card> : views.map((view) => <RunBlock key={view.run.id} view={view} />)}
      </section>
      {session !== null && !mcpParametersValid ? <Alert className="mt-6"><XCircle /><AlertTitle>{text("缺少 MCP 参数", "Missing MCP parameters")}</AlertTitle><AlertDescription>{text("请先在", "Complete these in")} <Link className="underline" to={`/sessions/${session.id}/settings`}>{text("会话设置", "session settings")}</Link>{text(` 中填写：${missingMcpParameters.join("、")}`, `: ${missingMcpParameters.join(", ")}`)}</AlertDescription></Alert> : null}
      <Card className="sticky bottom-4 mt-6 shadow-lg"><CardContent className="p-4"><form className="flex flex-col gap-3" onSubmit={send}>
        <Field data-disabled={composerDisabled || undefined}><FieldLabel htmlFor="run-input">{text("发送给智能体", "Send to agent")}</FieldLabel><Textarea id="run-input" rows={3} value={input} onChange={(event) => setInput(event.target.value)} disabled={composerDisabled} placeholder={activeRunId === null ? text("描述下一步任务…", "Describe the next task…") : text("当前运行结束后可继续输入", "Continue after the current run finishes")} /></Field>
        <div className="flex justify-end gap-2">
          {activeRunId !== null ? <Button type="button" variant="destructive" onClick={() => void cancel()}><Square />{text("取消运行", "Cancel run")}</Button> : null}
          <Button type="submit" disabled={composerDisabled || input.trim() === ""}><Send />{submitting ? text("发送中…", "Sending…") : text("发送", "Send")}</Button>
        </div>
      </form></CardContent></Card>
    </div>
  );
};

const RunBlock = ({ view }: { view: RunView }) => {
  const { text } = useI18n();
  let output = "";
  const details: RunEvent[] = [];
  for (const item of view.events) {
    const content = eventContent(item);
    if (item.type === "message" && content.stream === "output" && typeof content.text === "string") output += content.text;
    if (item.type !== "message") details.push(item);
  }
  if (output === "" && view.run.result !== null) output = view.run.result;

  return <article className="flex flex-col gap-3">
    <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-foreground px-4 py-3 text-background"><span className="mb-1 block text-xs font-semibold uppercase tracking-wide opacity-70">{text("你", "You")}</span><p className="whitespace-pre-wrap">{view.run.input}</p></div>
    <Card className="border-l-4 border-l-primary"><CardContent className="p-5">
      <div className="mb-4 flex items-center justify-between"><span className="text-sm font-semibold">{text("智能体", "Agent")}</span><Badge variant={view.run.status === "failed" ? "destructive" : view.run.status === "succeeded" ? "default" : "secondary"}>{({ queued: text("排队中", "Queued"), running: text("运行中", "Running"), succeeded: text("已完成", "Completed"), failed: text("失败", "Failed"), cancelled: text("已取消", "Cancelled") } satisfies Record<RunStatus, string>)[view.run.status]}</Badge></div>
      {output !== "" ? <p className="whitespace-pre-wrap leading-7">{output}</p> : activeStatuses.has(view.run.status) ? <p className="text-muted-foreground">{text("等待智能体输出…", "Waiting for agent output…")}</p> : null}
      {(details.length > 0 || view.historyError !== null || (view.run.error !== null && !details.some((item) => item.type === "error"))) ? <details className="group mt-5 rounded-lg border bg-muted/30">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium"><span>{text(`执行轨迹 · ${details.length} 条`, `Execution trace · ${details.length}`)}</span><ChevronDown className="size-4 transition-transform group-open:rotate-180" /></summary>
        <div className="flex flex-col gap-2 border-t p-3">
          {view.historyError !== null ? <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{view.historyError}</div> : null}
          {details.map((item) => <EventRow key={item.id} item={item} />)}
          {view.run.error !== null && !details.some((item) => item.type === "error") ? <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">{view.run.error}</div> : null}
        </div>
      </details> : null}
    </CardContent></Card>
  </article>;
};

const EventRow = ({ item }: { item: RunEvent }) => {
  const { text } = useI18n();
  const content = eventContent(item);
  if (item.type === "error") return <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">{String(content.message ?? text("运行失败", "Run failed"))}</div>;
  if (item.type === "status") {
    if (typeof content.text !== "string") return null;
    return <div className="rounded-md border bg-background p-3 text-sm"><span className="mr-2 font-medium text-muted-foreground">{text("状态", "Status")}</span>{content.text}</div>;
  }
  if (item.type === "tool") {
    const status = String(content.status ?? "running");
    const label = status === "completed" ? text("已完成", "Completed") : status === "failed" ? text("失败", "Failed") : text("运行中", "Running");
    return <details className="rounded-md border bg-background"><summary className="flex cursor-pointer items-center gap-2 p-3 text-sm"><span className="text-muted-foreground">{text("工具", "Tool")}</span><strong>{String(content.title ?? content.name ?? text("工具调用", "Tool call"))}</strong><Badge className="ml-auto" variant="outline">{label}</Badge></summary><pre className="overflow-auto border-t p-3 text-xs">{JSON.stringify(content, null, 2)}</pre></details>;
  }
  return null;
};
