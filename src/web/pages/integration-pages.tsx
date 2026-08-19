import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, BookOpenText, Cable, Check, Clipboard, KeyRound, Play, Plus, RefreshCw, RotateCcw, Settings2,
  Trash2, Webhook, XCircle
} from "lucide-react";
import { Link, Outlet, useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router";

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
import { useI18n } from "@/i18n";

const StatusBadge = ({ status }: { status: IntegrationTaskStatus }) => { const { text } = useI18n(); const labels: Record<IntegrationTaskStatus, string> = {
  queued: text("排队中", "Queued"), running: text("运行中", "Running"), succeeded: text("已完成", "Completed"), failed: text("失败", "Failed"), cancelled: text("已取消", "Cancelled")
}; return <Badge variant={
  status === "succeeded" ? "default" : status === "failed" ? "destructive" : status === "running" ? "secondary" : "outline"
}>{labels[status]}</Badge>; };

const ErrorAlert = ({ message }: { message: string }) => { const { text } = useI18n(); return message === "" ? null : (
  <Alert variant="destructive"><XCircle /><AlertTitle>{text("操作失败", "Operation failed")}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>
); };

const OneTimeSecret = ({ title, value, onDismiss }: { title: string; value: string; onDismiss(): void }) => {
  const { text } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(value);
    setCopied(true);
  };
  return <Alert className="border-primary/40 bg-primary/5"><KeyRound /><AlertTitle>{title}</AlertTitle>
    <AlertDescription className="mt-3 flex flex-col gap-3">
      <code className="break-all rounded-md border bg-background p-3 text-xs text-foreground">{value}</code>
      <div className="flex flex-wrap gap-2"><Button type="button" size="sm" onClick={() => void copy()}>{copied ? <Check /> : <Clipboard />}{copied ? text("已复制", "Copied") : text("复制", "Copy")}</Button><Button type="button" size="sm" variant="ghost" onClick={onDismiss}>{text("我已保存", "I've saved it")}</Button></div>
    </AlertDescription>
  </Alert>;
};

const CopyableCode = ({ title, value }: { title: string; value: string }) => {
  const { text } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(value);
    setCopied(true);
  };
  return <div className="overflow-hidden rounded-lg border bg-[#1f2923] text-[#eff6ef]">
    <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
      <span className="text-xs font-medium text-white/70">{title}</span>
      <Button type="button" size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" onClick={() => void copy()}>
        {copied ? <Check /> : <Clipboard />}{copied ? text("已复制", "Copied") : text("复制", "Copy")}
      </Button>
    </div>
    <pre className="overflow-x-auto p-4 text-xs leading-6"><code>{value}</code></pre>
  </div>;
};

export const IntegrationEndpointListPage = () => {
  const { text } = useI18n();
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
    <PageHeader title={text("接入端点", "Integration endpoints")} description={text("为外部系统提供稳定的智能体调用入口，调用方无需了解内部执行器、智能体会话和单次执行。", "Provide stable agent entry points to external systems without exposing providers, sessions, or runs.")} action={<Button asChild><Link to="/integration-endpoints/new"><Plus />{text("新建接入端点", "New endpoint")}</Link></Button>} />
    <ErrorAlert message={error} />
    {endpoints === null ? <div className="grid gap-4 lg:grid-cols-2">{[0, 1].map((item) => <Skeleton key={item} className="h-52" />)}</div>
      : endpoints.length === 0 ? <Card className="border-dashed"><CardContent className="py-16 text-center text-muted-foreground">{text("暂无接入端点。创建后即可让外部系统安全提交任务。", "No integration endpoints yet. Create one to accept tasks from external systems.")}</CardContent></Card>
        : <div className="grid gap-4 lg:grid-cols-2">{endpoints.map((endpoint) => <Card key={endpoint.id} className="overflow-hidden transition-colors hover:border-primary/50"><CardHeader className="border-b bg-muted/20"><div className="flex items-start justify-between gap-4"><div><CardTitle><Link className="hover:underline" to={`/integration-endpoints/${endpoint.id}`}>{endpoint.name}</Link></CardTitle><CardDescription className="mt-2 font-mono">/{endpoint.slug}</CardDescription></div><Badge variant={endpoint.enabled ? "default" : "secondary"}>{endpoint.enabled ? text("已启用", "Enabled") : text("已停用", "Disabled")}</Badge></div></CardHeader><CardContent className="grid gap-4 p-5 sm:grid-cols-3"><div><p className="text-xs text-muted-foreground">{text("智能体", "Agent")}</p><p className="mt-1 truncate text-sm font-medium">{agentNames.get(endpoint.agentId) ?? endpoint.agentId}</p></div><div><p className="text-xs text-muted-foreground">{text("接续中的业务对话", "Active conversations")}</p><p className="mt-1 font-mono text-xl">{endpoint.activeConversationCount}</p></div><div><p className="text-xs text-muted-foreground">{text("排队 / 运行", "Queued / running")}</p><p className="mt-1 font-mono text-xl">{endpoint.activeTaskCount}</p></div><div className="sm:col-span-3"><p className="text-xs text-muted-foreground">{text("最近任务", "Latest task")}</p>{endpoint.latestTask === null ? <p className="mt-1 text-sm">{text("尚无调用", "No calls yet")}</p> : <div className="mt-1 flex items-center justify-between gap-3"><Link className="truncate text-sm font-medium hover:underline" to={`/integration-tasks/${endpoint.latestTask.id}`}>{endpoint.latestTask.requestId}</Link><StatusBadge status={endpoint.latestTask.status} /></div>}</div></CardContent></Card>)}</div>}
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
}) => { const { text } = useI18n(); return parameters.length === 0 ? <p className="text-sm text-muted-foreground">{text("该智能体没有声明会话参数。", "This agent has no session parameters.")}</p> : <div className="flex flex-col gap-3">{parameters.map((parameter) => {
  const draft = drafts[parameter.key] ?? { source: "none", requestKey: parameter.key, value: "", configured: false };
  return <div key={parameter.id} className="grid gap-3 rounded-lg border p-4 md:grid-cols-[minmax(10rem,1fr)_10rem_minmax(12rem,1fr)]"><div><p className="font-medium">{parameter.label}{parameter.required ? " *" : ""}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{parameter.key}</p></div><Field><FieldLabel htmlFor={`mapping-source-${parameter.key}`}>{text(`${parameter.label} 来源`, `${parameter.label} source`)}</FieldLabel><NativeSelect id={`mapping-source-${parameter.key}`} value={draft.source} onChange={(event) => onChange(parameter.key, { ...draft, source: event.target.value as MappingDraft["source"] })}><NativeSelectOption value="none" disabled={parameter.required}>{text("不传入", "Not provided")}</NativeSelectOption><NativeSelectOption value="request">{text("请求参数", "Request parameter")}</NativeSelectOption><NativeSelectOption value="fixed">{text("固定值", "Fixed value")}</NativeSelectOption></NativeSelect></Field>{draft.source === "request" ? <Field><FieldLabel htmlFor={`mapping-request-${parameter.key}`}>{text(`${parameter.label} 请求参数名`, `${parameter.label} request key`)}</FieldLabel><Input id={`mapping-request-${parameter.key}`} value={draft.requestKey} onChange={(event) => onChange(parameter.key, { ...draft, requestKey: event.target.value })} /></Field> : draft.source === "fixed" ? <Field><FieldLabel htmlFor={`mapping-fixed-${parameter.key}`}>{text(`${parameter.label} 固定值`, `${parameter.label} fixed value`)}</FieldLabel><Input id={`mapping-fixed-${parameter.key}`} type={parameter.secret ? "password" : "text"} value={draft.value} placeholder={draft.configured ? text("已配置；留空保持不变", "Configured; leave blank to keep it") : text("输入固定值", "Enter fixed value")} onChange={(event) => onChange(parameter.key, { ...draft, value: event.target.value })} /><FieldDescription>{draft.configured ? text("已配置", "Configured") : text("未配置", "Not configured")}</FieldDescription></Field> : <div className="self-center text-sm text-muted-foreground">{text("外部请求不会设置该参数", "External requests cannot set this parameter")}</div>}</div>;
})}</div>; };

