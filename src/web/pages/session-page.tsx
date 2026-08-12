import { FormEvent, useEffect, useMemo, useState } from "react";

import { api, errorMessage, streamRunEvents, type Agent, type Run, type RunEvent, type RunStatus, type SessionDetail } from "../api.js";

type RunView = { run: Run; events: RunEvent[] };
const activeStatuses = new Set<RunStatus>(["queued", "running"]);
const terminalStatuses = new Set<RunStatus>(["succeeded", "failed", "cancelled"]);
const statusNames: Record<RunStatus, string> = {
  queued: "排队中",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

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

const mergeEvent = (views: RunView[], runId: string, item: RunEvent): RunView[] => views.map((view) => {
  if (view.run.id !== runId || view.events.some((event) => event.seq === item.seq)) return view;
  const status = eventStatus(item);
  return {
    run: status === undefined
      ? view.run.status === "queued" ? { ...view.run, status: "running" } : view.run
      : { ...view.run, status },
    events: [...view.events, item].sort((left, right) => left.seq - right.seq)
  };
});

export const SessionPage = ({ sessionId }: { sessionId: string }) => {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [agentName, setAgentName] = useState("");
  const [views, setViews] = useState<RunView[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api<SessionDetail>(`/sessions/${sessionId}`, { signal: controller.signal }),
      api<Agent[]>("/agents", { signal: controller.signal })
    ]).then(async ([detail, agents]) => {
      const histories = await Promise.all(detail.runs.map((run) => api<RunEvent[]>(`/runs/${run.id}/events?afterSeq=0`, { signal: controller.signal })));
      if (controller.signal.aborted) return;
      setSession(detail);
      setAgentName(agents.find((agent) => agent.id === detail.agentId)?.name ?? detail.agentId);
      setViews(detail.runs.map((run, index) => ({ run, events: histories[index] ?? [] })));
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    });
    return () => controller.abort();
  }, [sessionId]);

  const activeRunId = useMemo(() => views.findLast((view) => activeStatuses.has(view.run.status))?.run.id ?? null, [views]);

  useEffect(() => {
    if (activeRunId === null) return;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cursor = views.find((view) => view.run.id === activeRunId)?.events.at(-1)?.seq ?? 0;

    const connect = async (): Promise<void> => {
      try {
        await streamRunEvents(activeRunId, cursor, (item) => {
          cursor = Math.max(cursor, item.seq);
          setViews((current) => mergeEvent(current, activeRunId, item));
          const status = eventStatus(item);
          if (status !== undefined && terminalStatuses.has(status)) controller.abort();
        }, controller.signal);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(`实时连接中断：${errorMessage(reason)}，正在重连`);
          retryTimer = setTimeout(() => void connect(), 500);
        }
      }
    };
    void connect();
    return () => {
      controller.abort();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [activeRunId]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (text === "" || activeRunId !== null) return;
    setSubmitting(true);
    setError("");
    try {
      const run = await api<Run>(`/sessions/${sessionId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input: text })
      });
      setViews((current) => [...current, { run, events: [] }]);
      setInput("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (activeRunId === null) return;
    setError("");
    try {
      const run = await api<Run>(`/runs/${activeRunId}/cancel`, { method: "POST", body: "{}" });
      setViews((current) => current.map((view) => view.run.id === run.id ? { ...view, run } : view));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  return (
    <div className="page-frame session-detail">
      <header className="page-heading">
        <div><p className="eyebrow">SESSION / {session?.status === "running" || activeRunId !== null ? "RUNNING" : "IDLE"}</p><h1>{session?.title ?? "加载 Session…"}</h1></div>
        <p>{agentName === "" ? "正在读取 Agent…" : `Agent · ${agentName}`}</p>
      </header>
      <p className="error-banner" role={error === "" ? undefined : "alert"} aria-live="polite">{error}</p>
      <section className="conversation" aria-label="运行历史" aria-live="polite">
        {views.length === 0 && session !== null ? <div className="empty-state">还没有消息，输入任务开始第一轮。</div> : views.map((view) => <RunBlock key={view.run.id} view={view} />)}
      </section>
      <form className="composer" onSubmit={send}>
        <label htmlFor="run-input">发送给 Agent</label>
        <textarea id="run-input" rows={3} value={input} onChange={(event) => setInput(event.target.value)} disabled={activeRunId !== null || submitting} placeholder={activeRunId === null ? "描述下一步任务…" : "当前 Run 结束后可继续输入"} />
        <div className="composer-actions">
          {activeRunId !== null ? <button type="button" className="danger-button" onClick={() => void cancel()}>取消运行</button> : null}
          <button type="submit" className="primary-button" disabled={activeRunId !== null || submitting || input.trim() === ""}>{submitting ? "发送中…" : "发送"}</button>
        </div>
      </form>
    </div>
  );
};

const RunBlock = ({ view }: { view: RunView }) => {
  let output = "";
  const details: RunEvent[] = [];
  for (const item of view.events) {
    const content = eventContent(item);
    if (item.type === "message" && content.stream === "output" && typeof content.text === "string") output += content.text;
    if (item.type !== "message") details.push(item);
  }
  if (output === "" && view.run.result !== null) output = view.run.result;

  return <article className="turn">
    <div className="message user-message"><span className="message-label">你</span><p>{view.run.input}</p></div>
    <div className="message agent-message">
      <div className="message-meta"><span className="message-label">Agent</span><span className={`badge ${view.run.status}`}>{statusNames[view.run.status]}</span></div>
      {output !== "" ? <p className="agent-output">{output}</p> : activeStatuses.has(view.run.status) ? <p className="muted">等待 Agent 输出…</p> : null}
      <div className="event-stack">
        {details.map((item) => <EventRow key={item.id} item={item} />)}
        {view.run.error !== null && !details.some((item) => item.type === "error") ? <div className="event-row error-event" role="alert">{view.run.error}</div> : null}
      </div>
    </div>
  </article>;
};

const EventRow = ({ item }: { item: RunEvent }) => {
  const content = eventContent(item);
  if (item.type === "error") return <div className="event-row error-event" role="alert">{String(content.message ?? "运行失败")}</div>;
  if (item.type === "status") {
    if (typeof content.text !== "string") return null;
    return <div className="event-row status-event"><span className="event-kind">状态</span>{content.text}</div>;
  }
  if (item.type === "tool") {
    const status = String(content.status ?? "running");
    const label = status === "completed" ? "已完成" : status === "failed" ? "失败" : "运行中";
    return <details className="event-row tool-event"><summary><span className="event-kind">工具</span><strong>{String(content.title ?? content.name ?? "工具调用")}</strong><span className="tool-status">{label}</span></summary><pre>{JSON.stringify(content, null, 2)}</pre></details>;
  }
  return null;
};
