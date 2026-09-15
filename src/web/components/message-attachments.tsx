import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { Download, FileIcon, X, XCircle } from "lucide-react";
import { type Attachment, type AttachmentInput, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, isNativeImage } from "../../attachments/attachment-types.js";
import { apiBlob, errorMessage } from "../api.js";
import { useI18n } from "../i18n.js";
import { Alert, AlertDescription } from "./ui/alert.js";
import { Button } from "./ui/button.js";
import { Field, FieldDescription, FieldLabel } from "./ui/field.js";
import { Input } from "./ui/input.js";

const readFile = (file: File): Promise<AttachmentInput> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error("file_read_failed"));
  reader.onload = () => resolve({ name: file.name, mediaType: file.type || "application/octet-stream", data: String(reader.result).split(",")[1]! });
  reader.readAsDataURL(file);
});
const byteSize = (data: string) => data.length * 3 / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

export const useAttachmentDraft = (scope: string | number) => {
  const { text } = useI18n();
  const [attachments, setAttachments] = useState<AttachmentInput[]>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const readingRef = useRef(false);
  const reset = () => { generation.current++; readingRef.current = false; setAttachments([]); setReading(false); setError(""); };
  useEffect(() => {
    reset();
    return () => { generation.current++; };
  }, [scope]);

  const addFiles = async (files: File[]) => {
    if (files.length === 0 || readingRef.current) return;
    setError("");
    if (attachments.length + files.length > MAX_ATTACHMENTS) {
      setError(text("每条消息最多 8 个附件。", "Each message supports up to 8 attachments.")); return;
    }
    if (files.some((file) => file.size > MAX_ATTACHMENT_BYTES || (isNativeImage(file.type) && file.size > MAX_IMAGE_BYTES))) {
      setError(text("单个文件最多 10 MiB，图片最多 5 MiB。", "Each file is limited to 10 MiB; images to 5 MiB.")); return;
    }
    if (files.reduce((sum, file) => sum + file.size, 0) + attachments.reduce((sum, item) => sum + byteSize(item.data), 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
      setError(text("每条消息的附件总大小最多 20 MiB。", "Attachments in one message are limited to 20 MiB in total.")); return;
    }
    const current = generation.current;
    readingRef.current = true;
    setReading(true);
    try {
      const added = await Promise.all(files.map(readFile));
      if (current === generation.current) setAttachments((items) => [...items, ...added]);
    } catch (_error) {
      if (current === generation.current) setError(text("读取附件失败，请重新选择文件。", "Could not read the attachment. Select the file again."));
    } finally {
      if (current === generation.current) { readingRef.current = false; setReading(false); }
    }
  };
  const paste = (event: ClipboardEvent, disabled: boolean) => {
    if (disabled || event.clipboardData.files.length === 0) return;
    event.preventDefault();
    void addFiles(Array.from(event.clipboardData.files));
  };
  const drop = (event: DragEvent, disabled: boolean) => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    if (!disabled) void addFiles(Array.from(event.dataTransfer.files));
  };
  return { attachments, reading, error, addFiles, paste, drop, reset, remove: (index: number) => setAttachments((items) => items.filter((_, position) => position !== index)) };
};

