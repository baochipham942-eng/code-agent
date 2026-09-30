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
import { isNativeRecoveryDescriptor } from '../../runtime/nativeRecoveryHost';
import { createLogger } from '../../services/infra/logger';
import type { AgentEvent } from '../../../shared/contract';
import { isTerminalAgentError } from '../../../shared/utils/agentErrorClassification';

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

async function finalizeDurableRun(input: DurableRunTerminalInput): Promise<void> {
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

/**
 * 停靠只留给没有父 run 的主 run。辅助子 run 没有「继续」入口：停成 waiting 会留下 owner
 * 和心跳，父 run 上 `agent-team:<child>` 也等不到终态。
 */
function canParkResumableUserStop(input: DurableRunTerminalInput): boolean {
  if (input.registration === 'auxiliary' || input.parentRunId) return false;
  return Boolean(input.cancelled)
    && isNativeRecoveryDescriptor(input.registry.getDurableCheckpointState(input.runId));
}

/**
 * 用户取消时：checkpoint 已是可续跑的 native descriptor 就停靠（保留 owner，只卸 handle）；
 * 否则走调用方今天的终态 cancelled。没有 descriptor 的 run，Continue 接不回来，不能停靠。
 * `terminal` 缺省是编排器的 finalizeDurableRun；网页路由传入自己的 terminalDurable 写入。
 * 停靠写库失败（handle 过期，或 checkpoint 失败）退回 terminal，不把异常抛出调用方的 finally。
 */
export async function finalizeOrParkDurableRun(
  input: DurableRunTerminalInput,
  terminal: (input: DurableRunTerminalInput) => Promise<void> = finalizeDurableRun,
): Promise<void> {
  if (canParkResumableUserStop(input)) {
    try {
      await input.registry.parkDurable(input.runId, { reason: 'user_stop' }, input.handle);
    } catch (error) {
      logger.error('Failed to park durable run on user stop; falling back to terminal cancelled', error);
      await terminal(input);
      return;
    }
    // 编排器 finally 会再 unregister 一次，对它是 no-op。网页路由停靠后要靠这一次卸 handle。
    input.registry.unregister(input.runId, input.handle);
    return;
  }
  await terminal(input);
}

export interface TerminalEventTracker {
  /** 透传事件并采集终态信号；喂给 AgentLoop 的事件出口。 */
  onEvent: (event: AgentEvent) => void;
  /** 截至当前的终态信号快照。 */
  snapshot: () => { cancelled: boolean; terminalError: boolean };
}

/**
 * 终态事件采集器：AgentLoop 对用户取消和「空最终回复转失败」都正常 resolve（不抛），
 * 调用方无法从「Promise 是否抛错」还原终态——在本轮事件流上旁听
 * agent_cancelled 与终态 error 事件（ai-review 二轮 Important）。
 */
export function createTerminalEventTracker(
  forward: (event: AgentEvent) => void,
): TerminalEventTracker {
  let cancelled = false;
  let terminalError = false;
  return {
    onEvent(event) {
      if (event.type === 'agent_cancelled') cancelled = true;
      else if (event.type === 'error' && isTerminalAgentError(event.data)) terminalError = true;
      forward(event);
    },
    snapshot: () => ({ cancelled, terminalError }),
  };
}
