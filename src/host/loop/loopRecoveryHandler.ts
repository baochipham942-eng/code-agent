// ============================================================================
// Loop durable 恢复 handler — N-LOOP-DURABLE-K2 刀2-b 收口版
//
// 残留 running 的 engine_kind='loop' 行被 recoverOnStartup 认领后，本 handler
// 收口成 failed/interrupted_by_restart，并向台账/通知投影一次中断事实。
// 续跑（adopt / cursor 重建 / sleeping 重排）是刀2-c，本棒不做。
// ============================================================================

import { LOOP_TASK_TITLE_MAX_LEN } from '../../shared/contract/loop';
import type { DurableEngineRecoveryHandler } from '../runtime/durableRecoveryDispatcher';
import type { RunRegistry } from '../runtime/runRegistry';
import {
  LOOP_INTERRUPTED_REASON,
  readLoopEngineCursor,
} from './loopDurableLedger';
import { projectInterruptedDurableLoop } from './loopStartupRecovery';

function loopTaskTitleFromPrompt(prompt: string | undefined): string {
  const flat = (prompt ?? '').replace(/\s+/g, ' ').trim();
  const clipped = flat.length > LOOP_TASK_TITLE_MAX_LEN
    ? `${flat.slice(0, LOOP_TASK_TITLE_MAX_LEN)}…`
    : flat;
  return `循环 · ${clipped || '未命名任务'}`;
}

export function createLoopRecoveryHandler(input: {
  registry: RunRegistry;
}): DurableEngineRecoveryHandler {
  return {
    name: 'loop',
    engineKind: 'loop',
    async recover(plan, now) {
      const cursor = readLoopEngineCursor(
        plan.checkpoint?.cursor.engineCursor ?? plan.envelope.cursor.engineCursor,
      );
      await input.registry.terminalDurable(plan.envelope.runId, {
        now,
        status: 'failed',
        reason: LOOP_INTERRUPTED_REASON,
        event: {
          type: 'loop_interrupted_by_restart',
          payload: { loopId: plan.envelope.runId, sessionId: plan.envelope.sessionId },
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
        status: 'recovered',
        reason: LOOP_INTERRUPTED_REASON,
        detail: { loopId: plan.envelope.runId, sessionId: plan.envelope.sessionId },
      };
    },
  };
}
