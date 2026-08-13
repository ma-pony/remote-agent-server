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
import { PageHeader } from "@/components/page-header";
import {
  api, errorMessage, type Agent, type AgentDoctorResult, type AgentSkill,
  type ProjectEnvironment, type Provider
} from "@/api";

const providerNames: Record<Provider, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  hermes: "Hermes"
};
const skillSourceNames: Record<AgentSkill["source"], string> = {
  codex: "Codex", agents: "共享目录", claude: "Claude", plugin: "插件",
  upload: "已上传", missing: "来源已移除"
};
const maxSkillArchiveBytes = 10 * 1024 * 1024;

const fileBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error("读取 ZIP 失败"));
  reader.onload = () => typeof reader.result === "string"
    ? resolve(reader.result.split(",", 2)[1] ?? "")
    : reject(new Error("读取 ZIP 失败"));
  reader.readAsDataURL(file);
});

const ErrorAlert = ({ message }: { message: string }) => message === "" ? null : (
  <Alert variant="destructive"><XCircle /><AlertTitle>操作失败</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>
);

export const AgentListPage = () => {
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
    <PageHeader eyebrow="EXECUTION PROFILES" title="Agent" description="选择一个 Agent 查看运行状态、管理 Skills 或修改配置。"
      action={<Button asChild><Link to="/agents/new"><Plus />新建 Agent</Link></Button>} />
    <ErrorAlert message={error} />
    <div className="mb-5 flex max-w-sm items-center gap-2 rounded-lg border bg-card px-3">
      <Search className="size-4 text-muted-foreground" aria-hidden="true" />
      <Input aria-label="搜索 Agent" className="border-0 bg-transparent shadow-none focus-visible:ring-0" placeholder="按名称搜索" value={query} onChange={(event) => setQuery(event.target.value)} />
    </div>
    {agents === null ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((item) => <Skeleton key={item} className="h-44" />)}</div>
      : visible.length === 0 ? <Card className="border-dashed"><CardContent className="py-16 text-center text-muted-foreground">{agents.length === 0 ? "暂无 Agent，先创建一个执行入口。" : "没有匹配的 Agent。"}</CardContent></Card>
      : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visible.map((agent) => <Card key={agent.id} className="transition-colors hover:border-primary/50">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div><CardTitle><Link className="hover:underline" to={`/agents/${agent.id}`}>{agent.name}</Link></CardTitle><CardDescription className="mt-2">{providerNames[agent.provider]}</CardDescription></div>
            <Badge variant={agent.enabled ? "default" : "secondary"}>{agent.enabled ? "已启用" : "已停用"}</Badge>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground"><span className="font-medium text-foreground">项目环境：</span>{agent.projectEnvironmentId === null ? "未绑定" : environmentNames.get(agent.projectEnvironmentId) ?? "环境不可用"}</CardContent>
      </Card>)}</div>}
  </div>;
};

