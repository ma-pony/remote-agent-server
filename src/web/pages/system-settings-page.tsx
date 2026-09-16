import { type FormEvent, useEffect, useState } from "react";
import { CheckCircle2, Gauge, HardDrive, XCircle } from "lucide-react";

import { api, errorMessage, type ConcurrencySettings, type RuntimeSettings } from "@/api";
import { PageContainer, PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/i18n";

type Settings = ConcurrencySettings & RuntimeSettings;
type Draft = Record<keyof Settings, string>;

const toDraft = (settings: Settings): Draft => ({
  globalRunConcurrency: String(settings.globalRunConcurrency),
  webhookConcurrency: String(settings.webhookConcurrency),
  environmentBuildConcurrency: String(settings.environmentBuildConcurrency),
  runTimeoutMinutes: String(settings.runTimeoutMinutes),
  sessionStorageRetentionHours: String(settings.sessionStorageRetentionHours)
});

const parseInteger = (value: string, min: number, max: number): number | null => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
};

export const ConcurrencySettingsPage = () => {
  const { text } = useI18n();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void api<Settings>("/system-settings/concurrency", { signal: controller.signal })
      .then((settings) => setDraft(toDraft(settings)))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, []);

  const values = draft === null ? null : {
    globalRunConcurrency: parseInteger(draft.globalRunConcurrency, 1, 64),
    webhookConcurrency: parseInteger(draft.webhookConcurrency, 1, 64),
    environmentBuildConcurrency: parseInteger(draft.environmentBuildConcurrency, 1, 64),
    runTimeoutMinutes: parseInteger(draft.runTimeoutMinutes, 1, 1440),
    sessionStorageRetentionHours: parseInteger(draft.sessionStorageRetentionHours, 0, 8760)
  };
  const valid = values !== null && Object.values(values).every((value) => value !== null);

  const update = (key: keyof Draft, value: string) => {
    setDraft((current) => current === null ? current : { ...current, [key]: value });
    setSaved(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || values === null) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const settings = await api<Settings>("/system-settings/concurrency", {
        method: "PUT",
        body: JSON.stringify(values)
      });
      setDraft(toDraft(settings));
      setSaved(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return <PageContainer width="form">
    <PageHeader eyebrow={text("系统设置", "SYSTEM SETTINGS")} title={text("运行与并发", "Runtime and concurrency")} description={text("统一控制任务运行时间、会话大文件保留期和服务并发。修改不会中断正在运行的任务。", "Control run duration, large Session storage retention, and service concurrency. Changes do not interrupt active work.")} />
    {error === "" ? null : <Alert variant="destructive" className="mb-5"><XCircle /><AlertTitle>{text("保存失败", "Save failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {saved ? <Alert className="mb-5 border-primary/30"><CheckCircle2 /><AlertTitle>{text("设置已保存", "Settings saved")}</AlertTitle><AlertDescription>{text("Run 超时作用于新启动的 Run；存储保留期在下一次清理时生效；并发限制立即作用于后续调度。", "Run timeout applies to newly started runs; storage retention applies at the next cleanup; concurrency limits affect subsequent scheduling immediately.")}</AlertDescription></Alert> : null}
    {draft === null ? <Skeleton className="h-[36rem]" /> : <form onSubmit={submit} className="space-y-5">
      <Card>
        <CardHeader className="border-b">
          <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><HardDrive className="size-5" /></span><div><CardTitle>{text("运行与存储", "Runtime and storage")}</CardTitle><CardDescription className="mt-1">{text("控制单次 Run 的硬超时，以及空闲 Session 的 Workspace、浏览器数据和执行器原生会话保留时间。Session、Run、事件和 Token 统计不会被删除。", "Control the hard timeout for a run and how long an idle Session keeps its Workspace, browser data, and provider-native session. Session, run, event, and token statistics are retained.")}</CardDescription></div></div>
        </CardHeader>
        <CardContent className="pt-6"><FieldGroup className="grid gap-5 md:grid-cols-2">
          <Field><FieldLabel htmlFor="run-timeout-minutes">{text("Run 超时（分钟）", "Run timeout (minutes)")}</FieldLabel><Input id="run-timeout-minutes" name="run-timeout-minutes" type="number" min={1} max={1440} step={1} value={draft.runTimeoutMinutes} onChange={(event) => update("runTimeoutMinutes", event.target.value)} /><FieldDescription>{text("新启动的 Run 最长运行时间，范围 1–1440 分钟。超时会终止当前 Turn 并释放执行器。", "Maximum duration for newly started runs, from 1 to 1440 minutes. A timeout stops the current turn and releases the runtime.")}</FieldDescription></Field>
          <Field><FieldLabel htmlFor="session-storage-retention-hours">{text("会话大文件保留（小时）", "Large Session storage retention (hours)")}</FieldLabel><Input id="session-storage-retention-hours" name="session-storage-retention-hours" type="number" min={0} max={8760} step={1} value={draft.sessionStorageRetentionHours} onChange={(event) => update("sessionStorageRetentionHours", event.target.value)} /><FieldDescription>{text("空闲 Session 超过该时间后清理磁盘内容和关联的 Webhook 投递记录。设为 0 关闭自动清理；会话、任务、事件和统计仍保留。", "Clean large on-disk data and linked Webhook deliveries after a Session stays idle for this many hours. Set to 0 to disable automatic cleanup; sessions, tasks, events, and statistics remain available.")}</FieldDescription></Field>
        </FieldGroup></CardContent>
      </Card>
      <Card>
        <CardHeader className="border-b">
          <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Gauge className="size-5" /></span><div><CardTitle>{text("服务并发上限", "Service concurrency limits")}</CardTitle><CardDescription className="mt-1">{text("每项可配置 1–64。会话内运行和同一外部对话保持串行；Webhook 对同一任务按事件顺序投递，不同任务可并发。", "Each limit accepts 1–64. Runs within one session and one external conversation remain serial. Webhook events stay ordered per task while different tasks may deliver concurrently.")}</CardDescription></div></div>
        </CardHeader>
        <CardContent className="pt-6"><FieldGroup className="grid gap-5 lg:grid-cols-3">
          <Field><FieldLabel htmlFor="global-run-concurrency">{text("全局 Run 并发", "Global run concurrency")}</FieldLabel><Input id="global-run-concurrency" name="global-run-concurrency" type="number" min={1} max={64} step={1} value={draft.globalRunConcurrency} onChange={(event) => update("globalRunConcurrency", event.target.value)} /><FieldDescription>{text("整个服务同时运行的 Agent Run 总数。Agent 自定义上限不能超过此值。", "Maximum Agent runs across the service. An Agent-specific limit cannot exceed this value.")}</FieldDescription></Field>
          <Field><FieldLabel htmlFor="webhook-concurrency">{text("Webhook 投递并发", "Webhook delivery concurrency")}</FieldLabel><Input id="webhook-concurrency" name="webhook-concurrency" type="number" min={1} max={64} step={1} value={draft.webhookConcurrency} onChange={(event) => update("webhookConcurrency", event.target.value)} /><FieldDescription>{text("整个服务同时发送的 Webhook 数量。同一任务的事件保持顺序，不同任务和订阅可并发投递。", "Maximum Webhook requests sent by the service. Events stay ordered within one task; different tasks and subscriptions may deliver concurrently.")}</FieldDescription></Field>
          <Field><FieldLabel htmlFor="environment-build-concurrency">{text("项目环境构建并发", "Project environment build concurrency")}</FieldLabel><Input id="environment-build-concurrency" name="environment-build-concurrency" type="number" min={1} max={64} step={1} value={draft.environmentBuildConcurrency} onChange={(event) => update("environmentBuildConcurrency", event.target.value)} /><FieldDescription>{text("同时同步或准备的项目环境数量；同一环境的重复请求会合并。", "Number of project environments prepared or synchronized at once; duplicate requests for one environment are coalesced.")}</FieldDescription></Field>
        </FieldGroup></CardContent>
      </Card>
      {!valid ? <p className="text-sm text-destructive" role="alert">{text("请检查输入范围：Run 超时 1–1440 分钟，存储保留 0–8760 小时，并发上限 1–64。", "Check the ranges: run timeout 1–1440 minutes, storage retention 0–8760 hours, and concurrency limits 1–64.")}</p> : null}
      <div className="sticky bottom-0 z-10 -mx-2 flex items-center justify-between gap-4 rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur sm:justify-end"><p className="hidden text-sm text-muted-foreground sm:block">{text("修改仅影响后续调度", "Changes affect subsequent scheduling")}</p><Button type="submit" className="max-sm:w-full" disabled={busy || !valid}>{busy ? text("保存中…", "Saving…") : text("保存设置", "Save settings")}</Button></div>
    </form>}
  </PageContainer>;
};
