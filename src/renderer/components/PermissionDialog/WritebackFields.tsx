// ============================================================================
// WritebackFields —— 写回类工具审批卡的字段区
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

/** 编辑态草稿：列表保留用户输入串，datetime 保留 datetime-local 的本机时间串。 */
export type WritebackDraft = Record<string, string>;

enum WritebackValidationReason {
  Required = 'required',
  InvalidDatetime = 'invalid_datetime',
  EndBeforeStart = 'end_before_start',
}

interface WritebackValidationIssue {
  fieldKey: string;
  reason: WritebackValidationReason;
}

const BODY_COLLAPSE_LINES = 12;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function datetimeToLocalInput(raw: unknown): string {
  const date = typeof raw === 'number' || typeof raw === 'string' ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const base = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return date.getMilliseconds() === 0 ? base : `${base}.${pad(date.getMilliseconds(), 3)}`;
}

function localDatetimeMillis(value: string): number | null {
  const match = LOCAL_DATETIME.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '0', millisecond = '0'] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond.padEnd(3, '0')),
  );
  if (
    date.getFullYear() !== Number(year)
    || date.getMonth() !== Number(month) - 1
    || date.getDate() !== Number(day)
    || date.getHours() !== Number(hour)
    || date.getMinutes() !== Number(minute)
    || date.getSeconds() !== Number(second)
    || date.getMilliseconds() !== Number(millisecond.padEnd(3, '0'))
  ) return null;
  return date.getTime();
}

function localDatetimeToIso(value: string, millis: number): string {
  const date = new Date(millis);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  return `${withSeconds}${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}

function formattedDatetime(raw: unknown, language: string): string {
  const date = typeof raw === 'number' || typeof raw === 'string' ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(language === 'en' ? 'en-US' : 'zh-CN');
}

export function draftFromArgs(tool: string, args: Record<string, unknown>): WritebackDraft {
  const draft: WritebackDraft = {};
  for (const field of EDITABLE_TOOL_FIELDS[tool] ?? []) {
    if (field.readonly) continue;
    const raw = args[field.key];
    if (field.kind === 'string_list') {
      draft[field.key] = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string').join(', ') : '';
    } else if (field.kind === 'datetime') {
      draft[field.key] = datetimeToLocalInput(raw);
    } else {
      draft[field.key] = typeof raw === 'string' ? raw : '';
    }
  }
  return draft;
}

/** 草稿 → 送回 host 的 updatedArgs（列表按逗号/分号/换行切开并去空）。 */
export function draftToArgs(tool: string, draft: WritebackDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of EDITABLE_TOOL_FIELDS[tool] ?? []) {
    if (field.readonly) continue;
    const value = draft[field.key] ?? '';
    if (field.kind === 'string_list') {
      out[field.key] = value.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    } else if (field.kind === 'datetime') {
      if (!value) continue;
      const millis = localDatetimeMillis(value);
      if (millis === null) {
        out[field.key] = value;
        continue;
      }
      out[field.key] = field.key.endsWith('_ms') ? millis : localDatetimeToIso(value, millis);
    } else {
      out[field.key] = value;
    }
  }
  return out;
}

/** 草稿校验结果：每个无效字段都保留具体原因，供禁用提交与字段提示共用。 */
export function validateWritebackDraft(tool: string, draft: WritebackDraft): WritebackValidationIssue[] {
  const fields = (EDITABLE_TOOL_FIELDS[tool] ?? []).filter((field) => !field.readonly);
  const invalid: WritebackValidationIssue[] = [];
  for (const field of fields) {
    const value = draft[field.key] ?? '';
    if (field.required && value.trim() === '') {
      invalid.push({ fieldKey: field.key, reason: WritebackValidationReason.Required });
    } else if (field.kind === 'datetime' && value !== '' && localDatetimeMillis(value) === null) {
      invalid.push({ fieldKey: field.key, reason: WritebackValidationReason.InvalidDatetime });
    }
  }
  const start = fields.find((field) => field.key === 'start' || field.key === 'start_ms');
  const end = fields.find((field) => field.key === 'end' || field.key === 'end_ms');
  if (start && end) {
    const startMillis = localDatetimeMillis(draft[start.key] ?? '');
    const endMillis = localDatetimeMillis(draft[end.key] ?? '');
    if (startMillis !== null && endMillis !== null && endMillis < startMillis) {
      invalid.push({ fieldKey: end.key, reason: WritebackValidationReason.EndBeforeStart });
    }
  }
  return invalid;
}

function useFieldLabels(): Record<string, string> {
  const { t } = useI18n();
  const w = t.decisionCard.permission.writeback;
  return {
    to: w.fieldTo,
    cc: w.fieldCc,
    bcc: w.fieldBcc,
    subject: w.fieldSubject,
    content: w.fieldContent,
    calendar: w.fieldCalendar,
    event_uid: w.fieldEventUid,
    list: w.fieldList,
    reminder_id: w.fieldReminderId,
    title: w.fieldTitle,
    notes: w.fieldNotes,
    location: w.fieldLocation,
    start: w.fieldStart,
    end: w.fieldEnd,
    start_ms: w.fieldStart,
    end_ms: w.fieldEnd,
    remind_at_ms: w.fieldRemindAt,
  };
}

// ----------------------------------------------------------------------------
// 查看态
// ----------------------------------------------------------------------------

export function WritebackFieldsView({ tool, args }: { tool: string; args: Record<string, unknown> }) {
  const { t, language } = useI18n();
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
          : field.kind === 'datetime'
            ? formattedDatetime(raw, language)
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
  const fields = (EDITABLE_TOOL_FIELDS[tool] ?? []).filter((field) => !field.readonly);
  const pristine = draftFromArgs(tool, original);
  const invalid = new Map(validateWritebackDraft(tool, draft).map((issue) => [issue.fieldKey, issue.reason]));
  const attachments = Array.isArray(original.attachments)
    ? original.attachments.filter((v): v is string => typeof v === 'string')
    : [];

  const renderField = (field: EditableField) => {
    const value = draft[field.key] ?? '';
    const changed = value !== (pristine[field.key] ?? '');
    const invalidReason = invalid.get(field.key);
    const errorMessage = invalidReason === WritebackValidationReason.Required
      ? w.required
      : invalidReason === WritebackValidationReason.InvalidDatetime
        ? w.invalidDatetime
        : invalidReason === WritebackValidationReason.EndBeforeStart
          ? w.endBeforeStart
          : undefined;
    const label = (
      <div className="text-xs text-zinc-500 mb-1 flex items-center gap-1">
        <span>{labels[field.key] ?? field.key}</span>
        {field.required && <span className="text-badge-danger">*</span>}
      </div>
    );
    const common = {
      value,
      fullWidth: true,
      error: invalidReason !== undefined,
      errorMessage,
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
            type={field.kind === 'datetime' ? 'datetime-local' : 'text'}
            step={field.kind === 'datetime' ? '0.001' : undefined}
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
      <p className="text-xs text-zinc-400">
        {tool === 'mail_send'
          ? w.editingHint
          : tool === 'calendar_create_event' || tool === 'reminders_create' || tool === 'tmeetMeetingCreate'
          ? w.editingCreateHint
          : w.editingUpdateHint}
      </p>
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
