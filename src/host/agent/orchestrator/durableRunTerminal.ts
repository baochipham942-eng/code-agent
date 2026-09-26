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
  /** 用户取消：AgentLoop 对 cancel 正常 resolve（不抛），调用方必须显式告知，否则取消会被记成 completed（ai-review Important）。 */
  cancelled?: boolean;
  /** 显式注册档（不以 parentRunId 推断——无父 run 的 auxiliary 存在）。 */
  registration?: 'primary' | 'auxiliary';
  /** auxiliary 子 run 带 parentRunId（事件里要指回父 run）。 */
  parentRunId?: string;
}

export async function finalizeDurableRun(input: DurableRunTerminalInput): Promise<void> {
  const { registry, runId, handle, sessionId, completed, cancelled, registration, parentRunId } = input;
  const isAuxiliary = registration === 'auxiliary';
  const status = cancelled ? 'cancelled' : completed ? 'completed' : 'failed';
  const reason = status === 'completed'
    ? undefined
    : status === 'cancelled'
      ? isAuxiliary ? 'auxiliary_run_cancelled' : 'primary_run_cancelled'
      : isAuxiliary ? 'auxiliary_run_failed' : 'primary_run_failed';
  const eventKind = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
  await registry.terminalDurable(runId, {
    status,
    now: Date.now(),
    reason,
    event: {
      type: `${isAuxiliary ? 'auxiliary_run' : 'run'}_${eventKind}`,
      payload: { sessionId, ...(parentRunId ? { parentRunId } : {}) },
      recordedAt: Date.now(),
    },
  }, handle).catch((error) => {
    logger.error(`Failed to persist ${isAuxiliary ? 'auxiliary' : 'primary'} durable terminal state`, error);
  });
}
