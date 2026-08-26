import { FormEvent, useEffect, useState } from "react";
import { ArrowLeft, Bot, Cable, ChevronLeft, ChevronRight, FolderGit2, Hash, MessageSquarePlus, Plus, Search, Trash2, XCircle } from "lucide-react";
import { Link, useNavigate } from "react-router";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { api, errorMessage, type Agent, type AgentSessionParameter, type Page, type Session, type SessionListItem } from "@/api";
import { useI18n } from "@/i18n";

const ErrorAlert = ({ message }: { message: string }) => { const { text } = useI18n(); return message === "" ? null : <Alert variant="destructive"><XCircle /><AlertTitle>{text("操作失败", "Operation failed")}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>; };

export const SessionDeleteDialog = ({ session, onDeleted, onError }: {
  session: Session;
  onDeleted(): void;
  onError(message: string): void;
}) => {
  const { text } = useI18n();
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    onError("");
    try {
      await api(`/sessions/${session.id}`, { method: "DELETE" });
      onDeleted();
    } catch (reason) {
      onError(errorMessage(reason));
      setBusy(false);
    }
  };
  const disabled = busy || session.status === "running";
  return <AlertDialog><AlertDialogTrigger asChild><Button type="button" size="icon-sm" variant="destructive" disabled={disabled} aria-label={text(`删除 ${session.title}`, `Delete ${session.title}`)} title={session.status === "running" ? text("运行中的会话不能删除", "A running session cannot be deleted") : text("删除会话", "Delete session")}><Trash2 /></Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{text(`永久删除“${session.title}”？`, `Permanently delete “${session.title}”?`)}</AlertDialogTitle><AlertDialogDescription>{text("全部对话历史和工作区都会永久删除，浏览器数据与执行器会话也无法恢复。", "All conversation history and the workspace will be permanently deleted. Browser data and the provider session cannot be recovered.")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{text("取消", "Cancel")}</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void remove()}>{text("永久删除", "Delete permanently")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
};

