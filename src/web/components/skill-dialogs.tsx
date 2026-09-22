import { type FormEvent, useEffect, useState } from "react";
import { GitBranch, Loader2, Plus, RefreshCw } from "lucide-react";
import { api, errorMessage, type AgentSkill, type SkillDiff, type SkillRevisionHistory, type SkillSource, type Page } from "@/api";
import { useI18n } from "@/i18n";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ListPagination } from "@/components/list-pagination";
import { PagedResourceSelect } from "@/components/paged-resource-select";
import { Skeleton } from "@/components/ui/skeleton";
import { SkillFileDiff } from "@/components/skill-file-diff";

type SourceSummary = Omit<SkillSource, "warnings"> & {warningCount: number};

type RevisionPage = Page<SkillRevisionHistory["revisions"][number]> & Omit<SkillRevisionHistory, "revisions">;
type DiffPage = Page<SkillDiff["files"][number]> & Omit<SkillDiff, "files">;

const SkillError = ({ message }: { message: string }) => {
  const { text } = useI18n();
  return message === "" ? null : <Alert variant="destructive">
    <AlertTitle>{text("操作失败", "Operation failed")}</AlertTitle><AlertDescription>{message}</AlertDescription>
  </Alert>;
};

export const SkillSourcesDialog = ({ onChanged, disabled }: { onChanged: () => Promise<void>; disabled: boolean }) => {
  const { text } = useI18n();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Page<SourceSummary> | null>(null);
  const sources = result?.items ?? null;
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const endpoint = `/skill-sources?page=${page}&pageSize=20&query=${encodeURIComponent(query)}`;
  const reload = async () => setResult(await api<Page<SourceSummary>>(endpoint));
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setResult(null); setError("");
    void api<Page<SourceSummary>>(endpoint, { signal: controller.signal }).then(setResult)
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [open, endpoint]);
  const operate = async (key: string, operation: () => Promise<void>) => {
    setBusy(key); setError("");
    try { await operation(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally {
      try { await reload(); await onChanged(); }
      catch (reason) { setError(errorMessage(reason)); }
      setBusy("");
    }
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    void operate("add", async () => {
      await api("/skill-sources", { method: "POST", body: JSON.stringify({ name: name.trim(), url: url.trim(),
        ...(ref.trim() ? { ref: ref.trim() } : {}), ...(path.trim() ? { path: path.trim() } : {}) }) });
      setName(""); setUrl(""); setRef(""); setPath("");
    });
  };
  const pending = busy !== "" || sources?.some((source) => source.status === "syncing") === true;
  return <Dialog open={open} onOpenChange={(next) => { if (busy === "") setOpen(next); }}>
    <DialogTrigger asChild><Button variant="outline" disabled={disabled}><GitBranch />{text("管理 Git 来源", "Manage Git sources")}</Button></DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{text("Git Skill 来源", "Git Skill sources")}</DialogTitle>
        <DialogDescription>{text("刷新只发现可用版本，不会更新任何智能体。移除来源会保留已安装的版本和回滚历史。", "Refreshing only discovers versions; it never updates an Agent. Removing a source keeps installed versions and rollback history.")}</DialogDescription>
      </DialogHeader>
      <SkillError message={error} />
      <form onSubmit={add}>
        <FieldGroup>
          <Field><FieldLabel htmlFor="skill-source-name">{text("名称", "Name")}</FieldLabel><Input id="skill-source-name" required maxLength={100} value={name} disabled={pending} onChange={(event) => setName(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor="skill-source-url">Git URL</FieldLabel><Input id="skill-source-url" required maxLength={2000} placeholder="https://github.com/org/skills.git" value={url} disabled={pending} onChange={(event) => setUrl(event.target.value)} /><FieldDescription>{text("支持 HTTPS、SSH 和 git@host:group/repo.git；凭证由服务用户的 Git 配置提供。", "Supports HTTPS, SSH and git@host:group/repo.git; Git credentials come from the service user.")}</FieldDescription></Field>
          <Field><FieldLabel htmlFor="skill-source-ref">{text("分支、标签或提交 SHA（可选）", "Branch, tag or commit SHA (optional)")}</FieldLabel><Input id="skill-source-ref" maxLength={255} value={ref} disabled={pending} onChange={(event) => setRef(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor="skill-source-path">{text("仓库路径（可选）", "Repository path (optional)")}</FieldLabel><Input id="skill-source-path" maxLength={1024} value={path} disabled={pending} onChange={(event) => setPath(event.target.value)} /></Field>
        </FieldGroup>
        <div className="mt-4 flex justify-end"><Button type="submit" disabled={pending || !name.trim() || !url.trim()}>{busy === "add" ? <Loader2 className="animate-spin" /> : <Plus />}{text("添加来源", "Add source")}</Button></div>
      </form>
      <div className="flex justify-end"><Button variant="ghost" size="sm" disabled={busy !== ""} onClick={() => { void reload().catch((reason: unknown) => setError(errorMessage(reason))); }}>{text("重新加载列表", "Reload list")}</Button></div>
      <Input aria-label={text("搜索 Git 来源", "Search Git sources")} value={query} onChange={event => {setPage(1); setQuery(event.target.value);}} />
      {sources === null ? (error === "" ? <Skeleton className="h-24" /> : null) : sources.length === 0
        ? <p className="text-sm text-muted-foreground">{text("尚未添加 Git 来源。", "No Git sources yet.")}</p>
        : <div className="divide-y rounded-lg border">{sources.map((source) => <div key={source.id} className="flex flex-col gap-3 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2"><p className="font-medium">{source.name}</p><Badge variant={source.status === "ready" ? "secondary" : source.status === "failed" ? "destructive" : "outline"}>{source.status === "ready" ? text("已就绪", "Ready") : source.status === "syncing" ? text("刷新中", "Refreshing") : text("失败", "Failed")}</Badge></div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void operate(`refresh-${source.id}`, async () => { await api(`/skill-sources/${encodeURIComponent(source.id)}/refresh`, { method: "POST" }); })}><RefreshCw className={busy === `refresh-${source.id}` ? "animate-spin" : ""} />{text("刷新", "Refresh")}</Button>
              <AlertDialog>
                <AlertDialogTrigger asChild><Button size="sm" variant="ghost" disabled={pending}>{text("移除", "Remove")}</Button></AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader><AlertDialogTitle>{text(`移除“${source.name}”？`, `Remove “${source.name}”?`)}</AlertDialogTitle><AlertDialogDescription>{text("这会停止发现该来源的新版本，但不会删除已安装的 Skill 或其回滚历史。", "This stops discovering new versions, but does not delete installed Skills or their rollback history.")}</AlertDialogDescription></AlertDialogHeader>
                  <AlertDialogFooter><AlertDialogCancel>{text("取消", "Cancel")}</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void operate(`delete-${source.id}`, async () => { await api(`/skill-sources/${encodeURIComponent(source.id)}`, { method: "DELETE" }); })}>{text("移除来源", "Remove source")}</AlertDialogAction></AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">{source.url}{source.ref ? `#${source.ref}` : ""}{source.path ? ` · ${source.path}` : ""}</p>
          <p className="text-xs text-muted-foreground">{text(`${source.skillCount} 个 Skill`, `${source.skillCount} Skills`)}</p>
          {source.error ? <p className="text-xs text-destructive">{source.error}</p> : null}
          {source.warningCount > 0 ? <SkillSourceWarnings source={source} /> : null}
        </div>)}</div>}
      {result === null ? null : <ListPagination {...result} onPageChange={setPage} disabled={pending} />}
    </DialogContent>
  </Dialog>;
};

const SkillSourceWarnings = ({source}: {source: SourceSummary}) => {
  const {text} = useI18n();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<string> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setResult(null); setError("");
    void api<Page<string>>(`/skill-sources/${encodeURIComponent(source.id)}/warnings?page=${page}&pageSize=20`, {signal: controller.signal})
      .then(setResult).catch(reason => {if (!controller.signal.aborted) setError(errorMessage(reason));});
    return () => controller.abort();
  }, [source.id, open, page]);
  return <div><Button type="button" size="sm" variant="ghost" onClick={() => setOpen(value => !value)} aria-expanded={open}>{text(`${source.warningCount} 条提示`, `${source.warningCount} warnings`)}</Button>
    {open ? <><SkillError message={error} />{result === null ? <Skeleton className="h-12" /> : result.items.map((warning, index) => <p key={index} className="text-xs text-muted-foreground">{warning}</p>)}{result === null ? null : <ListPagination {...result} onPageChange={setPage} />}</> : null}</div>;
};

export const SkillRevisionDialog = ({ agentId, skill, onApplied, disabled }: { agentId: number; skill: AgentSkill; onApplied: () => Promise<void>; disabled: boolean }) => {
  const { text } = useI18n();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<RevisionPage | null>(null);
  const [revision, setRevision] = useState("");
  const [diff, setDiff] = useState<DiffPage | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const base = `/agents/${agentId}/skills/${encodeURIComponent(skill.id)}`;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setHistory(null); setDiff(null); setRevision(""); setError("");
    void api<RevisionPage>(`${base}/revisions?page=1&pageSize=20`, { signal: controller.signal }).then((next) => {
      setHistory(next); setRevision(next.latestRevision ?? next.currentRevision ?? "");
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [open, base]);
  const preview = async (page = 1) => {
    if (!revision) return;
    setBusy("preview"); setError(""); setDiff(null);
    try { setDiff(await api<DiffPage>(`${base}/diff?revision=${encodeURIComponent(revision)}&page=${page}&pageSize=20`)); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(""); }
  };
  const apply = async () => {
    if (!diff || diff.revision !== revision) return;
    setBusy("apply"); setError("");
    try {
      await api<AgentSkill>(`${base}/revision`, { method: "POST", body: JSON.stringify({ revision: diff.revision, expectedRevision: diff.expectedRevision }) });
      await onApplied(); setOpen(false);
    } catch (reason) { setError(errorMessage(reason)); setDiff(null); }
    finally { setBusy(""); }
  };
  const target = history?.items.find((item) => item.revision === revision);
  return <Dialog open={open} onOpenChange={(next) => { if (busy === "") setOpen(next); }}>
    <DialogTrigger asChild><Button size="sm" variant="outline" disabled={disabled || !skill.enabled || skill.currentRevision === undefined}>{skill.updateAvailable ? text("查看更新", "View update") : text("版本", "Versions")}</Button></DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{text(`${skill.name} 的版本`, `Versions for ${skill.name}`)}</DialogTitle><DialogDescription>{text("先预览变更，再明确应用。只影响当前智能体的后续运行。", "Preview changes before explicitly applying them. Only future runs of this Agent are affected.")}</DialogDescription></DialogHeader>
      <SkillError message={error} />
      {history === null ? (error === "" ? <Skeleton className="h-28" /> : null) : <>
        <Field>
          <FieldLabel htmlFor={`skill-revision-${skill.id}`}>{text("目标版本", "Target version")}</FieldLabel>
          <PagedResourceSelect<SkillRevisionHistory["revisions"][number]> id={`skill-revision-${skill.id}`} endpoint={`${base}/revisions`} value={revision} selectedLabel={revision.slice(0, 12)} disabled={busy !== ""} onValueChange={value => {setRevision(value); setDiff(null);}} getOption={item => ({value: item.revision, label: `${item.revision.slice(0, 12)}${item.revision === history.currentRevision ? ` · ${text("当前", "current")}` : ""}${item.revision === history.latestRevision ? ` · ${text("最新", "latest")}` : ""}`})} />
          {target?.repositoryUrl ? <FieldDescription className="break-all">{target.repositoryUrl}{target.commit ? ` · ${target.commit.slice(0, 12)}` : ""}</FieldDescription> : null}
        </Field>
        <div className="flex justify-end"><Button variant="outline" disabled={!revision || busy !== ""} onClick={() => void preview()}>{busy === "preview" ? <Loader2 className="animate-spin" /> : null}{text("预览变更", "Preview changes")}</Button></div>
        {diff === null ? null : <>
          <Alert variant={diff.locallyModified ? "destructive" : "default"}>
            <AlertTitle>{diff.locallyModified ? text("检测到本地修改", "Local modifications detected") : text("版本比较", "Revision comparison")}</AlertTitle>
            <AlertDescription>{diff.locallyModified ? text("为保护本地内容，无法覆盖。请先保存本地修改，再恢复原内容或停用后重新启用。", "Applying is blocked to protect local content. Save your edits, then restore the original files or disable and enable the Skill.") : text(`${diff.total} 个文件发生变化。`, `${diff.total} files changed.`)}</AlertDescription>
          </Alert>
          {diff.total === 0 ? <p className="text-sm text-muted-foreground">{text("文件内容和权限没有变化。", "File contents and permissions are unchanged.")}</p> : <div className="max-h-[55vh] divide-y overflow-y-auto rounded-lg border">{diff.items.map((file) =>
            <SkillFileDiff key={`${diff.revision}:${diff.baseRevision}:${file.path}`} base={base} diff={{...diff, files: diff.items}} file={file} />
          )}</div>}
          <ListPagination {...diff} onPageChange={page => void preview(page)} disabled={busy !== ""} />
          <DialogFooter>
            <Button variant="outline" disabled={busy !== ""} onClick={() => setOpen(false)}>{text("取消", "Cancel")}</Button>
            <Button disabled={disabled || diff.locallyModified || busy !== "" || diff.revision !== revision || diff.revision === history.currentRevision} onClick={() => void apply()}>{busy === "apply" ? <Loader2 className="animate-spin" /> : null}{diff.revision === history.latestRevision ? text("应用此版本", "Apply this version") : text("回滚到此版本", "Roll back to this version")}</Button>
          </DialogFooter>
        </>}
      </>}
    </DialogContent>
  </Dialog>;
};
