import { FormEvent, useCallback, useEffect, useState } from "react";

import {
  api,
  errorMessage,
  type EnvironmentRepository,
  type ProjectEnvironment
} from "../api.js";

const revisionStatus = (environment: ProjectEnvironment): string => {
  if (environment.latestRevision?.status === "preparing") return "准备中";
  if (environment.latestRevision?.status === "failed") return "准备失败";
  if (environment.currentRevisionId !== null) return "可用";
  return "尚未准备";
};

export const ProjectEnvironmentsPage = () => {
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setEnvironments(await api<ProjectEnvironment[]>("/project-environments", { signal }));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const preparing = environments.some((item) => item.latestRevision?.status === "preparing");
    const timer = setTimeout(
      () => { void load().catch((reason: unknown) => setError(errorMessage(reason))); },
      preparing ? 2_000 : 5_000
    );
    return () => clearTimeout(timer);
  }, [environments, load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return;
    setBusy("create");
    setError("");
    try {
      const created = await api<Omit<ProjectEnvironment, "repositories" | "currentRevision" | "latestRevision">>(
        "/project-environments",
        { method: "POST", body: JSON.stringify({ name: name.trim() }) }
      );
      setEnvironments((current) => [...current, {
        ...created,
        repositories: [],
        currentRevision: null,
        latestRevision: null
      }]);
      setName("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy("");
    }
  };

  const check = async (id: string) => {
    setBusy(`check-${id}`);
    setError("");
    try {
      await api(`/project-environments/${id}/check`, { method: "POST", body: "{}" });
      setNotice("检查请求已提交");
      await load();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy("");
    }
  };

  const replaceRepository = (environmentId: string, repository: EnvironmentRepository) => {
    setEnvironments((current) => current.map((environment) => environment.id === environmentId
      ? {
        ...environment,
        repositories: environment.repositories.some((item) => item.id === repository.id)
          ? environment.repositories.map((item) => item.id === repository.id ? repository : item)
          : [...environment.repositories, repository]
      }
      : environment));
  };

  const removeRepository = (environmentId: string, repositoryId: string) => {
    setEnvironments((current) => current.map((environment) => environment.id === environmentId
      ? { ...environment, repositories: environment.repositories.filter((item) => item.id !== repositoryId) }
      : environment));
  };

  return <div className="page-frame">
    <header className="page-heading">
      <div><p className="eyebrow">MANAGED WORKSPACES</p><h1>项目环境</h1></div>
      <p>集中维护多个项目和依赖，新 Session 自动获得已准备好的独立 Workspace。</p>
    </header>
    <section className="control-strip" aria-labelledby="create-environment-title">
      <h2 id="create-environment-title">新建项目环境</h2>
      <form className="inline-form environment-create-form" onSubmit={create}>
        <div><label htmlFor="environment-name">项目环境名称</label><input id="environment-name" value={name} onChange={(event) => setName(event.target.value)} /></div>
        <button className="primary-button" type="submit" disabled={busy === "create"}>{busy === "create" ? "创建中…" : "创建项目环境"}</button>
      </form>
    </section>
    <p className="error-banner" role={error === "" ? undefined : "alert"}>{error}</p>
    <p className="notice-banner" aria-live="polite">{notice}</p>
    <section className="environment-list" aria-label="项目环境列表">
      {environments.length === 0 ? <div className="empty-state">暂无项目环境</div> : environments.map((environment) => {
        const preparing = environment.latestRevision?.status === "preparing";
        return <article className="environment-card" key={environment.id}>
          <header>
            <div><h2>{environment.name}</h2><p className="mono">当前版本 {environment.currentRevisionId?.slice(0, 8) ?? "—"}</p></div>
            <span className={`badge ${preparing ? "working" : environment.currentRevisionId === null ? "neutral" : "success"}`}>{revisionStatus(environment)}</span>
            <button onClick={() => void check(environment.id)} disabled={preparing || busy === `check-${environment.id}`}>立即检查</button>
          </header>
          {environment.latestRevision?.status === "failed" ? <div className="build-failure" role="alert">
            <strong>{environment.latestRevision.failureStage ?? "构建"}</strong>
            <span>{environment.latestRevision.error ?? "项目环境准备失败"}</span>
          </div> : null}
          <div className="repository-list">
            {environment.repositories.map((repository) => <RepositoryEditor
              key={repository.id}
              environmentId={environment.id}
              repository={repository}
              disabled={preparing}
              onSaved={(item) => replaceRepository(environment.id, item)}
              onRemoved={() => removeRepository(environment.id, repository.id)}
              onError={setError}
            />)}
          </div>
          <RepositoryEditor
            environmentId={environment.id}
            repository={null}
            disabled={preparing}
            onSaved={(item) => replaceRepository(environment.id, item)}
            onRemoved={() => undefined}
            onError={setError}
          />
        </article>;
      })}
    </section>
  </div>;
};

const RepositoryEditor = ({ environmentId, repository, disabled, onSaved, onRemoved, onError }: {
  environmentId: string;
  repository: EnvironmentRepository | null;
  disabled: boolean;
  onSaved(repository: EnvironmentRepository): void;
  onRemoved(): void;
  onError(message: string): void;
}) => {
  const [name, setName] = useState(repository?.name ?? "");
  const [gitUrl, setGitUrl] = useState(repository?.gitUrl ?? "");
  const [prepareCommand, setPrepareCommand] = useState(repository?.prepareCommand ?? "");
  const [busy, setBusy] = useState(false);
  const prefix = repository === null ? `new-${environmentId}` : repository.id;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "" || gitUrl.trim() === "") return;
    setBusy(true);
    onError("");
    try {
      const path = repository === null
        ? `/project-environments/${environmentId}/repositories`
        : `/project-environments/${environmentId}/repositories/${repository.id}`;
      const saved = await api<EnvironmentRepository>(path, {
        method: repository === null ? "POST" : "PATCH",
        body: JSON.stringify({
          name: name.trim(),
          gitUrl: gitUrl.trim(),
          prepareCommand: prepareCommand.trim() === "" ? null : prepareCommand.trim()
        })
      });
      onSaved(saved);
      if (repository === null) {
        setName("");
        setGitUrl("");
        setPrepareCommand("");
      }
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (repository === null) return;
    setBusy(true);
    onError("");
    try {
      await api(`/project-environments/${environmentId}/repositories/${repository.id}`, { method: "DELETE" });
      onRemoved();
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return <form className={`repository-editor ${repository === null ? "repository-new" : ""}`} onSubmit={save}>
    <div><label htmlFor={`${prefix}-name`}>项目目录名</label><input id={`${prefix}-name`} value={name} onChange={(event) => setName(event.target.value)} disabled={disabled} /></div>
    <div><label htmlFor={`${prefix}-url`}>Git 地址</label><input id={`${prefix}-url`} value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} disabled={disabled} /></div>
    <div><label htmlFor={`${prefix}-prepare`}>环境准备命令</label><input id={`${prefix}-prepare`} value={prepareCommand} onChange={(event) => setPrepareCommand(event.target.value)} disabled={disabled} placeholder="可留空" /></div>
    <button type="submit" disabled={disabled || busy}>{repository === null ? "添加项目" : "保存"}</button>
    {repository !== null ? <button className="danger-link" type="button" onClick={() => void remove()} disabled={disabled || busy}>移除</button> : null}
  </form>;
};
