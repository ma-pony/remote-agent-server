import { FormEvent, useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, Plus, RefreshCw, Search, Settings2, ShieldCheck, Upload, XCircle } from "lucide-react";
import { Link, Outlet, useLocation, useNavigate, useOutletContext, useParams } from "react-router";

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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/page-header";
import { TokenUsageSummaryCard } from "@/components/token-usage";
import {
  api, errorMessage, type Agent, type AgentDoctorResult, type AgentSkill,
  type ProjectEnvironment, type Provider, type TokenUsageSummary
} from "@/api";
import { useI18n } from "@/i18n";

const providerNames: Record<Provider, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  hermes: "Hermes"
};
const maxSkillArchiveBytes = 10 * 1024 * 1024;

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

  return <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
    <PageHeader eyebrow={text("执行配置", "EXECUTION PROFILES")} title={text("智能体", "Agents")} description={text("选择一个智能体查看运行状态、管理技能或修改配置。", "Select an agent to inspect its status, manage skills, or update configuration.")}
      action={<Button asChild><Link to="/agents/new"><Plus />{text("新建智能体", "New agent")}</Link></Button>} />
    <ErrorAlert message={error} />
    <div className="mb-5 flex max-w-sm items-center gap-2 rounded-lg border bg-card px-3">
      <Search className="size-4 text-muted-foreground" aria-hidden="true" />
      <Input aria-label={text("搜索智能体", "Search agents")} className="border-0 bg-transparent shadow-none focus-visible:ring-0" placeholder={text("按名称搜索", "Search by name")} value={query} onChange={(event) => setQuery(event.target.value)} />
    </div>
    {agents === null ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((item) => <Skeleton key={item} className="h-44" />)}</div>
      : visible.length === 0 ? <Card className="border-dashed"><CardContent className="py-16 text-center text-muted-foreground">{agents.length === 0 ? text("暂无智能体，先创建一个执行入口。", "No agents yet. Create an execution profile first.") : text("没有匹配的智能体。", "No matching agents.")}</CardContent></Card>
      : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visible.map((agent) => <Card key={agent.id} className="transition-colors hover:border-primary/50">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div><CardTitle><Link className="hover:underline" to={`/agents/${agent.id}`}>{agent.name}</Link></CardTitle><CardDescription className="mt-2">{providerNames[agent.provider]}</CardDescription></div>
            <Badge variant={agent.enabled ? "default" : "secondary"}>{agent.enabled ? text("已启用", "Enabled") : text("已停用", "Disabled")}</Badge>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground"><span className="font-medium text-foreground">{text("项目环境：", "Project environment: ")}</span>{agent.projectEnvironmentId === null ? text("未绑定", "Not assigned") : environmentNames.get(agent.projectEnvironmentId) ?? text("环境不可用", "Environment unavailable")}</CardContent>
      </Card>)}</div>}
  </div>;
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
      setProjectEnvironmentId(ready[0]?.id ?? "");
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "" || projectEnvironmentId === "") return;
    setBusy(true); setError("");
    try {
      const created = await api<Agent>("/agents", { method: "POST", body: JSON.stringify({
        name: name.trim(), provider, projectEnvironmentId,
        instructions: provider === "hermes" ? "" : instructions
      }) });
      navigate(`/agents/${created.id}`);
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  };

  return <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
    <Button variant="ghost" asChild className="mb-4"><Link to="/agents"><ArrowLeft />{text("返回智能体", "Back to agents")}</Link></Button>
    <PageHeader eyebrow={text("新建执行配置", "NEW EXECUTION PROFILE")} title={text("新建智能体", "New agent")} description={text("执行器创建后不可修改；名称、项目环境、智能体指令和技能可随时调整。", "The provider cannot be changed after creation. Name, environment, instructions, and skills remain editable.")} />
    <ErrorAlert message={error} />
    <Card><CardHeader><CardTitle>{text("基础配置", "Basic configuration")}</CardTitle><CardDescription>{text("绑定一个已准备完成的项目环境。", "Assign a prepared project environment.")}</CardDescription></CardHeader>
      <CardContent><form className="flex flex-col gap-6" onSubmit={submit}><FieldGroup>
        <Field><FieldLabel htmlFor="agent-name">{text("智能体名称", "Agent name")}</FieldLabel><Input id="agent-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus /></Field>
        <Field><FieldLabel htmlFor="provider">{text("执行器", "Provider")}</FieldLabel><NativeSelect id="provider" className="w-full" value={provider} onChange={(event) => {
          const nextProvider = event.target.value as Provider;
          setProvider(nextProvider);
          if (nextProvider === "hermes") setInstructions("");
        }}>{Object.entries(providerNames).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
        <Field data-disabled={provider === "hermes" || undefined}><FieldLabel htmlFor="agent-instructions">{text("智能体指令", "Agent instructions")}</FieldLabel><Textarea id="agent-instructions" rows={6} value={instructions} disabled={provider === "hermes"} placeholder={text("说明这个智能体长期遵循的角色、边界和工作方式", "Describe the agent's persistent role, boundaries, and working style")} onChange={(event) => setInstructions(event.target.value)} />
          <FieldDescription>{provider === "hermes" ? text("Hermes 当前不支持智能体指令", "Hermes does not currently support agent instructions") : text("创建会话时保存快照；之后修改只影响新会话。", "Instructions are snapshotted when a session is created; later edits affect new sessions only.")}</FieldDescription>
        </Field>
        <Field><FieldLabel htmlFor="agent-environment">{text("项目环境", "Project environment")}</FieldLabel><NativeSelect id="agent-environment" className="w-full" value={projectEnvironmentId} onChange={(event) => setProjectEnvironmentId(event.target.value)}><NativeSelectOption value="" disabled>{text("请选择可用环境", "Select a ready environment")}</NativeSelectOption>{environments.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect>{environments.length === 0 ? <FieldDescription>{text("暂无已准备完成的项目环境。", "No prepared project environments.")}</FieldDescription> : null}</Field>
        <div className="flex justify-end gap-2"><Button variant="outline" asChild><Link to="/agents">{text("取消", "Cancel")}</Link></Button><Button type="submit" disabled={busy || projectEnvironmentId === ""}>{busy ? text("创建中…", "Creating…") : text("创建智能体", "Create agent")}</Button></div>
      </FieldGroup></form></CardContent>
    </Card>
  </div>;
};

type AgentDetailContext = { agent: Agent; setAgent(agent: Agent): void };
const useAgentDetail = () => useOutletContext<AgentDetailContext>();

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
  const section = pathname.endsWith("/skills") ? "skills" : pathname.endsWith("/mcp") ? "mcp" : pathname.endsWith("/settings") ? "settings" : "overview";
  if (error !== "") return <div className="mx-auto max-w-5xl p-8"><ErrorAlert message={error} /><Button asChild variant="outline" className="mt-4"><Link to="/agents">{text("返回智能体", "Back to agents")}</Link></Button></div>;
  if (agent === null) return <div className="mx-auto max-w-5xl p-8"><Skeleton className="h-10 w-72" /><Skeleton className="mt-8 h-64" /></div>;

  return <div className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
    <Button variant="ghost" asChild className="mb-4"><Link to="/agents"><ArrowLeft />{text("返回智能体", "Back to agents")}</Link></Button>
    <PageHeader eyebrow={providerNames[agent.provider]} title={agent.name} description={text("项目环境、运行检查和技能均在这个智能体范围内管理。", "Project environment, runtime checks, and skills are managed within this agent.")} action={<Badge variant={agent.enabled ? "default" : "secondary"}>{agent.enabled ? text("已启用", "Enabled") : text("已停用", "Disabled")}</Badge>} />
    <Tabs value={section} onValueChange={(value) => navigate(value === "overview" ? `/agents/${id}` : `/agents/${id}/${value}`)}>
      <TabsList variant="line" aria-label={text("智能体管理", "Agent management")}><TabsTrigger value="overview">{text("概览", "Overview")}</TabsTrigger><TabsTrigger value="skills">{text("技能", "Skills")}</TabsTrigger><TabsTrigger value="mcp">MCP</TabsTrigger><TabsTrigger value="settings">{text("设置", "Settings")}</TabsTrigger></TabsList>
    </Tabs>
    <div className="mt-6"><Outlet context={{ agent, setAgent } satisfies AgentDetailContext} /></div>
  </div>;
};