export const SessionListPage = () => {
  const { locale, text, formatDate } = useI18n();
  const [result, setResult] = useState<Page<SessionListItem> | null>(null);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (query.trim() !== "") parameters.set("query", query.trim());
    setResult(null);
    void api<Page<SessionListItem>>(`/sessions?${parameters.toString()}`, { signal: controller.signal })
      .then(setResult)
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [page, query, refresh]);
  const sessions = result?.items ?? [];
  const providerLabel = (provider: SessionListItem["agentProvider"]): string => provider === "claude_code" ? "Claude Code" : provider === "codex" ? "Codex" : "Hermes";
  const tokenTotal = (session: SessionListItem): string => session.usage?.totalTokens == null
    ? text("未统计", "Not measured")
    : new Intl.NumberFormat(locale).format(session.usage.totalTokens);
  return <div className="mx-auto w-full max-w-6xl p-4 sm:p-6 lg:p-8"><PageHeader eyebrow={text("对话工作区", "CONVERSATION WORKSPACES")} title={text("会话", "Sessions")} description={text("活动会话使用独立工作区；过期后释放存储并保留历史与统计。", "Active sessions use isolated workspaces; expired sessions release storage while retaining history and statistics.")} action={<Button asChild><Link to="/sessions/new"><Plus />{text("新建会话", "New session")}</Link></Button>} /><ErrorAlert message={error} /><div className="mb-5 flex max-w-lg items-center gap-2 rounded-lg border bg-card px-3"><Search className="size-4 text-muted-foreground" /><Input aria-label={text("搜索会话", "Search sessions")} className="border-0 bg-transparent shadow-none focus-visible:ring-0" placeholder={text("搜索标题、会话 ID 或外部标识", "Search title, session ID, or external reference")} value={query} onChange={(event) => { setPage(1); setQuery(event.target.value); }} /></div>
    {result === null ? <div className="flex flex-col gap-3">{[0, 1, 2].map((item) => <Skeleton key={item} className="h-40" />)}</div> : sessions.length === 0 ? <Card className="border-dashed"><CardContent className="py-16 text-center text-muted-foreground">{query.trim() === "" ? text("暂无会话，创建一个开始对话。", "No sessions yet. Create one to start a conversation.") : text("没有匹配的会话。", "No matching sessions.")}</CardContent></Card> : <div className="divide-y overflow-hidden rounded-xl border bg-card">{sessions.map((session) => <article key={session.id} className="grid gap-5 p-5 transition-colors hover:bg-muted/40 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"><div className="min-w-0"><div className="flex flex-wrap items-center gap-x-3 gap-y-2"><h2 className="min-w-0 truncate font-heading text-lg font-medium"><Link className="hover:underline" to={`/sessions/${session.id}`} aria-label={session.title}>{session.title}</Link></h2><span className="font-mono text-xs text-muted-foreground">{text(`会话 #${session.id}`, `Session #${session.id}`)}</span></div><div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground"><span className="inline-flex items-center gap-1.5"><Bot className="size-3.5" />{session.agentName} · {providerLabel(session.agentProvider)}</span><span className="inline-flex items-center gap-1.5"><FolderGit2 className="size-3.5" />{session.projectEnvironmentName ?? text("未绑定项目环境", "No project environment")}</span></div>{session.integration === null ? <div className="mt-4 inline-flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"><Hash className="size-3.5" />{text("手工创建", "Created manually")}</div> : <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border bg-muted/25 px-3 py-2 text-xs"><span className="inline-flex items-center gap-1.5 text-muted-foreground"><Cable className="size-3.5" />{text("外部接入", "Integration")}</span><Link aria-label={text(`查看接入端点 ${session.integration.endpointName}`, `View integration endpoint ${session.integration.endpointName}`)} className="font-medium hover:underline" to={`/integration-endpoints/${session.integration.endpointId}`}>{session.integration.endpointName}</Link><span className="font-mono text-muted-foreground">/{session.integration.endpointSlug}</span>{session.integration.conversationKey === null ? null : <span><span className="mr-1 text-muted-foreground">{text("外部对话", "Conversation")}</span><span className="font-mono">{session.integration.conversationKey}</span></span>}{session.integration.latestRequestId === null ? null : <span className="truncate"><span className="mr-1 text-muted-foreground">{text("最近请求", "Latest request")}</span><span className="font-mono">{session.integration.latestRequestId}</span></span>}</div>}</div><div className="flex items-end justify-between gap-5 border-t pt-4 lg:min-w-52 lg:flex-col lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0"><div className="lg:text-right"><p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{text("累计 Token", "Total tokens")}</p><p className="mt-1 font-mono text-xl font-semibold tabular-nums">{tokenTotal(session)}</p></div><div className="flex flex-wrap items-center justify-end gap-3"><Badge variant={session.storageCleanedAt != null ? "outline" : session.status === "running" ? "default" : "secondary"}>{session.storageCleanedAt != null ? text("存储已清理", "Storage cleaned") : session.status === "running" ? text("运行中", "Running") : text("空闲", "Idle")}</Badge><time className="text-xs text-muted-foreground" dateTime={session.updatedAt}>{formatDate(session.updatedAt)}</time><SessionDeleteDialog session={session} onDeleted={() => { if (sessions.length === 1 && page > 1) setPage((current) => current - 1); else setRefresh((value) => value + 1); }} onError={setError} /></div></div></article>)}</div>}
    {result !== null && result.total > 0 ? <div className="mt-4 flex flex-col gap-3 rounded-lg border bg-card px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"><span className="text-muted-foreground">{text(`共 ${result.total} 个会话`, `${result.total} sessions`)}</span><div className="flex items-center justify-between gap-3 sm:justify-end"><Button type="button" size="sm" variant="outline" disabled={result.page <= 1} onClick={() => setPage((current) => current - 1)} aria-label={text("上一页", "Previous page")}><ChevronLeft />{text("上一页", "Previous")}</Button><span className="min-w-24 text-center font-mono text-xs tabular-nums">{text(`第 ${result.page} / ${result.totalPages} 页`, `Page ${result.page} / ${result.totalPages}`)}</span><Button type="button" size="sm" variant="outline" disabled={result.page >= result.totalPages} onClick={() => setPage((current) => current + 1)} aria-label={text("下一页", "Next page")}>{text("下一页", "Next")}<ChevronRight /></Button></div></div> : null}
  </div>;
};

