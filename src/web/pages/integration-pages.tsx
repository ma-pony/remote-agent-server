import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, Cable, Check, Clipboard, KeyRound, Plus, RefreshCw, RotateCcw, Settings2,
  Trash2, Webhook, XCircle
} from "lucide-react";
import { Link, Outlet, useLocation, useNavigate, useOutletContext, useParams } from "react-router";

import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  api, errorMessage, integrationApi, type Agent, type AgentSessionParameter,
  type IntegrationConversation, type IntegrationEndpoint, type IntegrationEndpointSummary,
  type IntegrationParameterMappingInput, type IntegrationParameterMappingUpdateInput, type IntegrationTask, type IntegrationTaskStatus,
  type IntegrationWebhook, type IntegrationWebhookInput, type RunEvent, type WebhookDelivery,
  type WebhookEventType
} from "@/api";

const displayTime = (value: string | null): string => value === null ? "—" : new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
}).format(new Date(value));

const taskStatusText: Record<IntegrationTaskStatus, string> = {
  queued: "排队中", running: "运行中", succeeded: "已完成", failed: "失败", cancelled: "已取消"
};

const StatusBadge = ({ status }: { status: IntegrationTaskStatus }) => <Badge variant={
  status === "succeeded" ? "default" : status === "failed" ? "destructive" : status === "running" ? "secondary" : "outline"
}>{taskStatusText[status]}</Badge>;

const ErrorAlert = ({ message }: { message: string }) => message === "" ? null : (
  <Alert variant="destructive"><XCircle /><AlertTitle>操作失败</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>
);

const OneTimeSecret = ({ title, value, onDismiss }: { title: string; value: string; onDismiss(): void }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(value);
    setCopied(true);
  };
  return <Alert className="border-primary/40 bg-primary/5"><KeyRound /><AlertTitle>{title}</AlertTitle>
    <AlertDescription className="mt-3 flex flex-col gap-3">
      <code className="break-all rounded-md border bg-background p-3 text-xs text-foreground">{value}</code>
      <div className="flex flex-wrap gap-2"><Button type="button" size="sm" onClick={() => void copy()}>{copied ? <Check /> : <Clipboard />}{copied ? "已复制" : "复制"}</Button><Button type="button" size="sm" variant="ghost" onClick={onDismiss}>我已保存</Button></div>
    </AlertDescription>
  </Alert>;
};

