import { FormEvent, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, Plus, RefreshCw, Trash2, XCircle } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";

import {
  api, errorMessage, type AgentMcpServerDetail, type AgentMcpServerSummary,
  type AgentSessionParameter, type McpValueView, type Session, type SharedMcpServerSummary
} from "@/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { useI18n } from "@/i18n";

const ErrorAlert = ({ message }: { message: string }) => { const { text } = useI18n(); return message === "" ? null : (
  <Alert variant="destructive"><XCircle /><AlertTitle>{text("操作失败", "Operation failed")}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>
); };

type McpToolSummary = { name: string; description: string | null };
type McpCheckResponse =
  | { status: "passed"; toolCount: number; message: string; tools?: McpToolSummary[] }
  | { status: "failed"; message: string };

export const AgentMcpPage = () => {
  const { text } = useI18n();
  const { id = "" } = useParams();
  const [servers, setServers] = useState<AgentMcpServerSummary[] | null>(null);
  const [catalog, setCatalog] = useState<SharedMcpServerSummary[] | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [checkSessionId, setCheckSessionId] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [toolDialog, setToolDialog] = useState<{ serverName: string; tools: McpToolSummary[] } | null>(null);

  const load = () => Promise.all([
    api<AgentMcpServerSummary[]>(`/agents/${id}/mcp-servers`),
    api<SharedMcpServerSummary[]>(`/agents/${id}/mcp-catalog`),
    api<Session[]>("/sessions")
  ]).then(([serverItems, catalogItems, sessionItems]) => {
    setServers(serverItems); setCatalog(catalogItems);
    setSessions(sessionItems.filter((item) => item.agentId === Number(id)));
  });
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api<AgentMcpServerSummary[]>(`/agents/${id}/mcp-servers`, { signal: controller.signal }),
      api<SharedMcpServerSummary[]>(`/agents/${id}/mcp-catalog`, { signal: controller.signal }),
      api<Session[]>("/sessions", { signal: controller.signal })
    ]).then(([serverItems, catalogItems, sessionItems]) => {
      setServers(serverItems); setCatalog(catalogItems);
      setSessions(sessionItems.filter((item) => item.agentId === Number(id)));
    })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [id]);

  const probe = (server: AgentMcpServerSummary) => api<McpCheckResponse>(
    `/agents/${id}/mcp-servers/${server.id}/check`, {
      method: "POST", body: checkSessionId === "" ? undefined : JSON.stringify({ sessionId: Number(checkSessionId) })
    }
  );
  const check = async (server: AgentMcpServerSummary) => {
    setBusy(`check-${server.id}`); setError(""); setNotice("");
    try {
      const result = await probe(server);
      setNotice(result.status === "passed" ? text(`${result.toolCount ?? 0} 个工具可用`, `${result.toolCount ?? 0} tools available`) : result.message);
      await load();
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };
  const showTools = async (server: AgentMcpServerSummary) => {
    setBusy(`tools-${server.id}`); setError("");
    try {
      const result = await probe(server);
      if (result.status === "failed") { setError(result.message); return; }
      setToolDialog({ serverName: server.name, tools: result.tools ?? [] });
      await load();
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };
  const install = async (server: SharedMcpServerSummary) => {
    setBusy(`install-${server.id}`); setError("");
    try {
      await api(`/agents/${id}/mcp-catalog/${server.id}/install`, { method: "POST" });
      await load();
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };
  const toggle = async (server: AgentMcpServerSummary) => {
    setBusy(`toggle-${server.id}`); setError("");
    try {
      const updated = await api<AgentMcpServerSummary>(`/agents/${id}/mcp-servers/${server.id}/enabled`, {
        method: "PATCH", body: JSON.stringify({ enabled: !server.enabled })
      });
      setServers((items) => (items ?? []).map((item) => item.id === updated.id ? updated : item));
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };
  const remove = async (server: AgentMcpServerSummary, scope: "current" | "all") => {
    setBusy(`delete-${server.id}`); setError("");
    try {
      await api(`/agents/${id}/mcp-servers/${server.id}?scope=${scope}`, { method: "DELETE" });
      await load();
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };

  return <div className="flex flex-col gap-6"><ErrorAlert message={error} />
    <Dialog open={toolDialog !== null} onOpenChange={(open) => { if (!open) setToolDialog(null); }}><DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{text(`${toolDialog?.serverName ?? "MCP"} 的工具`, `${toolDialog?.serverName ?? "MCP"} tools`)}</DialogTitle><DialogDescription>{text("实时读取当前 MCP 服务器公开的工具名称和说明。", "Read the tool names and descriptions currently exposed by this MCP server.")}</DialogDescription></DialogHeader>{toolDialog?.tools.length === 0 ? <p className="py-6 text-sm text-muted-foreground">{text("当前没有可用工具。", "No tools are currently available.")}</p> : <div className="divide-y rounded-lg border">{toolDialog?.tools.map((tool) => <div key={tool.name} className="p-4"><code className="text-sm font-semibold">{tool.name}</code><p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{tool.description ?? text("暂无说明", "No description")}</p></div>)}</div>}</DialogContent></Dialog>
    {notice === "" ? null : <Alert><CheckCircle2 /><AlertTitle>{text("连接正常", "Connection healthy")}</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>}
    <Card><CardHeader className="flex-row items-start justify-between gap-4"><div><CardTitle>{text("MCP 服务器", "MCP servers")}</CardTitle><CardDescription className="mt-2">{text("每次运行开始前都会检查所有已启用的 MCP。", "Every enabled MCP server is checked before each run.")}</CardDescription></div><Button asChild><Link to={`/agents/${id}/mcp/new`}><Plus />{text("新建 MCP", "New MCP server")}</Link></Button></CardHeader>
      <CardContent className="flex flex-col gap-4"><Field><FieldLabel htmlFor="check-session">{text("检查使用的会话", "Session used for checks")}</FieldLabel><NativeSelect id="check-session" className="max-w-sm" value={checkSessionId} onChange={(event) => setCheckSessionId(event.target.value)}><NativeSelectOption value="">{text("不使用会话参数", "Do not use session parameters")}</NativeSelectOption>{sessions.map((session) => <NativeSelectOption key={session.id} value={session.id}>{session.title}</NativeSelectOption>)}</NativeSelect><FieldDescription>{text("只有 MCP 引用了会话参数时才需要选择。", "Select a session only when the MCP configuration references session parameters.")}</FieldDescription></Field>{servers === null ? <Skeleton className="h-36" /> : servers.length === 0 ? <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">{text("尚未配置 MCP。", "No MCP servers configured.")}</div> : <div className="divide-y rounded-lg border">{servers.map((server) => <div key={server.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><Link className="font-medium hover:underline" to={`/agents/${id}/mcp/${server.id}`}>{server.name}</Link><Badge variant="outline">{server.transport.toUpperCase()}</Badge><Badge variant={server.enabled ? "default" : "secondary"}>{server.enabled ? text("已启用", "Enabled") : text("已停用", "Disabled")}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{server.lastCheckStatus === null ? text("尚未检查", "Not checked") : server.lastCheckStatus === "passed" ? <>{text("最近检查通过 · ", "Last check passed · ")}<button type="button" className="font-medium underline underline-offset-4 hover:text-foreground" aria-label={text(`查看 ${server.lastToolCount ?? 0} 个工具`, `View ${server.lastToolCount ?? 0} tools`)} disabled={busy !== ""} onClick={() => void showTools(server)}>{text(`${server.lastToolCount ?? 0} 个工具`, `${server.lastToolCount ?? 0} tools`)}</button></> : text("最近检查失败", "Last check failed")}</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy !== ""} onClick={() => void toggle(server)}>{server.enabled ? text("停用", "Disable") : text("启用", "Enable")}</Button><Button variant="outline" size="sm" disabled={busy !== ""} onClick={() => void check(server)}><RefreshCw className={busy === `check-${server.id}` ? "animate-spin" : ""} />{text("检查连接", "Check connection")}</Button><AlertDialog><AlertDialogTrigger asChild><Button variant="ghost" size="sm" disabled={busy !== ""} aria-label={text(`删除 ${server.name}`, `Delete ${server.name}`)}><Trash2 />{text("删除", "Delete")}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{text(`删除“${server.name}”？`, `Delete “${server.name}”?`)}</AlertDialogTitle><AlertDialogDescription>{text("仅删除当前配置只影响当前智能体；从所有智能体删除会同时删除共享源和全部副本。", "Deleting only the current configuration affects this agent. Deleting from all agents also removes the shared source and every copy.")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{text("取消", "Cancel")}</AlertDialogCancel><AlertDialogAction variant="outline" onClick={() => void remove(server, "current")}>{text("仅删除当前", "Current agent only")}</AlertDialogAction><AlertDialogAction variant="destructive" onClick={() => void remove(server, "all")}>{text("从所有智能体删除", "Delete from all agents")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div></div>)}</div>}</CardContent>
    </Card>
    <Card><CardHeader><CardTitle>{text("可添加的 MCP", "Available MCP servers")}</CardTitle><CardDescription>{text("其他智能体创建的 MCP。添加后配置独立，可单独编辑或停用。", "MCP servers created by other agents. Installed copies can be edited or disabled independently.")}</CardDescription></CardHeader><CardContent>{catalog === null ? <Skeleton className="h-24" /> : catalog.length === 0 ? <div className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">{text("所有共享 MCP 均已添加。", "All shared MCP servers are installed.")}</div> : <div className="divide-y rounded-lg border">{catalog.map((server) => <div key={server.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><p className="font-medium">{server.name}</p><Badge variant="outline">{server.transport.toUpperCase()}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{text(`来自 ${server.sourceAgentName}`, `From ${server.sourceAgentName}`)}</p></div><Button size="sm" disabled={busy !== ""} aria-label={text(`添加并启用 ${server.name}`, `Install and enable ${server.name}`)} onClick={() => void install(server)}><Plus />{text("添加并启用", "Install and enable")}</Button></div>)}</div>}</CardContent></Card>
  </div>;
};

type ValueSource = "fixed" | "session_parameter" | "runtime";
type ValueDraft = {
  id?: number; name?: string; source: ValueSource; value: string; secret: boolean;
  parameterKey: string; runtimeKey: NonNullable<McpValueView["runtimeKey"]>;
};
const emptyValue = (named: boolean): ValueDraft => ({
  ...(named ? { name: "" } : {}), source: "fixed", value: "", secret: false,
  parameterKey: "", runtimeKey: "session_id"
});
const toDraft = (item: McpValueView): ValueDraft => ({
  id: item.id, ...(item.name === undefined ? {} : { name: item.name }), source: item.source,
  value: item.value ?? "", secret: item.secret === true, parameterKey: item.parameterKey ?? "",
  runtimeKey: item.runtimeKey ?? "session_id"
});
const toInput = (item: ValueDraft) => ({
  ...(item.id === undefined ? {} : { id: item.id }), ...(item.name === undefined ? {} : { name: item.name }),
  ...(item.source === "fixed"
    ? { source: "fixed" as const, ...(item.value === "" && item.id !== undefined ? {} : { value: item.value }), secret: item.secret }
    : item.source === "session_parameter"
      ? { source: "session_parameter" as const, parameterKey: item.parameterKey }
      : { source: "runtime" as const, runtimeKey: item.runtimeKey })
});

const ValueRows = ({ label, named, values, parameters, onChange }: {
  label: "Header" | "Argument" | "Environment";
  named: boolean;
  values: ValueDraft[];
  parameters: AgentSessionParameter[];
  onChange: (values: ValueDraft[]) => void;
}) => {
  const { text } = useI18n();
  const displayLabel = ({ Header: text("请求头", "Header"), Argument: text("参数", "Argument"), Environment: text("环境变量", "Environment variable") } as const)[label];
  const runtimeOptions: Array<{ key: ValueDraft["runtimeKey"]; label: string }> = [
    { key: "agent_id", label: text("智能体 ID", "Agent ID") }, { key: "session_id", label: text("会话 ID", "Session ID") },
    { key: "run_id", label: text("运行 ID", "Run ID") }, { key: "workspace_path", label: text("工作区路径", "Workspace path") },
    { key: "browser_profile_path", label: text("浏览器配置路径", "Browser profile path") }
  ];
  const update = (index: number, patch: Partial<ValueDraft>) =>
    onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  return <div className="flex flex-col gap-3">{values.map((item, index) => <div key={item.id ?? index} className="grid gap-3 rounded-lg border p-3 md:grid-cols-2">
    {named ? <Field><FieldLabel htmlFor={`${label}-name-${index}`}>{text(`${displayLabel}名称 ${index + 1}`, `${displayLabel} name ${index + 1}`)}</FieldLabel><Input id={`${label}-name-${index}`} value={item.name ?? ""} onChange={(event) => update(index, { name: event.target.value })} /></Field> : null}
    <Field><FieldLabel htmlFor={`${label}-source-${index}`}>{text(`${displayLabel}来源 ${index + 1}`, `${displayLabel} source ${index + 1}`)}</FieldLabel><NativeSelect id={`${label}-source-${index}`} className="w-full" value={item.source} onChange={(event) => update(index, { source: event.target.value as ValueSource })}><NativeSelectOption value="fixed">{text("固定值", "Fixed value")}</NativeSelectOption><NativeSelectOption value="session_parameter">{text("会话参数", "Session parameter")}</NativeSelectOption><NativeSelectOption value="runtime">{text("运行参数", "Runtime value")}</NativeSelectOption></NativeSelect></Field>
    {item.source === "fixed" ? <Field><FieldLabel htmlFor={`${label}-value-${index}`}>{text(`${displayLabel}值 ${index + 1}`, `${displayLabel} value ${index + 1}`)}</FieldLabel><Input id={`${label}-value-${index}`} type={item.secret ? "password" : "text"} value={item.value} placeholder={item.id === undefined ? "" : text("留空保持原敏感值", "Leave blank to keep the current secret")} onChange={(event) => update(index, { value: event.target.value })} /></Field> : item.source === "session_parameter" ? <Field><FieldLabel htmlFor={`${label}-parameter-${index}`}>{text(`${displayLabel}会话参数 ${index + 1}`, `${displayLabel} session parameter ${index + 1}`)}</FieldLabel><NativeSelect id={`${label}-parameter-${index}`} className="w-full" value={item.parameterKey} onChange={(event) => update(index, { parameterKey: event.target.value })}><NativeSelectOption value="">{text("请选择", "Select")}</NativeSelectOption>{parameters.map((parameter) => <NativeSelectOption key={parameter.id} value={parameter.key}>{parameter.label} ({parameter.key})</NativeSelectOption>)}</NativeSelect></Field> : <Field><FieldLabel htmlFor={`${label}-runtime-${index}`}>{text(`${displayLabel}运行参数 ${index + 1}`, `${displayLabel} runtime value ${index + 1}`)}</FieldLabel><NativeSelect id={`${label}-runtime-${index}`} className="w-full" value={item.runtimeKey} onChange={(event) => update(index, { runtimeKey: event.target.value as ValueDraft["runtimeKey"] })}>{runtimeOptions.map((option) => <NativeSelectOption key={option.key} value={option.key}>{option.label}</NativeSelectOption>)}</NativeSelect></Field>}
    <div className="flex items-end justify-between gap-3">{item.source === "fixed" ? <label className="flex items-center gap-2 pb-2 text-sm"><input aria-label={text(`${displayLabel} 敏感值 ${index + 1}`, `${displayLabel} secret ${index + 1}`)} type="checkbox" checked={item.secret} onChange={(event) => update(index, { secret: event.target.checked })} />{text("敏感值", "Secret")}</label> : <span />}<Button type="button" variant="ghost" size="icon-sm" aria-label={text(`删除 ${displayLabel} ${index + 1}`, `Delete ${displayLabel} ${index + 1}`)} onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}><Trash2 /></Button></div>
  </div>)}<Button type="button" variant="outline" onClick={() => onChange([...values, emptyValue(named)])}><Plus />{text(`添加${displayLabel}`, `Add ${displayLabel.toLowerCase()}`)}</Button></div>;
};

export const AgentMcpEditorPage = () => {
  const { text } = useI18n();
  const { id = "", mcpServerId } = useParams();
  const navigate = useNavigate();
  const editing = mcpServerId !== undefined;
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("npx");
  const [headers, setHeaders] = useState<ValueDraft[]>([]);
  const [argumentsList, setArgumentsList] = useState<ValueDraft[]>([]);
  const [environment, setEnvironment] = useState<ValueDraft[]>([]);
  const [parameters, setParameters] = useState<AgentSessionParameter[]>([]);
  const [timeout, setTimeoutValue] = useState("30");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api<AgentSessionParameter[]>(`/agents/${id}/session-parameters`, { signal: controller.signal })
      .then(setParameters).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    if (!editing) return () => controller.abort();
    void api<AgentMcpServerDetail>(`/agents/${id}/mcp-servers/${mcpServerId}`, { signal: controller.signal }).then((server) => {
      setName(server.name); setTransport(server.transport); setTimeoutValue(String(server.checkTimeoutSeconds)); setEnabled(server.enabled);
      if (server.transport === "http") {
        setUrl(server.url);
        setHeaders(server.headers.map(toDraft));
      } else {
        setCommand(server.command);
        setArgumentsList(server.arguments.map(toDraft));
        setEnvironment(server.environment.map(toDraft));
      }
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [editing, id, mcpServerId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    const checkTimeoutSeconds = Number(timeout);
    const body = transport === "http" ? {
      name, transport, enabled, url, checkTimeoutSeconds,
      headers: headers.map(toInput)
    } : {
      name, transport, enabled, command, checkTimeoutSeconds,
      arguments: argumentsList.map(toInput),
      environment: environment.map(toInput)
    };
    try {
      await api(`/agents/${id}/mcp-servers${editing ? `/${mcpServerId}` : ""}`, {
        method: editing ? "PATCH" : "POST", body: JSON.stringify(body)
      });
      navigate(`/agents/${id}/mcp`);
    } catch (reason) { setError(errorMessage(reason)); setBusy(false); }
  };
  const remove = async () => {
    if (!editing) return;
    setBusy(true); setError("");
    try { await api(`/agents/${id}/mcp-servers/${mcpServerId}`, { method: "DELETE" }); navigate(`/agents/${id}/mcp`); }
    catch (reason) { setError(errorMessage(reason)); setBusy(false); }
  };

  return <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8"><Button variant="ghost" asChild className="mb-4"><Link to={`/agents/${id}/mcp`}><ArrowLeft />{text("返回 MCP", "Back to MCP")}</Link></Button><PageHeader eyebrow={text("模型上下文协议", "MODEL CONTEXT PROTOCOL")} title={editing ? text("编辑 MCP", "Edit MCP server") : text("新建 MCP", "New MCP server")} description={text("HTTP 用于远程服务；stdio 用于服务器本机命令。", "Use HTTP for remote services and stdio for commands on this server.")} /><ErrorAlert message={error} /><Card><CardHeader><CardTitle>{text("连接配置", "Connection configuration")}</CardTitle></CardHeader><CardContent><form onSubmit={submit}><FieldGroup>
    <Field><FieldLabel htmlFor="mcp-name">{text("MCP 名称", "MCP name")}</FieldLabel><Input id="mcp-name" value={name} onChange={(event) => setName(event.target.value)} /></Field>
    <Field><FieldLabel htmlFor="mcp-transport">{text("传输方式", "Transport")}</FieldLabel><NativeSelect id="mcp-transport" className="w-full" value={transport} disabled={editing} onChange={(event) => setTransport(event.target.value as "http" | "stdio")}><NativeSelectOption value="http">HTTP</NativeSelectOption><NativeSelectOption value="stdio">stdio</NativeSelectOption></NativeSelect></Field>
    {transport === "http" ? <><Field><FieldLabel htmlFor="mcp-url">{text("HTTP 地址", "HTTP URL")}</FieldLabel><Input id="mcp-url" value={url} onChange={(event) => setUrl(event.target.value)} /></Field><ValueRows label="Header" named values={headers} parameters={parameters} onChange={setHeaders} /></> : <><Field><FieldLabel htmlFor="mcp-command">{text("命令", "Command")}</FieldLabel><Input id="mcp-command" value={command} required onChange={(event) => setCommand(event.target.value)} /></Field><ValueRows label="Argument" named={false} values={argumentsList} parameters={parameters} onChange={setArgumentsList} /><ValueRows label="Environment" named values={environment} parameters={parameters} onChange={setEnvironment} /></>}
    <Field><FieldLabel htmlFor="mcp-timeout">{text("检查超时（秒）", "Check timeout (seconds)")}</FieldLabel><Input id="mcp-timeout" type="number" min="1" max="300" value={timeout} onChange={(event) => setTimeoutValue(event.target.value)} /></Field><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{text("启用 MCP", "Enable MCP")}</label><div className="flex justify-between"><div>{editing ? <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}><Trash2 />{text("删除", "Delete")}</Button> : null}</div><div className="flex gap-2"><Button type="button" variant="outline" asChild><Link to={`/agents/${id}/mcp`}>{text("取消", "Cancel")}</Link></Button><Button type="submit" disabled={busy || name.trim() === "" || (transport === "stdio" && command.trim() === "")}>{editing ? text("保存 MCP", "Save MCP") : text("创建 MCP", "Create MCP")}</Button></div></div>
  </FieldGroup></form></CardContent></Card></div>;
};
