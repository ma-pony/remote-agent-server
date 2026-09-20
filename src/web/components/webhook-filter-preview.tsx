import { useEffect, useRef, useState } from "react";
import { Check, XCircle } from "lucide-react";

import { errorMessage, integrationApi, type WebhookProviderDefinition } from "@/api";
import { useI18n } from "@/i18n";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { WebhookFilter, WebhookFilterResult } from "../../integrations/webhook-filter.js";

export const WebhookFilterPreview = ({ endpointId, definition, filter, disabled }: {
  endpointId: number; definition?: WebhookProviderDefinition; filter: WebhookFilter | null; disabled: boolean;
}) => {
  const { text } = useI18n();
  const [eventType, setEventType] = useState("");
  const [payload, setPayload] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ key: string; value: WebhookFilterResult & { reason: string } } | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const key = JSON.stringify([endpointId, definition?.id, filter, eventType, payload]);
  let parsedPayload: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) parsedPayload = parsed as Record<string, unknown>;
  } catch { /* Invalid examples cannot be previewed. */ }
  const preview = async () => {
    if (definition === undefined || parsedPayload === undefined || disabled) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(""); setResult(null);
    try {
      const value = await integrationApi.previewWebhookFilter(endpointId, { provider: definition.id, eventType, payload: parsedPayload, filter }, controller.signal);
      if (!controller.signal.aborted) setResult({ key, value });
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const current = !disabled && result?.key === key ? result.value : null;
  return <FieldGroup>
    <FieldDescription>{text("粘贴平台的示例载荷，预览当前未保存规则。预览不会创建任务，也不会保存载荷。", "Paste a sample platform payload to preview the current unsaved rules. Preview creates no tasks and stores no payload.")}</FieldDescription>
    <Field>
      <FieldLabel htmlFor="filter-preview-event">{text("预览事件类型", "Preview event type")}</FieldLabel>
      <Input id="filter-preview-event" value={eventType} maxLength={512} placeholder={definition?.id === "gitlab" ? "Merge Request Hook" : "pull_request"} onChange={(event) => { setEventType(event.target.value); setError(""); }} />
    </Field>
    <Field data-invalid={payload !== "" && parsedPayload === undefined}>
      <FieldLabel htmlFor="filter-preview-payload">{text("示例事件载荷（JSON）", "Sample event payload (JSON)")}</FieldLabel>
      <Textarea id="filter-preview-payload" rows={4} value={payload} aria-invalid={payload !== "" && parsedPayload === undefined}
        onChange={(event) => { setPayload(event.target.value); setError(""); }} />
      {payload !== "" && parsedPayload === undefined ? <FieldDescription>{text("请输入 JSON 对象。", "Enter a JSON object.")}</FieldDescription> : null}
    </Field>
    <Button type="button" variant="outline" className="self-start" disabled={disabled || busy || definition === undefined || eventType.trim() === "" || parsedPayload === undefined}
      onClick={() => { void preview(); }}>{busy ? text("预览中…", "Previewing…") : text("预览筛选", "Preview filter")}</Button>
    {error === "" ? null : <Alert variant="destructive"><XCircle /><AlertTitle>{text("预览失败", "Preview failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {current === null ? null : <Alert role="status">
      {current.matched ? <Check /> : <XCircle />}
      <AlertTitle>{current.matched ? text("符合筛选条件", "Matches the filter") : text("不会创建任务", "No task will be created")}</AlertTitle>
      <AlertDescription>
        {current.reason === "ping" ? <p>{text("GitHub ping 仅检查连接。", "GitHub ping only checks the connection.")}</p> : null}
        {current.matched ? <p>{text("实际接收还需通过认证、启用状态和任务参数校验。", "Actual delivery also requires authentication, enabled status, and valid task parameters.")}</p> : null}
        <ul className="flex flex-col gap-1">{current.checks.map((check) => <li key={check.path}>
          {check.path} · {check.field}{check.valueField === undefined ? null : ` ${check.op === "eq" ? "=" : "≠"} ${check.valueField}`} · {check.matched ? text("匹配", "Matched") : check.reason === "missing_field" ? text("字段缺失", "Missing field")
            : check.reason === "type_mismatch" ? text("类型不符", "Type mismatch") : text("值不匹配", "Value mismatch")}
        </li>)}</ul>
      </AlertDescription>
    </Alert>}
  </FieldGroup>;
};
