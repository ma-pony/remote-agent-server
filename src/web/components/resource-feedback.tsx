import { RefreshCw, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/i18n";

export const ResourceLoadError = ({ title, message, onRetry }: {
  title: string; message: string; onRetry(): void;
}) => {
  const { text } = useI18n();
  return <Alert variant="destructive">
    <TriangleAlert aria-hidden="true" />
    <AlertTitle>{title}</AlertTitle>
    <AlertDescription className="gap-3">
      <p className="[overflow-wrap:anywhere]">{message}</p>
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />{text("重新加载", "Try again")}
      </Button>
    </AlertDescription>
  </Alert>;
};

export const PageLoading = () => {
  const { text } = useI18n();
  return <div role="status" className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-6 lg:p-8">
    <span className="text-sm text-muted-foreground">{text("正在加载页面…", "Loading page…")}</span>
    <Skeleton className="h-8 w-48" />
    <Skeleton className="h-64 w-full" />
  </div>;
};