const mappingPayload = (parameters: AgentSessionParameter[], drafts: Record<string, MappingDraft>, preserve = false): IntegrationParameterMappingUpdateInput[] => parameters.flatMap<IntegrationParameterMappingUpdateInput>((parameter) => {
  const draft = drafts[parameter.key];
  if (draft === undefined || draft.source === "none") return [];
  if (draft.source === "request") return [{ parameterKey: parameter.key, source: "request" as const, requestKey: draft.requestKey.trim() }];
  return [{ parameterKey: parameter.key, source: "fixed" as const, ...(preserve && draft.configured && draft.value === "" ? {} : { value: draft.value }) }];
});

export const IntegrationEndpointCreatePage = () => {
  const { text } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedAgentId = searchParams.get("agentId");
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
      const requested = requestedAgentId !== null && active.some((item) => String(item.id) === requestedAgentId)
        ? requestedAgentId
        : undefined;
      setAgents(active); setAgentId(requested ?? (active[0] === undefined ? "" : String(active[0].id)));
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [requestedAgentId]);
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
        name: name.trim(), slug: slug.trim(), agentId: Number(agentId), enabled, promptPrefix,
        parameterMappings: mappingPayload(parameters, drafts).map((mapping): IntegrationParameterMappingInput =>
          mapping.source === "request" ? mapping : { ...mapping, value: mapping.value ?? "" }
        )
      });
      navigate(`/integration-endpoints/${created.endpoint.id}`, { state: { oneTimeToken: created.token } });
    } catch (reason) { setError(errorMessage(reason)); setBusy(false); }
  };
  return <div className="mx-auto w-full max-w-4xl p-4 sm:p-6 lg:p-8"><Button variant="ghost" asChild className="mb-4"><Link to="/integration-endpoints"><ArrowLeft />{text("返回接入端点", "Back to endpoints")}</Link></Button><PageHeader title={text("新建接入端点", "New integration endpoint")} description={text("端点绑定一个智能体。外部调用方只能提交消息和声明过的请求参数。", "An endpoint binds one agent. External callers can submit only messages and declared request parameters.")} /><ErrorAlert message={error} /><form className="flex flex-col gap-5" onSubmit={submit}><Card><CardHeader><CardTitle>{text("基础信息", "Basic information")}</CardTitle><CardDescription>{text("路径标识会成为外部系统使用的稳定网址标识。", "The slug becomes the stable URL identifier used by external systems.")}</CardDescription></CardHeader><CardContent><FieldGroup><Field><FieldLabel htmlFor="endpoint-name">{text("端点名称", "Endpoint name")}</FieldLabel><Input id="endpoint-name" required value={name} onChange={(event) => setName(event.target.value)} autoFocus /></Field><Field><FieldLabel htmlFor="endpoint-slug">{text("路径标识", "Slug")}</FieldLabel><Input id="endpoint-slug" required pattern="[a-z0-9][a-z0-9-]{0,63}" value={slug} onChange={(event) => setSlug(event.target.value)} /></Field><Field><FieldLabel htmlFor="endpoint-agent">{text("智能体", "Agent")}</FieldLabel><NativeSelect id="endpoint-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}><NativeSelectOption value="" disabled>{text("请选择智能体", "Select an agent")}</NativeSelectOption>{agents.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect></Field><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{text("创建后立即启用", "Enable after creation")}</label></FieldGroup></CardContent></Card><Card><CardHeader><CardTitle>{text("固定提示", "Fixed prompt")}</CardTitle><CardDescription>{text("每个任务的用户消息前都会加入这段提示。", "This prompt is prepended to every task message.")}</CardDescription></CardHeader><CardContent><Field><FieldLabel htmlFor="prompt-prefix">{text("提示内容", "Prompt")}</FieldLabel><Textarea id="prompt-prefix" value={promptPrefix} onChange={(event) => setPromptPrefix(event.target.value)} placeholder={text("可留空", "Optional")} /></Field></CardContent></Card><Card><CardHeader><CardTitle>{text("参数映射", "Parameter mappings")}</CardTitle><CardDescription>{text("将外部请求参数或固定值映射到智能体的工具服务会话参数。", "Map external request parameters or fixed values to the agent's MCP session parameters.")}</CardDescription></CardHeader><CardContent><MappingFields parameters={parameters} drafts={drafts} onChange={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))} /></CardContent></Card><div className="flex justify-end gap-2"><Button variant="outline" asChild><Link to="/integration-endpoints">{text("取消", "Cancel")}</Link></Button><Button type="submit" disabled={busy || agentId === ""}>{busy ? text("创建中…", "Creating…") : text("创建接入端点", "Create endpoint")}</Button></div></form></div>;
};

type EndpointContext = {
  endpoint: IntegrationEndpoint;
  agentName: string;
  agents: Agent[];
  setEndpoint(endpoint: IntegrationEndpoint): void;
};
const useEndpoint = () => useOutletContext<EndpointContext>();

