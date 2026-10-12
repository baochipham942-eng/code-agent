import type { CreateCronJobInput } from '../../../../services/cronClient';
import { formatCronScheduleLabel } from '../automationNotice';
import type { PendingScheduleDraft, ScheduleRestatement } from './useScheduleDraft';

interface ScheduleConfirmLabels {
  what: string;
  when: string;
  notifyWhen: string;
  result: string;
  fallbackWhat: string;
  fallbackWhen: string;
  fallbackNotifyWhen: string;
  reviewInbox: string;
}

interface ScheduleConfirmRow {
  key: 'what' | 'when' | 'notifyWhen' | 'result';
  label: string;
  value: string;
}

export interface NormalizedScheduleDraft {
  input: CreateCronJobInput;
  restatement: ScheduleRestatement | undefined;
}

// LLM 草案是不可信 JSON，确认卡渲染路径不允许直接解引用草案字段（会 TypeError 炸到全局错误页）。
// 统一口径：展示用字符串字段非字符串一律当缺失，交给兜底文案；结构性必需字段缺失 → null，
// 调用方走 scheduleDraftInvalid 错误提示，不渲染卡片。
function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const EVERY_SCHEDULE_UNITS: ReadonlySet<string> = new Set(['seconds', 'minutes', 'hours', 'days']);

const KNOWN_ACTION_TYPES: ReadonlySet<string> = new Set([
  'shell', 'tool', 'agent', 'webhook', 'ipc', 'memory-consolidation', 'role-wake',
]);

// restatement 两子字段一起校验：任一非字符串/为空就整组放弃，两行分别走各自兜底。
function readRestatement(value: unknown): ScheduleRestatement | undefined {
  if (!isPlainObject(value)) return undefined;
  const what = asTrimmedString(value.what);
  const notifyWhen = asTrimmedString(value.notifyWhen);
  return what && notifyWhen ? { what, notifyWhen } : undefined;
}

// 调度按 type 分支校验：every→interval 数字 + unit 枚举；cron→expression 非空；at→datetime 字符串/数字。
// 不满足的当缺失处理（when 行走 fallbackWhen），不再把垃圾对象喂给 formatCronScheduleLabel。
// weeks 是契约遗留单位，展示标签没有对应文案，按缺失处理。
function readValidSchedule(value: unknown): CreateCronJobInput['schedule'] | undefined {
  if (!isPlainObject(value)) return undefined;
  switch (asTrimmedString(value.type)) {
    case 'every':
      return typeof value.interval === 'number' && Number.isFinite(value.interval)
        && EVERY_SCHEDULE_UNITS.has(value.unit as string)
        ? (value as unknown as CreateCronJobInput['schedule'])
        : undefined;
    case 'at':
      return (typeof value.datetime === 'number' && Number.isFinite(value.datetime))
        || asTrimmedString(value.datetime) !== ''
        ? (value as unknown as CreateCronJobInput['schedule'])
        : undefined;
    case 'cron': {
      const expression = asTrimmedString(value.expression);
      if (!expression) return undefined;
      const timezone = asTrimmedString(value.timezone);
      const schedule = { ...value, type: 'cron', expression } as Record<string, unknown>;
      if (timezone) schedule.timezone = timezone;
      else delete schedule.timezone;
      return schedule as unknown as CreateCronJobInput['schedule'];
    }
    default:
      return undefined;
  }
}

// action 是结构字段而非展示字段：骨架（对象 + 已知 type）或按 type 的必需字段
// （agent→prompt、shell→command）缺失 → null → scheduleDraftInvalid，不渲染卡片。
function readValidAction(value: unknown): CreateCronJobInput['action'] | null {
  if (!isPlainObject(value)) return null;
  const type = asTrimmedString(value.type);
  if (!KNOWN_ACTION_TYPES.has(type)) return null;
  if (type === 'agent' && !asTrimmedString(value.prompt)) return null;
  if (type === 'shell' && !asTrimmedString(value.command)) return null;
  return value as unknown as CreateCronJobInput['action'];
}

/** LLM 草案进确认卡前的统一规范化。展示字段非字符串一律当缺失；action 结构缺失返回 null。 */
export function normalizeScheduleDraft(raw: unknown): NormalizedScheduleDraft | null {
  if (!isPlainObject(raw)) return null;
  const { restatement: rawRestatement, ...rawInput } = raw;
  const action = readValidAction(rawInput.action);
  if (!action) return null;
  const schedule = readValidSchedule(rawInput.schedule);
  const input = { ...rawInput, action, schedule } as Record<string, unknown>;
  const name = asTrimmedString(rawInput.name);
  const description = asTrimmedString(rawInput.description);
  const resultChannel = asTrimmedString(rawInput.resultChannel);
  if (name) input.name = name;
  else delete input.name;
  if (description) input.description = description;
  else delete input.description;
  if (resultChannel) input.resultChannel = resultChannel;
  else delete input.resultChannel;
  if (schedule === undefined) delete input.schedule;
  return {
    input: input as unknown as CreateCronJobInput,
    restatement: readRestatement(rawRestatement),
  };
}

function getActionDescription(action: unknown): string {
  if (!isPlainObject(action)) return '';
  switch (asTrimmedString(action.type)) {
    case 'agent': return asTrimmedString(action.prompt);
    case 'shell': return asTrimmedString(action.command);
    case 'webhook': return [asTrimmedString(action.method), asTrimmedString(action.url)].filter(Boolean).join(' ');
    default: return '';
  }
}

export function buildScheduleConfirmRows(
  draft: Pick<PendingScheduleDraft, 'input' | 'restatement'>,
  labels: ScheduleConfirmLabels,
): readonly ScheduleConfirmRow[] {
  // 草案已经过 normalizeScheduleDraft，但这里仍按不可信输入读：任何字段非字符串都当缺失，不抛错。
  const input = draft.input as unknown as Record<string, unknown>;
  const what = asTrimmedString(draft.restatement?.what)
    || asTrimmedString(input.name)
    || getActionDescription(input.action)
    || asTrimmedString(input.description)
    || labels.fallbackWhat;
  const notifyWhen = asTrimmedString(draft.restatement?.notifyWhen) || labels.fallbackNotifyWhen;
  const result = asTrimmedString(input.resultChannel) || labels.reviewInbox;
  const schedule = readValidSchedule(input.schedule);
  const when = schedule ? formatCronScheduleLabel(schedule) : labels.fallbackWhen;

  return [
    { key: 'what', label: labels.what, value: what },
    { key: 'when', label: labels.when, value: when },
    { key: 'notifyWhen', label: labels.notifyWhen, value: notifyWhen },
    { key: 'result', label: labels.result, value: result },
  ];
}
