import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, BarChart3 } from "lucide-react";
import { api, errorMessage, type UsageAnalysisSettings as Settings } from "@/api";
import { useI18n } from "@/i18n";
import { ResourceLoadError } from "@/components/resource-feedback";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";

const endpoint = "/system-settings/usage-analysis";

/** Loads the global usage-analysis switch; `reload` retries after a failure. */
export const useUsageAnalysisSettings = () => {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setError("");
    try {
      const next = await api<Settings>(endpoint, { signal });
      if (mounted.current && !signal?.aborted) setSettings(next);
    } catch (reason) { if (mounted.current && !signal?.aborted) setError(errorMessage(reason)); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => { mounted.current = false; controller.abort(); };
  }, [load]);
  return { settings, setSettings, error, setError, reload: () => void load(), mounted };
};

export const UsageAnalysisSettings = () => {
  const { text } = useI18n();
  const { settings, setSettings, error, setError, reload, mounted } = useUsageAnalysisSettings();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async (enabled: boolean) => {
    setBusy(true); setError(""); setSaved(false);
    try {
      const next = await api<Settings>(endpoint, { method: "PUT", body: JSON.stringify({ enabled }) });
      if (mounted.current) { setSettings(next); setSaved(true); }
    } catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
    finally { if (mounted.current) setBusy(false); }
  };

  return <Card>
    <CardHeader className="border-b">
      <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><BarChart3 className="size-5" /></span><div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><CardTitle>{text("用量分析", "Usage analysis")}</CardTitle>
          {settings ? <Badge variant={settings.enabled ? "default" : "secondary"}>{settings.enabled ? text("已开启", "Enabled") : text("已关闭", "Disabled")}</Badge> : null}</div>
        <CardDescription className="mt-1">{text("统计提示词、工具、MCP 和上下文的 token 估算，并采集执行器日志与抓包用量。默认关闭；关闭时这些内容不记录、不分析，模型上报的 token、用量看板和已有分析数据保留。设置从下一次 Run 生效。", "Estimates tokens for prompts, tools, MCP, and context, and collects provider-log and captured usage. Disabled by default; while disabled, none of this is recorded or analyzed, and model-reported tokens, the usage dashboard, and existing analysis data are kept. Changes apply to the next Run.")}</CardDescription>
      </div></div>
    </CardHeader>
    <CardContent className="flex flex-col gap-4 pt-6">
      {error ? settings ? <Alert variant="destructive"><AlertCircle /><AlertTitle>{text("保存失败", "Save failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>
        : <ResourceLoadError title={text("用量分析设置加载失败", "Could not load usage analysis settings")} message={error} onRetry={reload} /> : null}
      {!settings ? !error ? <Skeleton className="h-10" aria-label={text("正在加载用量分析设置", "Loading usage analysis settings")} /> : null : <>
        {saved ? <p role="status" className="text-sm text-muted-foreground">{text("已保存，将从下一次 Run 生效；正在运行的任务保持原设置。", "Saved. Applies to the next Run; active work keeps its original setting.")}</p> : null}
        <div>{settings.enabled ? <AlertDialog><AlertDialogTrigger asChild><Button type="button" variant="outline" disabled={busy}>{busy ? text("保存中…", "Saving…") : text("关闭用量分析", "Disable usage analysis")}</Button></AlertDialogTrigger><AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{text("关闭用量分析？", "Disable usage analysis?")}</AlertDialogTitle><AlertDialogDescription>{text("关闭期间不记录、不分析内容、工具、MCP、上下文和执行器日志用量。重新开启后不会补算关闭期间 Run 的内容和工具估算；仍保留的执行器日志会从上次进度继续采集。模型上报的 token 和用量看板不受影响。", "While disabled, content, tool, MCP, context, and provider-log usage is neither recorded nor analyzed. Re-enabling does not backfill content or tool estimates for Runs started while disabled; retained provider logs resume from their last checkpoint. Model-reported tokens and the usage dashboard are unaffected.")}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>{text("取消", "Cancel")}</AlertDialogCancel><AlertDialogAction onClick={() => void save(false)}>{text("确认关闭", "Disable")}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent></AlertDialog>
          : <Button type="button" disabled={busy} onClick={() => void save(true)}>{busy ? text("保存中…", "Saving…") : text("开启用量分析", "Enable usage analysis")}</Button>}</div>
      </>}
    </CardContent>
  </Card>;
};
