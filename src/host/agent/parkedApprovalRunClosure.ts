// ============================================================================
// 停车审批收口后的 durable run 收尾（N-FIX-PARKED-APPROVAL-SURVIVE-RESTART-RESUME-FU1-FU1）
//
// 审批行被自动拒绝 / 批准执行一次后，原会话那条 waiting 的 root run 不会再有人推进，
// 读层会把它投影成 running（僵尸 spinner）。这里把它在 waiting 栅栏内收成 cancelled
// （投影为 interrupted）。只收口，不续跑、不派发（A′ 不变）。
// ============================================================================

import type { PendingApprovalRepository } from '../services/core/repositories/PendingApprovalRepository';
import type { DurableRunRepository } from '../services/core/repositories/DurableRunRepository';
import { createLogger } from '../services/infra/logger';
import { parseParkedApprovalPayload } from './parkedApprovalSurvival';

const logger = createLogger('ParkedApprovalRunClosure');

const PARKED_APPROVAL_RUN_CLOSE_REASON = 'parked_approval_closed';

/** 该会话是否还有 pending 的 tool_approval 行（还有就说明 run 仍要停靠等人）。 */
export function sessionHasPendingToolApproval(
  repo: PendingApprovalRepository,
  sessionId: string,
): boolean {
  return repo.listByKindAndStatus('tool_approval', 'pending').some((row) => {
    const payload = parseParkedApprovalPayload(row.payloadJson);
    const rowSession = payload?.argsRef?.sessionId ?? payload?.sessionId ?? row.coordinatorId;
    return rowSession === sessionId;
  });
}

/**
 * 快速重启窗口：hydrate 时旧 run 还是 running 且租约未过期（生产租约 15s，正常退出不释放），
 * 此刻不能碰（可能属于活进程）。登记下来，等恢复清扫器每次认领前重试——租约过期后在被
 * recoverOnStartup 回收成 waiting 之前把它收掉。只登记「审批已被收口」的会话，幸存会话不会进来。
 */
const deferredCloses = new Map<string, { repository: DurableRunRepository; approvalRequestedAt: number }>();

/** 在每次 durable 恢复认领之前调用：重试此前因租约未过期而跳过的收口。绝不抛。 */
export async function retryDeferredParkedRunCloses(now: number): Promise<void> {
  for (const [sessionId, entry] of [...deferredCloses]) {
    try {
      const { closed, skippedReason } = await entry.repository.closeParkedWaitingRunForSession({
        sessionId,
        now,
        reason: PARKED_APPROVAL_RUN_CLOSE_REASON,
        approvalRequestedAt: entry.approvalRequestedAt,
      });
      if (closed) {
        deferredCloses.delete(sessionId);
        logger.info('Closed parked durable run on deferred retry after lease expiry', { sessionId });
      } else if (!skippedReason?.endsWith('_lease_live')) {
        deferredCloses.delete(sessionId);
        logger.warn('Deferred parked durable run close dropped', { sessionId, reason: skippedReason });
      }
    } catch (error) {
      logger.warn('Deferred parked durable run close failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** 收口会话的 waiting root run；失败只 warn，绝不抛（不阻塞启动 / 点击链）。 */
export async function closeSessionParkedRun(
  repository: DurableRunRepository,
  sessionId: string,
  now: number,
  approvalRequestedAt: number,
): Promise<boolean> {
  try {
    const { closed, skippedReason } = await repository.closeParkedWaitingRunForSession({
      sessionId,
      now,
      reason: PARKED_APPROVAL_RUN_CLOSE_REASON,
      approvalRequestedAt,
    });
    if (closed) logger.info('Closed parked durable run after approval closure', { sessionId });
    else {
      logger.warn('Parked durable run not closed after approval closure', { sessionId, reason: skippedReason });
      if (skippedReason?.endsWith('_lease_live')) {
        const prior = deferredCloses.get(sessionId)?.approvalRequestedAt ?? approvalRequestedAt;
        deferredCloses.set(sessionId, { repository, approvalRequestedAt: Math.min(prior, approvalRequestedAt) });
      }
    }
    return closed;
  } catch (error) {
    logger.warn('Failed to close parked durable run after approval closure', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
