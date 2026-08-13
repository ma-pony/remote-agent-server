import { FormEvent, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, Plus, RefreshCw, Trash2, XCircle } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";

import {
  api, errorMessage, type AgentMcpServerDetail, type AgentMcpServerSummary,
  type AgentSessionParameter, type McpValueView, type Session
} from "@/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";

const ErrorAlert = ({ message }: { message: string }) => message === "" ? null : (
  <Alert variant="destructive"><XCircle /><AlertTitle>操作失败</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>
);

export const AgentMcpPage = () => {
  const { id = "" } = useParams();
  const [servers, setServers] = useState<AgentMcpServerSummary[] | null>(null);
  const [parameters, setParameters] = useState<AgentSessionParameter[] | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [checkSessionId, setCheckSessionId] = useState("");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [required, setRequired] = useState(false);
  const [secret, setSecret] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = () => Promise.all([
    api<AgentMcpServerSummary[]>(`/agents/${id}/mcp-servers`),
    api<AgentSessionParameter[]>(`/agents/${id}/session-parameters`),
    api<Session[]>("/sessions")
  ]).then(([serverItems, parameterItems, sessionItems]) => {
    setServers(serverItems); setParameters(parameterItems); setSessions(sessionItems.filter((item) => item.agentId === id));
  });
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api<AgentMcpServerSummary[]>(`/agents/${id}/mcp-servers`, { signal: controller.signal }),
      api<AgentSessionParameter[]>(`/agents/${id}/session-parameters`, { signal: controller.signal }),
      api<Session[]>("/sessions", { signal: controller.signal })
    ]).then(([serverItems, parameterItems, sessionItems]) => {
      setServers(serverItems); setParameters(parameterItems); setSessions(sessionItems.filter((item) => item.agentId === id));
    })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [id]);

  const check = async (server: AgentMcpServerSummary) => {
    setBusy(`check-${server.id}`); setError(""); setNotice("");
    try {
      const result = await api<{ status: "passed" | "failed"; toolCount?: number; message: string }>(
        `/agents/${id}/mcp-servers/${server.id}/check`, {
          method: "POST", body: checkSessionId === "" ? undefined : JSON.stringify({ sessionId: checkSessionId })
        }
      );
      setNotice(result.status === "passed" ? `${result.toolCount ?? 0} 个工具可用` : result.message);
      await load();
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };
  const createParameter = async (event: FormEvent) => {
    event.preventDefault();
    if (key.trim() === "" || label.trim() === "") return;
    setBusy("parameter"); setError("");
    try {
      const created = await api<AgentSessionParameter>(`/agents/${id}/session-parameters`, {
        method: "POST",
        body: JSON.stringify({ key: key.trim(), label: label.trim(), description: null, required, secret })
      });
      setParameters((items) => [...(items ?? []), created]);
      setKey(""); setLabel(""); setRequired(false); setSecret(false);
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };
  const removeParameter = async (parameterId: string) => {
    setBusy(`parameter-${parameterId}`); setError("");
    try {
      await api(`/agents/${id}/session-parameters/${parameterId}`, { method: "DELETE" });
      setParameters((items) => (items ?? []).filter((item) => item.id !== parameterId));
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };

  return <div className="flex flex-col gap-6"><ErrorAlert message={error} />
    {notice === "" ? null : <Alert><CheckCircle2 /><AlertTitle>连接正常</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>}
    <Card><CardHeader className="flex-row items-start justify-between gap-4"><div><CardTitle>MCP 服务器</CardTitle><CardDescription className="mt-2">每次 Run 开始前都会检查所有已启用 MCP。</CardDescription></div><Button asChild><Link to={`/agents/${id}/mcp/new`}><Plus />新建 MCP</Link></Button></CardHeader>
      <CardContent className="flex flex-col gap-4"><Field><FieldLabel htmlFor="check-session">检查使用的 Session</FieldLabel><NativeSelect id="check-session" className="max-w-sm" value={checkSessionId} onChange={(event) => setCheckSessionId(event.target.value)}><NativeSelectOption value="">不使用 Session 参数</NativeSelectOption>{sessions.map((session) => <NativeSelectOption key={session.id} value={session.id}>{session.title}</NativeSelectOption>)}</NativeSelect><FieldDescription>只有 MCP 引用了 Session 参数时才需要选择。</FieldDescription></Field>{servers === null ? <Skeleton className="h-36" /> : servers.length === 0 ? <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">尚未配置 MCP。</div> : <div className="divide-y rounded-lg border">{servers.map((server) => <div key={server.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><Link className="font-medium hover:underline" to={`/agents/${id}/mcp/${server.id}`}>{server.name}</Link><Badge variant="outline">{server.transport.toUpperCase()}</Badge><Badge variant={server.enabled ? "default" : "secondary"}>{server.enabled ? "已启用" : "已停用"}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{server.lastCheckStatus === null ? "尚未检查" : server.lastCheckStatus === "passed" ? `最近检查通过 · ${server.lastToolCount ?? 0} 个工具` : "最近检查失败"}</p></div><Button variant="outline" size="sm" disabled={busy !== ""} onClick={() => void check(server)}><RefreshCw className={busy === `check-${server.id}` ? "animate-spin" : ""} />检查连接</Button></div>)}</div>}</CardContent>
    </Card>
    <Card><CardHeader><CardTitle>Session 参数</CardTitle><CardDescription>声明可由不同 Session 提供的值，再在 MCP Header、Argument 或 Environment 中引用。</CardDescription></CardHeader><CardContent className="flex flex-col gap-5">
      {parameters === null ? <Skeleton className="h-24" /> : parameters.length === 0 ? <p className="text-sm text-muted-foreground">暂无 Session 参数。</p> : <div className="divide-y rounded-lg border">{parameters.map((parameter) => <div key={parameter.id} className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"><Field><FieldLabel htmlFor={`label-${parameter.id}`}>显示名称</FieldLabel><Input id={`label-${parameter.id}`} value={parameter.label} readOnly /></Field><div className="pb-2 text-sm"><code>{parameter.key}</code> · {parameter.required ? "必填" : "可选"} · {parameter.secret ? "敏感" : "普通"}</div><Button aria-label={`删除参数 ${parameter.label}`} variant="ghost" size="icon-sm" disabled={busy !== ""} onClick={() => void removeParameter(parameter.id)}><Trash2 /></Button></div>)}</div>}
      <form className="rounded-lg border bg-muted/20 p-4" onSubmit={createParameter}><FieldGroup><div className="grid gap-4 md:grid-cols-2"><Field><FieldLabel htmlFor="parameter-label">显示名称</FieldLabel><Input id="parameter-label" value={label} onChange={(event) => setLabel(event.target.value)} /></Field><Field><FieldLabel htmlFor="parameter-key">参数 Key</FieldLabel><Input id="parameter-key" value={key} onChange={(event) => setKey(event.target.value)} placeholder="tenant_id" /></Field></div><div className="flex flex-wrap gap-5 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />必填</label><label className="flex items-center gap-2"><input type="checkbox" checked={secret} onChange={(event) => setSecret(event.target.checked)} />敏感值</label></div><Button type="submit" variant="outline" disabled={busy !== "" || key.trim() === "" || label.trim() === ""}>添加 Session 参数</Button></FieldGroup></form>
    </CardContent></Card>
  </div>;
};

type ValueSource = "fixed" | "session_parameter" | "runtime";
type ValueDraft = {
  id?: string; name?: string; source: ValueSource; value: string; secret: boolean;
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

const runtimeOptions: Array<{ key: ValueDraft["runtimeKey"]; label: string }> = [
  { key: "agent_id", label: "Agent ID" }, { key: "session_id", label: "Session ID" },
  { key: "run_id", label: "Run ID" }, { key: "workspace_path", label: "Workspace 路径" },
  { key: "browser_profile_path", label: "浏览器 Profile 路径" }
];

const ValueRows = ({ label, named, values, parameters, onChange }: {
  label: "Header" | "Argument" | "Environment";
  named: boolean;
  values: ValueDraft[];
  parameters: AgentSessionParameter[];
  onChange: (values: ValueDraft[]) => void;
}) => {
  const update = (index: number, patch: Partial<ValueDraft>) =>
    onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  return <div className="flex flex-col gap-3">{values.map((item, index) => <div key={item.id ?? index} className="grid gap-3 rounded-lg border p-3 md:grid-cols-2">
    {named ? <Field><FieldLabel htmlFor={`${label}-name-${index}`}>{label} 名称 {index + 1}</FieldLabel><Input id={`${label}-name-${index}`} value={item.name ?? ""} onChange={(event) => update(index, { name: event.target.value })} /></Field> : null}
    <Field><FieldLabel htmlFor={`${label}-source-${index}`}>{label} 来源 {index + 1}</FieldLabel><NativeSelect id={`${label}-source-${index}`} className="w-full" value={item.source} onChange={(event) => update(index, { source: event.target.value as ValueSource })}><NativeSelectOption value="fixed">固定值</NativeSelectOption><NativeSelectOption value="session_parameter">Session 参数</NativeSelectOption><NativeSelectOption value="runtime">运行参数</NativeSelectOption></NativeSelect></Field>
    {item.source === "fixed" ? <Field><FieldLabel htmlFor={`${label}-value-${index}`}>{label} 值 {index + 1}</FieldLabel><Input id={`${label}-value-${index}`} type={item.secret ? "password" : "text"} value={item.value} placeholder={item.id === undefined ? "" : "留空保持原敏感值"} onChange={(event) => update(index, { value: event.target.value })} /></Field> : item.source === "session_parameter" ? <Field><FieldLabel htmlFor={`${label}-parameter-${index}`}>{label} Session 参数 {index + 1}</FieldLabel><NativeSelect id={`${label}-parameter-${index}`} className="w-full" value={item.parameterKey} onChange={(event) => update(index, { parameterKey: event.target.value })}><NativeSelectOption value="">请选择</NativeSelectOption>{parameters.map((parameter) => <NativeSelectOption key={parameter.id} value={parameter.key}>{parameter.label} ({parameter.key})</NativeSelectOption>)}</NativeSelect></Field> : <Field><FieldLabel htmlFor={`${label}-runtime-${index}`}>{label} 运行参数 {index + 1}</FieldLabel><NativeSelect id={`${label}-runtime-${index}`} className="w-full" value={item.runtimeKey} onChange={(event) => update(index, { runtimeKey: event.target.value as ValueDraft["runtimeKey"] })}>{runtimeOptions.map((option) => <NativeSelectOption key={option.key} value={option.key}>{option.label}</NativeSelectOption>)}</NativeSelect></Field>}
    <div className="flex items-end justify-between gap-3">{item.source === "fixed" ? <label className="flex items-center gap-2 pb-2 text-sm"><input aria-label={`${label} 敏感值 ${index + 1}`} type="checkbox" checked={item.secret} onChange={(event) => update(index, { secret: event.target.checked })} />敏感值</label> : <span />}<Button type="button" variant="ghost" size="icon-sm" aria-label={`删除 ${label} ${index + 1}`} onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}><Trash2 /></Button></div>
  </div>)}<Button type="button" variant="outline" onClick={() => onChange([...values, emptyValue(named)])}><Plus />添加 {label}</Button></div>;
};

export const AgentMcpEditorPage = () => {
  const { id = "", mcpServerId } = useParams();
  const navigate = useNavigate();
  const editing = mcpServerId !== undefined;
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
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

  return <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8"><Button variant="ghost" asChild className="mb-4"><Link to={`/agents/${id}/mcp`}><ArrowLeft />返回 MCP</Link></Button><PageHeader eyebrow="MODEL CONTEXT PROTOCOL" title={editing ? "编辑 MCP" : "新建 MCP"} description="HTTP 用于远程服务；stdio 用于服务器本机命令。" /><ErrorAlert message={error} /><Card><CardHeader><CardTitle>连接配置</CardTitle></CardHeader><CardContent><form onSubmit={submit}><FieldGroup>
    <Field><FieldLabel htmlFor="mcp-name">MCP 名称</FieldLabel><Input id="mcp-name" value={name} onChange={(event) => setName(event.target.value)} /></Field>
    <Field><FieldLabel htmlFor="mcp-transport">Transport</FieldLabel><NativeSelect id="mcp-transport" className="w-full" value={transport} disabled={editing} onChange={(event) => setTransport(event.target.value as "http" | "stdio")}><NativeSelectOption value="http">HTTP</NativeSelectOption><NativeSelectOption value="stdio">stdio</NativeSelectOption></NativeSelect></Field>
    {transport === "http" ? <><Field><FieldLabel htmlFor="mcp-url">HTTP URL</FieldLabel><Input id="mcp-url" value={url} onChange={(event) => setUrl(event.target.value)} /></Field><ValueRows label="Header" named values={headers} parameters={parameters} onChange={setHeaders} /></> : <><Field><FieldLabel htmlFor="mcp-command">Command</FieldLabel><Input id="mcp-command" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" /></Field><ValueRows label="Argument" named={false} values={argumentsList} parameters={parameters} onChange={setArgumentsList} /><ValueRows label="Environment" named values={environment} parameters={parameters} onChange={setEnvironment} /></>}
    <Field><FieldLabel htmlFor="mcp-timeout">检查超时（秒）</FieldLabel><Input id="mcp-timeout" type="number" min="1" max="300" value={timeout} onChange={(event) => setTimeoutValue(event.target.value)} /></Field><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用 MCP</label><div className="flex justify-between"><div>{editing ? <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}><Trash2 />删除</Button> : null}</div><div className="flex gap-2"><Button type="button" variant="outline" asChild><Link to={`/agents/${id}/mcp`}>取消</Link></Button><Button type="submit" disabled={busy || name.trim() === ""}>{editing ? "保存 MCP" : "创建 MCP"}</Button></div></div>
  </FieldGroup></form></CardContent></Card></div>;
};