export const SessionCreatePage = () => {
  const { text } = useI18n();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState("");
  const [parameters, setParameters] = useState<AgentSessionParameter[]>([]);
  const [parameterValues, setParameterValues] = useState<Record<string, string>>(Object.create(null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { const controller = new AbortController(); void api<Agent[]>("/agents", { signal: controller.signal }).then((items) => { const enabled = items.filter((item) => item.enabled); setAgents(enabled); setAgentId(enabled[0] === undefined ? "" : String(enabled[0].id)); }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); }); return () => controller.abort(); }, []);
  useEffect(() => {
    if (agentId === "") { setParameters([]); setParameterValues(Object.create(null)); return; }
    const controller = new AbortController();
    setParameters([]); setParameterValues(Object.create(null));
    void api<AgentSessionParameter[]>(`/agents/${agentId}/session-parameters`, { signal: controller.signal })
      .then(setParameters).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [agentId]);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (title.trim() === "" || agentId === "") return; setBusy(true); setError(""); try { const created = await api<Session>("/sessions", { method: "POST", body: JSON.stringify({ title: title.trim(), agentId: Number(agentId), mcpParameters: parameterValues }) }); navigate(`/sessions/${created.id}`); } catch (reason) { setError(errorMessage(reason)); setBusy(false); } };
  return <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8"><Button asChild variant="ghost" className="mb-4"><Link to="/sessions"><ArrowLeft />{text("返回会话", "Back to sessions")}</Link></Button><PageHeader eyebrow={text("新建对话工作区", "NEW CONVERSATION WORKSPACE")} title={text("新建会话", "New session")} description={text("选择智能体后，系统会从它绑定的项目环境创建独立工作区。", "The server creates an isolated workspace from the selected agent's project environment.")} /><ErrorAlert message={error} /><Card><CardHeader><CardTitle className="flex items-center gap-2"><MessageSquarePlus className="size-5" />{text("会话信息", "Session details")}</CardTitle><CardDescription>{text("创建完成后即可发送第一条任务。", "Send the first task after creation.")}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-6" onSubmit={submit}><FieldGroup><Field><FieldLabel htmlFor="session-title">{text("会话标题", "Session title")}</FieldLabel><Input id="session-title" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></Field><Field><FieldLabel htmlFor="session-agent">{text("选择智能体", "Select agent")}</FieldLabel><NativeSelect id="session-agent" className="w-full" value={agentId} onChange={(event) => setAgentId(event.target.value)}><NativeSelectOption value="" disabled>{text("请选择", "Select")}</NativeSelectOption>{agents.map((agent) => <NativeSelectOption key={agent.id} value={agent.id}>{agent.name}</NativeSelectOption>)}</NativeSelect>{agents.length === 0 ? <FieldDescription>{text("暂无已启用的智能体。", "No enabled agents.")}</FieldDescription> : null}</Field>{parameters.length === 0 ? null : <div className="rounded-lg border bg-muted/20 p-4"><p className="mb-4 text-sm font-medium">{text("MCP 会话参数", "MCP session parameters")}</p><FieldGroup>{parameters.map((parameter) => <Field key={parameter.id}><FieldLabel htmlFor={`create-parameter-${parameter.key}`}>{parameter.label}{parameter.required ? text("（必填）", " (required)") : ""}</FieldLabel><Input id={`create-parameter-${parameter.key}`} type={parameter.secret ? "password" : "text"} value={parameterValues[parameter.key] ?? ""} required={parameter.required} onChange={(event) => setParameterValues((current) => ({ ...current, [parameter.key]: event.target.value }))} />{parameter.description === null ? null : <FieldDescription>{parameter.description}</FieldDescription>}</Field>)}</FieldGroup></div>}<div className="flex justify-end gap-2"><Button asChild variant="outline"><Link to="/sessions">{text("取消", "Cancel")}</Link></Button><Button type="submit" disabled={busy || agentId === ""}>{busy ? text("创建中…", "Creating…") : text("创建会话", "Create session")}</Button></div></FieldGroup></form></CardContent></Card></div>;
};
