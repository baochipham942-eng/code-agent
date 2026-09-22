// ============================================================================
// Loop durable 恢复 handler — N-LOOP-DURABLE-K2 刀2-c 续跑版
//
// 残留 running 的 engine_kind='loop' 行被 recoverOnStartup 认领后：
//   1. 解析 plan checkpoint 的 engineCursor；失败 → 降级收口（刀1 语义）。
//   2. session 已删/不可用 → adopt 失败，走 interrupted 收口（R3）。
//   3. dispatched+sideEffect 的 operation 显式判回 prepared（重跑即决议，
//      不走人工确认）；checkpoint 把 envelope 拉回 running。
//   4. 重建 LoopRunState，LoopController.adopt 后续跑：
//        dispatching / awaiting_reply → 重跑当轮（at-least-once）
//        sleeping → 按 nextRunAt - now 重排（已过期立即跑）
//      adopt 撞上本进程内存已是终态的同 id → 不复活，按内存终态收口该行
//      （LOOP_RECOVERY_TERMINAL_REASON）；撞上仍在跑的同 id → 不动账本直接返回。
// 此后 heartbeat / checkpoint / terminal 由重建后的控制器 + 账本驱动。
// ============================================================================

import { LOOP_TASK_TITLE_MAX_LEN, type LoopRunState } from '../../shared/contract/loop';
import type { PendingOperation } from '../../shared/contract/durableRun';
import type { DurableEngineRecoveryHandler } from '../runtime/durableRecoveryDispatcher';
import type { RunRehydrationPlan } from '../runtime/durableRunStores';
import type { RunRegistry } from '../runtime/runRegistry';
import { getSessionManager } from '../services/infra/sessionManager';
import { createLogger } from '../services/infra/logger';
import { getLoopController, type LoopController } from './loopController';
import {
  LOOP_INTERRUPTED_REASON,
  getLoopDurableLedger,
  readLoopEngineCursor,
  type LoopEngineCursor,
} from './loopDurableLedger';
import { projectInterruptedDurableLoop } from './loopStartupRecovery';

const logger = createLogger('LoopRecoveryHandler');

export const LOOP_RECOVERY_RERUN_REASON = 'rerun_in_flight_turn';
export const LOOP_RECOVERY_SLEEP_REASON = 'reschedule_sleep';
/** 认领回来的行在本进程内存里已是终态：adopt 按内存终态收口，不是续跑。 */
const LOOP_RECOVERY_TERMINAL_REASON = 'terminal_state_close_out';

function loopTaskTitleFromPrompt(prompt: string | undefined): string {
  const flat = (prompt ?? '').replace(/\s+/g, ' ').trim();
  const clipped = flat.length > LOOP_TASK_TITLE_MAX_LEN
    ? `${flat.slice(0, LOOP_TASK_TITLE_MAX_LEN)}…`
    : flat;
  return `循环 · ${clipped || '未命名任务'}`;
}

function preparedForRerun(operations: PendingOperation[], now: number): PendingOperation[] {
  return operations.map((operation) => {
    if (operation.kind !== 'model_call') return operation;
    if (operation.status !== 'unknown' && operation.status !== 'dispatched' && operation.status !== 'prepared') {
      return operation;
    }
    return {
      ...operation,
      status: 'prepared' as const,
      requiresHumanConfirmation: false,
      updatedAt: now,
    };
  });
}

function stateFromCursor(
  plan: RunRehydrationPlan,
  cursor: LoopEngineCursor,
): LoopRunState {
  return {
    id: plan.envelope.runId,
    sessionId: plan.envelope.sessionId,
    prompt: cursor.config.prompt,
    maxTurns: cursor.config.maxTurns,
    turn: cursor.turn,
    status: 'running',
    startedAt: plan.envelope.createdAt,
    durable: true,
    phase: cursor.phase,
    ...(cursor.config.intervalMs !== undefined ? { intervalMs: cursor.config.intervalMs } : {}),
    ...(cursor.config.until ? { until: cursor.config.until } : {}),
    ...(cursor.config.handoffPrompt ? { handoffPrompt: cursor.config.handoffPrompt } : {}),
    ...(cursor.lastTurnAt !== undefined ? { lastTurnAt: cursor.lastTurnAt } : {}),
    ...(cursor.nextRunAt !== undefined ? { nextRunAt: cursor.nextRunAt } : {}),
  };
}

async function defaultSessionExists(sessionId: string): Promise<boolean> {
  try {
    const session = await getSessionManager().getSession(sessionId, 1);
    return session != null;
  } catch (error) {
    logger.warn(`loop recovery session lookup failed for ${sessionId}:`, error);
    return false;
  }
}

