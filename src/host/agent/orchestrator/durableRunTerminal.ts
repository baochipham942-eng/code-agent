// ============================================================================
// durableRunTerminal — orchestrator 一侧的 durable run 终态收口
//
// /api/run 主链有自己的 durableRunLifecycle.markSuccess/markFailure；TaskManager
// 路径（@neo 工作卡、后台 run）没有那层包装——不在这里收口，结束后的 run 只清内存
// 注册，DB 侧 durable 记录永远 active，同会话下一条消息 startDurable 撞库冲突 409
// （N-CHAT-EMPTY-FINAL-NO-EXIT slotless 实测：工作卡 401 失败后普通聊天全部
// RunSessionConflictError，renderer 停在发送态）。
// ============================================================================

import type { RunRegistry } from '../../runtime/runRegistry';
import type { RunHandle } from '../../runtime/runContext';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('AgentOrchestrator');

export interface DurableRunTerminalInput {
  registry: RunRegistry;
  runId: string;
  handle: RunHandle;
  sessionId?: string | null;
  completed: boolean;
  /** auxiliary 子 run 带 parentRunId（事件里要指回父 run）。 */
  parentRunId?: string;
}

export async function finalizeDurableRun(input: DurableRunTerminalInput): Promise<void> {
  const { registry, runId, handle, sessionId, completed, parentRunId } = input;
  const isAuxiliary = parentRunId !== undefined;
  await registry.terminalDurable(runId, {
    status: completed ? 'completed' : 'failed',
    now: Date.now(),
    reason: completed ? undefined : isAuxiliary ? 'auxiliary_run_failed' : 'primary_run_failed',
    event: {
      type: completed
        ? isAuxiliary ? 'auxiliary_run_completed' : 'run_completed'
        : isAuxiliary ? 'auxiliary_run_failed' : 'run_failed',
      payload: { sessionId, ...(parentRunId ? { parentRunId } : {}) },
      recordedAt: Date.now(),
    },
  }, handle).catch((error) => {
    logger.error(`Failed to persist ${isAuxiliary ? 'auxiliary' : 'primary'} durable terminal state`, error);
  });
}
