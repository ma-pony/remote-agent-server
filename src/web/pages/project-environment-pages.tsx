import { FormEvent, useCallback, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, GitBranch, Loader2, Pencil, Plus, RefreshCw, Trash2, XCircle } from "lucide-react";
import { Link, Outlet, useLocation, useNavigate, useOutletContext, useParams } from "react-router";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { api, errorMessage, type EnvironmentRepository, type ProjectEnvironment } from "@/api";
import { useI18n } from "@/i18n";

const revisionStatus = (environment: ProjectEnvironment, text: (chinese: string, english: string) => string): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } => {
  if (environment.latestRevision?.status === "preparing") return { label: text("准备中", "Preparing"), variant: "secondary" };
  if (environment.latestRevision?.status === "failed") return { label: text("准备失败", "Preparation failed"), variant: "destructive" };
  if (environment.currentRevisionId !== null) return { label: text("可用", "Ready"), variant: "default" };
  return { label: text("尚未准备", "Not prepared"), variant: "outline" };
};

const ErrorAlert = ({ message }: { message: string }) => {
  const { text } = useI18n();
  return message === "" ? null : <Alert variant="destructive"><XCircle /><AlertTitle>{text("操作失败", "Operation failed")}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>;
};

export const ProjectEnvironmentListPage = () => {
  const { text, formatDate } = useI18n();
  const [items, setItems] = useState<ProjectEnvironment[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<ProjectEnvironment[]>("/project-environments", { signal: controller.signal }).then(setItems).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, []);
  return <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
    <PageHeader eyebrow={text("托管工作区", "MANAGED WORKSPACES")} title={text("项目环境", "Project environments")} description={text("一个环境可以包含多个 Git 项目，会话从可用版本创建独立工作区。", "An environment can contain multiple Git projects. Sessions receive isolated workspaces from a ready revision.")} action={<Button asChild><Link to="/project-environments/new"><Plus />{text("新建项目环境", "New environment")}</Link></Button>} />
    <ErrorAlert message={error} />
    {items === null ? <div className="grid gap-4 md:grid-cols-2">{[0, 1].map((item) => <Skeleton key={item} className="h-48" />)}</div>
      : items.length === 0 ? <Card className="border-dashed"><CardContent className="py-16 text-center text-muted-foreground">{text("暂无项目环境，先创建一个并添加需要的仓库。", "No project environments yet. Create one and add its repositories.")}</CardContent></Card>
      : <div className="grid gap-4 md:grid-cols-2">{items.map((environment) => { const status = revisionStatus(environment, text); return <Card key={environment.id} className="transition-colors hover:border-primary/50"><CardHeader><div className="flex items-start justify-between gap-4"><div><CardTitle><Link className="hover:underline" to={`/project-environments/${environment.id}`}>{environment.name}</Link></CardTitle><CardDescription className="mt-2">{text(`${environment.repositories.length} 个项目`, `${environment.repositories.length} projects`)}</CardDescription></div><Badge variant={status.variant}>{status.label}</Badge></div></CardHeader><CardContent className="flex flex-col gap-2 text-sm text-muted-foreground"><p><span className="font-medium text-foreground">{text("当前版本：", "Current revision: ")}</span>{environment.currentRevisionId?.slice(0, 8) ?? "—"}</p><p><span className="font-medium text-foreground">{text("最近同步：", "Last sync: ")}</span>{environment.lastCheckedAt === null ? text("尚未同步", "Never") : formatDate(environment.lastCheckedAt)}</p><p><span className="font-medium text-foreground">{text("下次同步：", "Next sync: ")}</span>{environment.sync.nextScheduledAt === null ? text("尚未安排", "Not scheduled") : formatDate(environment.sync.nextScheduledAt)}</p></CardContent></Card>; })}</div>}
  </div>;
};

