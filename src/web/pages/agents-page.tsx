import { FormEvent, useEffect, useState } from "react";

import {
  api,
  errorMessage,
  type Agent,
  type AgentDoctorResult,
  type ProjectEnvironment,
  type Provider
} from "../api.js";

const providerNames: Record<Provider, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  hermes: "Hermes"
};
export const AgentsPage = () => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<Provider>("codex");
  const [projectEnvironments, setProjectEnvironments] = useState<ProjectEnvironment[]>([]);
  const [projectEnvironmentId, setProjectEnvironmentId] = useState("");
  const [doctorResults, setDoctorResults] = useState<Record<string, AgentDoctorResult>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editProjectEnvironmentId, setEditProjectEnvironmentId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api<Agent[]>("/agents", { signal: controller.signal }),
      api<ProjectEnvironment[]>("/project-environments", { signal: controller.signal })
    ])
      .then(([items, environments]) => {
        setAgents(items);
        setProjectEnvironments(environments);
        setProjectEnvironmentId(environments.find((item) => item.currentRevisionId !== null)?.id ?? "");
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      });
    return () => controller.abort();
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "" || projectEnvironmentId === "") return;
    setBusy("create");
    setError("");
    try {
      const created = await api<Agent>("/agents", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), provider, projectEnvironmentId })
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
      const result = await api<AgentDoctorResult>(`/agents/${agentId}/doctor`);
      setDoctorResults((current) => ({ ...current, [agentId]: result }));
    } catch (reason) {
      setDoctorResults((current) => ({
        ...current,
        [agentId]: {
          provider: { ok: false, message: errorMessage(reason), details: [] },
          projectEnvironment: { ok: false, message: "项目环境检查失败", revisionId: null }
        }
      }));
    } finally {
      setBusy(null);
    }
  };

  const startEdit = (agent: Agent) => {
    setEditingId(agent.id);
    setEditName(agent.name);
    setEditProjectEnvironmentId(agent.projectEnvironmentId ?? "");
    setError("");
  };

  const saveEdit = async (event: FormEvent, agent: Agent) => {
    event.preventDefault();
    if (editName.trim() === "" || editProjectEnvironmentId === "") return;
    setBusy(`edit-${agent.id}`);
    setError("");
    try {
      const updated = await api<Agent>(`/agents/${agent.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName.trim(),
          projectEnvironmentId: editProjectEnvironmentId
        })
      });
      setAgents((current) => current.map((item) => item.id === updated.id ? updated : item));
      setEditingId(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  const deleteAgent = async (agent: Agent) => {
    if (!window.confirm(`确定删除 Agent“${agent.name}”吗？`)) return;
    setBusy(`delete-${agent.id}`);
    setError("");
    try {
      await api(`/agents/${agent.id}`, { method: "DELETE" });
      setAgents((current) => current.filter((item) => item.id !== agent.id));
      setDoctorResults((current) => {
        const next = { ...current };
        delete next[agent.id];
        return next;
      });
    } catch (reason) {
      setError(errorMessage(reason));
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
        <form className="inline-form agent-create-form" onSubmit={create}>
          <div><label htmlFor="agent-name">Agent 名称</label><input id="agent-name" value={name} onChange={(event) => setName(event.target.value)} /></div>
          <div><label htmlFor="provider">Provider</label><select id="provider" value={provider} onChange={(event) => setProvider(event.target.value as Provider)}>
            {Object.entries(providerNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></div>
          <div><label htmlFor="agent-environment">项目环境</label><select id="agent-environment" value={projectEnvironmentId} onChange={(event) => setProjectEnvironmentId(event.target.value)}>
            <option value="" disabled>请选择可用环境</option>
            {projectEnvironments.filter((item) => item.currentRevisionId !== null).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></div>
          <button className="primary-button" type="submit" disabled={busy === "create" || projectEnvironmentId === ""}>{busy === "create" ? "创建中…" : "创建 Agent"}</button>
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
              <button onClick={() => startEdit(agent)} disabled={busy !== null}>修改</button>
              <button className="danger-link" onClick={() => void deleteAgent(agent)} disabled={busy !== null}>删除</button>
            </div>
            {editingId === agent.id ? <form className="agent-edit-form" onSubmit={(event) => void saveEdit(event, agent)}>
              <div><label htmlFor={`edit-agent-name-${agent.id}`}>Agent 名称</label><input id={`edit-agent-name-${agent.id}`} value={editName} onChange={(event) => setEditName(event.target.value)} /></div>
              <div><label>Provider</label><span className="readonly-value">{providerNames[agent.provider]}</span></div>
              <div><label htmlFor={`edit-agent-environment-${agent.id}`}>项目环境</label><select id={`edit-agent-environment-${agent.id}`} value={editProjectEnvironmentId} onChange={(event) => setEditProjectEnvironmentId(event.target.value)}>
                {projectEnvironments.filter((item) => item.currentRevisionId !== null).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></div>
              <div className="agent-edit-actions">
                <button type="button" onClick={() => setEditingId(null)}>取消</button>
                <button className="primary-button" type="submit" disabled={busy === `edit-${agent.id}`}>保存修改</button>
              </div>
            </form> : null}
            {result !== undefined ? <div className={`doctor-result ${result.provider.ok && result.projectEnvironment.ok ? "passed" : "failed"}`} aria-live="polite">
              <strong>{result.provider.ok ? "可用" : result.provider.message}</strong>
              <span>项目环境：{result.projectEnvironment.ok ? "可用" : result.projectEnvironment.message}</span>
              {result.provider.details.length > 0 ? <details><summary>检查详情</summary><pre>{result.provider.details.join("\n")}</pre></details> : null}
            </div> : null}
          </article>;
        })}
      </section>
    </div>
  );
};
