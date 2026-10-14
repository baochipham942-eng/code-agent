// ============================================================================
// cronHumanize —— cron/every 调度 → 人话文案（host 自动化记录 + renderer 通知共用）。
// 只覆盖常见形态：每天|工作日|每周单天|每月 D 号 HH:MM、每 N 分钟、每 N 小时、每 N <unit>；
// 覆盖不了的返回 null，由调用方回退原 cron 表达式——宁缺毋滥，不瞎猜。
// 纯函数、零依赖，host 与 renderer 都可以 import。
// ============================================================================

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
 * `m h * * *`（每天）、`m h * * 1-5`（工作日）、`m h * * d`（每周单天）、`m h D * *`（每月 D 号）。
 * 模块内构件：生产消费方一律走 formatCronExpressionLabel（含回退），不单独导出。
 */
function humanizeCronExpression(expression: string, lang: CronHumanLang): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (month !== '*') return null;

  const minuteStep = /^\*\/(\d+)$/.exec(minute);
  if (minuteStep && hour === '*' && dayOfMonth === '*' && dayOfWeek === '*') {
    const n = Number(minuteStep[1]);
    if (n <= 0 || n > 59) return null;
    if (lang === 'zh') return `每 ${n} 分钟`;
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (hourStep && /^\d{1,2}$/.test(minute) && Number(minute) <= 59 && dayOfMonth === '*' && dayOfWeek === '*') {
    const n = Number(hourStep[1]);
    if (n <= 0 || n > 23) return null;
    if (lang === 'zh') return `每 ${n} 小时`;
    return n === 1 ? 'Every hour' : `Every ${n} hours`;
  }

  const clock = parseClock(minute, hour);
  if (!clock) return null;

  // 每月 D 号：`m h D * *`。D 超出 1-31、dayOfWeek 也有限制的（cron 语义变 OR）不猜。
  if (dayOfMonth !== '*') {
    if (dayOfWeek !== '*') return null;
    if (!/^\d{1,2}$/.test(dayOfMonth)) return null;
    const day = Number(dayOfMonth);
    if (day < 1 || day > 31) return null;
    return lang === 'zh' ? `每月 ${day} 号 ${clock}` : `Monthly on day ${day} at ${clock}`;
  }

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

/**
 * cron 表达式 → 展示标签：能翻译就说人话（不带时区后缀——"每天 08:17"与墙钟时间对应，
 * 时区只是执行侧细节）；翻译不了的复杂表达式回退「自定义时间 · 原表达式[ · 时区]」，
 * 宁可露出原文也不给出错误的猜测。
 */
export function formatCronExpressionLabel(
  expression: string,
  timezone: string | undefined,
  lang: CronHumanLang,
): string {
  const human = humanizeCronExpression(expression, lang);
  if (human) return human;
  const raw = timezone ? `${expression} · ${timezone}` : expression;
  return lang === 'zh' ? `自定义时间 · ${raw}` : `Custom schedule · ${raw}`;
}
