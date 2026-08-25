// ============================================================================
// WritebackFields —— 写回类工具（首版 mail_send）审批卡的字段区
//
// 查看态：把要发出去的东西全部摊开（收件人 / 抄送 / 密送 / 主题 / 正文 / 附件），
//         正文默认展开、超过 12 行折叠。不可逆动作的审批卡把正文藏起来 = 盲批。
// 编辑态：表内字段变成输入框，改完的值由 PermissionCard 随 'allow' 一起送回 host；
//         必填为空时由 PermissionCard 禁用主按钮（fail-closed 在两端各守一道）。
// 字段表来自 @shared/contract 的 EDITABLE_TOOL_FIELDS，renderer 不自持一份。
// ============================================================================

import React, { useState } from 'react';
import { EDITABLE_TOOL_FIELDS, type EditableField } from '@shared/contract';
import { Input } from '../primitives/Input';
import { Textarea } from '../primitives/Textarea';
import { useI18n } from '../../hooks/useI18n';

/** 编辑态草稿：列表字段以逗号串保存（用户逐字输入时不能过早切数组）。 */
export type WritebackDraft = Record<string, string>;

const BODY_COLLAPSE_LINES = 12;

export function draftFromArgs(tool: string, args: Record<string, unknown>): WritebackDraft {
  const draft: WritebackDraft = {};
  for (const field of EDITABLE_TOOL_FIELDS[tool] ?? []) {
    const raw = args[field.key];
    draft[field.key] = field.kind === 'string_list'
      ? (Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string').join(', ') : '')
      : (typeof raw === 'string' ? raw : '');
  }
  return draft;
}

/** 草稿 → 送回 host 的 updatedArgs（列表按逗号/分号/换行切开并去空）。 */
export function draftToArgs(tool: string, draft: WritebackDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of EDITABLE_TOOL_FIELDS[tool] ?? []) {
    const value = draft[field.key] ?? '';
    out[field.key] = field.kind === 'string_list'
      ? value.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)
      : value;
  }
  return out;
}

/** 必填字段是否都有值（空 = 主按钮禁用）。 */
export function draftMissingRequired(tool: string, draft: WritebackDraft): string[] {
  return (EDITABLE_TOOL_FIELDS[tool] ?? [])
    .filter((f) => f.required && (draftToArgs(tool, draft)[f.key] as string | string[]).length === 0)
    .map((f) => f.key);
}

function useFieldLabels(): Record<string, string> {
  const { t } = useI18n();
  const w = t.decisionCard.permission.writeback;
  return { to: w.fieldTo, cc: w.fieldCc, bcc: w.fieldBcc, subject: w.fieldSubject, content: w.fieldContent };
}

// ----------------------------------------------------------------------------
// 查看态
// ----------------------------------------------------------------------------