export const AgentOverviewPage = () => {
  const { text } = useI18n();
  const { agent, setAgent } = useAgentDetail();
  const [doctor, setDoctor] = useState<AgentDoctorResult | null>(null);
  const [usage, setUsage] = useState<TokenUsageSummary | null>(null);
  const [usageError, setUsageError] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setUsage(null);
    setUsageError("");
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
  const upload = async (file: File | undefined, input: HTMLInputElement) => {
    if (file === undefined) return;
    if (!file.name.toLowerCase().endsWith(".zip") || file.size > maxSkillArchiveBytes) { setError(text("请选择不超过 10 MB 的技能 ZIP 文件", "Select a Skill ZIP file no larger than 10 MB")); input.value = ""; return; }
    setBusy("upload"); setError("");
    try {
      const uploaded = await api<AgentSkill>(`/agents/${agent.id}/skills/upload`, { method: "POST", body: JSON.stringify({ fileName: file.name, contentBase64: await fileBase64(file, text("读取 ZIP 失败", "Failed to read ZIP")) }) });
      setSkills((current) => [...(current ?? []).filter((item) => item.id !== uploaded.id), uploaded].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (reason) { setError(errorMessage(reason)); } finally { input.value = ""; setBusy(""); }
  };
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} />
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative max-w-sm flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label={text("搜索技能", "Search skills")} className="pl-9" placeholder={text("搜索名称或说明", "Search name or description")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <Button variant="outline" asChild><label><Upload />{busy === "upload" ? text("上传中…", "Uploading…") : text("上传 ZIP", "Upload ZIP")}<input className="sr-only" type="file" accept=".zip,application/zip" disabled={busy !== ""} onChange={(event) => void upload(event.target.files?.[0], event.currentTarget)} /></label></Button>
    </div>
    <p className="text-sm text-muted-foreground">{text(`已启用 ${(skills ?? []).filter((item) => item.enabled).length} / ${(skills ?? []).length}。配置会在下一次运行生效。`, `${(skills ?? []).filter((item) => item.enabled).length} / ${(skills ?? []).length} enabled. Changes apply to the next run.`)}</p>
    {skills === null ? <Skeleton className="h-64" /> : visible.length === 0 ? <Card className="border-dashed"><CardContent className="py-12 text-center text-muted-foreground">{text("暂无匹配的技能。", "No matching skills.")}</CardContent></Card> : <div className="divide-y rounded-xl border bg-card">{visible.map((skill) => { const source = ({ codex: "Codex", agents: text("共享目录", "Shared directory"), claude: "Claude", plugin: text("插件", "Plugin"), upload: text("已上传", "Uploaded"), missing: text("来源已移除", "Source removed") } satisfies Record<AgentSkill["source"], string>)[skill.source]; return <div key={skill.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex items-center gap-2"><p className="font-medium">{skill.name}</p><Badge variant="outline">{source}</Badge>{!skill.available ? <Badge variant="destructive">{text("不可用", "Unavailable")}</Badge> : null}</div><p className="mt-1 line-clamp-1 text-sm text-muted-foreground" title={skill.description || text("暂无说明", "No description")}>{skill.description || text("暂无说明", "No description")}</p></div><Button size="sm" variant={skill.enabled ? "outline" : "default"} disabled={busy !== "" || !skill.available} onClick={() => void toggle(skill)}>{skill.enabled ? text("停用", "Disable") : text("启用", "Enable")}</Button></div>; })}</div>}
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
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<ProjectEnvironment[]>("/project-environments", { signal: controller.signal }).then((items) => setEnvironments(items.filter((item) => item.currentRevisionId !== null))).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (name.trim() === "" || projectEnvironmentId === "") return;
    setBusy("save"); setError("");
    try { setAgent(await api<Agent>(`/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({
      name: name.trim(), projectEnvironmentId,
      instructions: agent.provider === "hermes" ? "" : instructions
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
      <Field data-disabled={agent.provider === "hermes" || undefined}><FieldLabel htmlFor="settings-agent-instructions">{text("智能体指令", "Agent instructions")}</FieldLabel><Textarea id="settings-agent-instructions" rows={8} value={instructions} disabled={agent.provider === "hermes"} placeholder={text("说明这个智能体长期遵循的角色、边界和工作方式", "Describe the agent's persistent role, boundaries, and working style")} onChange={(event) => setInstructions(event.target.value)} />
        <FieldDescription>{agent.provider === "hermes" ? text("Hermes 当前不支持智能体指令", "Hermes does not currently support agent instructions") : text("创建会话时保存快照；之后修改只影响新会话。", "Instructions are snapshotted at session creation; later edits affect new sessions only.")}</FieldDescription>
      </Field>
      <Button type="submit" disabled={busy !== ""}>{busy === "save" ? text("保存中…", "Saving…") : text("保存设置", "Save settings")}</Button>
    </FieldGroup></form></CardContent></Card>
    <Card className="border-destructive/40"><CardHeader><CardTitle className="flex items-center gap-2 text-destructive"><ShieldCheck className="size-5" />{text("危险操作", "Danger zone")}</CardTitle><CardDescription>{text("只有从未创建过会话的智能体才能删除；否则请停用智能体。", "Only agents with no sessions can be deleted. Disable the agent otherwise.")}</CardDescription></CardHeader><CardContent>
      <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive" disabled={busy !== ""}>{text("删除智能体", "Delete agent")}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{text(`确定删除“${agent.name}”？`, `Delete “${agent.name}”?`)}</AlertDialogTitle><AlertDialogDescription>{text("智能体配置和专属目录会被永久删除。已有会话时服务端会拒绝此操作。", "The agent configuration and private directory will be permanently deleted. The server rejects deletion when sessions exist.")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{text("取消", "Cancel")}</AlertDialogCancel><AlertDialogAction onClick={() => void remove()}>{text("确认删除", "Delete")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </CardContent></Card>
  </div>;
};
