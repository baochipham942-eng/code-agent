// ============================================================================
// cronRunLedger —— 定时任务运行账本（N-CRON-RUN-LEDGER-VISIBLE）。
// 纯函数：单次运行成本（USD）的日归集 + 角色唤醒 skip 原因的机读解析与人话模板。
// 主进程（写 cost 字段）与 renderer（运行列表/详情/每日小计）共用，不引入 IO。
// ============================================================================

/** wakeRole 落在执行记录 result.skipReason 里的原因枚举（roleProactivity 写、这里读）。 */
type WakeSkipKind = 'silent_level' | 'daily_budget_exceeded' | 'quiet_hours';

export interface WakeSkipInfo {
  kind: WakeSkipKind;
  /** daily_budget_exceeded 时的已用次数，来自 `daily_budget_exceeded (n/MAX)` 字符串。 */
  used?: number;
  /** daily_budget_exceeded 时的每日上限。 */
  max?: number;
}

/** 解析 wakeRole 的 skipReason 字符串；不认识的形状返回 null（展示侧回落原文，不猜）。 */
function parseWakeSkipReason(skipReason: string): WakeSkipInfo | null {
  if (skipReason === 'silent_level') return { kind: 'silent_level' };
  if (skipReason === 'quiet_hours') return { kind: 'quiet_hours' };
  const match = skipReason.match(/^daily_budget_exceeded \((\d+)\/(\d+)\)$/);
  if (match) return { kind: 'daily_budget_exceeded', used: Number(match[1]), max: Number(match[2]) };
  return null;
}

/** 从执行记录 result 读出的「本次是跳过的唤醒」：解析成功给 info，未登记形状给原文。 */
export interface WakeSkipView {
  info: WakeSkipInfo | null;
  raw: string;
}

/**
 * 判定执行记录的 result 是否是「跳过的角色唤醒」。
 * 只认 RoleWakeResult 的 skipped 形状（status='skipped' + skipReason 字符串）；
 * 空产物的安静醒来是 completed（不算 skip）、heartbeat 的 outside_active_hours 也不算。
 */
export function readWakeSkipFromResult(result: unknown): WakeSkipView | null {
  if (typeof result !== 'object' || result === null) return null;
  const record = result as Record<string, unknown>;
  if (record.status !== 'skipped' || typeof record.skipReason !== 'string') return null;
  return { info: parseWakeSkipReason(record.skipReason), raw: record.skipReason };
}

/** skip 原因的人话模板（renderer 的 i18n 词条填入；{used}/{max} 逐个替换）。 */
export interface WakeSkipTexts {
  silentLevel: string;
  dailyBudget: string;
  quietHours: string;
}

export function wakeSkipReasonText(info: WakeSkipInfo, texts: WakeSkipTexts): string {
  switch (info.kind) {
    case 'silent_level':
      return texts.silentLevel;
    case 'quiet_hours':
      return texts.quietHours;
    case 'daily_budget_exceeded':
      return texts.dailyBudget
        .replace('{used}', String(info.used ?? '?'))
        .replace('{max}', String(info.max ?? '?'));
  }
}

/** 每日小计的输入条目（CronJobExecution 的最小投影）。 */
export interface CronRunCostEntry {
  scheduledAt: number;
  startedAt?: number;
  /** 本次运行实测成本（USD）；null/undefined = 无模型调用（展示 dash，不加钱）。 */
  cost?: number;
  runsOn?: 'local' | 'cloud';
  /** 跳过的唤醒（无成本，但计数）。 */
  skipped?: boolean;
}

export interface CronRunCostDayTotal {
  /** 本地日历日 YYYY-MM-DD（按 startedAt，缺失回落 scheduledAt）。 */
  dayKey: string;
  totalUsd: number;
  /** 参与归集的运行条数（含无成本运行）。 */
  runCount: number;
  /** 其中跳过的唤醒次数。 */
  skippedCount: number;
}

function localDayKey(time: number): string {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 按本地日历日归集运行成本。
 * 口径：日界以 startedAt（缺失回落 scheduledAt）的本地日历日为准；云端运行单次
 * 显示 dash、不计入小计（本地无云端账单）；无成本与跳过的条目计数但不加钱；
 * 只返回有运行的天、今天在前、最多 maxDays 天。
 */
export function cronDailyCostTotals(
  entries: readonly CronRunCostEntry[],
  maxDays = 7,
): CronRunCostDayTotal[] {
  const buckets = new Map<string, CronRunCostDayTotal>();
  for (const entry of entries) {
    if (entry.runsOn === 'cloud') continue;
    const dayKey = localDayKey(entry.startedAt ?? entry.scheduledAt);
    const bucket = buckets.get(dayKey) ?? { dayKey, totalUsd: 0, runCount: 0, skippedCount: 0 };
    bucket.runCount += 1;
    if (entry.skipped) bucket.skippedCount += 1;
    if (typeof entry.cost === 'number' && Number.isFinite(entry.cost) && entry.cost > 0) {
      bucket.totalUsd += entry.cost;
    }
    buckets.set(dayKey, bucket);
  }
  return [...buckets.values()].sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1)).slice(0, maxDays);
}

/** 今天/昨天的 dayKey（与 cronDailyCostTotals 同一日界口径；跨月/月末用日期回退法，不吃 DST 亏）。 */
export function cronTodayYesterdayKeys(now: number): { today: string; yesterday: string } {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return { today: localDayKey(now), yesterday: localDayKey(yesterday.getTime()) };
}

/**
 * 把一次尝试实测的成本并入执行记录的累计成本（一次执行可含多次重试尝试）。
 * 只在确有读数时写：undefined/非正数不清零、不覆盖已记账（重试簿记不冲销）。
 */
export function addCronRunCostUsd(
  existing: number | undefined,
  attempt: number | undefined,
): number | undefined {
  if (attempt === undefined || !Number.isFinite(attempt) || attempt <= 0) return existing;
  return Math.round(((existing ?? 0) + attempt) * 1e6) / 1e6;
}
