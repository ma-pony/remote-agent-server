import { FormEvent, useEffect, useMemo, useState } from "react";
import { ArrowLeft, MessageSquarePlus, Plus, Search, Trash2, XCircle } from "lucide-react";
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
import { api, errorMessage, type Agent, type Session } from "@/api";

const displayTime = (value: string): string => new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
}).format(new Date(value));
const ErrorAlert = ({ message }: { message: string }) => message === "" ? null : <Alert variant="destructive"><XCircle /><AlertTitle>操作失败</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>;

export const SessionDeleteDialog = ({ session, onDeleted, onError }: {
  session: Session;
  onDeleted(): void;
  onError(message: string): void;
}) => {
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
  return <AlertDialog><AlertDialogTrigger asChild><Button type="button" size="icon-sm" variant="destructive" disabled={disabled} aria-label={`删除 ${session.title}`} title={session.status === "running" ? "运行中的 Session 不能删除" : "删除 Session"}><Trash2 /></Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>永久删除“{session.title}”？</AlertDialogTitle><AlertDialogDescription>全部对话历史和 Workspace 都会永久删除，浏览器数据与 Provider Session 也无法恢复。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void remove()}>永久删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
};

export const SessionListPage = () => {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([api<Session[]>("/sessions", { signal: controller.signal }), api<Agent[]>("/agents", { signal: controller.signal })]).then(([sessionItems, agentItems]) => { setSessions(sessionItems); setAgents(agentItems); }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, []);
  const names = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const visible = (sessions ?? []).filter((session) => session.title.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="mx-auto w-full max-w-6xl p-4 sm:p-6 lg:p-8"><PageHeader eyebrow="CONVERSATION WORKSPACES" title="Session" description="每个 Session 保留独立 Workspace，并可在同一 Agent 上继续多轮任务。" action={<Button asChild><Link to="/sessions/new"><Plus />新建 Session</Link></Button>} /><ErrorAlert message={error} /><div className="mb-5 flex max-w-sm items-center gap-2 rounded-lg border bg-card px-3"><Search className="size-4 text-muted-foreground" /><Input aria-label="搜索 Session" className="border-0 bg-transparent shadow-none focus-visible:ring-0" placeholder="按标题搜索" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    {sessions === null ? <div className="flex flex-col gap-3">{[0, 1, 2].map((item) => <Skeleton key={item} className="h-24" />)}</div> : visible.length === 0 ? <Card className="border-dashed"><CardContent className="py-16 text-center text-muted-foreground">{sessions.length === 0 ? "暂无 Session，创建一个开始对话。" : "没有匹配的 Session。"}</CardContent></Card> : <div className="divide-y rounded-xl border bg-card">{visible.map((session) => <div key={session.id} className="flex flex-col gap-3 p-5 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><h2 className="truncate font-medium"><Link className="hover:underline" to={`/sessions/${session.id}`} aria-label={session.title}>{session.title}</Link></h2><p className="mt-1 text-sm text-muted-foreground">{names.get(session.agentId) ?? session.agentId}</p></div><div className="flex items-center gap-3"><Badge variant={session.status === "running" ? "default" : "secondary"}>{session.status === "running" ? "运行中" : "空闲"}</Badge><time className="text-sm text-muted-foreground" dateTime={session.updatedAt}>{displayTime(session.updatedAt)}</time><SessionDeleteDialog session={session} onDeleted={() => setSessions((current) => current?.filter((item) => item.id !== session.id) ?? [])} onError={setError} /></div></div>)}</div>}
  </div>;
};

export const SessionCreatePage = () => {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { const controller = new AbortController(); void api<Agent[]>("/agents", { signal: controller.signal }).then((items) => { const enabled = items.filter((item) => item.enabled); setAgents(enabled); setAgentId(enabled[0]?.id ?? ""); }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); }); return () => controller.abort(); }, []);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (title.trim() === "" || agentId === "") return; setBusy(true); setError(""); try { const created = await api<Session>("/sessions", { method: "POST", body: JSON.stringify({ title: title.trim(), agentId }) }); navigate(`/sessions/${created.id}`); } catch (reason) { setError(errorMessage(reason)); setBusy(false); } };
  return <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8"><Button asChild variant="ghost" className="mb-4"><Link to="/sessions"><ArrowLeft />返回 Session</Link></Button><PageHeader eyebrow="NEW CONVERSATION WORKSPACE" title="新建 Session" description="选择 Agent 后，系统会从它绑定的项目环境创建独立 Workspace。" /><ErrorAlert message={error} /><Card><CardHeader><CardTitle className="flex items-center gap-2"><MessageSquarePlus className="size-5" />Session 信息</CardTitle><CardDescription>创建完成后即可发送第一条任务。</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-6" onSubmit={submit}><FieldGroup><Field><FieldLabel htmlFor="session-title">Session 标题</FieldLabel><Input id="session-title" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></Field><Field><FieldLabel htmlFor="session-agent">选择 Agent</FieldLabel><NativeSelect id="session-agent" className="w-full" value={agentId} onChange={(event) => setAgentId(event.target.value)}><NativeSelectOption value="" disabled>请选择</NativeSelectOption>{agents.map((agent) => <NativeSelectOption key={agent.id} value={agent.id}>{agent.name}</NativeSelectOption>)}</NativeSelect>{agents.length === 0 ? <FieldDescription>暂无已启用的 Agent。</FieldDescription> : null}</Field><div className="flex justify-end gap-2"><Button asChild variant="outline"><Link to="/sessions">取消</Link></Button><Button type="submit" disabled={busy || agentId === ""}>{busy ? "创建中…" : "创建 Session"}</Button></div></FieldGroup></form></CardContent></Card></div>;
};