export const IntegrationEndpointDetailLayout = () => {
  const { text } = useI18n();
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
    void Promise.all([integrationApi.getEndpoint(Number(id), controller.signal), api<Agent[]>("/agents", { signal: controller.signal })])
      .then(([item, agentItems]) => { setEndpoint(item); setAgents(agentItems); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [id]);
  if (endpoint === null) return <div className="mx-auto max-w-6xl p-8"><ErrorAlert message={error} /><Skeleton className="h-12 w-72" /><Skeleton className="mt-8 h-64" /></div>;
  const base = `/integration-endpoints/${id}`;
  const suffix = location.pathname.slice(base.length).replace(/^\//, "");
  const section = suffix === "" ? "overview" : suffix;
  const agentName = agents.find((item) => item.id === endpoint.agentId)?.name ?? String(endpoint.agentId);
  return <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8"><Button asChild variant="ghost" className="mb-4"><Link to="/integration-endpoints"><ArrowLeft />{text("返回接入端点", "Back to endpoints")}</Link></Button><PageHeader title={endpoint.name} description={`/${endpoint.slug} · ${agentName}`} action={<Badge variant={endpoint.enabled ? "default" : "secondary"}>{endpoint.enabled ? text("已启用", "Enabled") : text("已停用", "Disabled")}</Badge>} />{oneTimeToken === "" ? null : <div className="mb-6"><OneTimeSecret title={text("请立即保存，此访问令牌不会再次显示", "Save this access token now. It will not be shown again.")} value={oneTimeToken} onDismiss={() => setOneTimeToken("")} /></div>}<Tabs value={section}><TabsList variant="line" aria-label={text("接入端点管理", "Integration endpoint management")} className="max-w-full justify-start overflow-x-auto"><TabsTrigger value="overview" asChild><Link to={base}>{text("概览", "Overview")}</Link></TabsTrigger><TabsTrigger value="usage" asChild><Link to={`${base}/usage`}>{text("调用说明", "Usage")}</Link></TabsTrigger><TabsTrigger value="mappings" asChild><Link to={`${base}/mappings`}>{text("参数映射", "Mappings")}</Link></TabsTrigger><TabsTrigger value="webhooks" asChild><Link to={`${base}/webhooks`}>{text("事件回调", "Webhooks")}</Link></TabsTrigger><TabsTrigger value="conversations" asChild><Link to={`${base}/conversations`}>{text("业务对话", "Conversations")}</Link></TabsTrigger><TabsTrigger value="tasks" asChild><Link to={`${base}/tasks`}>{text("任务", "Tasks")}</Link></TabsTrigger><TabsTrigger value="settings" asChild><Link to={`${base}/settings`}>{text("设置", "Settings")}</Link></TabsTrigger></TabsList></Tabs><div className="mt-6"><Outlet context={{ endpoint, agentName, agents, setEndpoint } satisfies EndpointContext} /></div></div>;
};

export const IntegrationEndpointOverviewPage = () => {
  const { text } = useI18n();
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
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Card><CardHeader><CardDescription>{text("绑定智能体", "Agent")}</CardDescription><CardTitle className="text-lg">{agentName}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>{text("接续中的业务对话", "Active conversations")}</CardDescription><CardTitle className="font-mono text-3xl">{conversations.filter((item) => item.status === "active").length}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>{text("排队 / 运行", "Queued / running")}</CardDescription><CardTitle className="font-mono text-3xl">{tasks.filter((item) => item.status === "queued" || item.status === "running").length}</CardTitle></CardHeader></Card><Card><CardHeader><CardDescription>{text("最近任务", "Latest task")}</CardDescription><CardTitle className="text-base">{latest === undefined ? text("暂无", "None") : <Link className="hover:underline" to={`/integration-tasks/${latest.id}`}>{latest.requestId}</Link>}</CardTitle></CardHeader></Card></div><Card><CardHeader><CardTitle className="flex items-center gap-2"><Cable className="size-5" />{text("调用入口", "Task endpoint")}</CardTitle><CardDescription>{text("外部系统使用独立访问令牌调用此地址。", "External systems call this URL with the endpoint access token.")}</CardDescription></CardHeader><CardContent><code className="block break-all rounded-md border bg-muted/30 p-4 text-xs">POST /integration/v1/endpoints/{endpoint.slug}/tasks</code></CardContent></Card><Card><CardHeader><CardTitle>{text("固定提示", "Fixed prompt")}</CardTitle></CardHeader><CardContent className="whitespace-pre-wrap text-sm text-muted-foreground">{endpoint.promptPrefix === "" ? text("未配置", "Not configured") : endpoint.promptPrefix}</CardContent></Card></div>;
};

export const IntegrationEndpointUsagePage = () => {
  const { text } = useI18n();
  const { endpoint } = useEndpoint();
  const navigate = useNavigate();
  const [definitions, setDefinitions] = useState<AgentSessionParameter[] | null>(null);
  const [message, setMessage] = useState("");
  const [conversationKey, setConversationKey] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<AgentSessionParameter[]>(`/agents/${endpoint.agentId}/session-parameters`, { signal: controller.signal })
      .then(setDefinitions)
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [endpoint.agentId]);

  const definitionByKey = new Map((definitions ?? []).map((item) => [item.key, item]));
  const requestMappings = endpoint.parameterMappings.filter(
    (mapping): mapping is Extract<IntegrationEndpoint["parameterMappings"][number], { source: "request" }> =>
      mapping.source === "request"
  );
  const fixedMappings = endpoint.parameterMappings.filter((mapping) => mapping.source === "fixed");
  const exampleParameters = Object.fromEntries(requestMappings.map((mapping) => {
    const definition = definitionByKey.get(mapping.parameterKey);
    return [mapping.requestKey, `<${definition?.label ?? mapping.requestKey}>`];
  }));
  const taskPath = `/integration/v1/endpoints/${endpoint.slug}/tasks`;
  const requestExample = JSON.stringify({
    requestId: text("request-<唯一值>", "request-<unique-value>"),
    conversationKey: text("business-<业务标识>", "business-<conversation-key>"),
    message: text("请处理这项任务", "Please handle this task"),
    parameters: exampleParameters
  }, null, 2);
  const curlExample = [
    `curl '${taskPath}' \\`,
    "  -X POST \\",
    text("  -H 'Authorization: Bearer <接入端点访问令牌>' \\", "  -H 'Authorization: Bearer <endpoint-access-token>' \\") ,
    "  -H 'Content-Type: application/json' \\",
    `  --data '${requestExample.replaceAll("'", "'\\''")}'`
  ].join("\n");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!endpoint.enabled || message.trim() === "") return;
    setBusy(true);
    setError("");
    try {
      const parameters = Object.fromEntries(requestMappings.flatMap((mapping) => {
        const value = values[mapping.requestKey] ?? "";
        const definition = definitionByKey.get(mapping.parameterKey);
        return value === "" && !definition?.required ? [] : [[mapping.requestKey, value]];
      }));
      const created = await integrationApi.createTestTask(endpoint.id, {
        ...(conversationKey.trim() === "" ? {} : { conversationKey: conversationKey.trim() }),
        message: message.trim(),
        parameters
      });
      navigate(`/integration-tasks/${created.id}`);
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  };

  return <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,0.8fr)]">
    <div className="flex min-w-0 flex-col gap-5">
      <Card className="overflow-hidden border-primary/30">
        <CardHeader className="border-b bg-primary/5"><CardTitle className="flex items-center gap-2"><BookOpenText className="size-5" />{text("调用入口", "Task endpoint")}</CardTitle><CardDescription>{text("外部系统使用端点访问令牌提交任务。访问令牌仅在创建或轮换时展示一次。", "External systems submit tasks with the endpoint access token. The token is shown only after creation or rotation.")}</CardDescription></CardHeader>
        <CardContent className="grid gap-4 p-5 sm:grid-cols-[7rem_1fr]"><div className="text-sm text-muted-foreground">{text("请求方式", "Request")}</div><code className="break-all text-sm">POST {taskPath}</code><div className="text-sm text-muted-foreground">{text("认证方式", "Authentication")}</div><code className="break-all text-sm">Authorization: Bearer &lt;{text("接入端点访问令牌", "endpoint-access-token")}&gt;</code></CardContent>
      </Card>
      <Card><CardHeader><CardTitle>{text("请求参数", "Request parameters")}</CardTitle><CardDescription>{text("参数名称区分大小写。相同请求标识重复提交时会返回同一个任务。", "Parameter names are case-sensitive. Reusing the same request ID returns the same task.")}</CardDescription></CardHeader><CardContent className="overflow-x-auto"><table className="w-full min-w-[42rem] text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="pb-3 font-medium">{text("参数", "Parameter")}</th><th className="pb-3 font-medium">{text("必填", "Required")}</th><th className="pb-3 font-medium">{text("说明", "Description")}</th></tr></thead><tbody className="divide-y"><tr><td className="py-3"><code>requestId</code></td><td className="py-3">{text("是", "Yes")}</td><td className="py-3 text-muted-foreground">{text("调用方生成的唯一请求标识，用于安全重试。", "A caller-generated unique ID used for safe retries.")}</td></tr><tr><td className="py-3"><code>message</code></td><td className="py-3">{text("是", "Yes")}</td><td className="py-3 text-muted-foreground">{text("发送给智能体的任务内容。", "The task message sent to the agent.")}</td></tr><tr><td className="py-3"><code>conversationKey</code></td><td className="py-3">{text("否", "No")}</td><td className="py-3 text-muted-foreground">{text("相同对话标识会接续同一个业务对话；不传则每次创建独立会话。", "The same key continues one business conversation; omit it to create a new session per task.")}</td></tr><tr><td className="py-3"><code>parameters</code></td><td className="py-3">{text("否", "No")}</td><td className="py-3 text-muted-foreground">{text("当前端点声明的动态业务参数对象。", "Dynamic business parameters declared by this endpoint.")}</td></tr>{requestMappings.map((mapping) => { const definition = definitionByKey.get(mapping.parameterKey); return <tr key={mapping.parameterKey}><td className="py-3"><code>parameters.{mapping.requestKey}</code><span className="mt-1 block text-xs text-muted-foreground">{definition?.label ?? mapping.parameterKey}</span></td><td className="py-3">{definition?.required ? text("是", "Yes") : text("否", "No")}</td><td className="py-3 text-muted-foreground">{definition?.description ?? text("传入当前任务使用的参数值。", "The parameter value used by this task.")}</td></tr>; })}</tbody></table></CardContent></Card>
      {fixedMappings.length === 0 ? null : <Card><CardHeader><CardTitle>{text("系统固定参数", "System-managed parameters")}</CardTitle><CardDescription>{text("这些值由管理员预先配置，不属于外部请求。", "These values are configured by an administrator and do not belong in the external request.")}</CardDescription></CardHeader><CardContent className="divide-y rounded-lg border p-0">{fixedMappings.map((mapping) => { const definition = definitionByKey.get(mapping.parameterKey); return <div key={mapping.parameterKey} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-medium">{definition?.label ?? mapping.parameterKey}</p><p className="text-xs text-muted-foreground">{definition?.description ?? mapping.parameterKey}</p></div><Badge variant="secondary">{text("由系统配置，请求中不要传入", "Managed by the server; do not include in requests")}</Badge></div>; })}</CardContent></Card>}
      <Card><CardHeader><CardTitle>{text("调用示例", "Request example")}</CardTitle><CardDescription>{text("示例只包含占位符，不会读取或展示真实访问令牌和固定参数。", "Examples contain placeholders only and never expose real access tokens or fixed parameters.")}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4"><CopyableCode title={text("请求内容", "Request body")} value={requestExample} /><CopyableCode title="curl" value={curlExample} /></CardContent></Card>
      <Card><CardHeader><CardTitle>{text("获取执行结果", "Retrieve results")}</CardTitle><CardDescription>{text("先保存提交响应中的任务标识，再查询状态或订阅事件。", "Save the task ID from the submission response, then query status or subscribe to events.")}</CardDescription></CardHeader><CardContent className="space-y-3 text-xs"><code className="block break-all rounded-md border bg-muted/30 p-3">GET /integration/v1/tasks/&lt;{text("任务标识", "task-id")}&gt;</code><code className="block break-all rounded-md border bg-muted/30 p-3">GET /integration/v1/tasks/&lt;{text("任务标识", "task-id")}&gt;/events?afterSeq=0</code><code className="block break-all rounded-md border bg-muted/30 p-3">GET /integration/v1/tasks/&lt;{text("任务标识", "task-id")}&gt;/events/stream?afterSeq=0</code></CardContent></Card>
    </div>
    <Card className="xl:sticky xl:top-20"><CardHeader><CardTitle className="flex items-center gap-2"><Play className="size-5" />{text("发送测试任务", "Send test task")}</CardTitle><CardDescription>{text("使用当前配置创建真实任务，提交后进入任务详情查看运行过程。", "Create a real task with the current configuration, then inspect its execution on the task page.")}</CardDescription></CardHeader><CardContent><ErrorAlert message={error} />{!endpoint.enabled ? <Alert className="mb-5"><XCircle /><AlertTitle>{text("接入端点未启用", "Endpoint disabled")}</AlertTitle><AlertDescription>{text("请先在设置中启用接入端点，再发送测试任务。", "Enable the endpoint in settings before sending a test task.")}</AlertDescription></Alert> : null}<form className="flex flex-col gap-5" onSubmit={submit}><Field><FieldLabel htmlFor="test-task-message">{text("测试消息", "Test message")}</FieldLabel><Textarea id="test-task-message" required rows={5} value={message} onChange={(event) => setMessage(event.target.value)} placeholder={text("描述希望智能体完成的任务", "Describe the task for the agent")} /></Field><Field><FieldLabel htmlFor="test-conversation-key">{text("对话标识（可选）", "Conversation key (optional)")}</FieldLabel><Input id="test-conversation-key" value={conversationKey} onChange={(event) => setConversationKey(event.target.value)} /><FieldDescription>{text("填写相同标识可以继续上一次业务对话。", "Reuse the same key to continue the previous business conversation.")}</FieldDescription></Field>{definitions === null ? <Skeleton className="h-24" /> : requestMappings.map((mapping) => { const definition = definitionByKey.get(mapping.parameterKey); return <Field key={mapping.parameterKey}><FieldLabel htmlFor={`test-parameter-${mapping.requestKey}`}>{definition?.label ?? mapping.requestKey}</FieldLabel><Input id={`test-parameter-${mapping.requestKey}`} type={definition?.secret ? "password" : "text"} required={definition?.required} value={values[mapping.requestKey] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [mapping.requestKey]: event.target.value }))} />{definition?.description === null || definition?.description === undefined ? null : <FieldDescription>{definition.description}</FieldDescription>}</Field>; })}<Button type="submit" disabled={busy || !endpoint.enabled || definitions === null}>{busy ? text("正在创建任务…", "Creating task…") : text("发送测试任务", "Send test task")}</Button></form></CardContent></Card>
  </div>;
};

