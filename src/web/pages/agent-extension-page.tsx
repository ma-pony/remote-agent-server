import { useEffect, useMemo, useState } from "react";
import { Blocks, CheckCircle2, PlugZap, ShieldCheck, XCircle } from "lucide-react";
import { useParams } from "react-router";

import { api, errorMessage, type ProviderExtensionCatalogItem } from "@/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/i18n";

const providerName = { codex: "Codex", claude_code: "Claude Code" } as const;

const ExtensionRow = ({ item, busy, onToggle }: {
  item: ProviderExtensionCatalogItem;
  busy: boolean;
  onToggle(): void;
}) => {
  const { text } = useI18n();
  return <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{item.name}</p>
        <Badge variant="outline">{item.kind === "plugin" ? text("插件", "Plugin") : text("钩子", "Hook")}</Badge>
        {item.version === null ? null : <Badge variant="secondary">v{item.version}</Badge>}
        {!item.available ? <Badge variant="destructive">{text("来源已移除", "Source unavailable")}</Badge> : null}
      </div>
      <p className="mt-1 line-clamp-1 text-sm text-muted-foreground" title={item.description}>
        {item.description || text("暂无说明", "No description")}
      </p>
    </div>
    <Button
      size="sm"
      variant={item.enabled ? "outline" : "default"}
      disabled={busy || !item.available}
      aria-label={text(`${item.enabled ? "停用" : "启用"} ${item.name}`, `${item.enabled ? "Disable" : "Enable"} ${item.name}`)}
      onClick={onToggle}
    >
      {item.enabled ? text("停用", "Disable") : text("启用", "Enable")}
    </Button>
  </div>;
};

export const AgentExtensionPage = () => {
  const { text } = useI18n();
  const { id = "" } = useParams();
  const [items, setItems] = useState<ProviderExtensionCatalogItem[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api<ProviderExtensionCatalogItem[]>(`/agents/${id}/extensions`, { signal: controller.signal })
      .then(setItems)
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [id]);

  const groups = useMemo(() => ({
    plugin: (items ?? []).filter(({ kind }) => kind === "plugin").sort((a, b) => Number(b.enabled) - Number(a.enabled)),
    hook: (items ?? []).filter(({ kind }) => kind === "hook").sort((a, b) => Number(b.enabled) - Number(a.enabled))
  }), [items]);
  const provider = items?.[0]?.provider;

  const toggle = async (item: ProviderExtensionCatalogItem) => {
    setBusy(item.id); setError(""); setNotice("");
    try {
      const updated = await api<ProviderExtensionCatalogItem>(
        `/agents/${id}/extensions/${encodeURIComponent(item.id)}`,
        { method: "PUT", body: JSON.stringify({ enabled: !item.enabled }) }
      );
      setItems((current) => (current ?? []).map((candidate) => candidate.id === updated.id ? updated : candidate));
      setNotice(text("配置已保存，下一次运行会自动刷新执行器会话。", "Saved. The next run refreshes the executor session automatically."));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy("");
    }
  };

  const section = (kind: "plugin" | "hook", title: string, description: string, icon: React.ReactNode) => <Card>
    <CardHeader className="flex-row items-start gap-3">
      <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/50">{icon}</span>
      <div><CardTitle>{title}</CardTitle><CardDescription className="mt-1.5">{description}</CardDescription></div>
    </CardHeader>
    <CardContent>
      {items === null ? <Skeleton className="h-28" /> : groups[kind].length === 0
        ? <div className="rounded-lg border border-dashed py-9 text-center text-sm text-muted-foreground">{text("系统中尚未发现。", "None discovered on this system.")}</div>
        : <div className="divide-y rounded-lg border">{groups[kind].map((item) => <ExtensionRow
          key={item.id}
          item={item}
          busy={busy !== ""}
          onToggle={() => void toggle(item)}
        />)}</div>}
    </CardContent>
  </Card>;

  return <div className="flex flex-col gap-5">
    {error === "" ? null : <Alert variant="destructive"><XCircle /><AlertTitle>{text("操作失败", "Operation failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {notice === "" ? null : <Alert><CheckCircle2 /><AlertTitle>{text("已更新", "Updated")}</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>}
    <Card className="overflow-hidden border-primary/20 bg-[linear-gradient(135deg,var(--card),color-mix(in_oklab,var(--muted)_55%,transparent))]">
      <CardHeader>
        <div className="flex items-center gap-2"><ShieldCheck className="size-5" /><CardTitle role="heading" aria-level={2}>{text("执行器扩展", "Provider extensions")}</CardTitle></div>
        <CardDescription>{provider === undefined
          ? text("从当前执行器的系统配置中发现插件和钩子，由这个智能体单独选择。", "Discover plugins and hooks from this provider's system configuration and select them per agent.")
          : text(`${providerName[provider]} 插件与钩子`, `${providerName[provider]} plugins and hooks`)}</CardDescription>
      </CardHeader>
      <CardContent><p className="text-sm leading-6 text-muted-foreground">{text(
        "发现到的扩展默认停用，不会隐式继承主机配置。启用后只投影到当前智能体，并在下一次运行生效。",
        "Discovered extensions are disabled by default and never inherited implicitly. Enabled items are projected only to this agent and apply on the next run."
      )}</p></CardContent>
    </Card>
    {section("plugin", text("插件", "Plugins"), text("执行器原生插件及其随附能力。", "Provider-native plugins and their bundled capabilities."), <Blocks className="size-4" />)}
    {section("hook", text("钩子", "Hooks"), text("在执行器生命周期事件上运行的本机钩子。", "Local hooks invoked at provider lifecycle events."), <PlugZap className="size-4" />)}
  </div>;
};
