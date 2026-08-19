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
import { api, errorMessage, type Agent, type AgentSessionParameter, type Session } from "@/api";
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
  const { text, formatDate } = useI18n();
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
  return <div className="mx-auto w-full max-w-6xl p-4 sm:p-6 lg:p-8"><PageHeader eyebrow={text("对话工作区", "CONVERSATION WORKSPACES")} title={text("会话", "Sessions")} description={text("每个会话保留独立工作区，并可在同一智能体上继续多轮任务。", "Each session keeps an isolated workspace and supports multiple turns with the same agent.")} action={<Button asChild><Link to="/sessions/new"><Plus />{text("新建会话", "New session")}</Link></Button>} /><ErrorAlert message={error} /><div className="mb-5 flex max-w-sm items-center gap-2 rounded-lg border bg-card px-3"><Search className="size-4 text-muted-foreground" /><Input aria-label={text("搜索会话", "Search sessions")} className="border-0 bg-transparent shadow-none focus-visible:ring-0" placeholder={text("按标题搜索", "Search by title")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    {sessions === null ? <div className="flex flex-col gap-3">{[0, 1, 2].map((item) => <Skeleton key={item} className="h-24" />)}</div> : visible.length === 0 ? <Card className="border-dashed"><CardContent className="py-16 text-center text-muted-foreground">{sessions.length === 0 ? text("暂无会话，创建一个开始对话。", "No sessions yet. Create one to start a conversation.") : text("没有匹配的会话。", "No matching sessions.")}</CardContent></Card> : <div className="divide-y rounded-xl border bg-card">{visible.map((session) => <div key={session.id} className="flex flex-col gap-3 p-5 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><h2 className="truncate font-medium"><Link className="hover:underline" to={`/sessions/${session.id}`} aria-label={session.title}>{session.title}</Link></h2><p className="mt-1 text-sm text-muted-foreground">{names.get(session.agentId) ?? session.agentId}</p></div><div className="flex items-center gap-3"><Badge variant={session.status === "running" ? "default" : "secondary"}>{session.status === "running" ? text("运行中", "Running") : text("空闲", "Idle")}</Badge><time className="text-sm text-muted-foreground" dateTime={session.updatedAt}>{formatDate(session.updatedAt)}</time><SessionDeleteDialog session={session} onDeleted={() => setSessions((current) => current?.filter((item) => item.id !== session.id) ?? [])} onError={setError} /></div></div>)}</div>}
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