export const IntegrationEndpointMappingsPage = () => {
  const { text } = useI18n();
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
  return <form className="flex flex-col gap-5" onSubmit={submit}><ErrorAlert message={error} />{saved ? <Alert><Check /><AlertTitle>{text("参数映射已保存", "Parameter mappings saved")}</AlertTitle><AlertDescription>{text("新配置会用于之后创建的任务；已排队任务继续使用自己的参数快照。", "New tasks use this configuration; queued tasks keep their existing parameter snapshot.")}</AlertDescription></Alert> : null}<Card><CardHeader><CardTitle>{text("会话参数映射", "Session parameter mappings")}</CardTitle><CardDescription>{text("固定敏感值只展示配置状态。留空保存会保留原值。", "Fixed secrets show configuration status only. Leave them blank to keep the current value.")}</CardDescription></CardHeader><CardContent><MappingFields parameters={parameters} drafts={drafts} onChange={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))} /></CardContent></Card><div className="flex justify-end"><Button type="submit" disabled={busy}>{busy ? text("保存中…", "Saving…") : text("保存参数映射", "Save mappings")}</Button></div></form>;
};

const webhookEvents: Array<{ value: WebhookEventType; labels: readonly [string, string] }> = [
  { value: "task.queued", labels: ["任务已排队", "Task queued"] },
  { value: "task.started", labels: ["任务已开始", "Task started"] },
  { value: "task.succeeded", labels: ["任务已完成", "Task completed"] },
  { value: "task.failed", labels: ["任务失败", "Task failed"] },
  { value: "task.cancelled", labels: ["任务已取消", "Task cancelled"] },
  { value: "message.user.received", labels: ["收到用户消息", "User message received"] },
  { value: "message.agent.reply", labels: ["智能体完整回复", "Agent reply"] },
  { value: "message.system.notice", labels: ["系统通知", "System notice"] },
  { value: "tool.started", labels: ["工具开始", "Tool started"] },
  { value: "tool.completed", labels: ["工具完成", "Tool completed"] },
  { value: "tool.failed", labels: ["工具失败", "Tool failed"] }
];

