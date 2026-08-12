import { FormEvent, useEffect, useState } from "react";

import { api, errorMessage, type Agent, type DoctorResult, type Provider } from "../api.js";

const providerNames: Record<Provider, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  hermes: "Hermes"
};
export const AgentsPage = () => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<Provider>("codex");
  const [doctorResults, setDoctorResults] = useState<Record<string, DoctorResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api<Agent[]>("/agents", { signal: controller.signal })
      .then((items) => setAgents(items))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      });
    return () => controller.abort();
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return;
    setBusy("create");
    setError("");
    try {
      const created = await api<Agent>("/agents", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), provider })
      });
      setAgents((current) => [...current, created]);
      setName("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (agent: Agent) => {
    setBusy(agent.id);
    setError("");
    try {
      const updated = await api<Agent>(`/agents/${agent.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !agent.enabled })
      });
      setAgents((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  const doctor = async (agentId: string) => {
    setBusy(`doctor-${agentId}`);
    setError("");
    try {
      const result = await api<DoctorResult>(`/agents/${agentId}/doctor`);
      setDoctorResults((current) => ({ ...current, [agentId]: result }));
    } catch (reason) {
      setDoctorResults((current) => ({
        ...current,
        [agentId]: { ok: false, message: errorMessage(reason), details: [] }
      }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page-frame">
      <header className="page-heading">
        <div><p className="eyebrow">EXECUTION PROFILES</p><h1>Agent</h1></div>
        <p>管理 Provider 执行入口及运行环境状态。</p>
      </header>

      <section className="control-strip" aria-labelledby="create-agent-title">
        <h2 id="create-agent-title">新建 Agent</h2>
        <form className="inline-form" onSubmit={create}>
          <div><label htmlFor="agent-name">Agent 名称</label><input id="agent-name" value={name} onChange={(event) => setName(event.target.value)} /></div>
          <div><label htmlFor="provider">Provider</label><select id="provider" value={provider} onChange={(event) => setProvider(event.target.value as Provider)}>
            {Object.entries(providerNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></div>
          <button className="primary-button" type="submit" disabled={busy === "create"}>{busy === "create" ? "创建中…" : "创建 Agent"}</button>
        </form>
      </section>

      <p className="error-banner" role={error === "" ? undefined : "alert"} aria-live="polite">{error}</p>
      <section className="record-list" aria-label="Agent 列表">
        {agents.length === 0 ? <div className="empty-state">暂无 Agent，请先创建一个执行入口。</div> : agents.map((agent) => {
          const result = doctorResults[agent.id];
          return <article className="record agent-record" key={agent.id}>
            <div className="record-main">
              <span className={`status-dot ${agent.enabled ? "online" : "offline"}`} aria-hidden="true" />
              <div><h2>{agent.name}</h2><p className="mono">{providerNames[agent.provider]}</p></div>
            </div>
            <div className="record-state"><span className={`badge ${agent.enabled ? "success" : "neutral"}`}>{agent.enabled ? "已启用" : "已停用"}</span></div>
            <div className="record-actions">
              <button onClick={() => void doctor(agent.id)} disabled={busy === `doctor-${agent.id}`}>运行检查</button>
              <button onClick={() => void toggle(agent)} disabled={busy === agent.id}>{agent.enabled ? "停用" : "启用"}</button>
            </div>
            {result !== undefined ? <div className={`doctor-result ${result.ok ? "passed" : "failed"}`} aria-live="polite">
              <strong>{result.ok ? "可用" : result.message}</strong>
              {result.ok && result.message !== "ready" ? <span>{result.message}</span> : null}
              {result.details.length > 0 ? <details><summary>检查详情</summary><pre>{result.details.join("\n")}</pre></details> : null}
            </div> : null}
          </article>;
        })}
      </section>
    </div>
  );
};
