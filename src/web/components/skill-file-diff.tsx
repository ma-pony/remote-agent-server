import { useEffect, useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, errorMessage, type SkillDiff, type SkillDiffFile, type SkillFilePreview } from "@/api";
import { useI18n } from "@/i18n";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const size = (bytes: number | null): string => bytes === null ? "—"
  : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/** Mounted for one file in one comparison; changing versions discards pending requests and cached output. */
export const SkillFileDiff = ({ base, diff, file }: { base: string; diff: SkillDiff; file: SkillDiffFile }) => {
  const { text } = useI18n();
  const previewId = useId();
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<SkillFilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (attempt === 0) return;
    const controller = new AbortController();
    setLoading(true); setError("");
    const query = new URLSearchParams({ revision: diff.revision, baseRevision: diff.baseRevision, path: file.path });
    void api<SkillFilePreview>(`${base}/diff/file?${query}`, { signal: controller.signal })
      .then((next) => { if (!controller.signal.aborted) setPreview(next); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt, base, diff.revision, diff.baseRevision, file.path]);
  const kind = preview?.kind ?? file.preview;
  const omitted = kind === "binary" ? text("二进制文件，不提供文本差异。", "Binary file; text diff is unavailable.")
    : kind === "unsupported_encoding" ? text("文件不是有效的 UTF-8 文本，无法预览。", "The file is not valid UTF-8 text and cannot be previewed.")
      : kind === "too_large" ? text(`文件超过单侧 ${size(diff.previewLimitBytes)} 的预览限制。`, `The file exceeds the ${size(diff.previewLimitBytes)} preview limit per side.`) : null;
  return <div className="flex min-w-0 flex-col gap-2 p-3">
    <div className="flex items-start gap-2">
      <Badge variant="outline">{{ added: text("新增", "Added"), removed: text("删除", "Removed"), modified: text("修改", "Modified") }[file.status]}</Badge>
      <code className="break-all text-xs">{file.path}</code>
    </div>
    <p className="text-xs text-muted-foreground">{size(file.beforeBytes)} → {size(file.afterBytes)}</p>
    {file.beforeMode !== file.afterMode ? <p className="text-xs text-muted-foreground">{text("文件权限", "Permissions")}: {file.beforeMode?.toString(8) ?? "—"} → {file.afterMode?.toString(8) ?? "—"}</p> : null}
    {omitted !== null ? <p className="text-xs text-muted-foreground">{omitted}</p> : <>
      {error === "" ? null : <Alert variant="destructive"><AlertTitle>{text("差异加载失败", "Could not load diff")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {preview !== null ? null : <Button size="sm" variant="outline" className="self-start" disabled={loading} aria-controls={previewId}
        aria-label={error === "" ? text(`查看 ${file.path} 的差异`, `View changes for ${file.path}`) : text(`重试 ${file.path} 的差异`, `Retry changes for ${file.path}`)}
        onClick={() => setAttempt((previous) => previous + 1)}>
        {loading ? <Loader2 className="animate-spin" /> : null}
        {loading ? text("加载差异…", "Loading diff…") : error === "" ? text("查看差异", "View diff") : text("重试", "Retry")}
      </Button>}
      <div id={previewId} aria-busy={loading} aria-live="polite">
        {preview?.kind !== "text" ? null : preview.patch === "" ? <p className="text-xs text-muted-foreground">{text("无文本行变化（空文件或仅权限变化）。", "No text line changes (empty file or permissions only).")}</p> : <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">{text("− 当前内容 · + 目标内容", "− Current content · + Target content")}</p>
          <pre tabIndex={0} aria-label={text(`${file.path} 的文本差异`, `Text diff for ${file.path}`)} className="max-h-80 overflow-auto rounded bg-muted p-2 font-mono text-xs">{preview.patch}</pre>
          {preview.truncated ? <p className="text-xs text-muted-foreground">{text("差异超过 64 KiB，当前仅显示开头部分。", "The diff exceeds 64 KiB; only its beginning is shown.")}</p> : null}
        </div>}
      </div>
    </>}
  </div>;
};