const DeliveryBadge = ({ status }: { status: WebhookDelivery["status"] }) => { const { text } = useI18n(); return <Badge variant={
  status === "succeeded" ? "default" : status === "failed" ? "destructive" : "secondary"
}>{status === "succeeded" ? text("成功", "Succeeded") : status === "failed" ? text("失败", "Failed") : status === "delivering" ? text("投递中", "Delivering") : text("等待投递", "Pending")}</Badge>; };

const WebhookEditorDialog = ({ endpointId, onCreated, onError }: {
  endpointId: number;
  onCreated(webhook: IntegrationWebhook, secret: string): void;
  onError(message: string): void;
}) => {
  const { text } = useI18n();
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
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button><Plus />{text("新建事件回调", "New webhook")}</Button></DialogTrigger><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><form onSubmit={submit}><DialogHeader><DialogTitle>{text("新建事件回调", "New webhook")}</DialogTitle><DialogDescription>{text("固定使用 HTTP POST。签名密钥只会在创建成功后展示一次。", "Webhooks use HTTP POST. The signing secret is shown only once after creation.")}</DialogDescription></DialogHeader><FieldGroup className="py-5"><Field><FieldLabel htmlFor="webhook-name">{text("回调名称", "Webhook name")}</FieldLabel><Input id="webhook-name" required value={name} onChange={(event) => setName(event.target.value)} /></Field><Field><FieldLabel htmlFor="webhook-url">{text("回调地址", "Webhook URL")}</FieldLabel><Input id="webhook-url" required type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/callback" /></Field><Field><FieldLabel>{text("订阅事件", "Subscribed events")}</FieldLabel><div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">{webhookEvents.map((item) => <label key={item.value} className="flex items-start gap-2 text-sm"><input aria-label={item.value} type="checkbox" checked={events.includes(item.value)} onChange={() => toggleEvent(item.value)} className="mt-0.5" /><span><span className="font-mono text-xs">{item.value}</span><span className="block text-xs text-muted-foreground">{text(...item.labels)}</span></span></label>)}</div><FieldDescription>{text("至少选择一个事件。智能体思考内容不会通过事件回调外发。", "Select at least one event. Agent thoughts are never sent through webhooks.")}</FieldDescription></Field><div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="webhook-header-name">{text("请求头名称（可选）", "Header name (optional)")}</FieldLabel><Input id="webhook-header-name" value={headerName} onChange={(event) => setHeaderName(event.target.value)} placeholder="Authorization" /></Field><Field><FieldLabel htmlFor="webhook-header-value">{text("请求头值", "Header value")}</FieldLabel><Input id="webhook-header-value" type="password" value={headerValue} onChange={(event) => setHeaderValue(event.target.value)} autoComplete="off" /></Field></div><Field><FieldLabel htmlFor="webhook-timeout">{text("超时秒数", "Timeout in seconds")}</FieldLabel><Input id="webhook-timeout" type="number" min={1} max={60} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} /></Field></FieldGroup><DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>{text("取消", "Cancel")}</Button><Button type="submit" disabled={busy || events.length === 0}>{busy ? text("创建中…", "Creating…") : text("创建事件回调", "Create webhook")}</Button></DialogFooter></form></DialogContent></Dialog>;
};

