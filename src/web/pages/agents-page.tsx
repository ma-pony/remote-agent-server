import { FormEvent, useEffect, useState } from "react";

import {
  api,
  errorMessage,
  type Agent,
  type AgentDoctorResult,
  type AgentSkill,
  type ProjectEnvironment,
  type Provider
} from "../api.js";

const providerNames: Record<Provider, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  hermes: "Hermes"
};
const skillSourceNames: Record<AgentSkill["source"], string> = {
  codex: "Codex",
  agents: "共享目录",
  claude: "Claude",
  plugin: "插件",
  upload: "已上传",
  missing: "来源已移除"
};
const maxSkillArchiveBytes = 10 * 1024 * 1024;

const fileBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error("读取 ZIP 失败"));
  reader.onload = () => {
    if (typeof reader.result !== "string") return reject(new Error("读取 ZIP 失败"));
    resolve(reader.result.split(",", 2)[1] ?? "");
  };
  reader.readAsDataURL(file);
});
export const AgentsPage = () => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<Provider>("codex");
  const [projectEnvironments, setProjectEnvironments] = useState<ProjectEnvironment[]>([]);
  const [projectEnvironmentId, setProjectEnvironmentId] = useState("");
  const [doctorResults, setDoctorResults] = useState<Record<string, AgentDoctorResult>>({});
  const [skillsByAgent, setSkillsByAgent] = useState<Record<string, AgentSkill[]>>({});
  const [skillsAgentId, setSkillsAgentId] = useState<string | null>(null);
  const [skillQuery, setSkillQuery] = useState("");
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

  const openSkills = async (agentId: string) => {
    if (skillsAgentId === agentId) {
      setSkillsAgentId(null);
      return;
    }
    setSkillsAgentId(agentId);
    setSkillQuery("");
    setBusy(`skills-${agentId}`);
    setError("");
    try {
      const skills = await api<AgentSkill[]>(`/agents/${agentId}/skills`);
      setSkillsByAgent((current) => ({ ...current, [agentId]: skills }));
    } catch (reason) {
      setSkillsAgentId(null);
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  const toggleSkill = async (agentId: string, skill: AgentSkill) => {
    setBusy(`skill-${agentId}-${skill.id}`);
    setError("");
    try {
      const updated = await api<AgentSkill>(`/agents/${agentId}/skills/${skill.id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !skill.enabled })
      });
      setSkillsByAgent((current) => ({
        ...current,
        [agentId]: (current[agentId] ?? []).map((item) => item.id === updated.id ? updated : item)
      }));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  const uploadSkill = async (agentId: string, file: File | undefined, input: HTMLInputElement) => {
    if (file === undefined) return;
    if (!file.name.toLowerCase().endsWith(".zip") || file.size > maxSkillArchiveBytes) {
      setError("请选择不超过 10 MB 的 Skill ZIP 文件");
      input.value = "";
      return;
    }
    setBusy(`skill-upload-${agentId}`);
    setError("");
    try {
      const uploaded = await api<AgentSkill>(`/agents/${agentId}/skills/upload`, {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, contentBase64: await fileBase64(file) })
      });
      setSkillsByAgent((current) => {
        const skills = current[agentId] ?? [];
        return {
          ...current,
          [agentId]: [...skills.filter((skill) => skill.id !== uploaded.id), uploaded]
            .sort((left, right) => left.name.localeCompare(right.name))
        };
      });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      input.value = "";
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
              <button onClick={() => void openSkills(agent.id)} disabled={busy !== null}>Skills</button>
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
            {skillsAgentId === agent.id ? <section className="agent-skills" aria-label={`${agent.name} Skills`}>
              <div className="agent-skills-heading">
                <div><h3>Skills</h3><p>只在下一次运行时加载已启用项。</p></div>
                <div className="agent-skills-controls">
                  <input aria-label="搜索 Skills" placeholder="搜索名称或描述" value={skillQuery} onChange={(event) => setSkillQuery(event.target.value)} />
                  <label className="skill-upload">上传 ZIP<input
                    type="file"
                    accept=".zip,application/zip"
                    aria-label="上传 Skill ZIP"
                    disabled={busy !== null}
                    onChange={(event) => void uploadSkill(agent.id, event.target.files?.[0], event.currentTarget)}
                  /></label>
                </div>
              </div>
              {busy === `skills-${agent.id}` && skillsByAgent[agent.id] === undefined
                ? <p className="muted">正在读取主机 Skills…</p>
                : <div className="skill-list">
                  {(skillsByAgent[agent.id] ?? [])
                    .filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(skillQuery.trim().toLowerCase()))
                    .map((skill) => <label className="skill-row" key={skill.id}>
                      <input
                        type="checkbox"
                        aria-label={`启用 ${skill.name}`}
                        checked={skill.enabled}
                        disabled={busy !== null || (!skill.available && !skill.enabled)}
                        onChange={() => void toggleSkill(agent.id, skill)}
                      />
                      <span><strong>{skill.name}</strong><small>{skill.description || "暂无描述"}</small></span>
                      <span className={`badge ${skill.available ? "neutral" : "failed"}`}>{skillSourceNames[skill.source]}</span>
                    </label>)}
                  {(skillsByAgent[agent.id] ?? []).length === 0 ? <p className="muted">主机上没有可用 Skill。</p> : null}
                </div>}
            </section> : null}
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
