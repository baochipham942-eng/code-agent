import type { CreateCronJobInput } from '../../../../services/cronClient';
import { formatCronExpressionLabel, humanizeEverySchedule, type CronHumanLang } from '@shared/cronHumanize';
import type { PendingScheduleDraft, ScheduleRestatement } from './useScheduleDraft';

interface ScheduleConfirmLabels {
  what: string;
  when: string;
  notifyWhen: string;
  result: string;
  fallbackWhat: string;
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
// 校验失败返回 undefined，由 normalizeScheduleDraft 判草案无效（与缺 action 同等处理）：
// 缺 schedule 的草案走到确认一步也会被 host 拒掉，不能出卡。
// weeks 是契约遗留单位，展示标签没有对应文案，按无效处理。
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

/** LLM 草案进确认卡前的统一规范化。展示字段非字符串一律当缺失；schedule/action 结构缺失返回 null。 */
export function normalizeScheduleDraft(raw: unknown): NormalizedScheduleDraft | null {
  if (!isPlainObject(raw)) return null;
  const { restatement: rawRestatement, ...rawInput } = raw;
  const action = readValidAction(rawInput.action);
  if (!action) return null;
  const schedule = readValidSchedule(rawInput.schedule);
  if (!schedule) return null;
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

/**
 * 「什么时候」行的语言感知文案：直走 shared/cronHumanize（每天/每天 08:17/每 3 小时，
 * 复杂表达式带「自定义时间 ·」前缀），at 按 UI 语言本地化日期。
 * 直走 shared 实现后，原 automationNotice.formatCronScheduleLabel（硬编码 zh）无生产
 * 消费方，已随本单删除；host 侧记录文案仍由 cronAutomationBridge 走同一 shared 函数。
 */
function formatScheduleWhenLabel(
  schedule: CreateCronJobInput['schedule'],
  lang: CronHumanLang,
): string {
  switch (schedule.type) {
    case 'every':
      return humanizeEverySchedule(schedule.interval, schedule.unit, lang);
    case 'at': {
      const ts = typeof schedule.datetime === 'number'
        ? schedule.datetime
        : Date.parse(String(schedule.datetime));
      return Number.isFinite(ts)
        ? new Date(ts).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        })
        : (lang === 'zh' ? '一次性' : 'Once');
    }
    case 'cron':
      return formatCronExpressionLabel(schedule.expression, schedule.timezone, lang);
    default:
      return '';
  }
}

export function buildScheduleConfirmRows(
  draft: Pick<PendingScheduleDraft, 'input' | 'restatement'>,
  labels: ScheduleConfirmLabels,
  lang: CronHumanLang = 'zh',
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
  // 无「按配置」兜底：真实链路里无效 schedule 在 normalizeScheduleDraft 就被拒，到不了这张卡；
  // 留空串只保证纯函数直喂垃圾时不抛错（生产不可达）。
  const schedule = readValidSchedule(input.schedule);
  const when = schedule ? formatScheduleWhenLabel(schedule, lang) : '';
  // 通知判据只有 agent 动作能生效（prompt 注入 + 通知门都挂在 agent 执行链上）：
  // 非 agent 草案整行不出，不给「看起来可配置」的假口子（N-CRON-RESTATE-HUMAN-WHEN）。
  const isAgentAction = isPlainObject(input.action) && asTrimmedString(input.action.type) === 'agent';

  return [
    { key: 'what', label: labels.what, value: what },
    { key: 'when', label: labels.when, value: when },
    ...(isAgentAction ? [{ key: 'notifyWhen' as const, label: labels.notifyWhen, value: notifyWhen }] : []),
    { key: 'result', label: labels.result, value: result },
  ];
}