export const AgentCreatePage = () => {
  const navigate = useNavigate();
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<Provider>("codex");
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
      const created = await api<Agent>("/agents", { method: "POST", body: JSON.stringify({ name: name.trim(), provider, projectEnvironmentId }) });
      navigate(`/agents/${created.id}`);
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  };

  return <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
    <Button variant="ghost" asChild className="mb-4"><Link to="/agents"><ArrowLeft />返回 Agent</Link></Button>
    <PageHeader eyebrow="NEW EXECUTION PROFILE" title="新建 Agent" description="Provider 创建后不可修改；名称、项目环境和 Skills 可随时调整。" />
    <ErrorAlert message={error} />
    <Card><CardHeader><CardTitle>基础配置</CardTitle><CardDescription>绑定一个已准备完成的项目环境。</CardDescription></CardHeader>
      <CardContent><form className="flex flex-col gap-6" onSubmit={submit}><FieldGroup>
        <Field><FieldLabel htmlFor="agent-name">Agent 名称</FieldLabel><Input id="agent-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus /></Field>
        <Field><FieldLabel htmlFor="provider">Provider</FieldLabel><NativeSelect id="provider" className="w-full" value={provider} onChange={(event) => setProvider(event.target.value as Provider)}>{Object.entries(providerNames).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
        <Field><FieldLabel htmlFor="agent-environment">项目环境</FieldLabel><NativeSelect id="agent-environment" className="w-full" value={projectEnvironmentId} onChange={(event) => setProjectEnvironmentId(event.target.value)}><NativeSelectOption value="" disabled>请选择可用环境</NativeSelectOption>{environments.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect>{environments.length === 0 ? <FieldDescription>暂无已准备完成的项目环境。</FieldDescription> : null}</Field>
        <div className="flex justify-end gap-2"><Button variant="outline" asChild><Link to="/agents">取消</Link></Button><Button type="submit" disabled={busy || projectEnvironmentId === ""}>{busy ? "创建中…" : "创建 Agent"}</Button></div>
      </FieldGroup></form></CardContent>
    </Card>
  </div>;
};

type AgentDetailContext = { agent: Agent; setAgent(agent: Agent): void };
const useAgentDetail = () => useOutletContext<AgentDetailContext>();

export const AgentDetailLayout = () => {
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
  if (error !== "") return <div className="mx-auto max-w-5xl p-8"><ErrorAlert message={error} /><Button asChild variant="outline" className="mt-4"><Link to="/agents">返回 Agent</Link></Button></div>;
  if (agent === null) return <div className="mx-auto max-w-5xl p-8"><Skeleton className="h-10 w-72" /><Skeleton className="mt-8 h-64" /></div>;

  return <div className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
    <Button variant="ghost" asChild className="mb-4"><Link to="/agents"><ArrowLeft />返回 Agent</Link></Button>
    <PageHeader eyebrow={providerNames[agent.provider]} title={agent.name} description={`项目环境、运行检查和 Skill 均在这个 Agent 范围内管理。`} action={<Badge variant={agent.enabled ? "default" : "secondary"}>{agent.enabled ? "已启用" : "已停用"}</Badge>} />
    <Tabs value={section} onValueChange={(value) => navigate(value === "overview" ? `/agents/${id}` : `/agents/${id}/${value}`)}>
      <TabsList variant="line" aria-label="Agent 管理"><TabsTrigger value="overview">概览</TabsTrigger><TabsTrigger value="skills">Skills</TabsTrigger><TabsTrigger value="mcp">MCP</TabsTrigger><TabsTrigger value="settings">设置</TabsTrigger></TabsList>
    </Tabs>
    <div className="mt-6"><Outlet context={{ agent, setAgent } satisfies AgentDetailContext} /></div>
  </div>;
};

export const AgentOverviewPage = () => {
  const { agent, setAgent } = useAgentDetail();
  const [doctor, setDoctor] = useState<AgentDoctorResult | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
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
      <Card><CardHeader><CardTitle>运行状态</CardTitle><CardDescription>控制该 Agent 是否允许创建新 Session。</CardDescription></CardHeader><CardContent><Button variant={agent.enabled ? "outline" : "default"} disabled={busy !== ""} onClick={() => void toggle()}>{agent.enabled ? "停用 Agent" : "启用 Agent"}</Button></CardContent></Card>
      <Card><CardHeader><CardTitle>运行检查</CardTitle><CardDescription>检查 Provider 登录与项目环境可用性。</CardDescription></CardHeader><CardContent><Button variant="outline" disabled={busy !== ""} onClick={() => void runDoctor()}><RefreshCw className={busy === "doctor" ? "animate-spin" : ""} />运行检查</Button></CardContent></Card>
    </div>
    {doctor === null ? null : <Card><CardHeader><CardTitle>检查结果</CardTitle></CardHeader><CardContent className="grid gap-3 md:grid-cols-2">
      {[{ label: "Provider", value: doctor.provider }, { label: "项目环境", value: doctor.projectEnvironment }].map(({ label, value }) => <div key={label} className="rounded-lg border p-4"><div className="flex items-center gap-2 font-medium">{value.ok ? <CheckCircle2 className="size-4 text-primary" /> : <XCircle className="size-4 text-destructive" />}{label}</div><p className="mt-2 text-sm text-muted-foreground">{value.message}</p></div>)}
    </CardContent></Card>}
  </div>;
};

export const AgentSkillsPage = () => {
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
  const visible = (skills ?? []).filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = async (skill: AgentSkill) => {
    setBusy(skill.id); setError("");
    try {
      const updated = await api<AgentSkill>(`/agents/${agent.id}/skills/${skill.id}`, { method: "PUT", body: JSON.stringify({ enabled: !skill.enabled }) });
      setSkills((current) => (current ?? []).map((item) => item.id === updated.id ? updated : item));
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };
  const upload = async (file: File | undefined, input: HTMLInputElement) => {
    if (file === undefined) return;
    if (!file.name.toLowerCase().endsWith(".zip") || file.size > maxSkillArchiveBytes) { setError("请选择不超过 10 MB 的 Skill ZIP 文件"); input.value = ""; return; }
    setBusy("upload"); setError("");
    try {
      const uploaded = await api<AgentSkill>(`/agents/${agent.id}/skills/upload`, { method: "POST", body: JSON.stringify({ fileName: file.name, contentBase64: await fileBase64(file) }) });
      setSkills((current) => [...(current ?? []).filter((item) => item.id !== uploaded.id), uploaded].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (reason) { setError(errorMessage(reason)); } finally { input.value = ""; setBusy(""); }
  };
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} />
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative max-w-sm flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="搜索 Skill" className="pl-9" placeholder="搜索名称或说明" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <Button variant="outline" asChild><label><Upload />{busy === "upload" ? "上传中…" : "上传 ZIP"}<input className="sr-only" type="file" accept=".zip,application/zip" disabled={busy !== ""} onChange={(event) => void upload(event.target.files?.[0], event.currentTarget)} /></label></Button>
    </div>
    <p className="text-sm text-muted-foreground">已启用 {(skills ?? []).filter((item) => item.enabled).length} / {(skills ?? []).length}。配置会在下一次 Run 生效。</p>
    {skills === null ? <Skeleton className="h-64" /> : visible.length === 0 ? <Card className="border-dashed"><CardContent className="py-12 text-center text-muted-foreground">暂无匹配的 Skill。</CardContent></Card> : <div className="divide-y rounded-xl border bg-card">{visible.map((skill) => <div key={skill.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex items-center gap-2"><p className="font-medium">{skill.name}</p><Badge variant="outline">{skillSourceNames[skill.source]}</Badge>{!skill.available ? <Badge variant="destructive">不可用</Badge> : null}</div><p className="mt-1 text-sm text-muted-foreground">{skill.description || "暂无说明"}</p></div><Button size="sm" variant={skill.enabled ? "outline" : "default"} disabled={busy !== "" || !skill.available} onClick={() => void toggle(skill)}>{skill.enabled ? "停用" : "启用"}</Button></div>)}</div>}
  </div>;
};

export const AgentSettingsPage = () => {
  const { agent, setAgent } = useAgentDetail();
  const navigate = useNavigate();
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
  const [name, setName] = useState(agent.name);
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
    try { setAgent(await api<Agent>(`/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim(), projectEnvironmentId }) })); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };
  const remove = async () => {
    setBusy("delete"); setError("");
    try { await api(`/agents/${agent.id}`, { method: "DELETE" }); navigate("/agents"); }
    catch (reason) { setError(errorMessage(reason)); setBusy(""); }
  };
  return <div className="flex flex-col gap-5"><ErrorAlert message={error} />
    <Card><CardHeader><CardTitle>Agent 设置</CardTitle><CardDescription>Provider 为执行身份，不允许在创建后修改。</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-5" onSubmit={save}><FieldGroup>
      <Field><FieldLabel htmlFor="settings-agent-name">名称</FieldLabel><Input id="settings-agent-name" value={name} onChange={(event) => setName(event.target.value)} /></Field>
      <Field data-disabled><FieldLabel htmlFor="settings-provider">Provider</FieldLabel><Input id="settings-provider" value={providerNames[agent.provider]} disabled /></Field>
      <Field><FieldLabel htmlFor="settings-environment">项目环境</FieldLabel><NativeSelect id="settings-environment" className="w-full" value={projectEnvironmentId} onChange={(event) => setProjectEnvironmentId(event.target.value)}>{environments.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}</NativeSelect></Field>
      <Button type="submit" disabled={busy !== ""}>{busy === "save" ? "保存中…" : "保存设置"}</Button>
    </FieldGroup></form></CardContent></Card>
    <Card className="border-destructive/40"><CardHeader><CardTitle className="flex items-center gap-2 text-destructive"><ShieldCheck className="size-5" />危险操作</CardTitle><CardDescription>只有从未创建过 Session 的 Agent 才能删除；否则请停用 Agent。</CardDescription></CardHeader><CardContent>
      <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive" disabled={busy !== ""}>删除 Agent</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确定删除“{agent.name}”？</AlertDialogTitle><AlertDialogDescription>Agent 配置和专属目录会被永久删除。已有 Session 时服务端会拒绝此操作。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void remove()}>确认删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </CardContent></Card>
  </div>;
};
