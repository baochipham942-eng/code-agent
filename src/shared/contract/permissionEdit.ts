// ============================================================================
// 审批面「改一改再发」（N-WRITEBACK-EDIT）—— 可编辑写回工具的字段表与合并校验
//
// 原则：mail_send 与明确登记的 calendar/reminders/tmeet 写回动作在真正派发前允许修改；
// mail_draft 本身就是草稿容器，不重复套编辑，delete 动作也不开放内容编辑。
//
// renderer 与 host 共用这一份表：renderer 只对表内工具出编辑口，host 只认表内工具与
// 表内可编辑字段（fail-closed），只读标识与 attachments 从原参数原样带回。
// ============================================================================

import { CLI_CONNECTOR_DESCRIPTORS } from '../constants/cliConnectorDescriptors';

type EditableFieldKind = 'string' | 'string_list' | 'datetime';

export interface EditableField {
  key: string;
  kind: EditableFieldKind;
  required?: boolean;
  /** 只在审批卡查看态展示；编辑态不出控件，host 也拒绝 updatedArgs 修改。 */
  readonly?: boolean;
  /** 多行文本（renderer 用 Textarea）。 */
  multiline?: boolean;
}

const NATIVE_EDITABLE_TOOL_FIELDS: Readonly<Record<string, readonly EditableField[]>> = {
  mail_send: [
    { key: 'to', kind: 'string_list', required: true },
    { key: 'cc', kind: 'string_list' },
    { key: 'bcc', kind: 'string_list' },
    { key: 'subject', kind: 'string', required: true },
    { key: 'content', kind: 'string', multiline: true },
  ],
  calendar_create_event: [
    { key: 'calendar', kind: 'string', required: true, readonly: true },
    { key: 'title', kind: 'string', required: true },
    { key: 'start_ms', kind: 'datetime', required: true },
    { key: 'end_ms', kind: 'datetime' },
    { key: 'location', kind: 'string' },
  ],
  calendar_update_event: [
    { key: 'calendar', kind: 'string', required: true, readonly: true },
    { key: 'event_uid', kind: 'string', required: true, readonly: true },
    { key: 'title', kind: 'string' },
    { key: 'start_ms', kind: 'datetime' },
    { key: 'end_ms', kind: 'datetime' },
    { key: 'location', kind: 'string' },
  ],
  reminders_create: [
    { key: 'list', kind: 'string', required: true, readonly: true },
    { key: 'title', kind: 'string', required: true },
    { key: 'notes', kind: 'string', multiline: true },
    { key: 'remind_at_ms', kind: 'datetime' },
  ],
  reminders_update: [
    { key: 'list', kind: 'string', required: true, readonly: true },
    { key: 'reminder_id', kind: 'string', required: true, readonly: true },
    { key: 'title', kind: 'string' },
    { key: 'notes', kind: 'string', multiline: true },
    { key: 'remind_at_ms', kind: 'datetime' },
  ],
};

/** 工具名 → 可编辑字段。CLI 连接器字段从连接器描述符派生，避免 renderer/host 各抄一份。 */
export const EDITABLE_TOOL_FIELDS: Readonly<Record<string, readonly EditableField[]>> =
  CLI_CONNECTOR_DESCRIPTORS.reduce<Record<string, readonly EditableField[]>>(
    (fields, descriptor) => Object.assign(fields, descriptor.editablePermissionFields ?? {}),
    { ...NATIVE_EDITABLE_TOOL_FIELDS },
  );

export function isEditableTool(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(EDITABLE_TOOL_FIELDS, toolName);
}

/**
 * 无审批 UI 环境中，可编辑工具的 fail-closed 超时。普通工具是 60s；可编辑内容需要
 * 更长的外部裁决窗口，因此保留 5 分钟。带审批 UI 的交互会话不使用该超时。
 */
export const EDITABLE_PERMISSION_TIMEOUT_MS = 5 * 60_000;

export type ApplyEditedArgsResult =
  | { ok: true; params: Record<string, unknown>; changedKeys: string[] }
  | { ok: false; reason: string };

function normalizeList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

const ISO_DATETIME_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

function validDateParts(match: RegExpExecArray): boolean {
  const [, year, month, day, hour, minute, second = '0', offsetSign, offsetHour = '0', offsetMinute = '0'] = match;
  const calendarDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return calendarDate.getUTCFullYear() === Number(year)
    && calendarDate.getUTCMonth() === Number(month) - 1
    && calendarDate.getUTCDate() === Number(day)
    && Number(hour) <= 23
    && Number(minute) <= 59
    && Number(second) <= 59
    && (!offsetSign || (Number(offsetHour) <= 14 && Number(offsetMinute) <= 59));
}