export const ProjectEnvironmentCreatePage = () => {
  const { text } = useI18n();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (name.trim() === "") return;
    setBusy(true); setError("");
    try { const created = await api<ProjectEnvironment>("/project-environments", { method: "POST", body: JSON.stringify({ name: name.trim() }) }); navigate(`/project-environments/${created.id}/repositories`); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  };
  return <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8"><Button asChild variant="ghost" className="mb-4"><Link to="/project-environments"><ArrowLeft />{text("返回项目环境", "Back to environments")}</Link></Button><PageHeader eyebrow={text("新建托管工作区", "NEW MANAGED WORKSPACE")} title={text("新建项目环境", "New project environment")} description={text("创建后添加一个或多个项目，系统会自动准备可复用的基础版本。", "Add one or more projects after creation. The server prepares a reusable base revision automatically.")} /><ErrorAlert message={error} /><Card><CardHeader><CardTitle>{text("环境信息", "Environment details")}</CardTitle></CardHeader><CardContent><form className="flex flex-col gap-6" onSubmit={submit}><FieldGroup><Field><FieldLabel htmlFor="environment-name">{text("项目环境名称", "Environment name")}</FieldLabel><Input id="environment-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus /></Field><div className="flex justify-end gap-2"><Button asChild variant="outline"><Link to="/project-environments">{text("取消", "Cancel")}</Link></Button><Button type="submit" disabled={busy}>{busy ? text("创建中…", "Creating…") : text("创建项目环境", "Create environment")}</Button></div></FieldGroup></form></CardContent></Card></div>;
};

type EnvironmentContext = { environment: ProjectEnvironment; reload(): Promise<void>; setEnvironment(value: ProjectEnvironment): void; error: string; setError(message: string): void };
const useEnvironment = () => useOutletContext<EnvironmentContext>();

export const ProjectEnvironmentDetailLayout = () => {
  const { text } = useI18n();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [environment, setEnvironment] = useState<ProjectEnvironment | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => setEnvironment(await api<ProjectEnvironment>(`/project-environments/${id}`)), [id]);
  useEffect(() => { const controller = new AbortController(); setEnvironment(null); setError(""); void api<ProjectEnvironment>(`/project-environments/${id}`, { signal: controller.signal }).then(setEnvironment).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); }); return () => controller.abort(); }, [id]);
  useEffect(() => {
    if (environment?.latestRevision?.status !== "preparing" && environment?.sync.status === "idle") return;
    const timer = setTimeout(() => void reload().catch((reason: unknown) => setError(errorMessage(reason))), 2_000);
    return () => clearTimeout(timer);
  }, [environment, reload]);
  const section = pathname.endsWith("/repositories") ? "repositories" : "overview";
  if (error !== "" && environment === null) return <div className="mx-auto max-w-5xl p-8"><ErrorAlert message={error} /></div>;
  if (environment === null) return <div className="mx-auto max-w-5xl p-8"><Skeleton className="h-10 w-72" /><Skeleton className="mt-8 h-64" /></div>;
  const status = revisionStatus(environment, text);
  return <div className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8"><Button asChild variant="ghost" className="mb-4"><Link to="/project-environments"><ArrowLeft />{text("返回项目环境", "Back to environments")}</Link></Button><PageHeader eyebrow={text("托管工作区", "MANAGED WORKSPACE")} title={environment.name} description={text("仓库配置改变后会自动生成新的基础版本，不影响已创建的会话。", "Repository changes create a new base revision without affecting existing sessions.")} action={<Badge variant={status.variant}>{status.label}</Badge>} /><Tabs value={section} onValueChange={(value) => navigate(value === "overview" ? `/project-environments/${id}` : `/project-environments/${id}/${value}`)}><TabsList variant="line" aria-label={text("项目环境管理", "Project environment management")}><TabsTrigger value="overview">{text("概览", "Overview")}</TabsTrigger><TabsTrigger value="repositories">{text("项目", "Projects")}</TabsTrigger></TabsList></Tabs><div className="mt-6"><Outlet context={{ environment, reload, setEnvironment, error, setError } satisfies EnvironmentContext} /></div></div>;
};

