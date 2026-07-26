// ============================================================================
// cronHumanize —— cron/every 调度 → 人话文案（自动化列表副标题 / 详情摘要 / 触发源 chip）。
// 只覆盖常见形态：每天|工作日|每周单天 HH:MM、每 N 分钟、每 N 小时、每 N <unit>；
// 覆盖不了的返回 null，由调用方回退原 cron 表达式——宁缺毋滥，不瞎猜。
// 触发源类型推导与 host 侧 cronAutomationBridge.deriveSessionAutomationType 同一规则
// （agent.context.externalWatch → 事件、agent.context.heartbeatTask → 心跳），
// 再按 scheduleType 细分一次性/循环/定时。
// ============================================================================

import type { CronJobDefinition } from '@shared/contract';
import { EXTERNAL_WATCH } from '@shared/constants/feishu';

export type CronHumanLang = 'zh' | 'en';

const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;
const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** "8" "30" → "08:30"；非数字或超界返回 null */
function parseClock(minute: string, hour: string): string | null {
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  const m = Number(minute);
  const h = Number(hour);
  if (m > 59 || h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 5 段 cron 表达式 → 人话；不认识的形态返回 null。
 * 覆盖：分钟步进（每 n 分钟）、小时步进（每 n 小时）、
 * `m h * * *`（每天）、`m h * * 1-5`（工作日）、`m h * * d`（每周单天）。
 */
export function humanizeCronExpression(expression: string, lang: CronHumanLang): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (dayOfMonth !== '*' || month !== '*') return null;

  const minuteStep = /^\*\/(\d+)$/.exec(minute);
  if (minuteStep && hour === '*' && dayOfWeek === '*') {
    const n = Number(minuteStep[1]);
    if (n <= 0 || n > 59) return null;
    if (lang === 'zh') return `每 ${n} 分钟`;
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (hourStep && /^\d{1,2}$/.test(minute) && Number(minute) <= 59 && dayOfWeek === '*') {
    const n = Number(hourStep[1]);
    if (n <= 0 || n > 23) return null;
    if (lang === 'zh') return `每 ${n} 小时`;
    return n === 1 ? 'Every hour' : `Every ${n} hours`;
  }

  const clock = parseClock(minute, hour);
  if (!clock) return null;
  if (dayOfWeek === '*') return lang === 'zh' ? `每天 ${clock}` : `Daily at ${clock}`;
  if (dayOfWeek === '1-5') return lang === 'zh' ? `工作日 ${clock}` : `Weekdays at ${clock}`;
  if (/^[0-6]$/.test(dayOfWeek)) {
    const day = Number(dayOfWeek);
    return lang === 'zh'
      ? `每${WEEKDAYS_ZH[day]} ${clock}`
      : `Weekly on ${WEEKDAYS_EN[day]} at ${clock}`;
  }
  return null;
}

const EVERY_UNIT_ZH: Record<string, string> = {
  seconds: '秒',
  minutes: '分钟',
  hours: '小时',
  days: '天',
};

const EVERY_UNIT_EN: Record<string, [singular: string, plural: string]> = {
  seconds: ['second', 'seconds'],
  minutes: ['minute', 'minutes'],
  hours: ['hour', 'hours'],
  days: ['day', 'days'],
};

/** every 调度 → 人话（`每 3 小时` / `Every 3 hours`）；unit 未知时原样带上 */
export function humanizeEverySchedule(interval: number, unit: string, lang: CronHumanLang): string {
  if (lang === 'zh') return `每 ${interval} ${EVERY_UNIT_ZH[unit] ?? unit}`;
  const [singular, plural] = EVERY_UNIT_EN[unit] ?? [unit, unit];
  return interval === 1 ? `Every ${singular}` : `Every ${interval} ${plural}`;
}

/** 触发源类型：对齐 contract 的 SessionAutomationType（事件/心跳），再按 scheduleType 细分 */
export type CronTriggerKind = 'cron' | 'at' | 'every' | 'heartbeat' | 'external_event';

export function getCronTriggerKind(job: CronJobDefinition): CronTriggerKind {
  const { action } = job;
  if (action.type === 'agent') {
    const context = action.context as Record<string, unknown> | undefined;
    if (context?.[EXTERNAL_WATCH.CONTEXT_KEY]) return 'external_event';
    if (context?.heartbeatTask) return 'heartbeat';
  }
  if (job.scheduleType === 'at') return 'at';
  if (job.scheduleType === 'every') return 'every';
  return 'cron';
}
