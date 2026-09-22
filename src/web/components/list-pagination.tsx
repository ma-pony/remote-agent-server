import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";

export const ListPagination = ({ page, total, totalPages, onPageChange, disabled = false }: {
  page: number; pageSize: number; total: number; totalPages: number;
  onPageChange(page: number): void; disabled?: boolean;
}) => {
  const { text } = useI18n();
  if (total === 0 || (totalPages <= 1 && page <= 1)) return null;
  return <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
    <span>{text(`共 ${total} 项 · 第 ${page} / ${totalPages} 页`, `${total} items · Page ${page} / ${totalPages}`)}</span>
    <div className="flex items-center gap-2">
      <Button type="button" size="sm" variant="outline" aria-label={text("上一页", "Previous page")} disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft />{text("上一页", "Previous")}</Button>
      <Button type="button" size="sm" variant="outline" aria-label={text("下一页", "Next page")} disabled={disabled || page >= totalPages} onClick={() => onPageChange(page + 1)}>{text("下一页", "Next")}<ChevronRight /></Button>
    </div>
  </div>;
};
