// ============================================================================
// 审批面「改一改再发」（N-WRITEBACK-EDIT）—— 可编辑写回工具的字段表与合并校验
//
// 原则：能撤的走事后回执（N-WRITEBACK-UNDO），撤不了的必须事前拦住。首版只收
// mail_send（AppleScript `send` 之后不返回任何句柄，物理不可逆）。calendar/reminders
// 六个动作已有撤销地基，归 UNDO 线；mail_draft 本身就是草稿容器，不重复套编辑。
//
// renderer 与 host 共用这一份表：renderer 只对表内工具出编辑口，host 只认表内工具与
// 表内字段（fail-closed），不可编辑字段（attachments）从原参数原样带回。
// ============================================================================

export type EditableFieldKind = 'string' | 'string_list';

export interface EditableField {
  key: string;
  kind: EditableFieldKind;
  required?: boolean;
  /** 多行文本（renderer 用 Textarea）。 */
  multiline?: boolean;
}

/** 工具名 → 可编辑字段。以后给 mail_draft / 带 attendees 的日历事件开口，在这里加一行。 */
export const EDITABLE_TOOL_FIELDS: Readonly<Record<string, readonly EditableField[]>> = {
  mail_send: [
    { key: 'to', kind: 'string_list', required: true },
    { key: 'cc', kind: 'string_list' },
    { key: 'bcc', kind: 'string_list' },
    { key: 'subject', kind: 'string', required: true },
    { key: 'content', kind: 'string', multiline: true },
  ],
};

export function isEditableTool(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(EDITABLE_TOOL_FIELDS, toolName);
}

/**
 * 可编辑工具的交互审批超时。默认 60s 是防「没人看卡导致 agentLoop 死锁」的兜底；
 * 用户在卡上改正文超过一分钟是常态，改到一半被 host 收走等于白打。
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
  const allowed = new Map(fields.map((f) => [f.key, f] as const));
  for (const key of Object.keys(updated)) {
    if (!allowed.has(key)) return { ok: false, reason: `field ${key} is not editable on ${toolName}` };
  }
  const params: Record<string, unknown> = { ...original };
  const changedKeys: string[] = [];
  for (const field of fields) {
    if (!(field.key in updated)) continue;
    const raw = updated[field.key];
    let value: unknown;
    if (field.kind === 'string_list') {
      const list = normalizeList(raw);
      if (list === null) return { ok: false, reason: `field ${field.key} must be a string list` };
      value = list;
    } else {
      if (typeof raw !== 'string') return { ok: false, reason: `field ${field.key} must be a string` };
      value = raw;
    }
    if (field.required && (Array.isArray(value) ? value.length === 0 : (value as string).trim() === '')) {
      return { ok: false, reason: `field ${field.key} is required` };
    }
    if (JSON.stringify(value) !== JSON.stringify(original[field.key])) changedKeys.push(field.key);
    params[field.key] = value;
  }
  return { ok: true, params, changedKeys };
}
