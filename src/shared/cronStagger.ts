// ============================================================================
// Cron 错峰（N-CRON-RESILIENCE）：整点扎堆引导的共享工具。
// host 侧用它生成 every-hours/days 任务的默认分钟；renderer 表单用它给出错峰建议。
// ============================================================================

/** 错峰分钟的取值上限（含）：1..59，跳过 0 本身就是「整点」。 */
const STAGGER_MINUTE_MAX = 59;

/**
 * 按 seed（通常是 jobId）稳定地取一个非整点分钟（1..59）。
 * 同一个 seed 永远得到同一个分钟——重启/升级后任务的触发分钟不漂移，
 * 多个任务的 seed 天然散开，避免全部落在 :00。
 */
export function suggestCronStaggerMinute(seed: string): number {
  // FNV-1a：短、无依赖、分布足够把 uuid 撒开
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % STAGGER_MINUTE_MAX) + 1;
}

/**
 * 判断 cron 表达式是否「撞整点」：分钟位是字面量 0（如 `0 9 * * *`）。
 * 步进（如 "0/5" 写法）、列表、范围都不算——它们本来就不只落在 :00。
 * 只认 5/6 段表达式；解析不了返回 false（不给建议，不挡创建）。
 */
export function isHourAlignedCronExpression(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) return false;
  return parts[parts.length - 5] === '0';
}
