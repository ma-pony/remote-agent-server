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

const revisionStatus = (environment: ProjectEnvironment): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } => {
  if (environment.latestRevision?.status === "preparing") return { label: "准备中", variant: "secondary" };
  if (environment.latestRevision?.status === "failed") return { label: "准备失败", variant: "destructive" };
  if (environment.currentRevisionId !== null) return { label: "可用", variant: "default" };
  return { label: "尚未准备", variant: "outline" };
};

const ErrorAlert = ({ message }: { message: string }) => message === "" ? null : <Alert variant="destructive"><XCircle /><AlertTitle>操作失败</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>;
const displayDateTime = (value: string | null): string => value === null ? "尚未同步" : new Date(value).toLocaleString("zh-CN");
const displayInterval = (milliseconds: number): string => `每 ${milliseconds / 60 / 60 / 1_000} 小时`;

export const ProjectEnvironmentListPage = () => {
  const [items, setItems] = useState<ProjectEnvironment[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<ProjectEnvironment[]>("/project-environments", { signal: controller.signal }).then(setItems).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, []);
  return <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
    <PageHeader eyebrow="MANAGED WORKSPACES" title="项目环境" description="一个环境可以包含多个 Git 项目，Session 从可用版本创建独立 Workspace。" action={<Button asChild><Link to="/project-environments/new"><Plus />新建项目环境</Link></Button>} />
    <ErrorAlert message={error} />
    {items === null ? <div className="grid gap-4 md:grid-cols-2">{[0, 1].map((item) => <Skeleton key={item} className="h-48" />)}</div>
      : items.length === 0 ? <Card className="border-dashed"><CardContent className="py-16 text-center text-muted-foreground">暂无项目环境，先创建一个并添加需要的仓库。</CardContent></Card>
      : <div className="grid gap-4 md:grid-cols-2">{items.map((environment) => { const status = revisionStatus(environment); return <Card key={environment.id} className="transition-colors hover:border-primary/50"><CardHeader><div className="flex items-start justify-between gap-4"><div><CardTitle><Link className="hover:underline" to={`/project-environments/${environment.id}`}>{environment.name}</Link></CardTitle><CardDescription className="mt-2">{environment.repositories.length} 个项目</CardDescription></div><Badge variant={status.variant}>{status.label}</Badge></div></CardHeader><CardContent className="flex flex-col gap-2 text-sm text-muted-foreground"><p><span className="font-medium text-foreground">当前版本：</span>{environment.currentRevisionId?.slice(0, 8) ?? "—"}</p><p><span className="font-medium text-foreground">最近同步：</span>{displayDateTime(environment.lastCheckedAt)}</p><p><span className="font-medium text-foreground">下次同步：</span>{displayDateTime(environment.sync.nextScheduledAt)}</p></CardContent></Card>; })}</div>}
  </div>;
};

export const ProjectEnvironmentCreatePage = () => {
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
  return <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8"><Button asChild variant="ghost" className="mb-4"><Link to="/project-environments"><ArrowLeft />返回项目环境</Link></Button><PageHeader eyebrow="NEW MANAGED WORKSPACE" title="新建项目环境" description="创建后添加一个或多个项目，系统会自动准备可复用的基础版本。" /><ErrorAlert message={error} /><Card><CardHeader><CardTitle>环境信息</CardTitle></CardHeader><CardContent><form className="flex flex-col gap-6" onSubmit={submit}><FieldGroup><Field><FieldLabel htmlFor="environment-name">项目环境名称</FieldLabel><Input id="environment-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus /></Field><div className="flex justify-end gap-2"><Button asChild variant="outline"><Link to="/project-environments">取消</Link></Button><Button type="submit" disabled={busy}>{busy ? "创建中…" : "创建项目环境"}</Button></div></FieldGroup></form></CardContent></Card></div>;
};

type EnvironmentContext = { environment: ProjectEnvironment; reload(): Promise<void>; setEnvironment(value: ProjectEnvironment): void; error: string; setError(message: string): void };
const useEnvironment = () => useOutletContext<EnvironmentContext>();

