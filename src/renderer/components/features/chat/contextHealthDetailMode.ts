import type { ContextHealthState } from '@shared/contract/contextHealth';

export type ContextHealthDetailMode = 'empty' | 'pending' | 'ready';

/** 全零快照是「还没数据」，不是「用了 0%」。 */
function isAllZeroContextHealth(health: ContextHealthState): boolean {
  return health.currentTokens === 0 && health.usagePercent === 0;
}

/**
 * 明细弹层三态：空会话走 S-30+S-47；已发首条尚无 provider 实报走 S-31；
 * 有实报（currentTokens>0，或 tokenSource=provider 且非全零）走现有数据渲染。
 */
export function resolveContextHealthDetailMode(
  health: ContextHealthState | null | undefined,
  hasSentFirstMessage: boolean,
): ContextHealthDetailMode {
  if (
    health &&
    (health.currentTokens > 0 || (health.tokenSource === 'provider' && !isAllZeroContextHealth(health)))
  ) {
    return 'ready';
  }
  if (hasSentFirstMessage) return 'pending';
  return 'empty';
}