export const AttachmentPicker = ({ draft, disabled }: { draft: ReturnType<typeof useAttachmentDraft>; disabled: boolean }) => {
  const { text } = useI18n();
  const id = useId();
  return <div className="flex flex-col gap-3">
    <Field data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id}>{text("添加图片或文件", "Add images or files")}</FieldLabel>
      <Input id={id} type="file" multiple disabled={disabled || draft.reading} onChange={(event) => {
        void draft.addFiles(Array.from(event.target.files ?? [])); event.target.value = "";
      }} />
      <FieldDescription>{draft.reading ? text("正在读取附件…", "Reading attachments…") : text("可粘贴图片或拖入文件。最多 8 个，单文件 10 MiB、图片 5 MiB，总计 20 MiB。", "Paste images or drop files. Up to 8 files, 10 MiB per file, 5 MiB per image, 20 MiB total.")}</FieldDescription>
    </Field>
    {draft.error === "" ? null : <Alert variant="destructive"><XCircle /><AlertDescription>{draft.error}</AlertDescription></Alert>}
    {draft.attachments.length === 0 ? null : <ul className="flex flex-wrap gap-2" aria-label={text("待发送附件", "Pending attachments")}>
      {draft.attachments.map((item, index) => <li key={index} className="flex max-w-full items-center gap-2 rounded-md border bg-muted/30 p-2">
        {isNativeImage(item.mediaType) ? <img src={`data:${item.mediaType};base64,${item.data}`} alt={item.name} className="size-14 rounded object-contain" /> : <FileIcon className="size-5 shrink-0" aria-hidden="true" />}
        <span className="max-w-48 truncate text-sm" title={item.name}>{item.name}</span>
        <Button type="button" size="icon-sm" variant="ghost" disabled={disabled || draft.reading} aria-label={text(`移除 ${item.name}`, `Remove ${item.name}`)} onClick={() => draft.remove(index)}><X /></Button>
      </li>)}
    </ul>}
  </div>;
};

const StoredAttachment = ({ attachment, pathPrefix }: { attachment: Attachment; pathPrefix: string }) => {
  const { text } = useI18n();
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const objectUrl = useRef<string | null>(null);
  const requestController = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    requestController.current = controller;
    setPreview(""); setBusy(false); setError("");
    return () => {
      controller.abort();
      if (objectUrl.current !== null) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    };
  }, [attachment.id, attachment.available, pathPrefix]);
  const load = async (previewImage: boolean) => {
    const controller = requestController.current;
    if (controller === null || controller.signal.aborted || !attachment.available) return;
    setBusy(true); setError("");
    try {
      if (objectUrl.current === null) {
        const blob = await apiBlob(`${pathPrefix}/${attachment.id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        objectUrl.current = URL.createObjectURL(blob);
      }
      const url = objectUrl.current;
      if (previewImage) setPreview(url);
      else {
        const link = document.createElement("a"); link.href = url; link.download = attachment.name;
        document.body.append(link); link.click(); link.remove();
      }
    } catch (reason) { if (!controller.signal.aborted) setError(errorMessage(reason)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <li className="flex flex-col gap-2 rounded-md border p-2 text-sm">
    <div className="flex flex-wrap items-center gap-2"><FileIcon className="size-4 shrink-0" aria-hidden="true" /><span className="max-w-64 truncate" title={attachment.name}>{attachment.name}</span><span className="text-xs opacity-70">{(attachment.size / 1024).toFixed(1)} KiB</span>
      {!attachment.available ? <span>{text("文件已清理", "File cleaned")}</span> : <>
        {isNativeImage(attachment.mediaType) ? <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void load(true)}>{text("预览", "Preview")}</Button> : null}
        <Button type="button" size="icon-sm" variant="secondary" disabled={busy} aria-label={text(`下载 ${attachment.name}`, `Download ${attachment.name}`)} onClick={() => void load(false)}><Download /></Button>
        {busy ? <span role="status">{text("读取中…", "Loading…")}</span> : null}
      </>}
    </div>
    {preview === "" ? null : <img src={preview} alt={attachment.name} className="max-h-80 max-w-full rounded object-contain" onError={() => { setPreview(""); setError(text("无法预览该图片，可以下载查看。", "Cannot preview this image. Download it to view.")); }} />}
    {error === "" ? null : <span role="alert">{error}</span>}
  </li>;
};

export const MessageAttachments = ({ attachments, pathPrefix }: { attachments?: Attachment[]; pathPrefix: string }) => {
  const { text } = useI18n();
  return !attachments?.length ? null : <ul className="mt-3 flex flex-col gap-2" aria-label={text("消息附件", "Message attachments")}>
    {attachments.map((item) => <StoredAttachment key={item.id} attachment={item} pathPrefix={pathPrefix} />)}
  </ul>;
};