export const IntegrationEndpointListPage = () => {
  const [endpoints, setEndpoints] = useState<IntegrationEndpointSummary[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([integrationApi.listEndpoints(controller.signal), api<Agent[]>("/agents", { signal: controller.signal })])
      .then(([items, agentItems]) => { setEndpoints(items); setAgents(agentItems); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, []);
  const agentNames = useMemo(() => new Map(agents.map((item) => [item.id, item.name])), [agents]);
  return <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
    <PageHeader eyebrow="EXTERNAL CONNECTIONS" title="接入端点" description="为外部系统提供稳定的 Agent 调用入口，调用方无需了解内部 Provider、Session 和 Run。" action={<Button asChild><Link to="/integration-endpoints/new"><Plus />新建接入端点</Link></Button>} />
    <ErrorAlert message={error} />
    {endpoints === null ? <div className="grid gap-4 lg:grid-cols-2">{[0, 1].map((item) => <Skeleton key={item} className="h-52" />)}</div>
      : endpoints.length === 0 ? <Card className="border-dashed"><CardContent className="py-16 text-center text-muted-foreground">暂无接入端点。创建后即可让外部系统安全提交任务。</CardContent></Card>
        : <div className="grid gap-4 lg:grid-cols-2">{endpoints.map((endpoint) => <Card key={endpoint.id} className="overflow-hidden transition-colors hover:border-primary/50"><CardHeader className="border-b bg-muted/20"><div className="flex items-start justify-between gap-4"><div><CardTitle><Link className="hover:underline" to={`/integration-endpoints/${endpoint.id}`}>{endpoint.name}</Link></CardTitle><CardDescription className="mt-2 font-mono">/{endpoint.slug}</CardDescription></div><Badge variant={endpoint.enabled ? "default" : "secondary"}>{endpoint.enabled ? "已启用" : "已停用"}</Badge></div></CardHeader><CardContent className="grid gap-4 p-5 sm:grid-cols-3"><div><p className="text-xs text-muted-foreground">Agent</p><p className="mt-1 truncate text-sm font-medium">{agentNames.get(endpoint.agentId) ?? endpoint.agentId}</p></div><div><p className="text-xs text-muted-foreground">Active Conversation</p><p className="mt-1 font-mono text-xl">{endpoint.activeConversationCount}</p></div><div><p className="text-xs text-muted-foreground">排队 / 运行</p><p className="mt-1 font-mono text-xl">{endpoint.activeTaskCount}</p></div><div className="sm:col-span-3"><p className="text-xs text-muted-foreground">最近 Task</p>{endpoint.latestTask === null ? <p className="mt-1 text-sm">尚无调用</p> : <div className="mt-1 flex items-center justify-between gap-3"><Link className="truncate text-sm font-medium hover:underline" to={`/integration-tasks/${endpoint.latestTask.id}`}>{endpoint.latestTask.requestId}</Link><StatusBadge status={endpoint.latestTask.status} /></div>}</div></CardContent></Card>)}</div>}
  </div>;
};

type MappingDraft = { source: "none" | "request" | "fixed"; requestKey: string; value: string; configured: boolean };
const initialMappingDrafts = (parameters: AgentSessionParameter[], endpoint?: IntegrationEndpoint): Record<string, MappingDraft> => Object.fromEntries(parameters.map((parameter) => {
  const mapping = endpoint?.parameterMappings.find((item) => item.parameterKey === parameter.key);
  if (mapping?.source === "request") return [parameter.key, { source: "request", requestKey: mapping.requestKey, value: "", configured: false }];
  if (mapping?.source === "fixed") return [parameter.key, { source: "fixed", requestKey: parameter.key, value: "", configured: mapping.configured }];
  return [parameter.key, { source: parameter.required ? "request" : "none", requestKey: parameter.key, value: "", configured: false }];
}));

const MappingFields = ({ parameters, drafts, onChange }: {
  parameters: AgentSessionParameter[];
  drafts: Record<string, MappingDraft>;
  onChange(key: string, value: MappingDraft): void;
}) => parameters.length === 0 ? <p className="text-sm text-muted-foreground">该 Agent 没有声明 Session 参数。</p> : <div className="flex flex-col gap-3">{parameters.map((parameter) => {
  const draft = drafts[parameter.key] ?? { source: "none", requestKey: parameter.key, value: "", configured: false };
  return <div key={parameter.id} className="grid gap-3 rounded-lg border p-4 md:grid-cols-[minmax(10rem,1fr)_10rem_minmax(12rem,1fr)]"><div><p className="font-medium">{parameter.label}{parameter.required ? " *" : ""}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{parameter.key}</p></div><Field><FieldLabel htmlFor={`mapping-source-${parameter.key}`}>{parameter.label} 来源</FieldLabel><NativeSelect id={`mapping-source-${parameter.key}`} value={draft.source} onChange={(event) => onChange(parameter.key, { ...draft, source: event.target.value as MappingDraft["source"] })}><NativeSelectOption value="none" disabled={parameter.required}>不传入</NativeSelectOption><NativeSelectOption value="request">请求参数</NativeSelectOption><NativeSelectOption value="fixed">固定值</NativeSelectOption></NativeSelect></Field>{draft.source === "request" ? <Field><FieldLabel htmlFor={`mapping-request-${parameter.key}`}>{parameter.label} 请求参数名</FieldLabel><Input id={`mapping-request-${parameter.key}`} value={draft.requestKey} onChange={(event) => onChange(parameter.key, { ...draft, requestKey: event.target.value })} /></Field> : draft.source === "fixed" ? <Field><FieldLabel htmlFor={`mapping-fixed-${parameter.key}`}>{parameter.label} 固定值</FieldLabel><Input id={`mapping-fixed-${parameter.key}`} type={parameter.secret ? "password" : "text"} value={draft.value} placeholder={draft.configured ? "已配置；留空保持不变" : "输入固定值"} onChange={(event) => onChange(parameter.key, { ...draft, value: event.target.value })} /><FieldDescription>{draft.configured ? "已配置" : "未配置"}</FieldDescription></Field> : <div className="self-center text-sm text-muted-foreground">外部请求不会设置该参数</div>}</div>;
})}</div>;

const mappingPayload = (parameters: AgentSessionParameter[], drafts: Record<string, MappingDraft>, preserve = false): IntegrationParameterMappingUpdateInput[] => parameters.flatMap<IntegrationParameterMappingUpdateInput>((parameter) => {
  const draft = drafts[parameter.key];
  if (draft === undefined || draft.source === "none") return [];
  if (draft.source === "request") return [{ parameterKey: parameter.key, source: "request" as const, requestKey: draft.requestKey.trim() }];
  return [{ parameterKey: parameter.key, source: "fixed" as const, ...(preserve && draft.configured && draft.value === "" ? {} : { value: draft.value }) }];
});

export const IntegrationEndpointCreatePage = () => {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [parameters, setParameters] = useState<AgentSessionParameter[]>([]);
  const [drafts, setDrafts] = useState<Record<string, MappingDraft>>({});
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [agentId, setAgentId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [promptPrefix, setPromptPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<Agent[]>("/agents", { signal: controller.signal }).then((items) => {
      const active = items.filter((item) => item.enabled);
      setAgents(active); setAgentId(active[0]?.id ?? "");
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (agentId === "") { setParameters([]); setDrafts({}); return; }
    const controller = new AbortController();
    void api<AgentSessionParameter[]>(`/agents/${agentId}/session-parameters`, { signal: controller.signal }).then((items) => {
      setParameters(items); setDrafts(initialMappingDrafts(items));
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [agentId]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const created = await integrationApi.createEndpoint({
        name: name.trim(), slug: slug.trim(), agentId, enabled, promptPrefix,
        parameterMappings: mappingPayload(parameters, drafts).map((mapping): IntegrationParameterMappingInput =>
          mapping.source === "request" ? mapping : { ...mapping, value: mapping.value ?? "" }
        )
      });
      navigate(`/integration-endpoints/${created.endpoint.id}`, { state: { oneTimeToken: created.token } });
    } catch (reason) { setError(errorMessage(reason)); setBusy(false); }
  };
  return <div className="mx-auto w-full max-w-4xl p-4 sm:p-6 lg:p-8"><Button variant="ghost" asChild className="mb-4"><Link to="/integration-endpoints"><ArrowLeft />返回接入端点</Link></Button><PageHeader eyebrow="NEW EXTERNAL CONNECTION" title="新建接入端点" description="端点绑定一个 Agent。外部调用方只能提交消息和声明过的请求参数。" /><ErrorAlert message={error} /><form className="flex flex-col gap-5" onSubmit={submit}><Card><CardHeader><CardTitle>基础信息</CardTitle><CardDescription>slug 会成为外部系统使用的稳定 URL 标识。</CardDescription></CardHeader><CardContent><FieldGroup><Field><FieldLabel htmlFor="endpoint-name">端点名称</FieldLabel><Input id="endpoint-name" required value={name} onChange={(event) => setName(event.target.value)} autoFocus /></Field><Field><FieldLabel htmlFor="endpoint-slug">端点 slug</FieldLabel><Input id="endpoint-slug" required pattern="[a-z0-9][a-z0-9-]{0,63}" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="grab-manager-ticket" /></Field><Field><FieldLabel htmlFor="endpoint-agent">Agent</FieldLabel><NativeSelect id="endpoint-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}><NativeSelectOption value="" disabled>请选择 Agent</NativeSelectOption>{agents.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect></Field><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />创建后立即启用</label></FieldGroup></CardContent></Card><Card><CardHeader><CardTitle>固定提示</CardTitle><CardDescription>每个 Task 的用户消息前都会加入这段提示。</CardDescription></CardHeader><CardContent><Field><FieldLabel htmlFor="prompt-prefix">提示内容</FieldLabel><Textarea id="prompt-prefix" value={promptPrefix} onChange={(event) => setPromptPrefix(event.target.value)} placeholder="可留空" /></Field></CardContent></Card><Card><CardHeader><CardTitle>参数映射</CardTitle><CardDescription>将外部请求参数或固定值映射到 Agent 的 MCP Session 参数。</CardDescription></CardHeader><CardContent><MappingFields parameters={parameters} drafts={drafts} onChange={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))} /></CardContent></Card><div className="flex justify-end gap-2"><Button variant="outline" asChild><Link to="/integration-endpoints">取消</Link></Button><Button type="submit" disabled={busy || agentId === ""}>{busy ? "创建中…" : "创建接入端点"}</Button></div></form></div>;
};

type EndpointContext = {
  endpoint: IntegrationEndpoint;
  agentName: string;
  agents: Agent[];
  setEndpoint(endpoint: IntegrationEndpoint): void;
};
const useEndpoint = () => useOutletContext<EndpointContext>();

export const IntegrationEndpointDetailLayout = () => {
  const { id = "" } = useParams();
  const location = useLocation();
  const [endpoint, setEndpoint] = useState<IntegrationEndpoint | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState("");
  const [oneTimeToken, setOneTimeToken] = useState(() => (location.state as { oneTimeToken?: string } | null)?.oneTimeToken ?? "");
  useEffect(() => {
    if ((location.state as { oneTimeToken?: string } | null)?.oneTimeToken !== undefined) {
      const state = window.history.state as Record<string, unknown> | null;
      window.history.replaceState(state === null ? null : { ...state, usr: null }, "", location.pathname);
    }
  }, [location.pathname, location.state]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([integrationApi.getEndpoint(id, controller.signal), api<Agent[]>("/agents", { signal: controller.signal })])
      .then(([item, agentItems]) => { setEndpoint(item); setAgents(agentItems); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [id]);
  if (endpoint === null) return <div className="mx-auto max-w-6xl p-8"><ErrorAlert message={error} /><Skeleton className="h-12 w-72" /><Skeleton className="mt-8 h-64" /></div>;
  const base = `/integration-endpoints/${id}`;
  const suffix = location.pathname.slice(base.length).replace(/^\//, "");
  const section = suffix === "" ? "overview" : suffix;
  const agentName = agents.find((item) => item.id === endpoint.agentId)?.name ?? endpoint.agentId;
  return <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8"><Button asChild variant="ghost" className="mb-4"><Link to="/integration-endpoints"><ArrowLeft />返回接入端点</Link></Button><PageHeader eyebrow="EXTERNAL CONNECTION" title={endpoint.name} description={`/${endpoint.slug} · ${agentName}`} action={<Badge variant={endpoint.enabled ? "default" : "secondary"}>{endpoint.enabled ? "已启用" : "已停用"}</Badge>} />{oneTimeToken === "" ? null : <div className="mb-6"><OneTimeSecret title="请立即保存，此 Token 不会再次显示" value={oneTimeToken} onDismiss={() => setOneTimeToken("")} /></div>}<Tabs value={section}><TabsList variant="line" aria-label="接入端点管理" className="max-w-full justify-start overflow-x-auto"><TabsTrigger value="overview" asChild><Link to={base}>概览</Link></TabsTrigger><TabsTrigger value="mappings" asChild><Link to={`${base}/mappings`}>参数映射</Link></TabsTrigger><TabsTrigger value="webhooks" asChild><Link to={`${base}/webhooks`}>Webhook</Link></TabsTrigger><TabsTrigger value="conversations" asChild><Link to={`${base}/conversations`}>Conversation</Link></TabsTrigger><TabsTrigger value="tasks" asChild><Link to={`${base}/tasks`}>Task</Link></TabsTrigger><TabsTrigger value="settings" asChild><Link to={`${base}/settings`}>设置</Link></TabsTrigger></TabsList></Tabs><div className="mt-6"><Outlet context={{ endpoint, agentName, agents, setEndpoint } satisfies EndpointContext} /></div></div>;
};

export const IntegrationEndpointOverviewPage = () => {
  const { endpoint, agentName } = useEndpoint();
  const [conversations, setConversations] = useState<IntegrationConversation[]>([]);
  const [tasks, setTasks] = useState<IntegrationTask[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([integrationApi.listConversations(endpoint.id, controller.signal), integrationApi.listTasks(endpoint.id, controller.signal)])
      .then(([conversationItems, taskItems]) => { setConversations(conversationItems); setTasks(taskItems); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [endpoint.id]);
  const latest = tasks.at(-1);
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Card><CardHeader><CardDescription>绑定 Agent</CardDescription><CardTitle className="text-lg">{agentName}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>Active Conversation</CardDescription><CardTitle className="font-mono text-3xl">{conversations.filter((item) => item.status === "active").length}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>排队 / 运行</CardDescription><CardTitle className="font-mono text-3xl">{tasks.filter((item) => item.status === "queued" || item.status === "running").length}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>最近 Task</CardDescription><CardTitle className="text-base">{latest === undefined ? "暂无" : <Link className="hover:underline" to={`/integration-tasks/${latest.id}`}>{latest.requestId}</Link>}</CardTitle></CardHeader></Card></div><Card><CardHeader><CardTitle className="flex items-center gap-2"><Cable className="size-5" />调用入口</CardTitle><CardDescription>外部系统使用独立 Token 调用此地址。</CardDescription></CardHeader><CardContent><code className="block break-all rounded-md border bg-muted/30 p-4 text-xs">POST /integration/v1/endpoints/{endpoint.slug}/tasks</code></CardContent></Card><Card><CardHeader><CardTitle>固定提示</CardTitle></CardHeader><CardContent className="whitespace-pre-wrap text-sm text-muted-foreground">{endpoint.promptPrefix === "" ? "未配置" : endpoint.promptPrefix}</CardContent></Card></div>;
};

export const IntegrationEndpointMappingsPage = () => {
  const { endpoint, setEndpoint } = useEndpoint();
  const [parameters, setParameters] = useState<AgentSessionParameter[]>([]);
  const [drafts, setDrafts] = useState<Record<string, MappingDraft>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<AgentSessionParameter[]>(`/agents/${endpoint.agentId}/session-parameters`, { signal: controller.signal })
      .then((items) => { setParameters(items); setDrafts(initialMappingDrafts(items, endpoint)); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [endpoint]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setSaved(false); setError("");
    try {
      const updated = await integrationApi.updateEndpoint(endpoint.id, { parameterMappings: mappingPayload(parameters, drafts, true) });
      setEndpoint(updated); setDrafts(initialMappingDrafts(parameters, updated)); setSaved(true);
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  };
  return <form className="flex flex-col gap-5" onSubmit={submit}><ErrorAlert message={error} />{saved ? <Alert><Check /><AlertTitle>参数映射已保存</AlertTitle><AlertDescription>新配置会用于之后创建的 Task；已排队 Task 继续使用自己的快照。</AlertDescription></Alert> : null}<Card><CardHeader><CardTitle>Session 参数映射</CardTitle><CardDescription>固定敏感值只展示配置状态。留空保存会保留原值。</CardDescription></CardHeader><CardContent><MappingFields parameters={parameters} drafts={drafts} onChange={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))} /></CardContent></Card><div className="flex justify-end"><Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存参数映射"}</Button></div></form>;
};

const webhookEvents: Array<{ value: WebhookEventType; label: string; group: string }> = [
  { value: "task.queued", label: "Task 已排队", group: "Task" },
  { value: "task.started", label: "Task 已开始", group: "Task" },
  { value: "task.succeeded", label: "Task 已完成", group: "Task" },
  { value: "task.failed", label: "Task 失败", group: "Task" },
  { value: "task.cancelled", label: "Task 已取消", group: "Task" },
  { value: "message.user.received", label: "收到用户消息", group: "Message" },
  { value: "message.agent.reply", label: "Agent 完整回复", group: "Message" },
  { value: "message.system.notice", label: "系统通知", group: "Message" },
  { value: "tool.started", label: "工具开始", group: "Tool" },
  { value: "tool.completed", label: "工具完成", group: "Tool" },
  { value: "tool.failed", label: "工具失败", group: "Tool" }
];

const DeliveryBadge = ({ status }: { status: WebhookDelivery["status"] }) => <Badge variant={
  status === "succeeded" ? "default" : status === "failed" ? "destructive" : "secondary"
}>{status === "succeeded" ? "成功" : status === "failed" ? "失败" : status === "delivering" ? "投递中" : "等待投递"}</Badge>;

const WebhookEditorDialog = ({ endpointId, onCreated, onError }: {
  endpointId: string;
  onCreated(webhook: IntegrationWebhook, secret: string): void;
  onError(message: string): void;
}) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEventType[]>([]);
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(10);
  const [busy, setBusy] = useState(false);
  const toggleEvent = (value: WebhookEventType) => setEvents((current) => current.includes(value)
    ? current.filter((item) => item !== value) : [...current, value]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (events.length === 0) return;
    setBusy(true); onError("");
    const headers = headerName.trim() === "" ? {} : { [headerName.trim()]: headerValue };
    const input: IntegrationWebhookInput = { name: name.trim(), url: url.trim(), enabled: true, events, headers, timeoutSeconds };
    try {
      const created = await integrationApi.createWebhook(endpointId, input);
      onCreated(created.webhook, created.signingSecret); setOpen(false);
      setName(""); setUrl(""); setEvents([]); setHeaderName(""); setHeaderValue(""); setTimeoutSeconds(10);
    } catch (reason) { onError(errorMessage(reason)); } finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button><Plus />新建 Webhook</Button></DialogTrigger><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><form onSubmit={submit}><DialogHeader><DialogTitle>新建 Webhook</DialogTitle><DialogDescription>固定使用 HTTP POST。签名密钥只会在创建成功后展示一次。</DialogDescription></DialogHeader><FieldGroup className="py-5"><Field><FieldLabel htmlFor="webhook-name">Webhook 名称</FieldLabel><Input id="webhook-name" required value={name} onChange={(event) => setName(event.target.value)} /></Field><Field><FieldLabel htmlFor="webhook-url">Webhook URL</FieldLabel><Input id="webhook-url" required type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/webhook" /></Field><Field><FieldLabel>订阅事件</FieldLabel><div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">{webhookEvents.map((item) => <label key={item.value} className="flex items-start gap-2 text-sm"><input aria-label={item.value} type="checkbox" checked={events.includes(item.value)} onChange={() => toggleEvent(item.value)} className="mt-0.5" /><span><span className="font-mono text-xs">{item.value}</span><span className="block text-xs text-muted-foreground">{item.label}</span></span></label>)}</div><FieldDescription>至少选择一个事件。Agent 思考内容不会通过 Webhook 外发。</FieldDescription></Field><div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="webhook-header-name">Header 名称（可选）</FieldLabel><Input id="webhook-header-name" value={headerName} onChange={(event) => setHeaderName(event.target.value)} placeholder="Authorization" /></Field><Field><FieldLabel htmlFor="webhook-header-value">Header 值</FieldLabel><Input id="webhook-header-value" type="password" value={headerValue} onChange={(event) => setHeaderValue(event.target.value)} autoComplete="off" /></Field></div><Field><FieldLabel htmlFor="webhook-timeout">超时秒数</FieldLabel><Input id="webhook-timeout" type="number" min={1} max={60} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} /></Field></FieldGroup><DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>取消</Button><Button type="submit" disabled={busy || events.length === 0}>{busy ? "创建中…" : "创建 Webhook"}</Button></DialogFooter></form></DialogContent></Dialog>;
};

export const IntegrationEndpointWebhooksPage = () => {
  const { endpoint } = useEndpoint();
  const [webhooks, setWebhooks] = useState<IntegrationWebhook[] | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [signingSecret, setSigningSecret] = useState("");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const load = async (signal?: AbortSignal) => {
    const [subscriptions, deliveryItems] = await Promise.all([
      integrationApi.listWebhooks(endpoint.id, signal), integrationApi.listDeliveries(endpoint.id, signal)
    ]);
    setWebhooks(subscriptions); setDeliveries(deliveryItems);
  };
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [endpoint.id]);
  const act = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id); setError("");
    try { await action(); await load(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusyId(""); }
  };
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} />{signingSecret === "" ? null : <OneTimeSecret title="请立即保存签名密钥，此后不会再次显示" value={signingSecret} onDismiss={() => setSigningSecret("")} />}<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-semibold">Webhook 订阅</h2><p className="text-sm text-muted-foreground">失败投递会自动重试；最终失败后可手动重发。</p></div><WebhookEditorDialog endpointId={endpoint.id} onError={setError} onCreated={(webhook, secret) => { setWebhooks((current) => [...(current ?? []), webhook]); setSigningSecret(secret); }} /></div>{webhooks === null ? <Skeleton className="h-40" /> : webhooks.length === 0 ? <Card className="border-dashed"><CardContent className="py-14 text-center text-muted-foreground">尚未配置 Webhook。</CardContent></Card> : <div className="flex flex-col gap-4">{webhooks.map((webhook) => {
    const recent = deliveries.find((item) => item.subscriptionId === webhook.id);
    return <Card key={webhook.id}><CardHeader className="border-b bg-muted/20"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><CardTitle className="flex items-center gap-2"><Webhook className="size-4" />{webhook.name}</CardTitle><CardDescription className="mt-2 break-all">{webhook.url}</CardDescription></div><Badge variant={webhook.enabled ? "default" : "secondary"}>{webhook.enabled ? "已启用" : "已停用"}</Badge></div></CardHeader><CardContent className="flex flex-col gap-4 p-5"><div className="flex flex-wrap gap-1">{webhook.events.map((item) => <Badge key={item} variant="outline" className="font-mono">{item}</Badge>)}</div><div className="grid gap-3 text-sm sm:grid-cols-4"><div><p className="text-xs text-muted-foreground">最近投递</p><p className="mt-1">{recent === undefined ? "等待首次投递" : <DeliveryBadge status={recent.status} />}</p></div><div><p className="text-xs text-muted-foreground">状态码</p><p className="mt-1 font-mono">{recent?.lastStatusCode ?? "—"}</p></div><div><p className="text-xs text-muted-foreground">尝试次数</p><p className="mt-1 font-mono">{recent?.attemptCount ?? 0}</p></div><div><p className="text-xs text-muted-foreground">时间</p><p className="mt-1">{displayTime(recent?.updatedAt ?? null)}</p></div></div>{recent?.lastError === null || recent === undefined ? null : <Alert variant="destructive"><XCircle /><AlertTitle>最近错误</AlertTitle><AlertDescription>{recent.lastError}</AlertDescription></Alert>}<div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busyId === webhook.id || !webhook.enabled} onClick={() => void act(webhook.id, () => integrationApi.testWebhook(endpoint.id, webhook.id))}><RefreshCw />发送测试</Button><Button size="sm" variant="outline" disabled={busyId === webhook.id} onClick={() => void act(webhook.id, () => integrationApi.updateWebhook(endpoint.id, webhook.id, { enabled: !webhook.enabled }))}>{webhook.enabled ? "停用" : "启用"}</Button><AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="ghost"><Trash2 />删除</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除“{webhook.name}”？</AlertDialogTitle><AlertDialogDescription>订阅和历史投递记录将被永久删除。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void act(webhook.id, () => integrationApi.deleteWebhook(endpoint.id, webhook.id))}>确认删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div></CardContent></Card>;
  })}</div>}<Card><CardHeader><CardTitle>最近投递</CardTitle><CardDescription>展示状态码、耗时、重试次数和脱敏错误。</CardDescription></CardHeader><CardContent>{deliveries.length === 0 ? <p className="text-sm text-muted-foreground">暂无投递记录。</p> : <div className="divide-y rounded-lg border">{deliveries.map((delivery) => <div key={delivery.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex items-center gap-2"><DeliveryBadge status={delivery.status} /><span className="font-mono text-xs">{delivery.eventType}</span></div><p className="mt-2 text-xs text-muted-foreground">HTTP {delivery.lastStatusCode ?? "—"} · {delivery.lastDurationMs ?? "—"} ms · 尝试 {delivery.attemptCount} 次 · {displayTime(delivery.updatedAt)}</p>{delivery.lastError === null ? null : <p className="mt-1 truncate text-xs text-destructive">{delivery.lastError}</p>}</div>{delivery.status === "failed" ? <Button size="sm" variant="outline" disabled={busyId === delivery.id} onClick={() => void act(delivery.id, () => integrationApi.retryDelivery(delivery.id))}><RotateCcw />手动重发</Button> : null}</div>)}</div>}</CardContent></Card></div>;
};

export const IntegrationConversationPage = () => {
  const { endpoint } = useEndpoint();
  const [items, setItems] = useState<IntegrationConversation[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { const controller = new AbortController(); void integrationApi.listConversations(endpoint.id, controller.signal).then(setItems).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); }); return () => controller.abort(); }, [endpoint.id]);
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} /><div><h2 className="text-lg font-semibold">Conversation</h2><p className="text-sm text-muted-foreground">外部 conversationKey 与长期 Session 的接续关系。</p></div>{items === null ? <Skeleton className="h-40" /> : items.length === 0 ? <Card className="border-dashed"><CardContent className="py-14 text-center text-muted-foreground">暂无 Conversation。</CardContent></Card> : <div className="divide-y rounded-xl border bg-card">{items.toReversed().map((item) => <div key={item.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-mono text-sm font-medium">{item.conversationKey}</p><p className="mt-1 text-xs text-muted-foreground">创建于 {displayTime(item.createdAt)}</p></div><div className="flex items-center gap-3"><Badge variant={item.status === "active" ? "default" : "secondary"}>{item.status === "active" ? "接续中" : "已结束"}</Badge><Button size="sm" variant="outline" asChild><Link to={`/sessions/${item.sessionId}`}>进入 Session</Link></Button></div></div>)}</div>}</div>;
};

export const IntegrationEndpointTasksPage = () => {
  const { endpoint } = useEndpoint();
  const [items, setItems] = useState<IntegrationTask[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { const controller = new AbortController(); void integrationApi.listTasks(endpoint.id, controller.signal).then(setItems).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); }); return () => controller.abort(); }, [endpoint.id]);
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} /><div><h2 className="text-lg font-semibold">Task</h2><p className="text-sm text-muted-foreground">外部请求的权威状态与最终结果。</p></div>{items === null ? <Skeleton className="h-40" /> : items.length === 0 ? <Card className="border-dashed"><CardContent className="py-14 text-center text-muted-foreground">暂无 Task。</CardContent></Card> : <div className="divide-y rounded-xl border bg-card">{items.toReversed().map((item) => <div key={item.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><Link className="block truncate font-medium hover:underline" to={`/integration-tasks/${item.id}`}>{item.requestId}</Link><p className="mt-1 line-clamp-1 text-sm text-muted-foreground">{item.message}</p></div><div className="flex items-center gap-3"><StatusBadge status={item.status} /><time className="text-xs text-muted-foreground">{displayTime(item.createdAt)}</time></div></div>)}</div>}</div>;
};

const endpointInUse = (reason: unknown): boolean => typeof reason === "object" && reason !== null
  && "error" in reason && typeof reason.error === "object" && reason.error !== null
  && "code" in reason.error && reason.error.code === "endpoint_in_use";

export const IntegrationEndpointSettingsPage = () => {
  const { endpoint, agents, setEndpoint } = useEndpoint();
  const navigate = useNavigate();
  const [name, setName] = useState(endpoint.name);
  const [slug, setSlug] = useState(endpoint.slug);
  const [agentId, setAgentId] = useState(endpoint.agentId);
  const [enabled, setEnabled] = useState(endpoint.enabled);
  const [promptPrefix, setPromptPrefix] = useState(endpoint.promptPrefix);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { const updated = await integrationApi.updateEndpoint(endpoint.id, { name: name.trim(), slug: slug.trim(), agentId, enabled, promptPrefix }); setEndpoint(updated); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } };
  const rotate = async () => { setBusy(true); setError(""); try { const rotated = await integrationApi.rotateEndpointToken(endpoint.id); setEndpoint(rotated.endpoint); setToken(rotated.token); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } };
  const remove = async () => { setBusy(true); setError(""); try { await integrationApi.deleteEndpoint(endpoint.id); navigate("/integration-endpoints"); } catch (reason) { setError(endpointInUse(reason) ? "已有 Conversation 或 Task，请停用" : errorMessage(reason)); setBusy(false); } };
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} />{token === "" ? null : <OneTimeSecret title="请立即保存，新 Token 不会再次显示" value={token} onDismiss={() => setToken("")} />}<Card><CardHeader><CardTitle className="flex items-center gap-2"><Settings2 className="size-5" />基础设置</CardTitle><CardDescription>更换 Agent 前必须先结束 active Conversation。</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-5" onSubmit={save}><FieldGroup><Field><FieldLabel htmlFor="settings-endpoint-name">端点名称</FieldLabel><Input id="settings-endpoint-name" value={name} onChange={(event) => setName(event.target.value)} /></Field><Field><FieldLabel htmlFor="settings-endpoint-slug">端点 slug</FieldLabel><Input id="settings-endpoint-slug" value={slug} onChange={(event) => setSlug(event.target.value)} /></Field><Field><FieldLabel htmlFor="settings-endpoint-agent">Agent</FieldLabel><NativeSelect id="settings-endpoint-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect></Field><Field><FieldLabel htmlFor="settings-prompt-prefix">固定提示</FieldLabel><Textarea id="settings-prompt-prefix" value={promptPrefix} onChange={(event) => setPromptPrefix(event.target.value)} /></Field><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用接入端点</label></FieldGroup><div className="flex justify-end"><Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存设置"}</Button></div></form></CardContent></Card><Card><CardHeader><CardTitle>Token</CardTitle><CardDescription>轮换后旧 Token 立即失效；新 Token 只展示一次。</CardDescription></CardHeader><CardContent><AlertDialog><AlertDialogTrigger asChild><Button variant="outline"><RefreshCw />轮换 Token</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>轮换端点 Token？</AlertDialogTitle><AlertDialogDescription>外部系统必须更新为新 Token，旧 Token 将立即失效。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void rotate()}>确认轮换</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></CardContent></Card><Card className="border-destructive/40"><CardHeader><CardTitle className="text-destructive">危险操作</CardTitle><CardDescription>有 Conversation 或 Task 历史的端点不能删除，请改为停用。</CardDescription></CardHeader><CardContent><AlertDialog><AlertDialogTrigger asChild><Button variant="destructive">删除接入端点</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>永久删除“{endpoint.name}”？</AlertDialogTitle><AlertDialogDescription>此操作无法撤销。存在历史数据时系统会拒绝删除。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void remove()}>确认删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></CardContent></Card></div>;
};

