import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/i18n";

export type TrendPoint = { label: string; detail?: string; values: Array<number | null> };
const colors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)"];
const height = 248, left = 56, right = 20, top = 16, bottom = 38;

/** A bounded time series using the console's chart tokens. Null observations break the line. */
export const UsageTrendChart = ({ label, points, series }: { label: string; points: TrendPoint[]; series: string[] }) => {
  const { locale, text } = useI18n();
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width;
      if (nextWidth) setWidth(nextWidth);
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const [selected, setSelected] = useState<number | null>(null);
  const active = Math.min(selected ?? points.length - 1, points.length - 1);
  const point = points[active];
  const format = (value: number | null) => value === null ? text("未上报", "Not reported") : new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  const compact = (value: number) => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const maximum = Math.max(1, ...points.flatMap(item => item.values.filter((value): value is number => value !== null)));
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const ceiling = Math.ceil(maximum / magnitude) * magnitude;
  const ticks = Math.min(4, ceiling);
  const x = (index: number) => points.length <= 1 ? (left + width - right) / 2 : left + index / (points.length - 1) * (width - left - right);
  const y = (value: number) => height - bottom - value / ceiling * (height - top - bottom);
  const labelIndices = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].filter(index => index >= 0);
  const instruction = text("聚焦图表后，使用左右方向键查看数据。", "Focus the chart and use the arrow keys to inspect values.");

  return <div ref={container} className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">{series.map((name, index) => <span className="inline-flex items-center gap-2" key={name}>
      <svg width="20" height="8" aria-hidden="true"><line x1="0" y1="4" x2="20" y2="4" stroke={colors[index % colors.length]} strokeWidth="2" strokeDasharray={index === 0 ? undefined : index === 1 ? "5 3" : "2 3"} /></svg>{name}
    </span>)}</div>
    <svg height={height} viewBox={`0 0 ${width} ${height}`} className="w-full rounded-md focus-visible:outline-2 focus-visible:outline-ring"
      tabIndex={0} role="group" aria-roledescription={text("折线图", "Line chart")} aria-label={label} aria-describedby={`${id}-help ${id}-value`}
      onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        setSelected(event.key === "Home" ? 0 : event.key === "End" ? points.length - 1
          : Math.max(0, Math.min(points.length - 1, active + (event.key === "ArrowLeft" ? -1 : 1))));
      }} onPointerMove={event => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (bounds.width === 0) return;
        const position = (event.clientX - bounds.left) / bounds.width * width;
        setSelected(Math.max(0, Math.min(points.length - 1, Math.round((position - left) / (width - left - right) * (points.length - 1)))));
      }}>
      <title>{label}</title>
      {Array.from({ length: ticks + 1 }, (_, index) => {
        const value = Math.round(ceiling * index / ticks);
        return <g key={index}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="var(--border)" strokeDasharray="3 4" />
          <text x={left - 10} y={y(value) + 4} textAnchor="end" fontSize="12" fill="var(--muted-foreground)">{compact(value)}</text></g>;
      })}
      {labelIndices.map(index => <text key={index} x={x(index)} y={height - 12}
        textAnchor={points.length <= 1 ? "middle" : index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
        fontSize="12" fill="var(--muted-foreground)">{points[index]!.label}</text>)}
      {series.map((name, seriesIndex) => {
        let previousKnown = false;
        const path = points.map((item, index) => {
          const value = item.values[seriesIndex] ?? null;
          if (value === null) { previousKnown = false; return ""; }
          const segment = `${previousKnown ? "L" : "M"}${x(index)},${y(value)}`;
          previousKnown = true;
          return segment;
        }).join(" ");
        return <g key={name} aria-hidden="true"><path d={path} fill="none" stroke={colors[seriesIndex % colors.length]} strokeWidth="2"
          strokeLinejoin="round" strokeDasharray={seriesIndex === 0 ? undefined : seriesIndex === 1 ? "5 3" : "2 3"} />
          {points.map((item, index) => item.values[seriesIndex] == null ? null : <circle key={index} cx={x(index)} cy={y(item.values[seriesIndex]!)}
            r={index === active ? 4 : 2} fill={colors[seriesIndex % colors.length]} />)}</g>;
      })}
      {point ? <line x1={x(active)} x2={x(active)} y1={top} y2={height - bottom} stroke="var(--muted-foreground)" strokeDasharray="3 4" opacity="0.4" /> : null}
      {points.every(item => item.values.every(value => value === null)) ? <text x={(left + width - right) / 2} y={height / 2} textAnchor="middle" fontSize="14" fill="var(--muted-foreground)">{text("暂无上报用量", "No reported usage")}</text> : null}
    </svg>
    <div id={`${id}-value`} aria-live="polite" aria-atomic="true" className="min-h-12 text-xs leading-5">
      {point ? <><p className="truncate font-medium" title={point.detail ?? point.label}>{point.detail ?? point.label}</p>
        <p className="flex flex-wrap gap-x-4 text-muted-foreground">{series.map((name, index) => <span key={name}>{name} <span className="font-mono tabular-nums">{format(point.values[index] ?? null)}</span></span>)}</p></> : null}
    </div>
    <p id={`${id}-help`} className="sr-only">{instruction}</p>
  </div>;
};