export const ProjectEnvironmentOverviewPage = () => {
  const { text, formatDate } = useI18n();
  const { environment, reload, error, setError } = useEnvironment();
  const [busy, setBusy] = useState(false);
  const sync = async () => { setBusy(true); setError(""); try { await api(`/project-environments/${environment.id}/sync`, { method: "POST" }); await reload(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } };
  const revision = environment.latestRevision;
  const syncing = environment.sync.status !== "idle";
  const buttonLabel = busy ? text("提交中…", "Submitting…") : environment.sync.status === "queued" ? text("等待同步", "Queued") : environment.sync.status === "running" ? text("同步中…", "Syncing…") : text("立即同步", "Sync now");
  const date = (value: string | null) => value === null ? text("尚未同步", "Never") : formatDate(value);
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Card><CardHeader><CardDescription>{text("项目数量", "Projects")}</CardDescription><CardTitle className="text-3xl">{environment.repositories.length}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>{text("当前版本", "Current revision")}</CardDescription><CardTitle className="font-mono text-lg">{environment.currentRevisionId?.slice(0, 8) ?? "—"}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>{text("最近同步", "Last sync")}</CardDescription><CardTitle className="text-base">{date(environment.lastCheckedAt)}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>{text("下次自动同步", "Next automatic sync")}</CardDescription><CardTitle className="text-base">{environment.sync.nextScheduledAt === null ? text("尚未安排", "Not scheduled") : formatDate(environment.sync.nextScheduledAt)}</CardTitle></CardHeader></Card></div>
    <Card className="overflow-hidden"><CardHeader className="border-b bg-muted/30"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><CardTitle>{text("项目环境同步", "Environment sync")}</CardTitle><CardDescription className="mt-2">{text("所有项目一起检查并原子发布新版本。自动计划：", "All projects are checked together and published as one revision. Schedule: ")}<span className="font-medium text-foreground">{text(`每 ${environment.sync.intervalMs / 3_600_000} 小时`, `Every ${environment.sync.intervalMs / 3_600_000} hours`)}</span></CardDescription></div><Badge variant={syncing ? "secondary" : "outline"}>{environment.sync.status === "running" ? text("同步中", "Syncing") : environment.sync.status === "queued" ? text("排队中", "Queued") : text("等待计划", "Scheduled")}</Badge></div></CardHeader><CardContent className="flex flex-col gap-5 p-5"><div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{text("环境工作区", "Environment workspace")}</p><p className="mt-2 break-all rounded-md border bg-background p-3 font-mono text-xs leading-5">{environment.workspacePath ?? text("尚未生成可用工作区", "No ready workspace yet")}</p></div><div><Button onClick={() => void sync()} disabled={busy || syncing}><RefreshCw className={busy || syncing ? "animate-spin" : ""} />{buttonLabel}</Button></div></CardContent></Card>
    {revision?.status === "failed" ? <Alert variant="destructive"><XCircle /><AlertTitle>{revision.failureStage ?? text("项目环境准备失败", "Environment preparation failed")}</AlertTitle><AlertDescription className="whitespace-pre-wrap">{revision.error ?? text("请检查仓库地址和准备命令。", "Check the repository URL and preparation command.")}</AlertDescription></Alert> : null}
    {revision?.status === "ready" ? <Alert><CheckCircle2 /><AlertTitle>{text("基础版本可用", "Base revision ready")}</AlertTitle><AlertDescription>{text("新会话会从当前版本创建独立工作区。", "New sessions receive an isolated workspace from this revision.")}</AlertDescription></Alert> : null}
  </div>;
};

export const ProjectEnvironmentRepositoriesPage = () => {
  const { text } = useI18n();
  const { environment, reload, error, setError } = useEnvironment();
  const [editing, setEditing] = useState<EnvironmentRepository | null | undefined>(undefined);
  const preparing = environment.latestRevision?.status === "preparing";
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} /><div className="flex items-center justify-between"><div><h2 className="text-lg font-semibold">{text("项目清单", "Projects")}</h2><p className="text-sm text-muted-foreground">{text("每个项目会被准备到同一个基础工作区。", "Every project is prepared into the same base workspace.")}</p></div><RepositoryDialog environmentId={environment.id} repository={null} open={editing === null} onOpenChange={(open) => setEditing(open ? null : undefined)} disabled={preparing} onSaved={async () => { setEditing(undefined); await reload(); }} onError={setError}><Button disabled={preparing}><Plus />{text("添加项目", "Add project")}</Button></RepositoryDialog></div>
    {environment.repositories.length === 0 ? <Card className="border-dashed"><CardContent className="py-14 text-center text-muted-foreground">{text("尚未添加项目。添加后系统会自动开始准备。", "No projects yet. Preparation starts automatically after adding one.")}</CardContent></Card> : <div className="flex flex-col gap-3">{environment.repositories.map((repository) => <Card key={repository.id}><CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><GitBranch className="size-4" /><h3 className="font-medium">{repository.name}</h3><Badge variant="outline">{text("随项目环境整体同步", "Synced with environment")}</Badge></div><p className="mt-2 truncate font-mono text-xs text-muted-foreground">{repository.gitUrl}</p><p className="mt-1 text-sm text-muted-foreground">{text("准备命令：", "Prepare command: ")}{repository.prepareCommand ?? text("无", "None")}</p><div className="mt-3"><p className="text-xs font-medium text-muted-foreground">{text("工作区路径", "Workspace path")}</p><p className="mt-1 break-all font-mono text-xs">{repository.workspacePath ?? text("尚未生成", "Not created")}</p></div></div><div className="flex gap-2"><RepositoryDialog environmentId={environment.id} repository={repository} open={editing?.id === repository.id} onOpenChange={(open) => setEditing(open ? repository : undefined)} disabled={preparing} onSaved={async () => { setEditing(undefined); await reload(); }} onError={setError}><Button size="sm" variant="outline" disabled={preparing}><Pencil />{text("编辑", "Edit")}</Button></RepositoryDialog><Button size="sm" variant="ghost" disabled={preparing} onClick={() => void (async () => { try { await api(`/project-environments/${environment.id}/repositories/${repository.id}`, { method: "DELETE" }); await reload(); } catch (reason) { setError(errorMessage(reason)); } })()}><Trash2 />{text("移除", "Remove")}</Button></div></CardContent></Card>)}</div>}
    {preparing ? <Alert><Loader2 className="animate-spin" /><AlertTitle>{text("正在准备新版本", "Preparing a new revision")}</AlertTitle><AlertDescription>{text("准备完成前暂时不能修改项目配置。", "Project configuration is locked until preparation completes.")}</AlertDescription></Alert> : null}
  </div>;
};

