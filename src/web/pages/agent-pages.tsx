import { FormEvent, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Bot, Cable, CheckCircle2, Copy, GitBranch, Loader2, Plus, RefreshCw, Search, Settings2, ShieldCheck, Trash2, Upload, XCircle } from "lucide-react";
import { Link, Outlet, useLocation, useNavigate, useOutletContext, useParams } from "react-router";

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
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, PageContainer, PageHeader } from "@/components/page-header";
import { TokenUsageSummaryCard } from "@/components/token-usage";
import {
  api, errorMessage, type Agent, type AgentDoctorResult, type AgentModelCatalog, type AgentModelPolicy,
  type AgentSkill, type IntegrationEndpointSummary,
  type ProjectEnvironment, type Provider, type TokenUsageSummary
} from "@/api";
import { useI18n } from "@/i18n";
import { SkillRevisionDialog, SkillSourcesDialog } from "@/components/skill-dialogs";

const providerNames: Record<Provider, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  hermes: "Hermes"
};
const maxSkillArchiveBytes = 10 * 1024 * 1024;
type SchedulePolicy = Extract<AgentModelPolicy, { mode: "schedule" }>;
type ScheduleWindow = SchedulePolicy["windows"][number];
type ModelWeekday = SchedulePolicy["windows"][number]["days"][number];
type ScheduleGroup = Pick<ScheduleWindow, "days" | "model" | "maxConcurrentRuns"> & {
  periods: Array<Pick<ScheduleWindow, "start" | "end">>;
};
const modelWeekdays: Array<{ value: ModelWeekday; zh: string; en: string; shortZh: string; shortEn: string }> = [
  { value: "mon", zh: "星期一", en: "Monday", shortZh: "一", shortEn: "Mon" },
  { value: "tue", zh: "星期二", en: "Tuesday", shortZh: "二", shortEn: "Tue" },
  { value: "wed", zh: "星期三", en: "Wednesday", shortZh: "三", shortEn: "Wed" },
  { value: "thu", zh: "星期四", en: "Thursday", shortZh: "四", shortEn: "Thu" },
  { value: "fri", zh: "星期五", en: "Friday", shortZh: "五", shortEn: "Fri" },
  { value: "sat", zh: "星期六", en: "Saturday", shortZh: "六", shortEn: "Sat" },
  { value: "sun", zh: "星期日", en: "Sunday", shortZh: "日", shortEn: "Sun" }
];
const allModelWeekdays = modelWeekdays.map(({ value }) => value);
const businessModelWeekdays = allModelWeekdays.slice(0, 5);
const weekendModelWeekdays = allModelWeekdays.slice(5);
const time24Pattern = /^([01]\d|2[0-3]):[0-5]\d$/;

const sameModelWeekdays = (left: ModelWeekday[], right: ModelWeekday[]): boolean => left.length === right.length
  && left.every((day) => right.includes(day));

const scheduleWindowsToGroups = (windows: ScheduleWindow[]): ScheduleGroup[] => windows.reduce<ScheduleGroup[]>((groups, window) => {
  const previous = groups.at(-1);
  if (previous !== undefined
    && sameModelWeekdays(previous.days, window.days)
    && previous.model === window.model
    && (previous.maxConcurrentRuns ?? null) === (window.maxConcurrentRuns ?? null)) {
    return [...groups.slice(0, -1), {
      ...previous,
      periods: [...previous.periods, { start: window.start, end: window.end }]
    }];
  }
  return [...groups, {
    days: [...window.days],
    model: window.model,
    maxConcurrentRuns: window.maxConcurrentRuns ?? null,
    periods: [{ start: window.start, end: window.end }]
  }];
}, []);

const scheduleGroupsToWindows = (groups: ScheduleGroup[]): ScheduleWindow[] => groups.flatMap((group) => group.periods.map((period) => ({
  days: [...group.days],
  model: group.model,
  maxConcurrentRuns: group.maxConcurrentRuns ?? null,
  ...period
})));

const nextSchedulePeriod = (periods: ScheduleGroup["periods"]): ScheduleGroup["periods"][number] => {
  const previousEnd = periods.at(-1)?.end ?? "12:00";
  const start = time24Pattern.test(previousEnd) ? previousEnd : "12:00";
  const hours = Number(start.slice(0, 2));
  const end = `${String((hours + 6) % 24).padStart(2, "0")}:${start.slice(3)}`;
  return { start, end };
};

const fileBase64 = (file: File, readError: string): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error(readError));
  reader.onload = () => typeof reader.result === "string"
    ? resolve(reader.result.split(",", 2)[1] ?? "")
    : reject(new Error(readError));
  reader.readAsDataURL(file);
});

const ErrorAlert = ({ message }: { message: string }) => { const { text } = useI18n(); return message === "" ? null : (
  <Alert variant="destructive"><XCircle /><AlertTitle>{text("操作失败", "Operation failed")}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>
); };

const ModelWeekdayPicker = ({ value, onChange }: {
  value: ModelWeekday[];
  onChange: (days: ModelWeekday[]) => void;
}) => {
  const { text } = useI18n();
  const selected = value;
  const selectedSet = new Set(selected);
  const matchesPreset = (days: ModelWeekday[]) => selected.length === days.length
    && days.every((day) => selectedSet.has(day));
  const toggle = (day: ModelWeekday) => {
    if (selectedSet.has(day)) {
      if (selected.length === 1) return;
      onChange(selected.filter((item) => item !== day));
      return;
    }
    onChange(allModelWeekdays.filter((item) => selectedSet.has(item) || item === day));
  };
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2"><span className="text-sm font-medium">{text("生效日（UTC）", "Active days (UTC)")}</span><Badge variant="outline">{text(`${selected.length} 天`, `${selected.length} days`)}</Badge></div>
      <div className="flex flex-wrap gap-1">
        <Button type="button" size="xs" variant={matchesPreset(businessModelWeekdays) ? "secondary" : "ghost"} onClick={() => onChange([...businessModelWeekdays])}>{text("工作日", "Weekdays")}</Button>
        <Button type="button" size="xs" variant={matchesPreset(weekendModelWeekdays) ? "secondary" : "ghost"} onClick={() => onChange([...weekendModelWeekdays])}>{text("周末", "Weekend")}</Button>
        <Button type="button" size="xs" variant={matchesPreset(allModelWeekdays) ? "secondary" : "ghost"} onClick={() => onChange([...allModelWeekdays])}>{text("每天", "Every day")}</Button>
      </div>
    </div>
    <div className="grid grid-cols-7 gap-1" role="group" aria-label={text("选择生效日", "Select active days")}>
      {modelWeekdays.map((day) => {
        const active = selectedSet.has(day.value);
        return <Button
          key={day.value}
          type="button"
          size="sm"
          variant={active ? "secondary" : "outline"}
          className="min-w-0 px-1 disabled:opacity-100"
          aria-label={text(day.zh, day.en)}
          aria-pressed={active}
          disabled={active && selected.length === 1}
          onClick={() => toggle(day.value)}
        >{text(day.shortZh, day.shortEn)}</Button>;
      })}
    </div>
  </div>;
};

