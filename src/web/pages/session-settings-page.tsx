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

export const SessionSettingsPage = () => {
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
      setNotice("参数已保存");
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  };

  if (session === null && error === "") return <div className="mx-auto max-w-3xl p-8"><Skeleton className="h-10 w-72" /><Skeleton className="mt-8 h-72" /></div>;
  return <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8"><Button variant="ghost" asChild className="mb-4"><Link to={`/sessions/${id}`}><ArrowLeft />返回对话</Link></Button><PageHeader eyebrow="SESSION SETTINGS" title={session?.title ?? "Session 设置"} description="这些参数只对当前 Session 生效。" action={session === null ? null : <Badge variant={session.status === "idle" ? "secondary" : "default"}>{session.status === "idle" ? "空闲" : "运行中"}</Badge>} />
    {error === "" ? null : <Alert variant="destructive"><XCircle /><AlertTitle>操作失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {notice === "" ? null : <Alert><CheckCircle2 /><AlertTitle>{notice}</AlertTitle></Alert>}
    {session === null ? null : <Card><CardHeader><CardTitle>MCP Session 参数</CardTitle><CardDescription>敏感值不会回显；留空表示保持原值。</CardDescription></CardHeader><CardContent><form onSubmit={submit}><FieldGroup>
      {(session.mcpParameters ?? []).length === 0 ? <p className="text-sm text-muted-foreground">该 Agent 没有声明 Session 参数。</p> : (session.mcpParameters ?? []).map((parameter) => <Field key={parameter.key}><FieldLabel htmlFor={`session-parameter-${parameter.key}`}>{parameter.label}{parameter.required ? "（必填）" : ""}</FieldLabel><Input id={`session-parameter-${parameter.key}`} type={parameter.secret ? "password" : "text"} value={values[parameter.key] ?? ""} placeholder={parameter.secret && parameter.configured ? "已配置，留空保持原值" : ""} disabled={session.status !== "idle"} onChange={(event) => setValues((current) => ({ ...current, [parameter.key]: event.target.value }))} />{parameter.description === null ? null : <FieldDescription>{parameter.description}</FieldDescription>}</Field>)}
      <Button type="submit" disabled={busy || session.status !== "idle"}>{busy ? "保存中…" : "保存参数"}</Button>
    </FieldGroup></form></CardContent></Card>}
  </div>;
};