export function createLoopRecoveryHandler(input: {
  registry: RunRegistry;
  controller?: LoopController;
  sessionExists?: (sessionId: string) => boolean | Promise<boolean>;
}): DurableEngineRecoveryHandler {
  return {
    name: 'loop',
    engineKind: 'loop',
    async recover(plan, now) {
      const rawCursor = plan.checkpoint?.cursor.engineCursor ?? plan.envelope.cursor.engineCursor;
      const cursor = readLoopEngineCursor(rawCursor);
      const closeOut = (reason: string) => closeOutInterrupted(input.registry, plan, now, cursor, reason);

      if (!cursor) {
        return closeOut('invalid_loop_cursor');
      }

      const sessionOk = await (input.sessionExists ?? defaultSessionExists)(plan.envelope.sessionId);
      if (!sessionOk) {
        return closeOut('session_missing');
      }

      const owner = plan.envelope.owner;
      if (!owner) {
        return closeOut('missing_owner_lease');
      }
      if (!getLoopDurableLedger()) {
        return closeOut('ledger_unavailable');
      }

      try {
        await input.registry.checkpointDurable(plan.envelope.runId, {
          now,
          status: 'running',
          state: cursor,
          engineCursor: cursor,
          pendingOperations: preparedForRerun(plan.pendingOperations, now),
          events: [{
            type: 'loop_recovery_prepared',
            payload: {
              loopId: plan.envelope.runId,
              phase: cursor.phase,
              turn: cursor.turn,
              extraMetaTurnExpected: cursor.phase === 'dispatching' || cursor.phase === 'awaiting_reply',
            },
            recordedAt: now,
          }],
        });
      } catch (error) {
        logger.warn(`loop recovery checkpoint failed for ${plan.envelope.runId}:`, error);
        return closeOut('recovery_checkpoint_failed');
      }

      const controller = input.controller ?? getLoopController();
      let adopted: LoopRunState;
      try {
        adopted = controller.adopt(stateFromCursor(plan, cursor), {
          owner,
          attempt: plan.envelope.attempt,
        });
      } catch (error) {
        logger.warn(`loop adopt failed for ${plan.envelope.runId}:`, error);
        return closeOut('adopt_failed');
      }

      // 内存里已是终态（典型：心跳曾失联的行被 sweeper 认领回来）：adopt 内部
      // 已按内存终态把行收口，不是续跑——据实上报，不谎报 rerun/reschedule。
      if (adopted.status !== 'running') {
        return {
          status: 'recovered',
          reason: LOOP_RECOVERY_TERMINAL_REASON,
          detail: {
            loopId: plan.envelope.runId,
            sessionId: plan.envelope.sessionId,
            terminalStatus: adopted.status,
            ...(adopted.stopReason ? { terminalReason: adopted.stopReason } : {}),
          },
        };
      }

      const rerun = cursor.phase === 'dispatching' || cursor.phase === 'awaiting_reply';
      return {
        status: 'recovered',
        reason: rerun ? LOOP_RECOVERY_RERUN_REASON : LOOP_RECOVERY_SLEEP_REASON,
        detail: {
          loopId: plan.envelope.runId,
          sessionId: plan.envelope.sessionId,
          phase: cursor.phase,
          turn: cursor.turn,
          extraMetaTurnExpected: rerun,
        },
      };
    },
  };
}

async function closeOutInterrupted(
  registry: RunRegistry,
  plan: RunRehydrationPlan,
  now: number,
  cursor: LoopEngineCursor | null,
  reason: string,
) {
  await registry.terminalDurable(plan.envelope.runId, {
    now,
    status: 'failed',
    reason: LOOP_INTERRUPTED_REASON,
    event: {
      type: 'loop_interrupted_by_restart',
      payload: {
        loopId: plan.envelope.runId,
        sessionId: plan.envelope.sessionId,
        recoveryFallback: reason,
      },
      recordedAt: now,
    },
  });
  await projectInterruptedDurableLoop({
    loopId: plan.envelope.runId,
    sessionId: plan.envelope.sessionId,
    title: loopTaskTitleFromPrompt(cursor?.config.prompt),
    now,
  });
  return {
    status: 'recovered' as const,
    reason: LOOP_INTERRUPTED_REASON,
    detail: {
      loopId: plan.envelope.runId,
      sessionId: plan.envelope.sessionId,
      recoveryFallback: reason,
    },
  };
}
