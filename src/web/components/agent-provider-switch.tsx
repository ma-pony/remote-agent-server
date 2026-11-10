import { PROVIDER_CAPABILITIES } from "../../domain.js";
import { useState, type FormEvent } from "react";
import { api, errorMessage, type Agent, type Provider } from "@/api";
import { useI18n } from "@/i18n";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

const providers = Object.entries(PROVIDER_CAPABILITIES);

export function AgentProviderSwitch({ agent, onChanged }: { agent: Agent; onChanged(agent: Agent): void }) {
  const { text } = useI18n();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>(agent.provider);
  const [resetModel, setResetModel] = useState(false);
  const [handoff, setHandoff] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const incompatible = !PROVIDER_CAPABILITIES[provider].instructions && agent.instructions.trim() !== "";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || provider === agent.provider || incompatible) return;
    setBusy(true); setError("");
    try {
      const updated = await api<Agent>(`/agents/${agent.id}/provider-switch`, {
        method: "POST", body: JSON.stringify({ provider, ...(resetModel ? { modelPolicy: { mode: "provider_default" } } : {}), ...(handoff.trim() ? { handoff: handoff.trim() } : {}) })
      });
      onChanged(updated); setSuccess(true); setOpen(false);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  return <>
    {success ? <span role="status" className="text-sm text-muted-foreground">{text("执行器已切换", "Executor switched")}</span> : null}
    <Dialog open={open} onOpenChange={(value) => {
      if (busy) return;
      if (value) { setProvider(agent.provider); setHandoff(""); setResetModel(false); setError(""); setSuccess(false); }
      setOpen(value);
    }}>
      <DialogTrigger asChild><Button size="sm" variant="outline">{text("切换执行器", "Switch executor")}</Button></DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto"><form onSubmit={submit} className="flex flex-col gap-5">
        <DialogHeader><DialogTitle>{text("切换智能体执行器", "Switch agent executor")}</DialogTitle>
          <DialogDescription>{text("保留智能体身份、接入端点、会话、工作区文件和历史。已有会话下次运行使用新的原生上下文；旧对话不会自动传给新执行器。所有任务和维护操作结束后才能切换。", "Keep the agent identity, endpoints, sessions, workspace files, and history. Existing sessions use fresh native context on their next run; old conversations are not transferred automatically. All tasks and maintenance must finish before switching.")}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field><FieldLabel htmlFor="switch-provider">{text("目标执行器", "Target executor")}</FieldLabel>
            <NativeSelect id="switch-provider" value={provider} disabled={busy} onChange={(event) => { setProvider(event.target.value as Provider); setError(""); }}>
              {providers.map(([value, { label: name }]) => <NativeSelectOption key={value} value={value}>{name}</NativeSelectOption>)}
            </NativeSelect>
            <FieldDescription>{text("使用目标执行器自己的认证与模型配置。模型策略分别保留。已配置的插件会检查目标原生版本后安装。", "The target uses its own authentication and model configuration. Model policies are retained separately. Configured plugins require a matching native target installation.")}</FieldDescription>
          </Field>
          <Field><FieldLabel htmlFor="switch-model-policy">{text("模型配置", "Model configuration")}</FieldLabel>
            <NativeSelect id="switch-model-policy" value={resetModel ? "default" : "saved"} disabled={busy} onChange={event => setResetModel(event.target.value === "default")}>
              <NativeSelectOption value="saved">{text("恢复目标执行器上次的模型策略", "Restore the target’s saved model policy")}</NativeSelectOption>
              <NativeSelectOption value="default">{text("使用目标执行器默认模型", "Use the target’s default model")}</NativeSelectOption>
            </NativeSelect>
            <FieldDescription>{text("首次使用时跟随执行器默认模型；切换后可在设置中选择固定模型或分时策略。", "The first switch uses the executor default. After switching, select a fixed model or schedule in settings.")}</FieldDescription>
          </Field>
          <Field><FieldLabel htmlFor="provider-handoff">{text("交接说明（可选）", "Handoff notes (optional)")}</FieldLabel>
            <Textarea id="provider-handoff" value={handoff} disabled={busy} maxLength={20000} onChange={(event) => setHandoff(event.target.value)} />
            <FieldDescription>{text("这段文字将交给每个已有会话的新上下文。留空即重新开始上下文；文件和历史仍保留。不要填写只属于某一个会话的私密内容。", "These notes are passed to the new context of every existing session. Leave blank to start fresh; files and history remain. Avoid private details belonging to only one session.")}</FieldDescription>
          </Field>
        </FieldGroup>
        <Alert><AlertTitle>{text("原生插件兼容性", "Native plugin compatibility")}</AlertTitle><AlertDescription>{text("插件按目标执行器原生方式安装和启用，不转换为独立 Skills 或 MCP。没有匹配的目标原生版本时，切换会被阻止，原配置保持不变。", "Plugins use the target executor’s native installation and enablement. They are not converted into standalone Skills or MCP. A missing native counterpart blocks switching and preserves the original configuration.")}</AlertDescription></Alert>
        {PROVIDER_CAPABILITIES[provider].rtk === "unsupported" ? <Alert><AlertTitle>{text("RTK 不受支持", "RTK unsupported")}</AlertTitle><AlertDescription>{text("目标执行器尚无 RTK 自动改写适配；RTK 正在生效时会阻止切换。", "The target has no RTK automatic rewriting adapter. Active RTK blocks switching.")}</AlertDescription></Alert> : null}
        {incompatible ? <Alert variant="destructive"><AlertTitle>{text("指令不兼容", "Instructions incompatible")}</AlertTitle><AlertDescription>{text("目标执行器当前不支持智能体指令，请先处理智能体及已有会话的指令。", "The target does not support agent instructions. Resolve instructions for the Agent and its existing sessions first.")}</AlertDescription></Alert> : null}
        {error ? <Alert variant="destructive"><AlertTitle>{text("切换失败", "Switch failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>{text("取消", "Cancel")}</Button>
          <Button type="submit" disabled={busy || provider === agent.provider || incompatible}>{busy ? text("切换中…", "Switching…") : text("确认切换", "Confirm switch")}</Button>
        </DialogFooter>
      </form></DialogContent>
    </Dialog>
  </>;
}
