import { FormEvent, useEffect, useState } from "react";

import { api, errorMessage, type Agent, type Session } from "../api.js";

const displayTime = (value: string): string => new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
}).format(new Date(value));

export const SessionsPage = ({ navigate }: { navigate(path: string): void }) => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api<Session[]>("/sessions", { signal: controller.signal }),
      api<Agent[]>("/agents", { signal: controller.signal })
    ]).then(([sessionItems, agentItems]) => {
      setSessions(sessionItems);
      setAgents(agentItems);
      setAgentId((current) => current || agentItems.find((item) => item.enabled)?.id || "");
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    });
    return () => controller.abort();
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() === "" || agentId === "") return;
    setCreating(true);
    setError("");
    try {
      const created = await api<Session>("/sessions", {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), agentId })
      });
      setSessions((current) => [created, ...current]);
      navigate(`/sessions/${created.id}`);
    } catch (reason) {
      setError(errorMessage(reason));
      setCreating(false);
    }
  };

  const names = new Map(agents.map((agent) => [agent.id, agent.name]));

  return (
    <div className="page-frame">
      <header className="page-heading">
        <div><p className="eyebrow">CONVERSATION WORKSPACES</p><h1>Session</h1></div>
        <p>每个 Session 保留独立工作区和多轮上下文。</p>
      </header>
      <section className="control-strip" aria-labelledby="create-session-title">
        <h2 id="create-session-title">新建 Session</h2>
        <form className="inline-form" onSubmit={create}>
          <div><label htmlFor="session-title">Session 标题</label><input id="session-title" value={title} onChange={(event) => setTitle(event.target.value)} /></div>
          <div><label htmlFor="session-agent">选择 Agent</label><select id="session-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            <option value="" disabled>请选择</option>
            {agents.filter((agent) => agent.enabled).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select></div>
          <button className="primary-button" type="submit" disabled={creating || agentId === ""}>{creating ? "创建中…" : "创建 Session"}</button>
        </form>
      </section>
      <p className="error-banner" role={error === "" ? undefined : "alert"} aria-live="polite">{error}</p>
      <section className="record-list" aria-label="Session 列表">
        {sessions.length === 0 ? <div className="empty-state">暂无 Session</div> : sessions.map((item) => <button className="record session-record" key={item.id} onClick={() => navigate(`/sessions/${item.id}`)}>
          <span className="record-main"><span className={`status-dot ${item.status === "running" ? "working" : "online"}`} aria-hidden="true" /><span><strong>{item.title}</strong><small>{names.get(item.agentId) ?? item.agentId}</small></span></span>
          <span className={`badge ${item.status === "running" ? "working" : "neutral"}`}>{item.status === "running" ? "运行中" : "空闲"}</span>
          <time dateTime={item.updatedAt}>{displayTime(item.updatedAt)}</time>
        </button>)}
      </section>
    </div>
  );
};
