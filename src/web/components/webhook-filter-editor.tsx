import { useId } from "react";
import { Collapsible } from "radix-ui";
import { ChevronDown, Plus, Trash2 } from "lucide-react";

import type { WebhookProviderDefinition } from "@/api";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { webhookFilterSchema, type WebhookFilter } from "../../integrations/webhook-filter.js";

export type FilterDraft = { field: string; op: string; valueText: string }
  | { mode: "all" | "any"; children: FilterDraft[] };
export const draftFilter = (filter: WebhookFilter | null): FilterDraft | null => {
  if (filter === null) return null;
  if ("all" in filter) return { mode: "all", children: filter.all.map((child) => draftFilter(child)!) };
  if ("any" in filter) return { mode: "any", children: filter.any.map((child) => draftFilter(child)!) };
  return { field: filter.field, op: filter.op, valueText: JSON.stringify(filter.value) };
};
const draftValue = (draft: FilterDraft): unknown => "mode" in draft
  ? { [draft.mode]: draft.children.map(draftValue) }
  : { field: draft.field, op: draft.op, value: JSON.parse(draft.valueText) as unknown };
export const parseFilterDraft = (draft: FilterDraft | null): { valid: true; filter: WebhookFilter | null } | { valid: false } => {
  if (draft === null) return { valid: true, filter: null };
  try {
    const parsed = webhookFilterSchema.safeParse(draftValue(draft));
    return parsed.success ? { valid: true, filter: parsed.data } : { valid: false };
  } catch { return { valid: false }; }
};
const newCondition = (): FilterDraft => ({ field: "eventType", op: "eq", valueText: '""' });

const RuleEditor = ({ draft, onChange, onRemove, fieldsId, depth = 0 }: {
  draft: FilterDraft; onChange(draft: FilterDraft): void; onRemove?(): void; fieldsId: string; depth?: number;
}) => {
  const { text } = useI18n();
  const id = useId();
  if ("mode" in draft) return <Collapsible.Root defaultOpen={depth === 0} className="rounded-lg border p-3">
    <div className="flex items-center justify-between gap-2">
      <Collapsible.Trigger asChild><Button type="button" variant="ghost" size="sm"><ChevronDown data-icon="inline-start" />
        {draft.mode === "all" ? text("满足全部条件", "Match all") : text("满足任一条件", "Match any")} · {draft.children.length}
      </Button></Collapsible.Trigger>
      {onRemove === undefined ? null : <Button type="button" variant="ghost" size="sm" onClick={onRemove}><Trash2 data-icon="inline-start" />{text("删除条件组", "Remove group")}</Button>}
    </div>
    <Collapsible.Content><FieldSet className="pt-3">
    <Field>
      <FieldLabel htmlFor={`${id}-mode`}>{text("匹配方式", "Match mode")}</FieldLabel>
      <NativeSelect id={`${id}-mode`} value={draft.mode} onChange={(event) => onChange({ ...draft, mode: event.target.value as "all" | "any" })}>
        <NativeSelectOption value="all">{text("满足全部条件", "Match all conditions")}</NativeSelectOption>
        <NativeSelectOption value="any">{text("满足任一条件", "Match any condition")}</NativeSelectOption>
      </NativeSelect>
    </Field>
    {draft.children.map((child, index) => <RuleEditor key={index} draft={child} depth={depth + 1} fieldsId={fieldsId}
      onChange={(next) => onChange({ ...draft, children: draft.children.map((item, at) => at === index ? next : item) })}
      onRemove={() => onChange({ ...draft, children: draft.children.filter((_, at) => at !== index) })} />)}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" disabled={draft.children.length >= 50} onClick={() => onChange({ ...draft, children: [...draft.children, newCondition()] })}>
        <Plus data-icon="inline-start" />{text("添加条件", "Add condition")}
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={depth >= 5 || draft.children.length >= 50} onClick={() => onChange({ ...draft, children: [...draft.children, { mode: "any", children: [newCondition()] }] })}>
        <Plus data-icon="inline-start" />{text("添加条件组", "Add group")}
      </Button>
    </div>
    </FieldSet></Collapsible.Content>
  </Collapsible.Root>;
  const valid = parseFilterDraft(draft).valid;
  return <FieldGroup className="grid gap-3 rounded-lg border p-3 md:grid-cols-3">
    <Field>
      <FieldLabel htmlFor={`${id}-field`}>{text("字段路径", "Field path")}</FieldLabel>
      <Input id={`${id}-field`} list={fieldsId} maxLength={256} value={draft.field} onChange={(event) => onChange({ ...draft, field: event.target.value })} />
    </Field>
    <Field>
      <FieldLabel htmlFor={`${id}-op`}>{text("比较方式", "Operator")}</FieldLabel>
      <NativeSelect id={`${id}-op`} value={draft.op} onChange={(event) => onChange({ ...draft, op: event.target.value })}>
        {[["eq", "等于", "Equals"], ["neq", "不等于", "Does not equal"], ["in", "属于列表", "In list"],
          ["not_in", "不属于列表", "Not in list"], ["contains", "列表包含", "List contains"],
          ["not_contains", "列表不包含", "List does not contain"], ["exists", "字段存在", "Field exists"]].map(([value, zh, en]) =>
          <NativeSelectOption key={value} value={value}>{text(zh!, en!)}</NativeSelectOption>)}
      </NativeSelect>
    </Field>
    <Field data-invalid={!valid}>
      <FieldLabel htmlFor={`${id}-value`}>{text("比较值（JSON）", "Value (JSON)")}</FieldLabel>
      <Textarea id={`${id}-value`} rows={1} aria-invalid={!valid} value={draft.valueText} onChange={(event) => onChange({ ...draft, valueText: event.target.value })} />
      <FieldDescription>{draft.op === "exists" ? text("true 表示必须存在；false 表示必须缺失。通配路径按是否至少有一个元素存在该字段判断。", "true requires presence; false requires absence. Wildcard paths require at least one element with the selected field to count as present.")
        : draft.op === "contains" ? text('填写单个值，如 "CodeReview"。字段可用 labels.*.title 提取所有标签名。', 'Enter a single value, such as "CodeReview". Use labels.*.title to select every label title.')
        : draft.op === "not_contains" ? text('填写要排除的单个值，如 "Done-Pass"。字段必须为数组，所有元素须完整且与比较值同类型；空数组符合此条件。', 'Enter one value to exclude, such as "Done-Pass". The field must be an array with every element present and of the same type as the value; an empty array matches.')
        : text('例如：42、"main"、false 或 [101,102]。列表中的值须为同一类型。', 'Examples: 42, "main", false, or [101,102]. List values must have the same type.')}</FieldDescription>
    </Field>
    {onRemove === undefined ? null : <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onRemove}><Trash2 data-icon="inline-start" />{text("删除条件", "Remove condition")}</Button>}
  </FieldGroup>;
};

