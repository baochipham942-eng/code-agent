// ============================================================================
// memoryJournalActor — journal actor 归因（N-MEM-JOURNAL-SOURCEJUMP-FU1）
// ============================================================================
// 角色醒来会话（wakeRole / roleFirstWake 创建，origin.name = role-cadence）里
// agent 跑出来的 DB 记忆写入，journal actor 必须记 role_wake，不能再落 unknown。
// 调用点（memory_amend / 压缩前 flush / propose_project_memory）各自带 fallback
// actor；本 helper 只做一件事：按 sessionId 查会话 origin，命中唤醒标记就升级为
// role_wake，否则原样返回 fallback。
// 读取失败（DB 未初始化等）不拦写入：warn 出可区分的原因后按 fallback 记账，
// 与「降级路径必须留痕」纪律一致。
// ============================================================================

import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import { ROLE_PROACTIVITY } from '../../shared/constants';
import type {
  MemoryChangeActor,
  MemoryChangeJournalContext,
} from '../../shared/contract/memory';

const logger = createLogger('MemoryJournalActor');

/**
 * 解析 journal 上下文：醒来会话 → actor=role_wake；其余 → 调用点的 fallback actor。
 * sessionId 缺失时没有可查的会话，直接返回 fallback（不算失败，不 warn）。
 * 会话读取抛错时 fail-open：warn 带原因，按 fallback 记账。
 */
export function resolveJournalContext(
  sessionId: string | null | undefined,
  fallbackActor: MemoryChangeActor,
): MemoryChangeJournalContext {
  if (!sessionId) {
    return { actor: fallbackActor, sessionId: sessionId || null };
  }
  try {
    const session = getDatabase().getSession(sessionId);
    if (session?.origin?.name === ROLE_PROACTIVITY.CADENCE_JOB_TAG) {
      return { actor: 'role_wake', sessionId };
    }
    return { actor: fallbackActor, sessionId };
  } catch (error) {
    logger.warn('Journal actor lookup failed; keeping fallback actor', {
      sessionId,
      fallbackActor,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { actor: fallbackActor, sessionId };
  }
}