export const AgentListPage = () => {
  const { text } = useI18n();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api<Agent[]>("/agents", { signal: controller.signal }),
      api<ProjectEnvironment[]>("/project-environments", { signal: controller.signal })
    ]).then(([items, projects]) => {
      setAgents(items);
      setEnvironments(projects);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    });
    return () => controller.abort();
  }, []);

  const environmentNames = useMemo(() => new Map(environments.map((item) => [item.id, item.name])), [environments]);
  const visible = (agents ?? []).filter((agent) => agent.name.toLowerCase().includes(query.trim().toLowerCase()));

  return <PageContainer width="wide">
    <PageHeader eyebrow={text("执行配置", "EXECUTION PROFILES")} title={text("智能体", "Agents")} description={text("选择一个智能体查看运行状态、管理技能或修改配置。", "Select an agent to inspect its status, manage skills, or update configuration.")}
      action={<Button asChild><Link to="/agents/new"><Plus />{text("新建智能体", "New agent")}</Link></Button>} />
    <ErrorAlert message={error} />
    <div className="mb-5 flex max-w-md items-center gap-2 rounded-xl border bg-card px-3 shadow-sm">
      <Search className="size-4 text-muted-foreground" aria-hidden="true" />
      <Input type="search" name="agent-search" aria-label={text("搜索智能体", "Search agents")} className="border-0 bg-transparent shadow-none focus-visible:ring-0" placeholder={text("按名称搜索", "Search by name")} value={query} onChange={(event) => setQuery(event.target.value)} />
      {agents === null ? null : <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground" aria-live="polite">{visible.length}</span>}
    </div>
    {agents === null ? <div className="resource-grid">{[0, 1, 2].map((item) => <Skeleton key={item} className="h-44" />)}</div>
      : visible.length === 0 ? <EmptyState icon={Bot} title={agents.length === 0 ? text("还没有智能体", "No agents yet") : text("没有匹配结果", "No matching results")} description={agents.length === 0 ? text("创建智能体并绑定项目环境，开始运行独立任务。", "Create an agent, assign a project environment, and start isolated work.") : text("调整搜索词，或清除搜索查看全部智能体。", "Change the search term or clear it to see every agent.")} action={agents.length === 0 ? <Button asChild><Link to="/agents/new"><Plus />{text("新建智能体", "New agent")}</Link></Button> : <Button variant="outline" onClick={() => setQuery("")}>{text("清除搜索", "Clear search")}</Button>} />
      : <div className="resource-grid">{visible.map((agent) => <Card key={agent.id} className="h-full transition-[border-color,box-shadow] duration-150 hover:border-primary/30 hover:shadow-sm focus-within:border-primary/40">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div><CardTitle><Link className="hover:underline" to={`/agents/${agent.id}`}>{agent.name}</Link></CardTitle><CardDescription className="mt-2">{providerNames[agent.provider]}</CardDescription></div>
            <Badge variant={agent.enabled ? "default" : "secondary"}>{agent.enabled ? text("已启用", "Enabled") : text("已停用", "Disabled")}</Badge>
          </div>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3 text-sm text-muted-foreground"><p className="min-w-0 truncate"><span className="font-medium text-foreground">{text("项目环境：", "Project environment: ")}</span>{agent.projectEnvironmentId === null ? text("未绑定", "Not assigned") : environmentNames.get(agent.projectEnvironmentId) ?? text("环境不可用", "Environment unavailable")}</p><AgentCloneDialog key={agent.id} agent={agent} /></CardContent>
      </Card>)}</div>}
  </PageContainer>;
};

