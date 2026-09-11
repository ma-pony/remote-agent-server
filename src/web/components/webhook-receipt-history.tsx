import { useEffect, useState } from "react";
import { RefreshCw, Webhook, XCircle } from "lucide-react";
import { Link } from "react-router";

import { errorMessage, integrationApi, type WebhookReceiptDetail } from "@/api";
import { useI18n } from "@/i18n";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/page-header";

export const WebhookReceiptHistory = ({ endpointId }: { endpointId: number }) => {
  const { text, formatDate } = useI18n();
  const [receipts, setReceipts] = useState<WebhookReceiptDetail[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (reload === 0) return;
    const controller = new AbortController();
    setBusy(true); setError("");
    void integrationApi.listWebhookReceipts(endpointId, controller.signal).then((value) => {
      if (!controller.signal.aborted) setReceipts(value);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [endpointId, reload]);
  return <Card>
    <CardHeader>
      <CardTitle>{text("最近接收记录", "Recent receipts")}</CardTitle>
      <CardDescription>{text("查看最近 30 个投递的筛选决定与规则版本；重复投递复用原记录。", "View filter decisions and rule versions for the latest 30 deliveries. Retries reuse the original receipt.")}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      <Button type="button" variant="outline" className="self-start" disabled={busy} onClick={() => setReload((value) => value + 1)}>
        <RefreshCw data-icon="inline-start" />{text("刷新接收记录", "Refresh receipts")}</Button>
      {error === "" ? null : <Alert variant="destructive"><XCircle /><AlertTitle>{text("加载失败", "Load failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {busy ? <Skeleton className="h-24" /> : receipts === null ? <p className="text-sm text-muted-foreground">{text("点击刷新查看已认证的事件。", "Refresh to view authenticated events.")}</p>
        : receipts.length === 0 ? <EmptyState icon={Webhook} title={text("暂无接收记录", "No receipts yet")}
          description={text("请从平台发送测试事件；命中规则的测试事件也会创建任务。", "Send a test event from the platform; matching test events also create tasks.")} />
          : <div className="surface-list divide-y rounded-xl border bg-card">{receipts.map((receipt) => <div key={receipt.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0"><p className="break-all">{receipt.deliveryId}</p><p className="text-sm text-muted-foreground">{receipt.provider} · {receipt.eventType}</p>
              <p className="text-xs text-muted-foreground">{text("规则版本", "Rule version")} {receipt.filterVersion} · {formatDate(receipt.createdAt)}</p></div>
            <div className="flex flex-wrap items-center gap-3"><Badge variant={receipt.decision === "accepted" ? "default" : "secondary"}>
              {receipt.reason === "ping" ? text("连接检查", "Connection check") : receipt.decision === "accepted" ? text("筛选通过", "Filter passed") : text("未命中筛选规则", "Filter did not match")}
            </Badge>
            {receipt.taskId !== null ? <Button variant="link" size="sm" asChild><Link to={`/integration-tasks/${receipt.taskId}`}>#{receipt.taskId}</Link></Button>
              : receipt.decision === "accepted" ? <span className="text-sm text-muted-foreground">{text("尚未入队，等待平台重试", "Not queued; awaiting platform retry")}</span> : null}</div>
          </div>)}</div>}

    </CardContent>
  </Card>;
};