function datetimeMillis(field: EditableField, value: unknown): number | null {
  if (field.key.endsWith('_ms')) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Number.isNaN(new Date(value).getTime()) ? null : value;
  }
  if (typeof value !== 'string') return null;
  const match = ISO_DATETIME_WITH_ZONE.exec(value);
  if (!match || !validDateParts(match)) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function validateTimeRange(
  toolName: string,
  fields: readonly EditableField[],
  params: Record<string, unknown>,
): ApplyEditedArgsResult | null {
  const startField = fields.find((field) => field.kind === 'datetime' && (field.key === 'start' || field.key === 'start_ms'));
  const endField = fields.find((field) => field.kind === 'datetime' && (field.key === 'end' || field.key === 'end_ms'));
  if (!startField || !endField) return null;

  const startRaw = params[startField.key];
  const endRaw = params[endField.key];
  if (startRaw === undefined || endRaw === undefined) return null;
  const start = datetimeMillis(startField, startRaw);
  const end = datetimeMillis(endField, endRaw);
  if (start === null) return { ok: false, reason: `field ${startField.key} must be a valid datetime` };
  if (end === null) return { ok: false, reason: `field ${endField.key} must be a valid datetime` };
  if (end < start) return { ok: false, reason: `end must not be earlier than start on ${toolName}` };
  return null;
}

function validateFinalFields(fields: readonly EditableField[], params: Record<string, unknown>): ApplyEditedArgsResult | null {
  for (const field of fields) {
    const value = params[field.key];
    const empty = value === undefined
      || value === null
      || (typeof value === 'string' && value.trim() === '')
      || (Array.isArray(value) && value.length === 0);
    if (field.required && empty) return { ok: false, reason: `field ${field.key} is required` };
    if (field.kind === 'datetime' && !empty && datetimeMillis(field, value) === null) {
      return { ok: false, reason: `field ${field.key} must be a valid datetime` };
    }
  }
  return null;
}

/**
 * 把用户在审批卡上改过的参数合并回原参数。表外工具、表外字段、类型不对、必填为空
 * 一律返回 ok:false —— 调用方按 fail-closed 处理（不放行、不派发）。
 */
export function applyEditedArgs(
  toolName: string,
  original: Record<string, unknown>,
  updated: Record<string, unknown>,
): ApplyEditedArgsResult {
  const fields = EDITABLE_TOOL_FIELDS[toolName];
  if (!fields) return { ok: false, reason: `tool ${toolName} is not editable` };
  const allowed = new Map(fields.filter((field) => !field.readonly).map((f) => [f.key, f] as const));
  for (const key of Object.keys(updated)) {
    if (!allowed.has(key)) return { ok: false, reason: `field ${key} is not editable on ${toolName}` };
  }
  const params: Record<string, unknown> = { ...original };
  const changedKeys: string[] = [];
  for (const field of fields) {
    if (field.readonly || !(field.key in updated)) continue;
    const raw = updated[field.key];
    let value: unknown;
    if (field.kind === 'string_list') {
      const list = normalizeList(raw);
      if (list === null) return { ok: false, reason: `field ${field.key} must be a string list` };
      value = list;
    } else if (field.kind === 'datetime') {
      if (datetimeMillis(field, raw) === null) {
        return { ok: false, reason: `field ${field.key} must be a valid datetime` };
      }
      value = raw;
    } else {
      if (typeof raw !== 'string') return { ok: false, reason: `field ${field.key} must be a string` };
      value = raw;
    }
    const requiredEmpty = Array.isArray(value)
      ? value.length === 0
      : typeof value === 'string' && value.trim() === '';
    if (field.required && requiredEmpty) {
      return { ok: false, reason: `field ${field.key} is required` };
    }
    if (JSON.stringify(value) !== JSON.stringify(original[field.key])) changedKeys.push(field.key);
    params[field.key] = value;
  }
  const invalidFields = validateFinalFields(fields, params);
  if (invalidFields) return invalidFields;
  const invalidRange = validateTimeRange(toolName, fields, params);
  if (invalidRange) return invalidRange;
  return { ok: true, params, changedKeys };
}