export const IntegrationEndpointWebhooksPage = () => {
  const { text, formatDate } = useI18n();
  const { endpoint } = useEndpoint();
  const [webhooks, setWebhooks] = useState<IntegrationWebhook[] | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [signingSecret, setSigningSecret] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let timer: number | undefined;
    let remainingPolls = 30;
    const refresh = async () => {
      try {
        const [subscriptions, deliveryItems] = await Promise.all([
          integrationApi.listWebhooks(endpoint.id, controller.signal),
          integrationApi.listDeliveries(endpoint.id, controller.signal)
        ]);
        if (disposed || controller.signal.aborted) return;
        setWebhooks(subscriptions);
        setDeliveries(deliveryItems);
        if (
          remainingPolls > 0
          && deliveryItems.some(({ status }) => status === "pending" || status === "delivering")
        ) {
          remainingPolls -= 1;
          timer = window.setTimeout(() => { void refresh(); }, 1_000);
        }
      } catch (reason) {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      }
    };
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [endpoint.id, refreshKey]);
  const act = async (id: number, action: () => Promise<unknown>) => {
    setBusyId(id); setError("");
    try { await action(); setRefreshKey((value) => value + 1); } catch (reason) { setError(errorMessage(reason)); } finally { setBusyId(null); }
  };
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} />{signingSecret === "" ? null : <OneTimeSecret title={text("请立即保存签名密钥，此后不会再次显示", "Save the signing secret now. It will not be shown again.")} value={signingSecret} onDismiss={() => setSigningSecret("")} />}<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-semibold">{text("事件回调订阅", "Webhook subscriptions")}</h2><p className="text-sm text-muted-foreground">{text("失败投递会自动重试；最终失败后可手动重发。", "Failed deliveries retry automatically and can be resent manually after final failure.")}</p></div><WebhookEditorDialog endpointId={endpoint.id} onError={setError} onCreated={(webhook, secret) => { setWebhooks((current) => [...(current ?? []), webhook]); setSigningSecret(secret); }} /></div>{webhooks === null ? <Skeleton className="h-40" /> : webhooks.length === 0 ? <Card className="border-dashed"><CardContent className="py-14 text-center text-muted-foreground">{text("尚未配置事件回调。", "No webhooks configured.")}</CardContent></Card> : <div className="flex flex-col gap-4">{webhooks.map((webhook) => {
    const recent = deliveries.find((item) => item.subscriptionId === webhook.id);
    return <Card key={webhook.id}><CardHeader className="border-b bg-muted/20"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><CardTitle className="flex items-center gap-2"><Webhook className="size-4" />{webhook.name}</CardTitle><CardDescription className="mt-2 break-all">{webhook.url}</CardDescription></div><Badge variant={webhook.enabled ? "default" : "secondary"}>{webhook.enabled ? text("已启用", "Enabled") : text("已停用", "Disabled")}</Badge></div></CardHeader><CardContent className="flex flex-col gap-4 p-5"><div className="flex flex-wrap gap-1">{webhook.events.map((item) => <Badge key={item} variant="outline" className="font-mono">{item}</Badge>)}</div><div className="grid gap-3 text-sm sm:grid-cols-4"><div><p className="text-xs text-muted-foreground">{text("最近投递", "Latest delivery")}</p><p className="mt-1">{recent === undefined ? text("等待首次投递", "Waiting for first delivery") : <DeliveryBadge status={recent.status} />}</p></div><div><p className="text-xs text-muted-foreground">{text("状态码", "Status code")}</p><p className="mt-1 font-mono">{recent?.lastStatusCode ?? "—"}</p></div><div><p className="text-xs text-muted-foreground">{text("尝试次数", "Attempts")}</p><p className="mt-1 font-mono">{recent?.attemptCount ?? 0}</p></div><div><p className="text-xs text-muted-foreground">{text("时间", "Time")}</p><p className="mt-1">{formatDate(recent?.updatedAt ?? null)}</p></div></div>{recent?.lastError === null || recent === undefined ? null : <Alert variant="destructive"><XCircle /><AlertTitle>{text("最近错误", "Latest error")}</AlertTitle><AlertDescription>{recent.lastError}</AlertDescription></Alert>}<div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busyId === webhook.id || !webhook.enabled} onClick={() => void act(webhook.id, () => integrationApi.testWebhook(endpoint.id, webhook.id))}><RefreshCw />{text("发送测试", "Send test")}</Button><Button size="sm" variant="outline" disabled={busyId === webhook.id} onClick={() => void act(webhook.id, () => integrationApi.updateWebhook(endpoint.id, webhook.id, { enabled: !webhook.enabled }))}>{webhook.enabled ? text("停用", "Disable") : text("启用", "Enable")}</Button><AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="ghost"><Trash2 />{text("删除", "Delete")}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{text(`删除“${webhook.name}”？`, `Delete “${webhook.name}”?`)}</AlertDialogTitle><AlertDialogDescription>{text("订阅和历史投递记录将被永久删除。", "The subscription and delivery history will be permanently deleted.")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{text("取消", "Cancel")}</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void act(webhook.id, () => integrationApi.deleteWebhook(endpoint.id, webhook.id))}>{text("确认删除", "Delete")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div></CardContent></Card>;
  })}</div>}<Card><CardHeader><CardTitle>{text("最近投递", "Recent deliveries")}</CardTitle><CardDescription>{text("展示状态码、耗时、重试次数和脱敏错误。", "Shows status codes, duration, retry counts, and redacted errors.")}</CardDescription></CardHeader><CardContent>{deliveries.length === 0 ? <p className="text-sm text-muted-foreground">{text("暂无投递记录。", "No delivery records.")}</p> : <div className="divide-y rounded-lg border">{deliveries.map((delivery) => <div key={delivery.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex items-center gap-2"><DeliveryBadge status={delivery.status} /><span className="font-mono text-xs">{delivery.eventType}</span></div><p className="mt-2 text-xs text-muted-foreground">HTTP {delivery.lastStatusCode ?? "—"} · {delivery.lastDurationMs ?? "—"} ms · {text(`尝试 ${delivery.attemptCount} 次`, `${delivery.attemptCount} attempts`)} · {formatDate(delivery.updatedAt)}</p>{delivery.lastError === null ? null : <p className="mt-1 truncate text-xs text-destructive">{delivery.lastError}</p>}</div>{delivery.status === "failed" ? <Button size="sm" variant="outline" disabled={busyId === delivery.id} onClick={() => void act(delivery.id, () => integrationApi.retryDelivery(delivery.id))}><RotateCcw />{text("手动重发", "Retry")}</Button> : null}</div>)}</div>}</CardContent></Card></div>;
};

export const IntegrationConversationPage = () => {
  const { text, formatDate } = useI18n();
  const { endpoint } = useEndpoint();
  const [items, setItems] = useState<IntegrationConversation[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { const controller = new AbortController(); void integrationApi.listConversations(endpoint.id, controller.signal).then(setItems).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); }); return () => controller.abort(); }, [endpoint.id]);
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} /><div><h2 className="text-lg font-semibold">{text("业务对话", "Conversations")}</h2><p className="text-sm text-muted-foreground">{text("外部对话标识与长期智能体会话之间的接续关系。", "Continuation links between external conversation keys and persistent agent sessions.")}</p></div>{items === null ? <Skeleton className="h-40" /> : items.length === 0 ? <Card className="border-dashed"><CardContent className="py-14 text-center text-muted-foreground">{text("暂无业务对话。", "No conversations.")}</CardContent></Card> : <div className="divide-y rounded-xl border bg-card">{items.toReversed().map((item) => <div key={item.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-mono text-sm font-medium">{item.conversationKey}</p><p className="mt-1 text-xs text-muted-foreground">{text(`创建于 ${formatDate(item.createdAt)}`, `Created ${formatDate(item.createdAt)}`)}</p></div><div className="flex items-center gap-3"><Badge variant={item.status === "active" ? "default" : "secondary"}>{item.status === "active" ? text("接续中", "Active") : text("已结束", "Ended")}</Badge><Button size="sm" variant="outline" asChild><Link to={`/sessions/${item.sessionId}`}>{text("进入智能体会话", "Open agent session")}</Link></Button></div></div>)}</div>}</div>;
};

export const IntegrationEndpointTasksPage = () => {
  const { text, formatDate } = useI18n();
  const { endpoint } = useEndpoint();
  const [items, setItems] = useState<IntegrationTask[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { const controller = new AbortController(); void integrationApi.listTasks(endpoint.id, controller.signal).then(setItems).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); }); return () => controller.abort(); }, [endpoint.id]);
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} /><div><h2 className="text-lg font-semibold">{text("任务", "Tasks")}</h2><p className="text-sm text-muted-foreground">{text("外部请求的权威状态与最终结果。", "Authoritative status and final results for external requests.")}</p></div>{items === null ? <Skeleton className="h-40" /> : items.length === 0 ? <Card className="border-dashed"><CardContent className="py-14 text-center text-muted-foreground">{text("暂无任务。", "No tasks.")}</CardContent></Card> : <div className="divide-y rounded-xl border bg-card">{items.toReversed().map((item) => <div key={item.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><Link className="block truncate font-medium hover:underline" to={`/integration-tasks/${item.id}`}>{item.requestId}</Link><p className="mt-1 line-clamp-1 text-sm text-muted-foreground">{item.message}</p></div><div className="flex items-center gap-3"><StatusBadge status={item.status} /><time className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</time></div></div>)}</div>}</div>;
};

