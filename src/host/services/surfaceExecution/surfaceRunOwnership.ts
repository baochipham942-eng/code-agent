import type { RunRegistry } from '../../runtime/runRegistry';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';

export interface SurfaceRunOwnerIdentity {
  conversationId: string;
  runId: string;
  agentId: string;
}

/**
 * `active` / `cleanup` 是**行动授权**档：run 必须仍是 RunRegistry 里的活属主，
 * 才允许对真实浏览器/桌面派发或收尾（`cleanup` 只多放行「取消中的 run 拆自己」）。
 * cancel 是硬边界——停了之后旧 mutation 不得再改页面（ADR-046 stop 语义）。
 *
 * `read` 是**可见性**档：快照/投影这类只读枚举不碰任何 surface，没有理由跟着
 * run 的生死一起消失。它仍然要求 owner 三元组齐全，归属身份由调用方的
 * `requireOwnedForRead`（session 的 runId/agentId 必须与 subject 相同）钉死；
 * 放开的只有「run 还活着」这一条。取消/注销后 renderer 拉不到快照、durable
 * 投影落库连败，根因就是只读路径被这道行动闸管死（2026-08-02 排查报告 §2.2）。
 */
export function assertSurfaceRunOwner(input: {
  runRegistry: RunRegistry;
  identity: SurfaceRunOwnerIdentity;
  surface: 'browser' | 'computer';
  provider: string;
  access: 'active' | 'cleanup' | 'read';
}): void {
  const { identity } = input;
  if (!identity.conversationId.trim() || !identity.runId.trim() || !identity.agentId.trim()) {
    throw new Error('Surface execution requires conversationId, runId, and agentId.');
  }
  if (input.access === 'read') return;
  const handle = input.runRegistry.resolve({
    runId: identity.runId,
    sessionId: identity.conversationId,
  });
  const durableTrace = input.runRegistry.getTraceContext(identity.runId);
  const durableOwnerMissing = Boolean(durableTrace)
    && !input.runRegistry.hasDurableOwner(identity.runId);
  if (
    !handle
    || (input.access === 'active' && handle.cancellationRequested)
    || durableOwnerMissing
  ) {
    throw new SurfaceExecutionRuntimeError({
      code: 'SURFACE_TARGET_NOT_OWNED',
      message: 'Surface execution owner is not the active RunRegistry handle.',
      phase: 'prepare',
      recommendedAction: 'Use the active run and conversation owner.',
      surface: input.surface,
      provider: input.provider,
      sessionId: 'unbound',
      detailsSafe: {
        conversationId: identity.conversationId,
        runId: identity.runId,
        agentId: identity.agentId,
      },
    });
  }
}