export function WritebackFieldsView({ tool, args }: { tool: string; args: Record<string, unknown> }) {
  const { t } = useI18n();
  const w = t.decisionCard.permission.writeback;
  const labels = useFieldLabels();
  const fields = EDITABLE_TOOL_FIELDS[tool] ?? [];
  const attachments = Array.isArray(args.attachments)
    ? args.attachments.filter((v): v is string => typeof v === 'string')
    : [];

  // 紧凑「标签｜值」行：决策选项在 DecisionCard 的 50vh 滚动区里，字段区每高一行，
  // 「发送 / 改一改再发 / 不发」就更可能被顶出首屏。
  const row = (key: string, label: string, value: React.ReactNode) => (
    <div key={key} className="flex items-start gap-2 text-sm">
      <span className="w-14 shrink-0 text-xs text-zinc-500 pt-0.5">{label}</span>
      <div className="min-w-0 flex-1 text-zinc-300 break-all">{value}</div>
    </div>
  );

  return (
    <div className="space-y-1.5 rounded bg-zinc-800/60 p-2.5" data-testid="writeback-fields-view">
      {fields.map((field) => {
        const raw = args[field.key];
        const text = field.kind === 'string_list'
          ? (Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string').join(', ') : '')
          : (typeof raw === 'string' ? raw : '');
        // 可选列表字段为空就不占一行（密送常年为空）
        if (!text && !field.required && field.kind === 'string_list') return null;
        if (field.multiline) {
          return (
            <div key={field.key} className="pt-1 border-t border-zinc-700/60">
              <CollapsibleBody text={text} expandLabel={w.expandBody} collapseLabel={w.collapseBody} />
            </div>
          );
        }
        return row(
          field.key,
          labels[field.key] ?? field.key,
          <span data-testid={`writeback-view-${field.key}`}>{text || <span className="text-zinc-600">{w.none}</span>}</span>,
        );
      })}
      {attachments.length > 0 && row('attachments', w.fieldAttachments.replace(/（.*）|\(.*\)/, ''), (
        <span className="font-mono text-xs text-zinc-400">{attachments.join(', ')}</span>
      ))}
    </div>
  );
}

function CollapsibleBody({ text, expandLabel, collapseLabel }: { text: string; expandLabel: string; collapseLabel: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split('\n');
  const needsCollapse = lines.length > BODY_COLLAPSE_LINES;
  const shown = needsCollapse && !expanded ? lines.slice(0, BODY_COLLAPSE_LINES).join('\n') : text;
  return (
    <div>
      <pre
        className="text-sm text-zinc-300 whitespace-pre-wrap break-words font-sans"
        data-testid="writeback-view-content"
      >
        {shown}
      </pre>
      {needsCollapse && (
        <button /* ds-allow:button: 折叠开关，与 RequestDetails 的 DecisionTraceView 同形 */
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-2xs text-badge-info hover:underline"
        >
          {expanded ? collapseLabel : expandLabel}
        </button>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// 编辑态
// ----------------------------------------------------------------------------

export function WritebackEditForm({
  tool,
  draft,
  original,
  onChange,
}: {
  tool: string;
  draft: WritebackDraft;
  /** 原参数（用来标「改过」+ 展示不可编辑的附件） */
  original: Record<string, unknown>;
  onChange: (next: WritebackDraft) => void;
}) {
  const { t } = useI18n();
  const w = t.decisionCard.permission.writeback;
  const labels = useFieldLabels();
  const fields = EDITABLE_TOOL_FIELDS[tool] ?? [];
  const pristine = draftFromArgs(tool, original);
  const missing = new Set(draftMissingRequired(tool, draft));
  const attachments = Array.isArray(original.attachments)
    ? original.attachments.filter((v): v is string => typeof v === 'string')
    : [];

  const renderField = (field: EditableField) => {
    const value = draft[field.key] ?? '';
    const changed = value !== (pristine[field.key] ?? '');
    const label = (
      <div className="text-xs text-zinc-500 mb-1 flex items-center gap-1">
        <span>{labels[field.key] ?? field.key}</span>
        {field.required && <span className="text-badge-danger">*</span>}
      </div>
    );
    const common = {
      value,
      fullWidth: true,
      error: missing.has(field.key),
      errorMessage: missing.has(field.key) ? w.required : undefined,
      'data-testid': `writeback-edit-${field.key}`,
      'aria-label': labels[field.key] ?? field.key,
    };
    return (
      <div key={field.key} className={changed ? 'border-l-2 border-badge-success pl-2' : 'pl-2.5'}>
        {label}
        {field.multiline ? (
          <Textarea
            {...common}
            minRows={4}
            maxRows={14}
            autoResize
            onChange={(e) => onChange({ ...draft, [field.key]: e.target.value })}
          />
        ) : (
          <Input
            {...common}
            inputSize="sm"
            placeholder={field.kind === 'string_list' ? w.listPlaceholder : undefined}
            onChange={(e) => onChange({ ...draft, [field.key]: e.target.value })}
          />
        )}
      </div>
    );
  };

  return (
    <div className="space-y-2.5" data-testid="writeback-edit-form">
      <p className="text-xs text-zinc-400">{w.editingHint}</p>
      {fields.map(renderField)}
      {attachments.length > 0 && (
        <div className="pl-2.5">
          <div className="text-xs text-zinc-500 mb-1">{w.fieldAttachments}</div>
          <div className="p-2 rounded bg-zinc-800 text-xs font-mono text-zinc-500 break-all">
            {attachments.join('\n')}
          </div>
        </div>
      )}
    </div>
  );
}