const endpointInUse = (reason: unknown): boolean => typeof reason === "object" && reason !== null
  && "error" in reason && typeof reason.error === "object" && reason.error !== null
  && "code" in reason.error && reason.error.code === "endpoint_in_use";

export const IntegrationEndpointSettingsPage = () => {
  const { text } = useI18n();
  const { endpoint, agents, setEndpoint } = useEndpoint();
  const navigate = useNavigate();
  const [name, setName] = useState(endpoint.name);
  const [slug, setSlug] = useState(endpoint.slug);
  const [agentId, setAgentId] = useState(String(endpoint.agentId));
  const [enabled, setEnabled] = useState(endpoint.enabled);
  const [promptPrefix, setPromptPrefix] = useState(endpoint.promptPrefix);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { const updated = await integrationApi.updateEndpoint(endpoint.id, { name: name.trim(), slug: slug.trim(), agentId: Number(agentId), enabled, promptPrefix }); setEndpoint(updated); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } };
  const rotate = async () => { setBusy(true); setError(""); try { const rotated = await integrationApi.rotateEndpointToken(endpoint.id); setEndpoint(rotated.endpoint); setToken(rotated.token); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } };
  const remove = async () => { setBusy(true); setError(""); try { await integrationApi.deleteEndpoint(endpoint.id); navigate("/integration-endpoints"); } catch (reason) { setError(endpointInUse(reason) ? text("已有业务对话或任务，请停用", "This endpoint has conversations or tasks; disable it instead") : errorMessage(reason)); setBusy(false); } };
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} />{token === "" ? null : <OneTimeSecret title={text("请立即保存，新访问令牌不会再次显示", "Save the new access token now. It will not be shown again.")} value={token} onDismiss={() => setToken("")} />}<Card><CardHeader><CardTitle className="flex items-center gap-2"><Settings2 className="size-5" />{text("基础设置", "Basic settings")}</CardTitle><CardDescription>{text("更换智能体前必须先结束接续中的业务对话。", "End active conversations before changing the agent.")}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-5" onSubmit={save}><FieldGroup><Field><FieldLabel htmlFor="settings-endpoint-name">{text("端点名称", "Endpoint name")}</FieldLabel><Input id="settings-endpoint-name" value={name} onChange={(event) => setName(event.target.value)} /></Field><Field><FieldLabel htmlFor="settings-endpoint-slug">{text("路径标识", "Slug")}</FieldLabel><Input id="settings-endpoint-slug" value={slug} onChange={(event) => setSlug(event.target.value)} /></Field><Field><FieldLabel htmlFor="settings-endpoint-agent">{text("智能体", "Agent")}</FieldLabel><NativeSelect id="settings-endpoint-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect></Field><Field><FieldLabel htmlFor="settings-prompt-prefix">{text("固定提示", "Fixed prompt")}</FieldLabel><Textarea id="settings-prompt-prefix" value={promptPrefix} onChange={(event) => setPromptPrefix(event.target.value)} /></Field><label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{text("启用接入端点", "Enable endpoint")}</label></FieldGroup><div className="flex justify-end"><Button type="submit" disabled={busy}>{busy ? text("保存中…", "Saving…") : text("保存设置", "Save settings")}</Button></div></form></CardContent></Card><Card><CardHeader><CardTitle>{text("访问令牌", "Access token")}</CardTitle><CardDescription>{text("轮换后旧访问令牌立即失效；新访问令牌只展示一次。", "Rotation immediately invalidates the old token. The new token is shown once.")}</CardDescription></CardHeader><CardContent><AlertDialog><AlertDialogTrigger asChild><Button variant="outline"><RefreshCw />{text("轮换访问令牌", "Rotate access token")}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{text("轮换端点访问令牌？", "Rotate the endpoint access token?")}</AlertDialogTitle><AlertDialogDescription>{text("外部系统必须更新为新访问令牌，旧访问令牌将立即失效。", "External systems must switch to the new token. The old token becomes invalid immediately.")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{text("取消", "Cancel")}</AlertDialogCancel><AlertDialogAction onClick={() => void rotate()}>{text("确认轮换", "Rotate")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></CardContent></Card><Card className="border-destructive/40"><CardHeader><CardTitle className="text-destructive">{text("危险操作", "Danger zone")}</CardTitle><CardDescription>{text("有业务对话或任务历史的端点不能删除，请改为停用。", "Endpoints with conversation or task history cannot be deleted. Disable them instead.")}</CardDescription></CardHeader><CardContent><AlertDialog><AlertDialogTrigger asChild><Button variant="destructive">{text("删除接入端点", "Delete endpoint")}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{text(`永久删除“${endpoint.name}”？`, `Permanently delete “${endpoint.name}”?`)}</AlertDialogTitle><AlertDialogDescription>{text("此操作无法撤销。存在历史数据时系统会拒绝删除。", "This cannot be undone. The server rejects deletion when history exists.")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{text("取消", "Cancel")}</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void remove()}>{text("确认删除", "Delete")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></CardContent></Card></div>;
};

const eventSummary = (event: RunEvent, messageLabel: string): string => {
  try {
    const value = JSON.parse(event.contentJson) as Record<string, unknown>;
    if (typeof value.title === "string") return value.title;
    if (typeof value.status === "string") return value.status;
    if (typeof value.text === "string") return `${messageLabel}：${value.text.length > 120 ? `${value.text.slice(0, 120)}…` : value.text}`;
  } catch (_error) {
    return event.contentJson;
  }
  return event.type;
};

export const IntegrationTaskDetailPage = () => {
  const { text, formatDate } = useI18n();
  const { id = "" } = useParams();
  const [task, setTask] = useState<IntegrationTask | null>(null);
  const [endpoint, setEndpoint] = useState<IntegrationEndpoint | null>(null);
  const [conversation, setConversation] = useState<IntegrationConversation | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const cancelController = useRef<AbortController | null>(null);
  useEffect(() => {
    cancelController.current?.abort();
    const controller = new AbortController();
    let disposed = false;
    let timer: number | undefined;
    setTask(null);
    setEndpoint(null);
    setConversation(null);
    setEvents([]);
    setDeliveries([]);
    setError("");
    const refresh = async () => {
      try {
        const item = await integrationApi.getTask(Number(id), controller.signal);
        if (disposed || controller.signal.aborted) return;
        const [endpointItem, conversations, deliveryItems, eventItems] = await Promise.all([
          integrationApi.getEndpoint(item.endpointId, controller.signal),
          integrationApi.listConversations(item.endpointId, controller.signal),
          integrationApi.listDeliveries(item.endpointId, controller.signal),
          item.runId === null
            ? Promise.resolve([])
            : api<RunEvent[]>(`/runs/${item.runId}/events?afterSeq=0`, { signal: controller.signal })
        ]);
        if (disposed || controller.signal.aborted) return;
        setTask(item);
        setEndpoint(endpointItem);
        setConversation(conversations.find((value) => value.id === item.conversationId) ?? null);
        setDeliveries(deliveryItems.filter((value) => value.taskId === item.id));
        setEvents(eventItems);
        if (item.status === "queued" || item.status === "running") {
          timer = window.setTimeout(() => { void refresh(); }, 1_000);
        }
      } catch (reason) {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      }
    };
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      cancelController.current?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [id, refreshKey]);
  const cancel = async () => {
    if (task === null) return;
    cancelController.current?.abort();
    const controller = new AbortController();
    cancelController.current = controller;
    setBusy(true);
    setError("");
    try {
      await integrationApi.cancelTask(task.id, controller.signal);
      if (!controller.signal.aborted) setRefreshKey((value) => value + 1);
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (cancelController.current === controller) {
        cancelController.current = null;
        setBusy(false);
      }
    }
  };
  if (task === null) return <div className="mx-auto max-w-6xl p-8"><ErrorAlert message={error} /><Skeleton className="h-12 w-80" /><Skeleton className="mt-8 h-80" /></div>;
  const terminal = task.status === "succeeded" || task.status === "failed" || task.status === "cancelled";
  return <div className="mx-auto w-full max-w-6xl p-4 sm:p-6 lg:p-8">
    <Button asChild variant="ghost" className="mb-4"><Link to={`/integration-endpoints/${task.endpointId}/tasks`}><ArrowLeft />{text("返回任务", "Back to tasks")}</Link></Button>
    <PageHeader
      title={task.requestId}
      description={endpoint === null ? String(task.endpointId) : endpoint.name}
      action={<div className="flex items-center gap-2"><StatusBadge status={task.status} />{terminal ? null : <AlertDialog>
        <AlertDialogTrigger asChild><Button size="sm" variant="destructive" disabled={busy}>{text("取消任务", "Cancel task")}</Button></AlertDialogTrigger>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{text("取消这个任务？", "Cancel this task?")}</AlertDialogTitle><AlertDialogDescription>{text("正在运行的智能体执行会停止；同一业务对话的后续任务仍可继续。", "The running agent execution will stop. Later tasks in this conversation can still continue.")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{text("返回", "Back")}</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void cancel()}>{text("确认取消", "Cancel task")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>}</div>}
    />
    <ErrorAlert message={error} />
    <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
      <div className="flex flex-col gap-5">
        <Card><CardHeader><CardTitle>{text("请求与回复", "Request and reply")}</CardTitle></CardHeader><CardContent className="flex flex-col gap-5">
          <div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{text("用户消息", "User message")}</p><p className="mt-2 whitespace-pre-wrap rounded-lg border bg-muted/20 p-4 text-sm">{task.message}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{text("智能体最终回复", "Final agent reply")}</p><p className="mt-2 whitespace-pre-wrap rounded-lg border bg-background p-4 text-sm">{task.result ?? (task.status === "failed" ? task.error ?? text("执行失败", "Execution failed") : text("尚未产生最终回复", "No final reply yet"))}</p></div>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{text("执行轨迹", "Execution trace")}</CardTitle><CardDescription>{text("完整对话仍可在关联的智能体会话中查看。", "The full conversation remains available in the linked agent session.")}</CardDescription></CardHeader><CardContent>{events.length === 0 ? <p className="text-sm text-muted-foreground">{text("尚无执行事件。", "No execution events yet.")}</p> : <div className="divide-y rounded-lg border">{events.map((event) => <div key={event.id} className="grid grid-cols-[3rem_5rem_1fr] gap-3 p-3 text-sm"><span className="font-mono text-xs text-muted-foreground">#{event.seq}</span><Badge variant="outline">{event.type}</Badge><span className="min-w-0 break-words">{eventSummary(event, text("消息", "Message"))}</span></div>)}</div>}</CardContent></Card>
        <Card><CardHeader><CardTitle>{text("事件回调投递", "Webhook deliveries")}</CardTitle></CardHeader><CardContent>{deliveries.length === 0 ? <p className="text-sm text-muted-foreground">{text("没有关联投递。", "No related deliveries.")}</p> : <div className="flex flex-col gap-2">{deliveries.map((delivery) => <div key={delivery.id} className="flex items-center justify-between rounded-lg border p-3"><span className="font-mono text-xs">{delivery.eventType}</span><DeliveryBadge status={delivery.status} /></div>)}</div>}</CardContent></Card>
      </div>
      <aside className="flex flex-col gap-4">
        <Card><CardHeader><CardTitle>{text("关联资源", "Linked resources")}</CardTitle></CardHeader><CardContent className="flex flex-col gap-4 text-sm">
          <div><p className="text-xs text-muted-foreground">{text("业务对话", "Conversation")}</p><p className="mt-1 font-mono">{conversation?.conversationKey ?? text("一次性任务", "One-time task")}</p></div>
          <div><p className="text-xs text-muted-foreground">{text("智能体会话", "Agent session")}</p><p className="mt-1 break-all font-mono text-xs">{task.sessionId}</p></div>
          <div><p className="text-xs text-muted-foreground">{text("单次执行", "Run")}</p><p className="mt-1 break-all font-mono text-xs">{task.runId ?? text("尚未创建", "Not created")}</p></div>
          <Button asChild><Link to={`/sessions/${task.sessionId}`}>{text("进入智能体会话", "Open agent session")}</Link></Button>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{text("时间", "Time")}</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
          <div><p className="text-xs text-muted-foreground">{text("创建", "Created")}</p><p>{formatDate(task.createdAt)}</p></div>
          <div><p className="text-xs text-muted-foreground">{text("开始", "Started")}</p><p>{formatDate(task.startedAt)}</p></div>
          <div><p className="text-xs text-muted-foreground">{text("结束", "Finished")}</p><p>{formatDate(task.finishedAt)}</p></div>
        </CardContent></Card>
      </aside>
    </div>
  </div>;
};
