import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type Page } from "@/api";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";
import { ListPagination } from "@/components/list-pagination";
import { useI18n } from "@/i18n";

type Option = { value: string; label: string };

/** Browses a bounded page while retaining the selected option independently of that page. */
export function PagedResourceSelect<T>({ endpoint, value, onValueChange, getOption, selectedLabel, emptyLabel,
  id, name, ariaLabel, disabled = false, autoSelectFirst = false, onLoaded }: {
  endpoint: string; value: string; onValueChange(value: string): void; getOption(item: T): Option;
  selectedLabel?: string; emptyLabel?: string; id?: string; name?: string; ariaLabel?: string;
  disabled?: boolean; autoSelectFirst?: boolean; onLoaded?(page: Page<T>): void;
}) {
  const { text } = useI18n();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Page<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const selected = useRef<Option | undefined>(undefined);
  const callbacks = useRef({ getOption, onValueChange, onLoaded, value });
  callbacks.current = { getOption, onValueChange, onLoaded, value };
  useEffect(() => { setPage(1); setQuery(""); setResult(null); }, [endpoint]);
  useEffect(() => {
    const controller = new AbortController();
    const [path, search = ""] = endpoint.split("?");
    const params = new URLSearchParams(search);
    params.set("page", String(page)); params.set("pageSize", "20");
    if (query.trim()) params.set("query", query.trim());
    setLoading(true); setError("");
    void api<Page<T>>(`${path}?${params}`, { signal: controller.signal }).then((next) => {
      if (controller.signal.aborted) return;
      setResult(next); setLoading(false); callbacks.current.onLoaded?.(next);
      if (autoSelectFirst && callbacks.current.value === "" && query === "" && next.items[0] !== undefined) {
        const option = callbacks.current.getOption(next.items[0]);
        selected.current = option; callbacks.current.onValueChange(option.value);
      }
    }).catch((reason: unknown) => { if (!controller.signal.aborted) { setError(errorMessage(reason)); setLoading(false); } });
    return () => controller.abort();
  }, [endpoint, page, query, retry, autoSelectFirst]);
  const options = result?.items.map(getOption) ?? [];
  const current = options.find((option) => option.value === value);
  if (current) selected.current = current;
  const offPage = value !== "" && !current
    ? { value, label: selectedLabel ?? (selected.current?.value === value ? selected.current.label : value) } : undefined;
  const label = ariaLabel ?? text("资源", "Resources");
  return <div className="min-w-0">
    <Input type="search" value={query} disabled={disabled} aria-label={text(`搜索 ${label}`, `Search ${label}`)} placeholder={text("搜索资源", "Search resources")} className="mb-2" onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
    <NativeSelect id={id} name={name} aria-label={ariaLabel} value={value} disabled={disabled || loading || Boolean(error) || (result?.items.length === 0 && value === "")} onChange={(event) => onValueChange(event.target.value)}>
      <NativeSelectOption value="">{emptyLabel ?? text("请选择", "Select")}</NativeSelectOption>
      {offPage ? <NativeSelectOption value={offPage.value}>{offPage.label}</NativeSelectOption> : null}
      {options.map((option) => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}
    </NativeSelect>
    {loading ? <p className="mt-1 text-xs text-muted-foreground" role="status">{text("加载中…", "Loading…")}</p> : null}
    {error ? <div className="mt-1 text-xs text-destructive" role="alert">{error}<Button type="button" size="sm" variant="ghost" onClick={() => setRetry((value) => value + 1)}>{text("重试", "Retry")}</Button></div> : null}
    {!loading && !error && result?.total === 0 ? <p className="mt-1 text-xs text-muted-foreground">{text("没有匹配资源", "No matching resources")}</p> : null}
    {result ? <ListPagination {...result} disabled={disabled || loading} onPageChange={setPage} /> : null}
  </div>;
}
