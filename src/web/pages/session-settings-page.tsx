import { FormEvent, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, XCircle } from "lucide-react";
import { Link, useParams } from "react-router";

import { api, errorMessage, type SessionDetail } from "@/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { useI18n } from "@/i18n";

export const SessionSettingsPage = () => {
  const { text } = useI18n();
  const { id = "" } = useParams();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [values, setValues] = useState<Record<string, string>>(Object.create(null));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api<SessionDetail>(`/sessions/${id}`, { signal: controller.signal }).then((detail) => {
      setSession(detail);
      setValues(Object.fromEntries((detail.mcpParameters ?? []).filter((item) => !item.secret && item.value !== undefined)
        .map((item) => [item.key, item.value!] as const)));
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [id]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (session === null) return;
    setBusy(true); setNotice(""); setError("");
    const changed = Object.fromEntries((session.mcpParameters ?? []).flatMap((parameter) => {
      const value = values[parameter.key];
      if (value === undefined || value === "") return [];
      return [[parameter.key, value] as const];
    }));
    try {
      const updated = await api<SessionDetail>(`/sessions/${id}/mcp-parameters`, {
        method: "PATCH", body: JSON.stringify({ values: changed })
      });
      setSession({ ...session, ...updated });
      setValues(Object.fromEntries((updated.mcpParameters ?? []).filter((item) => !item.secret && item.value !== undefined)
        .map((item) => [item.key, item.value!] as const)));
      setNotice(text("参数已保存", "Parameters saved"));
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  };

  if (session === null && error === "") return <div className="mx-auto max-w-3xl p-8"><Skeleton className="h-10 w-72" /><Skeleton className="mt-8 h-72" /></div>;
  return <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8"><Button variant="ghost" asChild className="mb-4"><Link to={`/sessions/${id}`}><ArrowLeft />{text("返回对话", "Back to conversation")}</Link></Button><PageHeader eyebrow={text("会话设置", "SESSION SETTINGS")} title={session?.title ?? text("会话设置", "Session settings")} description={text("这些参数只对当前会话生效。", "These parameters apply only to this session.")} action={session === null ? null : <Badge variant={session.status === "idle" ? "secondary" : "default"}>{session.status === "idle" ? text("空闲", "Idle") : text("运行中", "Running")}</Badge>} />
    {error === "" ? null : <Alert variant="destructive"><XCircle /><AlertTitle>{text("操作失败", "Operation failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {notice === "" ? null : <Alert><CheckCircle2 /><AlertTitle>{notice}</AlertTitle></Alert>}
    {session === null ? null : <Card><CardHeader><CardTitle>{text("MCP 会话参数", "MCP session parameters")}</CardTitle><CardDescription>{text("敏感值不会回显；留空表示保持原值。", "Secret values are not displayed. Leave them blank to keep the current value.")}</CardDescription></CardHeader><CardContent><form onSubmit={submit}><FieldGroup>
      {(session.mcpParameters ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{text("该智能体没有声明会话参数。", "This agent has no session parameters.")}</p> : (session.mcpParameters ?? []).map((parameter) => <Field key={parameter.key}><FieldLabel htmlFor={`session-parameter-${parameter.key}`}>{parameter.label}{parameter.required ? text("（必填）", " (required)") : ""}</FieldLabel><Input id={`session-parameter-${parameter.key}`} type={parameter.secret ? "password" : "text"} value={values[parameter.key] ?? ""} placeholder={parameter.secret && parameter.configured ? text("已配置，留空保持原值", "Configured; leave blank to keep it") : ""} disabled={session.status !== "idle"} onChange={(event) => setValues((current) => ({ ...current, [parameter.key]: event.target.value }))} />{parameter.description === null ? null : <FieldDescription>{parameter.description}</FieldDescription>}</Field>)}
      <Button type="submit" disabled={busy || session.status !== "idle"}>{busy ? text("保存中…", "Saving…") : text("保存参数", "Save parameters")}</Button>
    </FieldGroup></form></CardContent></Card>}
  </div>;
};