export const ProjectEnvironmentDetailLayout = () => {
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
  const status = revisionStatus(environment);
  return <div className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8"><Button asChild variant="ghost" className="mb-4"><Link to="/project-environments"><ArrowLeft />返回项目环境</Link></Button><PageHeader eyebrow="MANAGED WORKSPACE" title={environment.name} description="仓库配置改变后会自动生成新的基础版本，不影响已创建的 Session。" action={<Badge variant={status.variant}>{status.label}</Badge>} /><Tabs value={section} onValueChange={(value) => navigate(value === "overview" ? `/project-environments/${id}` : `/project-environments/${id}/${value}`)}><TabsList variant="line" aria-label="项目环境管理"><TabsTrigger value="overview">概览</TabsTrigger><TabsTrigger value="repositories">项目</TabsTrigger></TabsList></Tabs><div className="mt-6"><Outlet context={{ environment, reload, setEnvironment, error, setError } satisfies EnvironmentContext} /></div></div>;
};

export const ProjectEnvironmentOverviewPage = () => {
  const { environment, reload, error, setError } = useEnvironment();
  const [busy, setBusy] = useState(false);
  const sync = async () => { setBusy(true); setError(""); try { await api(`/project-environments/${environment.id}/sync`, { method: "POST" }); await reload(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } };
  const revision = environment.latestRevision;
  const syncing = environment.sync.status !== "idle";
  const buttonLabel = busy ? "提交中…" : environment.sync.status === "queued" ? "等待同步" : environment.sync.status === "running" ? "同步中…" : "立即同步";
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Card><CardHeader><CardDescription>项目数量</CardDescription><CardTitle className="text-3xl">{environment.repositories.length}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>当前版本</CardDescription><CardTitle className="font-mono text-lg">{environment.currentRevisionId?.slice(0, 8) ?? "—"}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>最近同步</CardDescription><CardTitle className="text-base">{displayDateTime(environment.lastCheckedAt)}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>下次自动同步</CardDescription><CardTitle className="text-base">{displayDateTime(environment.sync.nextScheduledAt)}</CardTitle></CardHeader></Card></div>
    <Card className="overflow-hidden"><CardHeader className="border-b bg-muted/30"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><CardTitle>项目环境同步</CardTitle><CardDescription className="mt-2">所有项目一起检查并原子发布新版本。自动计划：<span className="font-medium text-foreground">{displayInterval(environment.sync.intervalMs)}</span></CardDescription></div><Badge variant={syncing ? "secondary" : "outline"}>{environment.sync.status === "running" ? "同步中" : environment.sync.status === "queued" ? "排队中" : "等待计划"}</Badge></div></CardHeader><CardContent className="flex flex-col gap-5 p-5"><div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">环境 Workspace</p><p className="mt-2 break-all rounded-md border bg-background p-3 font-mono text-xs leading-5">{environment.workspacePath ?? "尚未生成可用 Workspace"}</p></div><div><Button onClick={() => void sync()} disabled={busy || syncing}><RefreshCw className={busy || syncing ? "animate-spin" : ""} />{buttonLabel}</Button></div></CardContent></Card>
    {revision?.status === "failed" ? <Alert variant="destructive"><XCircle /><AlertTitle>{revision.failureStage ?? "项目环境准备失败"}</AlertTitle><AlertDescription className="whitespace-pre-wrap">{revision.error ?? "请检查仓库地址和准备命令。"}</AlertDescription></Alert> : null}
    {revision?.status === "ready" ? <Alert><CheckCircle2 /><AlertTitle>基础版本可用</AlertTitle><AlertDescription>新 Session 会从当前版本创建独立 Workspace。</AlertDescription></Alert> : null}
  </div>;
};

export const ProjectEnvironmentRepositoriesPage = () => {
  const { environment, reload, error, setError } = useEnvironment();
  const [editing, setEditing] = useState<EnvironmentRepository | null | undefined>(undefined);
  const preparing = environment.latestRevision?.status === "preparing";
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} /><div className="flex items-center justify-between"><div><h2 className="text-lg font-semibold">项目清单</h2><p className="text-sm text-muted-foreground">每个项目会被准备到同一个基础 Workspace。</p></div><RepositoryDialog environmentId={environment.id} repository={null} open={editing === null} onOpenChange={(open) => setEditing(open ? null : undefined)} disabled={preparing} onSaved={async () => { setEditing(undefined); await reload(); }} onError={setError}><Button disabled={preparing}><Plus />添加项目</Button></RepositoryDialog></div>
    {environment.repositories.length === 0 ? <Card className="border-dashed"><CardContent className="py-14 text-center text-muted-foreground">尚未添加项目。添加后系统会自动开始准备。</CardContent></Card> : <div className="flex flex-col gap-3">{environment.repositories.map((repository) => <Card key={repository.id}><CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><GitBranch className="size-4" /><h3 className="font-medium">{repository.name}</h3><Badge variant="outline">随项目环境整体同步</Badge></div><p className="mt-2 truncate font-mono text-xs text-muted-foreground">{repository.gitUrl}</p><p className="mt-1 text-sm text-muted-foreground">准备命令：{repository.prepareCommand ?? "无"}</p><div className="mt-3"><p className="text-xs font-medium text-muted-foreground">Workspace 路径</p><p className="mt-1 break-all font-mono text-xs">{repository.workspacePath ?? "尚未生成"}</p></div></div><div className="flex gap-2"><RepositoryDialog environmentId={environment.id} repository={repository} open={editing?.id === repository.id} onOpenChange={(open) => setEditing(open ? repository : undefined)} disabled={preparing} onSaved={async () => { setEditing(undefined); await reload(); }} onError={setError}><Button size="sm" variant="outline" disabled={preparing}><Pencil />编辑</Button></RepositoryDialog><Button size="sm" variant="ghost" disabled={preparing} onClick={() => void (async () => { try { await api(`/project-environments/${environment.id}/repositories/${repository.id}`, { method: "DELETE" }); await reload(); } catch (reason) { setError(errorMessage(reason)); } })()}><Trash2 />移除</Button></div></CardContent></Card>)}</div>}
    {preparing ? <Alert><Loader2 className="animate-spin" /><AlertTitle>正在准备新版本</AlertTitle><AlertDescription>准备完成前暂时不能修改项目配置。</AlertDescription></Alert> : null}
  </div>;
};

