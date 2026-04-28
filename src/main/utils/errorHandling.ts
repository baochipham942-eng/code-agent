// ============================================================================
// Error Handling Helpers - 替代 .catch(() => {}) 静默吞错
// ============================================================================
//
// 背景：2026-04-28 audit 在 src/ 实测 34 处 .catch(() => {}) 静默吞错，
// 集中在 hookManager 触发、生命周期清理、ipc 轮询等关键路径。Bug 出现时
// 完全没日志线索。
//
// 用法分级（按艾克斯反方律师建议）：
// - level: 'debug' — 清理类（fs.unlink、cancel、shutdown），错误不影响主流程
// - level: 'warn'  — 生命周期 hook 失败、UI 通知失败，需要可观测但不致命
// - level: 'error' — 审计链路（hookManager.triggerSubagentStop、runFinalizer 主路径），
//                   失败应当报警
//
// 默认 'warn'。重要审计调用必须显式传 'error'。
// ============================================================================

import type { createLogger } from '../services/infra/logger';

type Logger = ReturnType<typeof createLogger>;

export type SilenceLevel = 'debug' | 'warn' | 'error';

export interface SilenceContext {
  logger: Logger;
  tag: string;
  level?: SilenceLevel;
}

/**
 * 替代 `promise.catch(() => {})`：吞错但留下带 tag 的日志。
 * 返回成功值或 fallback（默认 undefined）。
 */
export async function silenceAsync<T>(
  promise: Promise<T>,
  ctx: SilenceContext,
  fallback?: T,
): Promise<T | undefined> {
  try {
    return await promise;
  } catch (e) {
    const lvl = ctx.level ?? 'warn';
    ctx.logger[lvl](`[${ctx.tag}] silenced error`, e);
    return fallback;
  }
}

/**
 * 用于 fire-and-forget 场景的 .catch handler。
 * 用法：promise.catch(silence(logger, 'tag', 'error'))
 */
export function silence(
  logger: Logger,
  tag: string,
  level: SilenceLevel = 'warn',
): (err: unknown) => void {
  return (err) => {
    logger[level](`[${tag}] silenced error`, err);
  };
}
