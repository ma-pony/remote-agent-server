import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import type { RtkStatus } from "../../rtk/rtk-types";
import { api, errorMessage } from "@/api";
import { useI18n } from "@/i18n";
import { ResourceLoadError } from "@/components/resource-feedback";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";

const isRunning = (status: RtkStatus | null): boolean => !!status?.operation && !["succeeded", "failed"].includes(status.operation.stage);

export const RtkSettings = () => {
  const { text } = useI18n();
  const [status, setStatus] = useState<RtkStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const mounted = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api<RtkStatus>("/system-settings/rtk", { signal });
      if (mounted.current && !signal?.aborted) { setStatus(next); setError(""); }
    } catch (reason) { if (mounted.current && !signal?.aborted) setError(errorMessage(reason)); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => { mounted.current = false; controller.abort(); };
  }, [load]);
  const running = isRunning(status);
  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 750);
    };
    timer = setTimeout(() => { void poll(); }, 750);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [running, load]);

  const operate = async (action: string, body?: unknown) => {
    setBusy(true); setError(""); setSaved(false);
    try {
      const next = await api<RtkStatus>(`/system-settings/rtk${action ? `/${action}` : ""}`, {
        method: action ? "POST" : "PUT", body: JSON.stringify(body ?? {})
      });
      if (mounted.current) { setStatus(next); setSaved(!action); }
    } catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const pending = busy || running;
  const operationLabel = status?.operation ? ({
    checking: text("正在检查版本…", "Checking version…"), downloading: text("正在下载…", "Downloading…"),
    verifying: text("正在校验…", "Verifying…"), testing: text("正在自检…", "Testing…"), activating: text("正在切换版本…", "Activating…"),
    succeeded: text("操作已完成", "Operation completed"), failed: text("操作失败，当前版本已保留", "Operation failed; current version retained")
  })[status.operation.stage] : "";
  const updateTarget = status?.latestVersion ?? status?.currentVersion ?? status?.recommendedVersion;

  return <Card>
    <CardHeader><CardTitle>{text("RTK 命令输出压缩", "RTK command output compression")}</CardTitle>
      <CardDescription>{text("默认安装并启用。减少模型读取的命令输出；设置和版本切换从下一次 Run 生效，正在运行的任务继续使用原配置。", "Installed and enabled by default. Reduces command output read by the model. Settings and version changes apply to the next Run; active work keeps its original configuration.")}</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-4">
      {error ? status ? <Alert variant="destructive"><AlertCircle /><AlertTitle>{text("请求失败", "Request failed")}</AlertTitle><AlertDescription>{error}<Button variant="outline" size="sm" onClick={() => void load()}>{text("重试", "Retry")}</Button></AlertDescription></Alert>
        : <ResourceLoadError title={text("RTK 设置加载失败", "Could not load RTK settings")} message={error} onRetry={() => void load()} /> : null}
      {!status ? !error ? <Skeleton className="h-40" /> : null : <>
        <FieldGroup><Field><FieldLabel htmlFor="rtk-enabled">{text("自动压缩", "Automatic compression")}</FieldLabel>
          <NativeSelect id="rtk-enabled" value={String(status.enabled)} disabled={busy} onChange={(event) => void operate("", { enabled: event.target.value === "true" })}>
            <NativeSelectOption value="true">{text("开启", "Enabled")}</NativeSelectOption><NativeSelectOption value="false">{text("关闭", "Disabled")}</NativeSelectOption>
          </NativeSelect><FieldDescription>{text("关闭后停止自动接管命令，已安装版本继续保留。", "Disabling stops automatic command rewriting and retains installed versions.")}</FieldDescription>
        </Field></FieldGroup>
        {saved ? <p role="status" className="text-sm text-muted-foreground">{text("已保存，将从下一次 Run 生效。", "Saved. Applies to the next Run.")}</p> : null}
        <div className="flex flex-wrap gap-2"><Badge variant="secondary">{text("当前版本", "Current")}: {status.currentVersion ?? text("未安装", "Not installed")}</Badge>
          <Badge variant="outline">{text("最新稳定版", "Latest stable")}: {status.latestVersion ?? text("尚未检测", "Not checked")}</Badge></div>
        {!status.installed ? <Alert><AlertTitle>{text("RTK 暂不可用", "RTK unavailable")}</AlertTitle><AlertDescription>{text("安装前任务继续使用原始命令输出。", "Runs use original command output until installation succeeds.")}</AlertDescription></Alert> : null}
        <p className="text-sm text-muted-foreground">{text("最后成功检测", "Last successful check")}: {status.lastCheckedAt ? new Date(status.lastCheckedAt).toLocaleString() : text("尚未检测", "Not checked")}</p>
        {status.releaseUrl ? <a className="text-sm underline" href={status.releaseUrl} target="_blank" rel="noreferrer">{text("查看版本说明", "Release notes")}</a> : null}
        {status.checkError ? <Alert variant="destructive"><AlertTitle>{text("版本检测失败", "Version check failed")}</AlertTitle><AlertDescription>{text("保留上次检测结果，可重新检查。", "The previous result is retained. Try checking again.")} ({status.checkError})</AlertDescription></Alert> : null}
        {status.operation ? <p role="status" aria-live="polite" className="text-sm">{operationLabel}{status.operation.error ? ` (${status.operation.error})` : ""}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={pending} onClick={() => void operate("check")}><RefreshCw data-icon="inline-start" />{text("检查更新", "Check updates")}</Button>
          {(!status.installed || status.updateAvailable) && updateTarget ? <Button disabled={pending} onClick={() => void operate("update", { version: updateTarget })}>{status.installed ? text(`更新到 ${updateTarget}`, `Update to ${updateTarget}`) : text(`安装 ${updateTarget}`, `Install ${updateTarget}`)}</Button> : null}
          {status.previousVersion ? <AlertDialog><AlertDialogTrigger asChild><Button variant="outline" disabled={pending}>{text("回退版本", "Roll back")}</Button></AlertDialogTrigger><AlertDialogContent>
            <AlertDialogHeader><AlertDialogTitle>{text(`回退到 ${status.previousVersion}？`, `Roll back to ${status.previousVersion}?`)}</AlertDialogTitle><AlertDialogDescription>{text("下一次 Run 将使用该版本，正在运行的任务继续使用原版本。", "The next Run will use this version. Active work keeps its current version.")}</AlertDialogDescription></AlertDialogHeader>
            <AlertDialogFooter><AlertDialogCancel>{text("取消", "Cancel")}</AlertDialogCancel><AlertDialogAction onClick={() => void operate("rollback", { version: status.previousVersion })}>{text("确认回退", "Confirm rollback")}</AlertDialogAction></AlertDialogFooter>
          </AlertDialogContent></AlertDialog> : null}
        </div>
        <p className="text-sm text-muted-foreground">{text("Claude Code / Codex 使用 Hook，Hermes 使用插件；DeepSeek Harness 暂无自动接入。实际压缩范围取决于执行器能力，Token 用量仍以原有统计为准。", "Claude Code and Codex use hooks; Hermes uses a plugin. DeepSeek Harness has no automatic integration yet. Coverage depends on the provider; existing usage accounting remains authoritative.")}</p>
      </>}
    </CardContent>
  </Card>;
};