export const WebhookFilterEditor = ({ draft, onChange, definition, disabled }: {
  draft: FilterDraft | null; onChange(draft: FilterDraft | null): void; definition?: WebhookProviderDefinition; disabled: boolean;
}) => {
  const { text } = useI18n();
  const id = useId();
  const valid = parseFilterDraft(draft).valid;
  return <FieldSet disabled={disabled}>
    <FieldLegend>{text("事件筛选", "Event filters")}</FieldLegend>
    <FieldDescription>{text("只为命中规则的事件创建任务。MR / PR 作者和事件操作者是不同字段；建议用开发人员 ID 白名单，或维护完整的 Agent ID 黑名单。", "Only matching events create tasks. MR / PR authors differ from event actors. Use a developer ID allowlist or maintain a complete agent ID denylist.")}</FieldDescription>
    <FieldDescription>{text("字段缺失或类型不符时不匹配，包括负向比较。未设置规则则接收所有事件（GitHub ping 除外）。", "Missing fields and type mismatches fail comparisons, including negative comparisons. Without rules, all events are accepted except GitHub ping.")}</FieldDescription>
    <datalist id={id}>{definition?.filterFields?.map((field) => <option key={field.path} value={field.path}>{text(field.label.zh, field.label.en)}</option>)}</datalist>
    <div className="flex flex-wrap gap-2">
      {definition?.filterPresets?.map((preset) => <Button key={preset.id} type="button" variant="outline" size="sm"
        onClick={() => onChange(draftFilter(preset.filter))}>{text("应用 ", "Apply ")}{text(preset.name.zh, preset.name.en)}</Button>)}
      {draft === null ? <Button type="button" variant="outline" size="sm" onClick={() => onChange({ mode: "all", children: [newCondition()] })}>
        <Plus data-icon="inline-start" />{text("自定义筛选", "Custom filter")}</Button>
        : <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>{text("清除筛选", "Clear filters")}</Button>}
    </div>
    {draft === null ? <FieldDescription>{text("当前不筛选事件。", "No event filters configured.")}</FieldDescription>
      : <RuleEditor draft={draft} fieldsId={id} onChange={onChange} />}
    {!valid ? <FieldDescription role="alert">{text("请检查字段路径、比较值和条件组：不得留空，最多 50 个节点、6 层嵌套。", "Check field paths, values, and groups: groups cannot be empty; at most 50 nodes and 6 nesting levels.")}</FieldDescription> : null}
    <FieldDescription>{text("应用预设会替换当前规则；预设只选择审核事件，还需添加项目和作者条件。保存后对新的投递生效，重试沿用原决定。", "A preset replaces the current rules and selects review events only; add project and author conditions. Saved changes apply to new deliveries; retries keep the original decision.")}</FieldDescription>
  </FieldSet>;
};