const RepositoryDialog = ({ environmentId, repository, open, onOpenChange, disabled, onSaved, onError, children }: { environmentId: string; repository: EnvironmentRepository | null; open: boolean; onOpenChange(open: boolean): void; disabled: boolean; onSaved(): Promise<void>; onError(message: string): void; children: React.ReactNode }) => {
  const [name, setName] = useState(repository?.name ?? "");
  const [gitUrl, setGitUrl] = useState(repository?.gitUrl ?? "");
  const [prepareCommand, setPrepareCommand] = useState(repository?.prepareCommand ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(repository?.name ?? ""); setGitUrl(repository?.gitUrl ?? ""); setPrepareCommand(repository?.prepareCommand ?? ""); } }, [open, repository]);
  const save = async (event: FormEvent) => { event.preventDefault(); if (name.trim() === "" || gitUrl.trim() === "") return; setBusy(true); onError(""); try { await api<EnvironmentRepository>(repository === null ? `/project-environments/${environmentId}/repositories` : `/project-environments/${environmentId}/repositories/${repository.id}`, { method: repository === null ? "POST" : "PATCH", body: JSON.stringify({ name: name.trim(), gitUrl: gitUrl.trim(), prepareCommand: prepareCommand.trim() === "" ? null : prepareCommand.trim() }) }); await onSaved(); } catch (reason) { onError(errorMessage(reason)); } finally { setBusy(false); } };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogTrigger asChild>{children}</DialogTrigger><DialogContent><form onSubmit={save}><DialogHeader><DialogTitle>{repository === null ? "添加项目" : `编辑 ${repository.name}`}</DialogTitle><DialogDescription>目录名用于 Workspace 内的项目文件夹。</DialogDescription></DialogHeader><FieldGroup className="py-5"><Field><FieldLabel htmlFor="repository-name">项目目录名</FieldLabel><Input id="repository-name" value={name} onChange={(event) => setName(event.target.value)} disabled={disabled} /></Field><Field><FieldLabel htmlFor="repository-url">Git 地址</FieldLabel><Input id="repository-url" value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} disabled={disabled} /></Field><Field><FieldLabel htmlFor="repository-prepare">环境准备命令</FieldLabel><Input id="repository-prepare" value={prepareCommand} onChange={(event) => setPrepareCommand(event.target.value)} disabled={disabled} placeholder="可留空" /></Field></FieldGroup><DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={disabled || busy}>{busy ? "保存中…" : "保存"}</Button></DialogFooter></form></DialogContent></Dialog>;
};