const eventSummary = (event: RunEvent): string => {
  try {
    const value = JSON.parse(event.contentJson) as Record<string, unknown>;
    if (typeof value.title === "string") return value.title;
    if (typeof value.status === "string") return value.status;
    if (typeof value.text === "string") return `消息：${value.text.length > 120 ? `${value.text.slice(0, 120)}…` : value.text}`;
  } catch (_error) {
    return event.contentJson;
  }
  return event.type;
};

export const IntegrationTaskDetailPage = () => {
  const { id = "" } = useParams();
  const [task, setTask] = useState<IntegrationTask | null>(null);
  const [endpoint, setEndpoint] = useState<IntegrationEndpoint | null>(null);
  const [conversation, setConversation] = useState<IntegrationConversation | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void integrationApi.getTask(id, controller.signal).then(async (item) => {
      setTask(item);
      const [endpointItem, conversations, deliveryItems, eventItems] = await Promise.all([
        integrationApi.getEndpoint(item.endpointId, controller.signal),
        integrationApi.listConversations(item.endpointId, controller.signal),
        integrationApi.listDeliveries(item.endpointId, controller.signal),
        item.runId === null ? Promise.resolve([]) : api<RunEvent[]>(`/runs/${item.runId}/events?afterSeq=0`, { signal: controller.signal })
      ]);
      setEndpoint(endpointItem); setConversation(conversations.find((value) => value.id === item.conversationId) ?? null);
      setDeliveries(deliveryItems.filter((value) => value.taskId === item.id)); setEvents(eventItems);
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [id]);
  const cancel = async () => { if (task === null) return; setBusy(true); setError(""); try { setTask(await integrationApi.cancelTask(task.id)); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } };
  if (task === null) return <div className="mx-auto max-w-6xl p-8"><ErrorAlert message={error} /><Skeleton className="h-12 w-80" /><Skeleton className="mt-8 h-80" /></div>;
  const terminal = task.status === "succeeded" || task.status === "failed" || task.status === "cancelled";
  return <div className="mx-auto w-full max-w-6xl p-4 sm:p-6 lg:p-8"><Button asChild variant="ghost" className="mb-4"><Link to={`/integration-endpoints/${task.endpointId}/tasks`}><ArrowLeft />返回 Task</Link></Button><PageHeader eyebrow="INTEGRATION TASK" title={task.requestId} description={endpoint === null ? task.endpointId : endpoint.name} action={<div className="flex items-center gap-2"><StatusBadge status={task.status} />{terminal ? null : <AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="destructive" disabled={busy}>取消 Task</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>取消这个 Task？</AlertDialogTitle><AlertDialogDescription>正在运行的 Agent Turn 会停止；同一 Conversation 后续 Task 仍会继续。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>返回</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void cancel()}>确认取消</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}</div>} /><ErrorAlert message={error} /><div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]"><div className="flex flex-col gap-5"><Card><CardHeader><CardTitle>请求与回复</CardTitle></CardHeader><CardContent className="flex flex-col gap-5"><div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">用户消息</p><p className="mt-2 whitespace-pre-wrap rounded-lg border bg-muted/20 p-4 text-sm">{task.message}</p></div><div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Agent 最终回复</p><p className="mt-2 whitespace-pre-wrap rounded-lg border bg-background p-4 text-sm">{task.result ?? (task.status === "failed" ? task.error ?? "执行失败" : "尚未产生最终回复")}</p></div></CardContent></Card><Card><CardHeader><CardTitle>执行轨迹</CardTitle><CardDescription>完整对话仍在关联 Session 中查看。</CardDescription></CardHeader><CardContent>{events.length === 0 ? <p className="text-sm text-muted-foreground">尚无 Run Event。</p> : <div className="divide-y rounded-lg border">{events.map((event) => <div key={event.id} className="grid grid-cols-[3rem_5rem_1fr] gap-3 p-3 text-sm"><span className="font-mono text-xs text-muted-foreground">#{event.seq}</span><Badge variant="outline">{event.type}</Badge><span className="min-w-0 break-words">{eventSummary(event)}</span></div>)}</div>}</CardContent></Card><Card><CardHeader><CardTitle>Webhook Delivery</CardTitle></CardHeader><CardContent>{deliveries.length === 0 ? <p className="text-sm text-muted-foreground">没有关联投递。</p> : <div className="flex flex-col gap-2">{deliveries.map((delivery) => <div key={delivery.id} className="flex items-center justify-between rounded-lg border p-3"><span className="font-mono text-xs">{delivery.eventType}</span><DeliveryBadge status={delivery.status} /></div>)}</div>}</CardContent></Card></div><aside className="flex flex-col gap-4"><Card><CardHeader><CardTitle>关联资源</CardTitle></CardHeader><CardContent className="flex flex-col gap-4 text-sm"><div><p className="text-xs text-muted-foreground">Conversation</p><p className="mt-1 font-mono">{conversation?.conversationKey ?? "一次性 Task"}</p></div><div><p className="text-xs text-muted-foreground">Session</p><p className="mt-1 break-all font-mono text-xs">{task.sessionId}</p></div><div><p className="text-xs text-muted-foreground">Run</p><p className="mt-1 break-all font-mono text-xs">{task.runId ?? "尚未创建"}</p></div><Button asChild><Link to={`/sessions/${task.sessionId}`}>进入 Session</Link></Button></CardContent></Card><Card><CardHeader><CardTitle>时间</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><div><p className="text-xs text-muted-foreground">创建</p><p>{displayTime(task.createdAt)}</p></div><div><p className="text-xs text-muted-foreground">开始</p><p>{displayTime(task.startedAt)}</p></div><div><p className="text-xs text-muted-foreground">结束</p><p>{displayTime(task.finishedAt)}</p></div></CardContent></Card></aside></div></div>;
};
