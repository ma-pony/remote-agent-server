import type { TokenUsage, TokenUsageSummary } from "@/api";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useI18n } from "@/i18n";

const compactToken = (value: number | null, locale: string): string => value === null
  ? "—"
  : new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);

export const TokenUsageLine = ({ usage }: { usage: TokenUsage | null | undefined }) => {
  const { locale, text } = useI18n();
  if (usage == null) {
    return <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">{text(
      "当前执行器未提供本轮用量",
      "The current provider did not report usage for this run"
    )}</p>;
  }
  const fields = [
    [text("输入", "Input"), usage.inputTokens],
    [text("输出", "Output"), usage.outputTokens],
    [text("缓存读取", "Cache read"), usage.cachedReadTokens],
    [text("缓存写入", "Cache write"), usage.cachedWriteTokens],
    [text("思考", "Thought"), usage.thoughtTokens],
    [text("总计", "Total"), usage.totalTokens]
  ] as const;
  const measured = fields.filter((item): item is readonly [string, number] => item[1] !== null);

  return <div className="mt-4 border-t pt-3 text-xs text-muted-foreground">
    {measured.length === 0 ? <p>{text(
      "当前执行器未提供本轮用量",
      "The current provider did not report usage for this run"
    )}</p> : <p>{measured.map(([label, value]) => `${label} ${compactToken(value, locale)}`).join(" · ")}</p>}
    {usage.contextUsedTokens !== null || usage.contextWindowTokens !== null
      ? <p className="mt-1">{text("上下文", "Context")} {compactToken(usage.contextUsedTokens, locale)} / {compactToken(usage.contextWindowTokens, locale)}</p>
      : null}
  </div>;
};

export const TokenUsageSummaryCard = ({
  title,
  summary,
  headingLevel = 3
}: {
  title: string;
  summary: TokenUsageSummary;
  headingLevel?: 2 | 3;
}) => {
  const { locale, text } = useI18n();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const details = [
    ["input", text("输入", "Input"), summary.usage.inputTokens],
    ["output", text("输出", "Output"), summary.usage.outputTokens],
    ["cache-read", text("缓存读取", "Cache read"), summary.usage.cachedReadTokens],
    ["cache-write", text("缓存写入", "Cache write"), summary.usage.cachedWriteTokens],
    ["thought", text("思考", "Thought"), summary.usage.thoughtTokens],
    ["total", text("总计", "Total"), summary.usage.totalTokens]
  ] as const;
  return <Card>
    <CardHeader><Heading className="font-heading text-base font-medium">{title}</Heading></CardHeader>
    <CardContent>
      <p className="text-2xl font-semibold tabular-nums">{text("总计", "Total")} {compactToken(summary.usage.totalTokens, locale)}</p>
      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        {details.map(([key, label, value]) => <div key={key} className="border-t border-border/70 pt-3">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 font-mono text-base font-semibold tabular-nums">{compactToken(value, locale)}</dd>
        </div>)}
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">{text(
        `已统计 ${summary.measuredSessionCount} / ${summary.sessionCount} 个会话`,
        `Measured ${summary.measuredSessionCount} / ${summary.sessionCount} sessions`
      )}</p>
    </CardContent>
  </Card>;
};
