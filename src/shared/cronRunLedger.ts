// ============================================================================
// cronRunLedger —— 定时任务运行账本（N-CRON-RUN-LEDGER-VISIBLE）。
// 纯函数：单次运行成本（USD）的累计口径，主进程写 cost 字段用，不引入 IO。
// 每日小计与唤醒 skip 原因解析属于 renderer 呈现，随 N-CRON-RUN-LEDGER-VISIBLE-P2。
// ============================================================================

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
