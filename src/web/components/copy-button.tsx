import { useLayoutEffect, useRef, useState } from "react";
import { Check, Clipboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";

export const CopyButton = ({ value, label, className }: { value: string; label: string; className?: string }) => {
  const { text } = useI18n();
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const copyRequestRef = useRef(0);
  useLayoutEffect(() => {
    setState("idle");
    return () => { copyRequestRef.current += 1; };
  }, [value]);
  const copy = async () => {
    const request = ++copyRequestRef.current;
    setState("copying");
    try {
      await navigator.clipboard.writeText(value);
      if (request === copyRequestRef.current) setState("copied");
    } catch {
      if (request === copyRequestRef.current) setState("failed");
    }
  };
  return <span className="inline-flex flex-col items-start gap-1">
    <Button type="button" size="sm" variant="outline" className={className} disabled={state === "copying"}
      aria-label={text(`复制${label}`, `Copy ${label}`)} onClick={() => void copy()}>
      {state === "copied" ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
      <span aria-live="polite">{state === "copied" ? text("已复制", "Copied") : state === "copying" ? text("复制中…", "Copying…") : text("复制", "Copy")}</span>
    </Button>
    {state === "failed" ? <span role="alert" className="max-w-xs text-xs leading-5">{text("复制失败，请选中文字后手动复制。", "Copy failed. Select the text and copy it manually.")}</span> : null}
  </span>;
};
