import { ListPagination } from "@/components/list-pagination";
import { type FormEvent, useEffect, useState } from "react";
import { Braces, Trash2, XCircle } from "lucide-react";
import { useParams } from "react-router";

import { api, errorMessage, type Page, type AgentSessionParameter } from "@/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/i18n";

export const AgentParameterPage = () => {
  const { text } = useI18n();
  const { id = "" } = useParams();
  const [parameters, setParameters] = useState<AgentSessionParameter[] | null>(null);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<Page<AgentSessionParameter> | null>(null);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [required, setRequired] = useState(false);
  const [secret, setSecret] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setParameters(null); setError("");
    void api<Page<AgentSessionParameter>>(`/agents/${id}/session-parameters?page=${page}&pageSize=20`, { signal: controller.signal })
      .then((result) => { if (page > Math.max(1, result.totalPages)) { setPage(Math.max(1, result.totalPages)); return; } setResult(result); setParameters(result.items); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [id, page, refresh]);

  const createParameter = async (event: FormEvent) => {
    event.preventDefault();
    if (key.trim() === "" || label.trim() === "") return;
    setBusy("create"); setError("");
    try {
      await api<AgentSessionParameter>(`/agents/${id}/session-parameters`, {
        method: "POST",
        body: JSON.stringify({ key: key.trim(), label: label.trim(), description: null, required, secret })
      });
      setRefresh((value) => value + 1);
      setKey(""); setLabel(""); setRequired(false); setSecret(false);
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };

  const removeParameter = async (parameterId: number) => {
    setBusy(`delete-${parameterId}`); setError("");
    try {
      await api(`/agents/${id}/session-parameters/${parameterId}`, { method: "DELETE" });
      setRefresh((value) => value + 1);
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(""); }
  };

  return <div className="flex flex-col gap-5">
    {error === "" ? null : <Alert variant="destructive"><XCircle /><AlertTitle>{text("操作失败", "Operation failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    <Card><CardHeader><CardTitle>{text("会话参数", "Session parameters")}</CardTitle><CardDescription>{text("声明外部任务或人工创建会话时需要提供的参数。MCP、接入端点和其他运行配置可以引用这些参数。", "Declare values supplied when an external task or user creates a session. MCP servers, endpoints, and other runtime configuration can reference them.")}</CardDescription></CardHeader><CardContent className="flex flex-col gap-5">
      {parameters === null ? <Skeleton className="h-24" /> : parameters.length === 0 ? <div className="rounded-lg border border-dashed bg-muted/10 px-5 py-8 text-center"><Braces className="mx-auto size-5 text-muted-foreground" aria-hidden="true" /><p className="mt-3 text-sm font-medium">{text("还没有会话参数", "No session parameters yet")}</p><p className="mt-1 text-xs text-muted-foreground">{text("在下方声明外部任务需要提供的第一个参数。", "Declare the first value an external task must provide below.")}</p></div> : <div className="surface-list divide-y rounded-lg border">{parameters.map((parameter) => <div key={parameter.id} className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"><Field><FieldLabel htmlFor={`parameter-label-${parameter.id}`}>{text("显示名称", "Display name")}</FieldLabel><Input id={`parameter-label-${parameter.id}`} value={parameter.label} readOnly /></Field><div className="pb-2 text-sm"><code>{parameter.key}</code> · {parameter.required ? text("必填", "Required") : text("可选", "Optional")} · {parameter.secret ? text("敏感", "Secret") : text("普通", "Plain")}</div><Button aria-label={text(`删除参数 ${parameter.label}`, `Delete parameter ${parameter.label}`)} variant="ghost" size="icon-sm" disabled={busy !== ""} onClick={() => void removeParameter(parameter.id)}><Trash2 /></Button></div>)}</div>}
      {result === null ? null : <ListPagination {...result} onPageChange={setPage} disabled={busy !== "" || parameters === null} />}
      <form className="rounded-lg border bg-muted/20 p-4" onSubmit={createParameter}><FieldGroup><div className="grid gap-4 md:grid-cols-2"><Field><FieldLabel htmlFor="parameter-label">{text("显示名称", "Display name")}</FieldLabel><Input id="parameter-label" name="parameter-label" value={label} onChange={(event) => setLabel(event.target.value)} /></Field><Field><FieldLabel htmlFor="parameter-key">{text("参数键", "Parameter key")}</FieldLabel><Input id="parameter-key" name="parameter-key" value={key} onChange={(event) => setKey(event.target.value)} placeholder="tenant_id" /></Field></div><div className="flex flex-wrap gap-5 text-sm"><label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />{text("必填", "Required")}</label><label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={secret} onChange={(event) => setSecret(event.target.checked)} />{text("敏感值", "Secret value")}</label></div><Button type="submit" variant="outline" disabled={busy !== "" || key.trim() === "" || label.trim() === ""}>{text("添加会话参数", "Add session parameter")}</Button></FieldGroup></form>
    </CardContent></Card>
  </div>;
};