const RepositoryDialog = ({ environmentId, repository, open, onOpenChange, disabled, onSaved, onError, children }: { environmentId: string; repository: EnvironmentRepository | null; open: boolean; onOpenChange(open: boolean): void; disabled: boolean; onSaved(): Promise<void>; onError(message: string): void; children: React.ReactNode }) => {
  const { text } = useI18n();
  const [name, setName] = useState(repository?.name ?? "");
  const [gitUrl, setGitUrl] = useState(repository?.gitUrl ?? "");
  const [prepareCommand, setPrepareCommand] = useState(repository?.prepareCommand ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(repository?.name ?? ""); setGitUrl(repository?.gitUrl ?? ""); setPrepareCommand(repository?.prepareCommand ?? ""); } }, [open, repository]);
  const save = async (event: FormEvent) => { event.preventDefault(); if (name.trim() === "" || gitUrl.trim() === "") return; setBusy(true); onError(""); try { await api<EnvironmentRepository>(repository === null ? `/project-environments/${environmentId}/repositories` : `/project-environments/${environmentId}/repositories/${repository.id}`, { method: repository === null ? "POST" : "PATCH", body: JSON.stringify({ name: name.trim(), gitUrl: gitUrl.trim(), prepareCommand: prepareCommand.trim() === "" ? null : prepareCommand.trim() }) }); await onSaved(); } catch (reason) { onError(errorMessage(reason)); } finally { setBusy(false); } };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogTrigger asChild>{children}</DialogTrigger><DialogContent><form onSubmit={save}><DialogHeader><DialogTitle>{repository === null ? text("添加项目", "Add project") : text(`编辑 ${repository.name}`, `Edit ${repository.name}`)}</DialogTitle><DialogDescription>{text("目录名用于工作区内的项目文件夹。", "The directory name becomes the project folder inside the workspace.")}</DialogDescription></DialogHeader><FieldGroup className="py-5"><Field><FieldLabel htmlFor="repository-name">{text("项目目录名", "Project directory")}</FieldLabel><Input id="repository-name" value={name} onChange={(event) => setName(event.target.value)} disabled={disabled} /></Field><Field><FieldLabel htmlFor="repository-url">{text("Git 地址", "Git URL")}</FieldLabel><Input id="repository-url" value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} disabled={disabled} /></Field><Field><FieldLabel htmlFor="repository-prepare">{text("环境准备命令", "Preparation command")}</FieldLabel><Input id="repository-prepare" value={prepareCommand} onChange={(event) => setPrepareCommand(event.target.value)} disabled={disabled} placeholder={text("可留空", "Optional")} /></Field></FieldGroup><DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{text("取消", "Cancel")}</Button><Button type="submit" disabled={disabled || busy}>{busy ? text("保存中…", "Saving…") : text("保存", "Save")}</Button></DialogFooter></form></DialogContent></Dialog>;
};
