import { type FormEvent, useEffect, useState } from "react";
import { CheckCircle2, Gauge, XCircle } from "lucide-react";

import { api, errorMessage, type ConcurrencySettings } from "@/api";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/i18n";

type Draft = Record<keyof ConcurrencySettings, string>;

const toDraft = (settings: ConcurrencySettings): Draft => ({
  globalRunConcurrency: String(settings.globalRunConcurrency),
  webhookConcurrency: String(settings.webhookConcurrency),
  environmentBuildConcurrency: String(settings.environmentBuildConcurrency)
});

const parseLimit = (value: string): number | null => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 64 ? number : null;
};

export const ConcurrencySettingsPage = () => {
  const { text } = useI18n();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void api<ConcurrencySettings>("/system-settings/concurrency", { signal: controller.signal })
      .then((settings) => setDraft(toDraft(settings)))
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, []);

  const values = draft === null ? null : {
    globalRunConcurrency: parseLimit(draft.globalRunConcurrency),
    webhookConcurrency: parseLimit(draft.webhookConcurrency),
    environmentBuildConcurrency: parseLimit(draft.environmentBuildConcurrency)
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
      const settings = await api<ConcurrencySettings>("/system-settings/concurrency", {
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

  return <div className="mx-auto w-full max-w-4xl p-4 sm:p-6 lg:p-8">
    <PageHeader eyebrow={text("系统设置", "SYSTEM SETTINGS")} title={text("并发与队列", "Concurrency and queues")} description={text("控制服务能够同时执行的工作数量。修改后立即作用于新的调度，不会中断正在运行的任务。", "Control how much work the service runs at once. Changes affect new scheduling immediately without cancelling active work.")} />
    {error === "" ? null : <Alert variant="destructive" className="mb-5"><XCircle /><AlertTitle>{text("保存失败", "Save failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {saved ? <Alert className="mb-5 border-primary/30"><CheckCircle2 /><AlertTitle>{text("设置已保存并立即生效", "Settings saved and active")}</AlertTitle><AlertDescription>{text("提高上限会立即继续派发；降低上限只限制后续工作。", "Raising a limit dispatches queued work immediately; lowering it only constrains subsequent work.")}</AlertDescription></Alert> : null}
    {draft === null ? <Skeleton className="h-96" /> : <form onSubmit={submit}>
      <Card>
        <CardHeader className="border-b">
          <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Gauge className="size-5" /></span><div><CardTitle>{text("服务并发上限", "Service concurrency limits")}</CardTitle><CardDescription className="mt-1">{text("每项可配置 1–64。会话内运行、同一外部对话和同一 Webhook 订阅仍保持串行。", "Each limit accepts 1–64. Runs within one session, one external conversation, and one webhook subscription remain serial.")}</CardDescription></div></div>
        </CardHeader>
        <CardContent className="pt-6"><FieldGroup>
          <Field><FieldLabel htmlFor="global-run-concurrency">{text("全局 Run 并发", "Global run concurrency")}</FieldLabel><Input id="global-run-concurrency" type="number" min={1} max={64} step={1} value={draft.globalRunConcurrency} onChange={(event) => update("globalRunConcurrency", event.target.value)} /><FieldDescription>{text("整个服务同时运行的 Agent Run 总数。Agent 自定义上限不能超过此值。", "Maximum Agent runs across the service. An Agent-specific limit cannot exceed this value.")}</FieldDescription></Field>
          <Field><FieldLabel htmlFor="webhook-concurrency">{text("Webhook 投递并发", "Webhook delivery concurrency")}</FieldLabel><Input id="webhook-concurrency" type="number" min={1} max={64} step={1} value={draft.webhookConcurrency} onChange={(event) => update("webhookConcurrency", event.target.value)} /><FieldDescription>{text("不同订阅之间可同时投递的回调数；同一订阅始终按顺序投递。", "Callbacks may run concurrently across subscriptions; each subscription is always delivered in order.")}</FieldDescription></Field>
          <Field><FieldLabel htmlFor="environment-build-concurrency">{text("项目环境构建并发", "Project environment build concurrency")}</FieldLabel><Input id="environment-build-concurrency" type="number" min={1} max={64} step={1} value={draft.environmentBuildConcurrency} onChange={(event) => update("environmentBuildConcurrency", event.target.value)} /><FieldDescription>{text("同时同步或准备的项目环境数量；同一环境的重复请求会合并。", "Number of project environments prepared or synchronized at once; duplicate requests for one environment are coalesced.")}</FieldDescription></Field>
          {!valid ? <p className="text-sm text-destructive" role="alert">{text("并发上限必须是 1 到 64 之间的整数。", "Concurrency limits must be integers from 1 to 64.")}</p> : null}
          <div className="flex justify-end"><Button type="submit" disabled={busy || !valid}>{busy ? text("保存中…", "Saving…") : text("保存设置", "Save settings")}</Button></div>
        </FieldGroup></CardContent>
      </Card>
    </form>}
  </div>;
};