export const AgentCreatePage = () => {
  const { text } = useI18n();
  const navigate = useNavigate();
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<Provider>("codex");
  const [instructions, setInstructions] = useState("");
  const [projectEnvironmentId, setProjectEnvironmentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api<ProjectEnvironment[]>("/project-environments", { signal: controller.signal }).then((items) => {
      const ready = items.filter((item) => item.currentRevisionId !== null);
      setEnvironments(ready);
      setProjectEnvironmentId(ready[0] === undefined ? "" : String(ready[0].id));
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "" || projectEnvironmentId === "") return;
    setBusy(true); setError("");
    try {
      const created = await api<Agent>("/agents", { method: "POST", body: JSON.stringify({
        name: name.trim(), provider, projectEnvironmentId: Number(projectEnvironmentId),
        instructions: provider === "hermes" ? "" : instructions
      }) });
      navigate(`/agents/${created.id}`);
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  };

  return <PageContainer width="form" className="max-w-3xl">
    <Button variant="ghost" asChild className="mb-4"><Link to="/agents"><ArrowLeft />{text("返回智能体", "Back to agents")}</Link></Button>
    <PageHeader eyebrow={text("新建执行配置", "NEW EXECUTION PROFILE")} title={text("新建智能体", "New agent")} description={text("执行器创建后不可修改；名称、项目环境、智能体指令和技能可随时调整。", "The provider cannot be changed after creation. Name, environment, instructions, and skills remain editable.")} />
    <ErrorAlert message={error} />
    <Card><CardHeader><CardTitle>{text("基础配置", "Basic configuration")}</CardTitle><CardDescription>{text("绑定一个已准备完成的项目环境。", "Assign a prepared project environment.")}</CardDescription></CardHeader>
      <CardContent><form className="flex flex-col gap-6" onSubmit={submit}><FieldGroup>
        <Field><FieldLabel htmlFor="agent-name">{text("智能体名称", "Agent name")}</FieldLabel><Input id="agent-name" name="agent-name" value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field><FieldLabel htmlFor="provider">{text("执行器", "Provider")}</FieldLabel><NativeSelect id="provider" name="provider" className="w-full" value={provider} onChange={(event) => {
          const nextProvider = event.target.value as Provider;
          setProvider(nextProvider);
          if (nextProvider === "hermes") setInstructions("");
        }}>{Object.entries(providerNames).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
        <Field data-disabled={provider === "hermes" || undefined}><FieldLabel htmlFor="agent-instructions">{text("智能体指令", "Agent instructions")}</FieldLabel><Textarea id="agent-instructions" name="agent-instructions" rows={6} value={instructions} disabled={provider === "hermes"} placeholder={text("说明这个智能体长期遵循的角色、边界和工作方式", "Describe the agent's persistent role, boundaries, and working style")} onChange={(event) => setInstructions(event.target.value)} />
          <FieldDescription>{provider === "hermes" ? text("Hermes 当前不支持智能体指令", "Hermes does not currently support agent instructions") : text("创建会话时保存快照；之后修改只影响新会话。", "Instructions are snapshotted when a session is created; later edits affect new sessions only.")}</FieldDescription>
        </Field>
        <Field><FieldLabel htmlFor="agent-environment">{text("项目环境", "Project environment")}</FieldLabel><NativeSelect id="agent-environment" name="agent-environment" className="w-full" value={projectEnvironmentId} onChange={(event) => setProjectEnvironmentId(event.target.value)}><NativeSelectOption value="" disabled>{text("请选择可用环境", "Select a ready environment")}</NativeSelectOption>{environments.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect>{environments.length === 0 ? <FieldDescription>{text("暂无已准备完成的项目环境。", "No prepared project environments.")}</FieldDescription> : null}</Field>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button variant="outline" asChild><Link to="/agents">{text("取消", "Cancel")}</Link></Button><Button type="submit" disabled={busy || projectEnvironmentId === ""}>{busy ? text("创建中…", "Creating…") : text("创建智能体", "Create agent")}</Button></div>
      </FieldGroup></form></CardContent>
    </Card>
  </PageContainer>;
};

type AgentDetailContext = { agent: Agent; setAgent(agent: Agent): void };
const useAgentDetail = () => useOutletContext<AgentDetailContext>();

const AgentCloneDialog = ({ agent }: { agent: Agent }) => {
  const { text } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${agent.name} ${text("副本", "copy")}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return;
    setBusy(true); setError("");
    try {
      const cloned = await api<Agent>(`/agents/${agent.id}/clone`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim() })
      });
      setOpen(false);
      navigate(`/agents/${cloned.id}`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button size="sm" variant="outline"><Copy />{text("复制创建", "Duplicate")}</Button></DialogTrigger>
    <DialogContent><form onSubmit={submit}>
      <DialogHeader><DialogTitle>{text("复制创建智能体", "Duplicate agent")}</DialogTitle><DialogDescription>{text("复制执行器配置、项目环境、智能体指令、技能和 MCP；不会复制会话、用量、接入端点或执行历史。", "Copies the provider configuration, environment, instructions, Skills, and MCP. Sessions, usage, endpoints, and execution history are excluded.")}</DialogDescription></DialogHeader>
      <div className="py-5"><Field><FieldLabel htmlFor="clone-agent-name">{text("新智能体名称", "New agent name")}</FieldLabel><Input id="clone-agent-name" name="clone-agent-name" value={name} onChange={(event) => setName(event.target.value)} /></Field></div>
      {error === "" ? null : <Alert variant="destructive" className="mb-4"><XCircle /><AlertTitle>{text("复制失败", "Duplication failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>{text("取消", "Cancel")}</Button><Button type="submit" disabled={busy || name.trim() === ""}>{busy ? text("复制中…", "Duplicating…") : text("创建副本", "Create copy")}</Button></DialogFooter>
    </form></DialogContent>
  </Dialog>;
};

export const AgentDetailLayout = () => {
  const { text } = useI18n();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setAgent(null); setError("");
    void api<Agent>(`/agents/${id}`, { signal: controller.signal }).then(setAgent).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [id]);
  const section = pathname.endsWith("/skills") ? "skills" : pathname.endsWith("/extensions") ? "extensions" : pathname.endsWith("/parameters") ? "parameters" : pathname.endsWith("/mcp") ? "mcp" : pathname.endsWith("/settings") ? "settings" : "overview";
  if (error !== "") return <PageContainer><ErrorAlert message={error} /><Button asChild variant="outline" className="mt-4"><Link to="/agents">{text("返回智能体", "Back to agents")}</Link></Button></PageContainer>;
  if (agent === null) return <PageContainer><Skeleton className="h-10 w-72" /><Skeleton className="mt-8 h-64" /></PageContainer>;

  return <PageContainer>
    <Button variant="ghost" asChild className="mb-4"><Link to="/agents"><ArrowLeft />{text("返回智能体", "Back to agents")}</Link></Button>
    <PageHeader eyebrow={providerNames[agent.provider]} title={agent.name} description={text("项目环境、运行检查和技能均在这个智能体范围内管理。", "Project environment, runtime checks, and skills are managed within this agent.")} action={<div className="flex items-center gap-2"><AgentCloneDialog key={agent.id} agent={agent} /><Badge variant={agent.enabled ? "default" : "secondary"}>{agent.enabled ? text("已启用", "Enabled") : text("已停用", "Disabled")}</Badge></div>} />
    <Tabs value={section} onValueChange={(value) => navigate(value === "overview" ? `/agents/${id}` : `/agents/${id}/${value}`)}>
      <TabsList variant="line" aria-label={text("智能体管理", "Agent management")}><TabsTrigger value="overview">{text("概览", "Overview")}</TabsTrigger><TabsTrigger value="skills">{text("技能", "Skills")}</TabsTrigger><TabsTrigger value="extensions">{text("扩展", "Extensions")}</TabsTrigger><TabsTrigger value="parameters">{text("会话参数", "Session parameters")}</TabsTrigger><TabsTrigger value="mcp">MCP</TabsTrigger><TabsTrigger value="settings">{text("设置", "Settings")}</TabsTrigger></TabsList>
    </Tabs>
    <div className="mt-6"><Outlet context={{ agent, setAgent } satisfies AgentDetailContext} /></div>
  </PageContainer>;
};

export const AgentOverviewPage = () => {
  const { text } = useI18n();
  const { agent, setAgent } = useAgentDetail();
  const [doctor, setDoctor] = useState<AgentDoctorResult | null>(null);
  const [endpoints, setEndpoints] = useState<IntegrationEndpointSummary[] | null>(null);
  const [endpointsError, setEndpointsError] = useState("");
  const [usage, setUsage] = useState<TokenUsageSummary | null>(null);
  const [usageError, setUsageError] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setEndpoints(null);
    setEndpointsError("");
    setUsage(null);
    setUsageError("");
    void api<IntegrationEndpointSummary[]>("/integration-endpoints", { signal: controller.signal })
      .then((items) => setEndpoints(items.filter((item) => item.agentId === agent.id)))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setEndpointsError(errorMessage(reason)); });
    void api<TokenUsageSummary>(`/agents/${agent.id}/usage`, { signal: controller.signal })
      .then(setUsage)
      .catch((reason: unknown) => { if (!controller.signal.aborted) setUsageError(errorMessage(reason)); });
    return () => controller.abort();
  }, [agent.id]);
  const toggle = async () => {
    setBusy("toggle"); setError("");
    try { setAgent(await api<Agent>(`/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !agent.enabled }) })); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };
  const runDoctor = async () => {
    setBusy("doctor"); setError("");
    try { setDoctor(await api<AgentDoctorResult>(`/agents/${agent.id}/doctor`)); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} />
    <div className="grid gap-4 md:grid-cols-2">
      <Card><CardHeader><CardTitle>{text("运行状态", "Runtime status")}</CardTitle><CardDescription>{text("控制该智能体是否允许创建新会话。", "Control whether this agent can create new sessions.")}</CardDescription></CardHeader><CardContent><Button variant={agent.enabled ? "outline" : "default"} disabled={busy !== ""} onClick={() => void toggle()}>{agent.enabled ? text("停用智能体", "Disable agent") : text("启用智能体", "Enable agent")}</Button></CardContent></Card>
      <Card><CardHeader><CardTitle>{text("运行检查", "Runtime check")}</CardTitle><CardDescription>{text("检查执行器登录与项目环境可用性。", "Check provider authentication and project environment availability.")}</CardDescription></CardHeader><CardContent><Button variant="outline" disabled={busy !== ""} onClick={() => void runDoctor()}><RefreshCw className={busy === "doctor" ? "animate-spin" : ""} />{text("运行检查", "Run check")}</Button></CardContent></Card>
    </div>
    {doctor === null ? null : <Card><CardHeader><CardTitle>{text("检查结果", "Check results")}</CardTitle></CardHeader><CardContent className="grid gap-3 md:grid-cols-2">
      {[{ label: text("执行器", "Provider"), value: doctor.provider }, { label: text("项目环境", "Project environment"), value: doctor.projectEnvironment }].map(({ label, value }) => <div key={label} className="rounded-lg border p-4"><div className="flex items-center gap-2 font-medium">{value.ok ? <CheckCircle2 className="size-4 text-primary" /> : <XCircle className="size-4 text-destructive" />}{label}</div><p className="mt-2 text-sm text-muted-foreground">{value.message}</p></div>)}
    </CardContent></Card>}
    <section aria-labelledby="agent-integration-endpoints-title">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 id="agent-integration-endpoints-title" className="font-heading text-lg font-medium">{text("外部调用入口", "External entry points")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{text("外部系统通过接入端点的路径标识调用这个智能体。", "External systems call this agent through an integration endpoint slug.")}</p>
        </div>
        {endpoints !== null && endpoints.length > 0 ? <Button size="sm" variant="outline" asChild><Link to={`/integration-endpoints/new?agentId=${agent.id}`}><Plus />{text("创建接入端点", "Create endpoint")}</Link></Button> : null}
      </div>
      {endpointsError !== "" ? <Alert variant="destructive"><XCircle /><AlertTitle>{text("调用入口加载失败", "Failed to load entry points")}</AlertTitle><AlertDescription>{endpointsError}</AlertDescription></Alert>
        : endpoints === null ? <Skeleton className="h-32" />
          : endpoints.length === 0 ? <Card className="border-dashed"><CardContent className="flex flex-col items-center gap-3 py-10 text-center"><span className="grid size-10 place-items-center rounded-full bg-muted"><Cable className="size-5 text-muted-foreground" /></span><div><p className="font-medium">{text("尚未配置外部调用入口", "No external entry point")}</p><p className="mt-1 text-sm text-muted-foreground">{text("智能体不能被外部系统直接调用，需要先创建接入端点。", "Agents cannot be called directly by external systems. Create an integration endpoint first.")}</p></div><Button asChild><Link to={`/integration-endpoints/new?agentId=${agent.id}`}><Plus />{text("创建接入端点", "Create endpoint")}</Link></Button></CardContent></Card>
            : <div className="divide-y rounded-xl border bg-card">{endpoints.map((endpoint) => <div key={endpoint.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex items-center gap-2"><p className="truncate font-medium">{endpoint.name}</p><Badge variant={endpoint.enabled ? "default" : "secondary"}>{endpoint.enabled ? text("已启用", "Enabled") : text("已停用", "Disabled")}</Badge></div><p className="mt-1 font-mono text-sm text-muted-foreground">/{endpoint.slug}</p></div><div className="flex shrink-0 flex-wrap gap-2"><Button size="sm" variant="ghost" asChild><Link to={`/integration-endpoints/${endpoint.id}/usage`}>{text("调用说明", "Usage")}</Link></Button><Button size="sm" variant="outline" asChild><Link to={`/integration-endpoints/${endpoint.id}`}>{text("管理端点", "Manage endpoint")}</Link></Button></div></div>)}</div>}
    </section>
    <section aria-labelledby="agent-token-usage-title">
      <h2 id="agent-token-usage-title" className="mb-3 font-heading text-lg font-medium">{text("Token 用量", "Token usage")}</h2>
      {usageError !== "" ? <Alert variant="destructive"><XCircle /><AlertTitle>{text("用量加载失败", "Failed to load usage")}</AlertTitle><AlertDescription>{usageError}</AlertDescription></Alert>
        : usage === null ? <Skeleton className="h-40" />
          : <TokenUsageSummaryCard title={text("累计", "Cumulative")} summary={usage} />}
    </section>
  </div>;
};

export const AgentSkillsPage = () => {
  const { text } = useI18n();
  const { agent } = useAgentDetail();
  const [skills, setSkills] = useState<AgentSkill[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const reload = async () => setSkills(await api<AgentSkill[]>(`/agents/${agent.id}/skills`));
  useEffect(() => {
    const controller = new AbortController();
    void api<AgentSkill[]>(`/agents/${agent.id}/skills`, { signal: controller.signal }).then(setSkills).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [agent.id]);
  const visible = (skills ?? [])
    .filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase()))
    .toSorted((left, right) => Number(right.enabled) - Number(left.enabled));
  const toggle = async (skill: AgentSkill) => {
    setBusy(skill.id); setError("");
    try {
      const updated = await api<AgentSkill>(`/agents/${agent.id}/skills/${skill.id}`, { method: "PUT", body: JSON.stringify({ enabled: !skill.enabled }) });
      setSkills((current) => (current ?? []).map((item) => item.id === updated.id ? updated : item));
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };
  const remove = async (skill: AgentSkill, scope: "current" | "all") => {
    setBusy(`delete-${skill.id}`); setError("");
    try {
      await api(`/agents/${agent.id}/skills/${encodeURIComponent(skill.id)}?scope=${scope}`, { method: "DELETE" });
      await reload();
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };
  const upload = async (file: File | undefined, input: HTMLInputElement, skill?: AgentSkill) => {
    if (file === undefined) return;
    if (!file.name.toLowerCase().endsWith(".zip") || file.size > maxSkillArchiveBytes) { setError(text("请选择不超过 10 MB 的技能 ZIP 文件", "Select a Skill ZIP file no larger than 10 MB")); input.value = ""; return; }
    setBusy(skill === undefined ? "upload" : `upload-${skill.id}`); setError("");
    try {
      await api<AgentSkill>(`/agents/${agent.id}/skills/${skill === undefined ? "upload" : `${encodeURIComponent(skill.id)}/upload`}`, { method: "POST", body: JSON.stringify({ fileName: file.name, contentBase64: await fileBase64(file, text("读取 ZIP 失败", "Failed to read ZIP")) }) });
      await reload();
    } catch (reason) { setError(errorMessage(reason)); } finally { input.value = ""; setBusy(""); }
  };
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} />
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative max-w-sm flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label={text("搜索技能", "Search skills")} className="pl-9" placeholder={text("搜索名称或说明", "Search name or description")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className="flex flex-wrap gap-2"><SkillSourcesDialog disabled={busy !== ""} onChanged={reload} /><Button variant="outline" asChild><label><Upload />{busy === "upload" ? text("上传中…", "Uploading…") : text("上传 ZIP 到共享库", "Upload ZIP to shared library")}<input className="sr-only" type="file" accept=".zip,application/zip" disabled={busy !== ""} onChange={(event) => void upload(event.target.files?.[0], event.currentTarget)} /></label></Button></div>
    </div>
    <p className="text-sm text-muted-foreground">{text(`已启用 ${(skills ?? []).filter((item) => item.enabled).length} / ${(skills ?? []).length}。配置会在下一次运行生效。`, `${(skills ?? []).filter((item) => item.enabled).length} / ${(skills ?? []).length} enabled. Changes apply to the next run.`)}</p>
    {skills === null ? <Skeleton className="h-64" /> : visible.length === 0 ? <EmptyState icon={Search} title={query.trim() === "" ? text("还没有可用技能", "No skills available") : text("没有匹配的技能", "No matching skills")} description={query.trim() === "" ? text("从执行器目录发现技能，上传 ZIP 或添加 Git 来源。", "Discover skills, upload a ZIP, or add a Git source.") : text("尝试更短的关键词，或清除搜索条件。", "Try a shorter keyword or clear the search.")} action={query.trim() === "" ? undefined : <Button type="button" variant="outline" onClick={() => setQuery("")}>{text("清除搜索", "Clear search")}</Button>} /> : <div className="surface-list divide-y rounded-xl border bg-card">{visible.map((skill) => { const source = ({ codex: "Codex", agents: text("共享目录", "Shared directory"), claude: "Claude", plugin: text("插件", "Plugin"), upload: text("已上传", "Uploaded"), git: "Git", missing: text("来源已移除", "Source removed") } satisfies Record<AgentSkill["source"], string>)[skill.source]; return <div key={skill.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-medium">{skill.name}</p><Badge variant="outline">{source}</Badge>{skill.updateAvailable ? <Badge>{text("有更新", "Update available")}</Badge> : null}{skill.locallyModified ? <Badge variant="destructive">{text("本地已修改", "Locally modified")}</Badge> : null}{!skill.available ? <Badge variant="destructive">{text("不可用", "Unavailable")}</Badge> : null}</div><p className="mt-1 line-clamp-1 text-sm text-muted-foreground" title={skill.description || text("暂无说明", "No description")}>{skill.description || text("暂无说明", "No description")}</p></div><div className="flex shrink-0 flex-wrap gap-2"><Button size="sm" variant={skill.enabled ? "outline" : "default"} disabled={busy !== "" || (!skill.available && !skill.enabled)} onClick={() => void toggle(skill)}>{skill.enabled ? text("停用", "Disable") : text("启用", "Enable")}</Button><SkillRevisionDialog agentId={agent.id} skill={skill} disabled={busy !== ""} onApplied={reload} />{skill.source === "upload" ? <Button size="sm" variant="outline" asChild><label><Upload />{text("上传新版本", "Upload new version")}<input className="sr-only" type="file" accept=".zip,application/zip" aria-label={text(`为 ${skill.name} 上传新版本`, `Upload a new version of ${skill.name}`)} disabled={busy !== ""} onChange={(event) => void upload(event.target.files?.[0], event.currentTarget, skill)} /></label></Button> : null}{skill.enabled || skill.source === "upload" ? <AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="ghost" disabled={busy !== ""} aria-label={text(`删除 ${skill.name}`, `Delete ${skill.name}`)}><Trash2 />{text("删除", "Delete")}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{text(`删除“${skill.name}”？`, `Delete “${skill.name}”?`)}</AlertDialogTitle><AlertDialogDescription>{text("仅删除当前副本只影响当前智能体；从所有智能体删除会同时删除共享上传源和全部副本。", "Deleting only the current copy affects this agent. Deleting from all agents also removes the shared upload and every copy.")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{text("取消", "Cancel")}</AlertDialogCancel>{skill.enabled ? <AlertDialogAction variant="outline" onClick={() => void remove(skill, "current")}>{text("仅删除当前", "Current agent only")}</AlertDialogAction> : null}{skill.source === "upload" ? <AlertDialogAction variant="destructive" onClick={() => void remove(skill, "all")}>{text("从所有智能体删除", "Delete from all agents")}</AlertDialogAction> : null}</AlertDialogFooter></AlertDialogContent></AlertDialog> : null}</div></div>; })}</div>}
  </div>;
};

export const AgentSettingsPage = () => {
  const { text } = useI18n();
  const { agent, setAgent } = useAgentDetail();
  const navigate = useNavigate();
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
  const [name, setName] = useState(agent.name);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [projectEnvironmentId, setProjectEnvironmentId] = useState(agent.projectEnvironmentId ?? "");
  const [concurrencyMode, setConcurrencyMode] = useState(agent.maxConcurrentRuns == null ? "inherit" : "custom");
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(String(agent.maxConcurrentRuns ?? agent.effectiveMaxConcurrentRuns ?? ""));
  const [modelCatalog, setModelCatalog] = useState<AgentModelCatalog | null>(null);
  const [modelCatalogError, setModelCatalogError] = useState("");
  const [modelPolicy, setModelPolicy] = useState<AgentModelPolicy>(agent.modelPolicy ?? { mode: "provider_default" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<ProjectEnvironment[]>("/project-environments", { signal: controller.signal }).then((items) => setEnvironments(items.filter((item) => item.currentRevisionId !== null))).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    void api<AgentModelCatalog>(`/agents/${agent.id}/models`, { signal: controller.signal })
      .then(setModelCatalog)
      .catch((reason: unknown) => { if (!controller.signal.aborted) setModelCatalogError(errorMessage(reason)); });
    return () => controller.abort();
  }, [agent.id]);
  const availableModels = modelCatalog?.availableModels ?? [];
  const selectableModels = modelCatalog?.supported === true && availableModels.length > 0;
  const selectedPolicyModels = modelPolicy.mode === "provider_default" ? [] : modelPolicy.mode === "fixed"
    ? [modelPolicy.model]
    : [modelPolicy.defaultModel, ...modelPolicy.windows.map((window) => window.model)];
  const policyModelsAvailable = modelPolicy.mode === "provider_default"
    || (selectableModels && selectedPolicyModels.every((model) => availableModels.includes(model)));
  const scheduleGroups = modelPolicy.mode === "schedule" ? scheduleWindowsToGroups(modelPolicy.windows) : [];
  const scheduleValid = modelPolicy.mode !== "schedule" || (modelPolicy.windows.length > 0
    && modelPolicy.windows.every((window) => time24Pattern.test(window.start) && time24Pattern.test(window.end)
      && window.start !== window.end && window.days.length > 0
      && (window.maxConcurrentRuns == null || (Number.isInteger(window.maxConcurrentRuns)
        && window.maxConcurrentRuns >= 1 && window.maxConcurrentRuns <= 64))));
  const modelPolicyValid = policyModelsAvailable && scheduleValid;
  const updateScheduleGroups = (update: (groups: ScheduleGroup[]) => ScheduleGroup[]): void => {
    setModelPolicy((current) => current.mode === "schedule"
      ? { ...current, windows: scheduleGroupsToWindows(update(scheduleWindowsToGroups(current.windows))) }
      : current);
  };
  const setModelMode = (mode: AgentModelPolicy["mode"]): void => {
    if (mode === "provider_default") {
      setModelPolicy({ mode });
      return;
    }
    const defaultModel = modelCatalog?.currentModel !== null && modelCatalog?.currentModel !== undefined
      && availableModels.includes(modelCatalog.currentModel)
      ? modelCatalog.currentModel
      : availableModels[0];
    if (defaultModel === undefined) return;
    setModelPolicy(mode === "fixed"
      ? { mode, model: defaultModel }
      : { mode, defaultModel, windows: [{
        days: [...allModelWeekdays], start: "00:00", end: "12:00", model: defaultModel, maxConcurrentRuns: null
      }] });
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const customLimit = Number(maxConcurrentRuns);
    if (name.trim() === "" || projectEnvironmentId === "" || !modelPolicyValid || (concurrencyMode === "custom" && (!Number.isInteger(customLimit) || customLimit < 1 || customLimit > 64))) return;
    setBusy("save"); setError("");
    try { setAgent(await api<Agent>(`/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({
      name: name.trim(), projectEnvironmentId,
      instructions: agent.provider === "hermes" ? "" : instructions,
      maxConcurrentRuns: concurrencyMode === "inherit" ? null : customLimit,
      modelPolicy
    }) })); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };
  const remove = async () => {
    setBusy("delete"); setError("");
    try { await api(`/agents/${agent.id}`, { method: "DELETE" }); navigate("/agents"); }
    catch (reason) { setError(errorMessage(reason)); setBusy(""); }
  };
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} />
    <Card><CardHeader><CardTitle>{text("智能体设置", "Agent settings")}</CardTitle><CardDescription>{text("执行器是运行身份，创建后不允许修改。", "The provider is the execution identity and cannot be changed after creation.")}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-5" onSubmit={save}><FieldGroup>
      <Field><FieldLabel htmlFor="settings-agent-name">{text("名称", "Name")}</FieldLabel><Input id="settings-agent-name" value={name} onChange={(event) => setName(event.target.value)} /></Field>
      <Field data-disabled><FieldLabel htmlFor="settings-provider">{text("执行器", "Provider")}</FieldLabel><Input id="settings-provider" value={providerNames[agent.provider]} disabled /></Field>
      <Field><FieldLabel htmlFor="settings-environment">{text("项目环境", "Project environment")}</FieldLabel><NativeSelect id="settings-environment" className="w-full" value={projectEnvironmentId} onChange={(event) => setProjectEnvironmentId(event.target.value)}>{environments.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect></Field>
      <Field><FieldLabel htmlFor="settings-concurrency-mode">{text("运行并发策略", "Run concurrency policy")}</FieldLabel><NativeSelect id="settings-concurrency-mode" className="w-full" value={concurrencyMode} onChange={(event) => setConcurrencyMode(event.target.value)}><NativeSelectOption value="inherit">{text("继承系统上限", "Inherit system limit")}</NativeSelectOption><NativeSelectOption value="custom">{text("自定义上限", "Custom limit")}</NativeSelectOption></NativeSelect><FieldDescription>{text(`当前有效上限：${agent.effectiveMaxConcurrentRuns}`, `Current effective limit: ${agent.effectiveMaxConcurrentRuns}`)}</FieldDescription></Field>
      {concurrencyMode === "custom" ? <Field><FieldLabel htmlFor="settings-max-concurrent-runs">{text("自定义 Run 并发上限", "Custom run concurrency limit")}</FieldLabel><Input id="settings-max-concurrent-runs" type="number" min={1} max={64} step={1} value={maxConcurrentRuns} onChange={(event) => setMaxConcurrentRuns(event.target.value)} /><FieldDescription>{text("最终有效值不会超过系统的全局 Run 并发上限。", "The effective value never exceeds the global run concurrency limit.")}</FieldDescription></Field> : null}
      <div className="rounded-xl border bg-muted/20 p-4 sm:p-5">
        <div className="mb-4">
          <h3 className="font-semibold">{text("模型策略", "Model policy")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{text("模型列表自动读取自 Agent Core。星期和时间统一使用 UTC，并在 Run 真正开始时选择；不会中断正在执行的 Run。", "Models are read from Agent Core. UTC weekdays and times are resolved when a Run actually starts and never interrupt an active Run.")}</p>
        </div>
        <div className="flex flex-col gap-4">
          <Field><FieldLabel htmlFor="settings-model-mode">{text("选择方式", "Selection mode")}</FieldLabel><NativeSelect id="settings-model-mode" className="w-full" value={modelPolicy.mode} disabled={modelCatalog === null && modelCatalogError === ""} onChange={(event) => setModelMode(event.target.value as AgentModelPolicy["mode"])}>
            <NativeSelectOption value="provider_default">{text("跟随 Agent Core 默认模型", "Follow Agent Core default")}</NativeSelectOption>
            <NativeSelectOption value="fixed" disabled={!selectableModels}>{text("固定模型", "Fixed model")}</NativeSelectOption>
            <NativeSelectOption value="schedule" disabled={!selectableModels}>{text("按 UTC 星期和时间切换", "Switch by UTC day and time")}</NativeSelectOption>
          </NativeSelect>
          {modelCatalog === null && modelCatalogError === "" ? <FieldDescription>{text("正在读取 Agent Core 模型…", "Loading models from Agent Core…")}</FieldDescription>
            : modelCatalogError !== "" ? <FieldDescription className="text-destructive">{text(`Agent Core 模型读取失败：${modelCatalogError}`, `Failed to read Agent Core models: ${modelCatalogError}`)}</FieldDescription>
            : !selectableModels ? <FieldDescription>{text("当前 Agent Core 没有暴露可选模型，因此不支持固定模型或定时切换。", "This Agent Core does not expose selectable models, so fixed and scheduled selection are unavailable.")}</FieldDescription>
            : <FieldDescription>{text(`Core 默认：${modelCatalog.currentModel ?? "未知"}；可选 ${availableModels.length} 个模型。`, `Core default: ${modelCatalog.currentModel ?? "unknown"}; ${availableModels.length} models available.`)}</FieldDescription>}
          </Field>
          {modelPolicy.mode === "fixed" ? <Field><FieldLabel htmlFor="settings-fixed-model">{text("模型", "Model")}</FieldLabel><NativeSelect id="settings-fixed-model" className="w-full" value={modelPolicy.model} onChange={(event) => setModelPolicy({ mode: "fixed", model: event.target.value })}>{availableModels.map((model) => <NativeSelectOption key={model} value={model}>{model}</NativeSelectOption>)}</NativeSelect></Field> : null}
          {modelPolicy.mode === "schedule" ? <div className="flex flex-col gap-4">
            <Field><FieldLabel htmlFor="settings-default-model">{text("其他时间使用", "Model outside windows")}</FieldLabel><NativeSelect id="settings-default-model" className="w-full" value={modelPolicy.defaultModel} onChange={(event) => setModelPolicy({ ...modelPolicy, defaultModel: event.target.value })}>{availableModels.map((model) => <NativeSelectOption key={model} value={model}>{model}</NativeSelectOption>)}</NativeSelect></Field>
            <div className="flex flex-col gap-3"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><p className="text-sm font-medium">{text("UTC 规则组", "UTC rule groups")}</p><Badge variant="outline">{text(`${scheduleGroups.length} 组`, `${scheduleGroups.length} groups`)}</Badge></div><p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{text("每组统一设置生效日、模型和 Run 并发，并可添加多个时间段。结束早于开始时跨到下一 UTC 日；规则组重叠时上方优先。", "Each group shares active days, model, and run concurrency across multiple time windows. An end earlier than its start crosses into the next UTC day; earlier groups take priority when they overlap.")}</p></div><Button type="button" size="sm" variant="outline" disabled={modelPolicy.windows.length >= 16} onClick={() => updateScheduleGroups((groups) => {
              const previous = groups.at(-1);
              const nextModel = availableModels.find((model) => model !== previous?.model) ?? previous?.model ?? modelPolicy.defaultModel;
              const nextDays = previous !== undefined && nextModel === previous.model
                ? (sameModelWeekdays(previous.days, businessModelWeekdays) ? weekendModelWeekdays : businessModelWeekdays)
                : previous?.days ?? allModelWeekdays;
              return [...groups, {
                days: [...nextDays],
                model: nextModel,
                maxConcurrentRuns: previous?.maxConcurrentRuns ?? null,
                periods: [{ start: "12:00", end: "18:00" }]
              }];
            })}><Plus />{text("添加规则组", "Add rule group")}</Button></div>
              {scheduleGroups.map((group, groupIndex) => <div key={groupIndex} className="overflow-hidden rounded-xl border bg-background shadow-xs">
                <div className="flex items-center justify-between gap-3 border-b bg-muted/20 px-4 py-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2"><Badge>{text(`规则 ${groupIndex + 1}`, `Rule ${groupIndex + 1}`)}</Badge><span className="truncate text-sm font-medium">{group.model}</span><span className="text-xs text-muted-foreground">{text(`${group.days.length} 天 · ${group.periods.length} 个时间段`, `${group.days.length} days · ${group.periods.length} windows`)}</span></div>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={text(`删除规则 ${groupIndex + 1}`, `Delete rule ${groupIndex + 1}`)} disabled={scheduleGroups.length === 1} onClick={() => updateScheduleGroups((groups) => groups.filter((_item, itemIndex) => itemIndex !== groupIndex))}><Trash2 /></Button>
                </div>
                <div className="grid gap-5 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,1fr)]">
                  <div className="flex min-w-0 flex-col gap-4">
                    <ModelWeekdayPicker value={group.days} onChange={(days) => updateScheduleGroups((groups) => groups.map((item, itemIndex) => itemIndex === groupIndex ? { ...item, days } : item))} />
                    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(150px,0.55fr)]">
                      <Field><FieldLabel htmlFor={`settings-group-model-${groupIndex}`}>{text("模型", "Model")}</FieldLabel><NativeSelect id={`settings-group-model-${groupIndex}`} className="w-full" value={group.model} onChange={(event) => updateScheduleGroups((groups) => groups.map((item, itemIndex) => itemIndex === groupIndex ? { ...item, model: event.target.value } : item))}>{availableModels.map((model) => <NativeSelectOption key={model} value={model}>{model}</NativeSelectOption>)}</NativeSelect></Field>
                      <Field><FieldLabel htmlFor={`settings-group-concurrency-${groupIndex}`}>{text("Run 并发上限", "Run concurrency limit")}</FieldLabel><Input id={`settings-group-concurrency-${groupIndex}`} type="number" min={1} max={64} step={1} placeholder={text("继承默认", "Use default")} value={group.maxConcurrentRuns ?? ""} onChange={(event) => {
                        const value = event.target.value;
                        updateScheduleGroups((groups) => groups.map((item, itemIndex) => itemIndex === groupIndex ? {
                          ...item,
                          maxConcurrentRuns: value === "" ? null : Number(value)
                        } : item));
                      }} /></Field>
                    </div>
                  </div>
                  <div className="overflow-hidden rounded-lg border bg-muted/10">
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5"><div><p className="text-sm font-medium">{text("时间段（UTC · 24h）", "Time windows (UTC · 24h)")}</p><p className="mt-0.5 text-xs text-muted-foreground">{text("本组所有时间段共用模型和并发", "All windows in this group share its model and concurrency")}</p></div><Button type="button" size="xs" variant="outline" aria-label={text(`为规则 ${groupIndex + 1} 添加时间段`, `Add time window to rule ${groupIndex + 1}`)} disabled={modelPolicy.windows.length >= 16} onClick={() => updateScheduleGroups((groups) => groups.map((item, itemIndex) => itemIndex === groupIndex ? { ...item, periods: [...item.periods, nextSchedulePeriod(item.periods)] } : item))}><Plus />{text("添加", "Add")}</Button></div>
                    <div className="divide-y border-t">{group.periods.map((period, periodIndex) => <div key={periodIndex} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                      <Field><FieldLabel htmlFor={`settings-model-start-${groupIndex}-${periodIndex}`}>{text("开始（UTC · 24h）", "Start (UTC · 24h)")}</FieldLabel><Input id={`settings-model-start-${groupIndex}-${periodIndex}`} type="text" inputMode="numeric" pattern="([01][0-9]|2[0-3]):[0-5][0-9]" maxLength={5} placeholder="08:00" value={period.start} onChange={(event) => updateScheduleGroups((groups) => groups.map((item, itemIndex) => itemIndex === groupIndex ? { ...item, periods: item.periods.map((entry, entryIndex) => entryIndex === periodIndex ? { ...entry, start: event.target.value } : entry) } : item))} /></Field>
                      <Field><FieldLabel htmlFor={`settings-model-end-${groupIndex}-${periodIndex}`}>{text("结束（UTC · 24h）", "End (UTC · 24h)")}</FieldLabel><Input id={`settings-model-end-${groupIndex}-${periodIndex}`} type="text" inputMode="numeric" pattern="([01][0-9]|2[0-3]):[0-5][0-9]" maxLength={5} placeholder="20:00" value={period.end} onChange={(event) => updateScheduleGroups((groups) => groups.map((item, itemIndex) => itemIndex === groupIndex ? { ...item, periods: item.periods.map((entry, entryIndex) => entryIndex === periodIndex ? { ...entry, end: event.target.value } : entry) } : item))} /></Field>
                      <Button type="button" variant="ghost" size="icon-sm" className="justify-self-end" aria-label={text(`删除规则 ${groupIndex + 1} 的时间段 ${periodIndex + 1}`, `Delete window ${periodIndex + 1} from rule ${groupIndex + 1}`)} disabled={group.periods.length === 1} onClick={() => updateScheduleGroups((groups) => groups.map((item, itemIndex) => itemIndex === groupIndex ? { ...item, periods: item.periods.filter((_entry, entryIndex) => entryIndex !== periodIndex) } : item))}><Trash2 /></Button>
                    </div>)}</div>
                  </div>
                </div>
              </div>)}
              {!scheduleValid ? <p className="text-sm text-destructive" role="alert" aria-live="polite">{text("请为每个规则组选择生效日，为时间段填写两个不同的 UTC 时间，并将并发上限留空或设为 1–64。", "Choose active days for every group, enter two different UTC times per window, and leave the concurrency limit empty or set it to 1–64.")}</p> : null}
            </div>
          </div> : null}
          {!policyModelsAvailable ? <p className="text-sm text-destructive">{text("当前策略引用的模型已不在 Agent Core 模型列表中。请选择 Core 默认模型或重新选择可用模型。", "The current policy references models no longer exposed by Agent Core. Follow the Core default or choose available models again.")}</p> : null}
        </div>
      </div>
      <Field data-disabled={agent.provider === "hermes" || undefined}><FieldLabel htmlFor="settings-agent-instructions">{text("智能体指令", "Agent instructions")}</FieldLabel><Textarea id="settings-agent-instructions" rows={8} value={instructions} disabled={agent.provider === "hermes"} placeholder={text("说明这个智能体长期遵循的角色、边界和工作方式", "Describe the agent's persistent role, boundaries, and working style")} onChange={(event) => setInstructions(event.target.value)} />
        <FieldDescription>{agent.provider === "hermes" ? text("Hermes 当前不支持智能体指令", "Hermes does not currently support agent instructions") : text("创建会话时保存快照；之后修改只影响新会话。", "Instructions are snapshotted at session creation; later edits affect new sessions only.")}</FieldDescription>
      </Field>
      <Button type="submit" disabled={busy !== "" || !modelPolicyValid || (concurrencyMode === "custom" && (!Number.isInteger(Number(maxConcurrentRuns)) || Number(maxConcurrentRuns) < 1 || Number(maxConcurrentRuns) > 64))}>{busy === "save" ? text("保存中…", "Saving…") : text("保存设置", "Save settings")}</Button>
    </FieldGroup></form></CardContent></Card>
    <Card className="border-destructive/40"><CardHeader><CardTitle className="flex items-center gap-2 text-destructive"><ShieldCheck className="size-5" />{text("危险操作", "Danger zone")}</CardTitle><CardDescription>{text("只有从未创建过会话的智能体才能删除；否则请停用智能体。", "Only agents with no sessions can be deleted. Disable the agent otherwise.")}</CardDescription></CardHeader><CardContent>
      <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive" disabled={busy !== ""}>{text("删除智能体", "Delete agent")}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{text(`确定删除“${agent.name}”？`, `Delete “${agent.name}”?`)}</AlertDialogTitle><AlertDialogDescription>{text("智能体配置和专属目录会被永久删除。已有会话时服务端会拒绝此操作。", "The agent configuration and private directory will be permanently deleted. The server rejects deletion when sessions exist.")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{text("取消", "Cancel")}</AlertDialogCancel><AlertDialogAction onClick={() => void remove()}>{text("确认删除", "Delete")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </CardContent></Card>
  </div>;
};
