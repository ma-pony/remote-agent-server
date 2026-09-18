import { useEffect, useState, type FormEvent } from "react";
import { Check, Clipboard, RefreshCw, Webhook, XCircle } from "lucide-react";
import { Link } from "react-router";

import { errorMessage, integrationApi, type IntegrationEndpoint, type WebhookReceiver, type WebhookProviderDefinition } from "@/api";
import { useI18n } from "@/i18n";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { WebhookFilterEditor, draftFilter, parseFilterDraft, type FilterDraft } from "@/components/webhook-filter-editor";
import { WebhookFilterPreview } from "@/components/webhook-filter-preview";
import { WebhookReceiptHistory } from "@/components/webhook-receipt-history";

export const WebhookReceiverSettings = ({ endpoint }: { endpoint: IntegrationEndpoint }) => {
  const { text } = useI18n();
  const [receiver, setReceiver] = useState<WebhookReceiver | null | undefined>();
  const [filterDraft, setFilterDraft] = useState<FilterDraft | null>(null);
  const [providers, setProviders] = useState<WebhookProviderDefinition[]>([]);
  const [provider, setProvider] = useState("");
  const [authMode, setAuthMode] = useState<WebhookReceiver["authMode"]>("signature");
  const [enabled, setEnabled] = useState(true);
  const [debounceSeconds, setDebounceSeconds] = useState("60");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setReceiver(undefined);
    setError("");
    setSecret("");
    setSaved(false);
    void Promise.all([
      integrationApi.getWebhookReceiver(endpoint.id, controller.signal), integrationApi.listWebhookProviders(controller.signal)
    ]).then(([result, definitions]) => {
      if (controller.signal.aborted) return;
      setReceiver(result);
      setProviders(definitions);
      setProvider(result?.provider ?? definitions[0]?.id ?? "");
      setAuthMode(result?.authMode ?? definitions[0]?.authModes[0] ?? "signature");
      setEnabled(result?.enabled ?? true);
      setDebounceSeconds(String(result?.debounceSeconds ?? 60));
      setFilterDraft(draftFilter(result?.filter ?? null));
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    });
    return () => controller.abort();
  }, [endpoint.id, reload]);

  const url = `${window.location.origin}/integration/v1/endpoints/${endpoint.slug}/webhook`;
  const definition = providers.find((item) => item.id === provider);
  const secretRequired = receiver == null || receiver.provider !== provider || receiver.authMode !== authMode;
  const parsedFilter = parseFilterDraft(filterDraft);
  const parsedDebounce = Number(debounceSeconds);
  const debounceValid = debounceSeconds.trim() !== "" && Number.isInteger(parsedDebounce) && parsedDebounce >= 0 && parsedDebounce <= 300;
  const canSave = parsedFilter.valid && receiver !== undefined && definition !== undefined && definition.authModes.includes(authMode)
    && debounceValid && !busy && (!secretRequired || secret.trim() !== "");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave || definition === undefined || !parsedFilter.valid) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await integrationApi.configureWebhookReceiver(endpoint.id, {
        provider: definition.id, authMode, enabled, filter: parsedFilter.filter, debounceSeconds: parsedDebounce,
        ...(secret === "" ? {} : { secret })
      });
      setReceiver(result);
      setSecret("");
      setSaved(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return <div className="flex flex-col gap-5">
    {error === "" ? null : <Alert variant="destructive"><XCircle /><AlertTitle>{text("操作失败", "Operation failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {receiver === undefined ? error === "" ? <Skeleton className="h-64" />
      : <Button variant="outline" className="self-start" onClick={() => setReload((value) => value + 1)}><RefreshCw />{text("重试", "Retry")}</Button>
      : <>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Webhook />{text("接收平台 Webhook", "Receive platform webhooks")}</CardTitle>
            <CardDescription>{text("使用平台默认 Webhook，请求验证且命中筛选规则后创建任务并调用绑定的智能体。", "Use native platform webhooks to verify and filter events, create tasks, and invoke the linked agent.")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(event) => { void submit(event); }}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="receiver-url">{text("接收地址", "Receiver URL")}</FieldLabel>
                  <Input id="receiver-url" value={url} readOnly />
                  <Button type="button" variant="outline" className="self-start" onClick={async () => {
                    try { await navigator.clipboard.writeText(url); setCopied(true); }
                    catch { setError(text("复制失败，请手动复制接收地址。", "Copy failed. Copy the receiver URL manually.")); }
                  }}>{copied ? <Check /> : <Clipboard />}{copied ? text("已复制", "Copied") : text("复制地址", "Copy URL")}</Button>
                </Field>
                <Field>
                  <FieldLabel htmlFor="receiver-provider">{text("来源平台", "Platform")}</FieldLabel>
                  <NativeSelect id="receiver-provider" disabled={busy} value={provider} onChange={(event) => {
                    setProvider(event.target.value);
                    setAuthMode(providers.find((item) => item.id === event.target.value)?.authModes[0] ?? "signature");
                    setFilterDraft(null);
                    setDebounceSeconds("60");
                    setSecret(""); setSaved(false);
                  }}>
                    {providers.map((item) => <NativeSelectOption key={item.id} value={item.id}>{text(item.name, item.name)}</NativeSelectOption>)}
                  </NativeSelect>
                  <FieldDescription>{text("切换平台会清除当前筛选草稿，请为新平台重新设置规则。", "Switching platforms clears the current filter draft. Configure rules for the new platform.")}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="receiver-auth-mode">{text("验证方式", "Authentication")}</FieldLabel>
                  <NativeSelect id="receiver-auth-mode" value={authMode} disabled={busy || (definition?.authModes.length ?? 0) < 2}
                    onChange={(event) => { setAuthMode(event.target.value as WebhookReceiver["authMode"]); setSecret(""); setSaved(false); }}>
                    {definition?.authModes.map((mode) => <NativeSelectOption key={mode} value={mode}>
                      {mode === "signature" ? text("签名验证", "Signature") : text("Token 验证", "Token")}
                    </NativeSelectOption>)}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="receiver-secret">{text("Webhook Secret", "Webhook Secret")}</FieldLabel>
                  <Input id="receiver-secret" type="password" autoComplete="new-password" disabled={busy} required={secretRequired}
                    maxLength={1024} value={secret} onChange={(event) => { setSecret(event.target.value); setSaved(false); }}
                    placeholder={secretRequired ? text("填写与平台相同的 Secret", "Enter the same secret as the platform") : text("已配置；留空保留", "Configured; leave blank to keep")} />
                  <FieldDescription>{definition === undefined ? "" : text(definition.secretHint.zh, definition.secretHint.en)}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="receiver-enabled">{text("接收状态", "Receiver status")}</FieldLabel>
                  <NativeSelect id="receiver-enabled" value={enabled ? "enabled" : "disabled"} disabled={busy} onChange={(event) => {
                    setEnabled(event.target.value === "enabled"); setSaved(false);
                  }}>
                    <NativeSelectOption value="enabled">{text("启用", "Enabled")}</NativeSelectOption>
                    <NativeSelectOption value="disabled">{text("停用", "Disabled")}</NativeSelectOption>
                  </NativeSelect>
                  {!endpoint.enabled ? <FieldDescription>{text("接入端点已停用，启用端点后才能接收事件。", "The integration endpoint is disabled. Enable it before receiving events.")}</FieldDescription> : null}
                </Field>
                <WebhookFilterEditor draft={filterDraft} onChange={(draft) => { setFilterDraft(draft); setSaved(false); }} definition={definition} disabled={busy} />
                <Field data-invalid={!debounceValid} data-disabled={busy}>
                  <FieldLabel htmlFor="receiver-debounce">{text("MR / PR 事件合并等待（秒）", "MR / PR event debounce (seconds)")}</FieldLabel>
                  <Input id="receiver-debounce" type="number" min={0} max={300} step={1} required disabled={busy}
                    aria-invalid={!debounceValid} aria-describedby="receiver-debounce-help" value={debounceSeconds}
                    onChange={(event) => { setDebounceSeconds(event.target.value); setSaved(false); }} />
                  <FieldDescription id="receiver-debounce-help">{text(
                    "默认 60 秒，设为 0 可关闭。同一 MR / PR 的新命中事件会重新计时，最长等待 5 分钟，然后用最后收到的载荷创建一个任务。重复投递和未命中事件不延长等待；其他事件仍立即创建任务。",
                    "Defaults to 60 seconds; set 0 to disable. New matching events for the same MR / PR restart the wait, up to 5 minutes, then create one task from the last received payload. Retries and filtered events do not extend the wait. Other event types create tasks immediately."
                  )}</FieldDescription>
                </Field>
                <WebhookFilterPreview endpointId={endpoint.id} definition={definition} filter={parsedFilter.valid ? parsedFilter.filter : null} disabled={busy || !parsedFilter.valid} />
                <div className="flex items-center gap-3">
                  <Button type="submit" disabled={!canSave}>{busy ? text("保存中…", "Saving…") : text("保存接收配置", "Save receiver")}</Button>
                  <Badge variant={receiver?.enabled && endpoint.enabled ? "default" : "secondary"}>
                    {receiver === null ? text("尚未配置", "Not configured") : receiver.enabled && endpoint.enabled ? text("接收已启用", "Receiving enabled") : text("接收已停用", "Receiving disabled")}
                  </Badge>
                </div>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
        {saved ? <Alert role="status"><Check /><AlertTitle>{text("接收配置已保存", "Receiver saved")}</AlertTitle><AlertDescription>{text("将地址和相同 Secret 填入平台 Webhook 设置，选择需要触发的事件。", "Enter the URL and matching secret in the platform's webhook settings, then select the events to trigger.")}</AlertDescription></Alert> : null}
        <WebhookReceiptHistory key={endpoint.id} endpointId={endpoint.id} />
        <Card>
          <CardHeader><CardTitle>{text("事件如何触发任务", "How events trigger tasks")}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <p>{text("默认将同一 MR / PR 的命中事件等待 60 秒后合并为一次任务；等待状态会保留，服务重启后继续处理。关闭合并或其他事件类型会立即创建任务。事件类型和 JSON 载荷会连同端点固定提示发送给智能体。", "By default, matching events for the same MR / PR merge into one task after a 60-second quiet period; pending events survive restarts. Disabling merging or receiving other event types creates tasks immediately. The event type and JSON payload are sent with the endpoint's fixed prompt.")}</p>
            <p>{text("在平台选择触发事件。GitHub ping 仅检查连接；GitLab 的测试事件同样经过筛选，命中时会创建任务。", "Select triggering events on the platform. GitHub ping only checks the connection; GitLab test events are also filtered and create tasks when matched.")}</p>
            <p>{text("需要智能体参数时，可在参数映射中用 project.id 等载荷路径读取值，也可使用固定值。", "For agent parameters, map payload paths such as project.id or use fixed values.")}</p>
            <div className="flex flex-wrap gap-3">
              <Button asChild variant="outline" size="sm"><Link to={`/integration-endpoints/${endpoint.id}/mappings`}>{text("配置参数映射", "Configure mappings")}</Link></Button>
              <Button asChild variant="outline" size="sm"><Link to={`/integration-endpoints/${endpoint.id}/tasks`}>{text("查看接收任务", "View received tasks")}</Link></Button>
            </div>
          </CardContent>
        </Card>
      </>}
  </div>;
};
