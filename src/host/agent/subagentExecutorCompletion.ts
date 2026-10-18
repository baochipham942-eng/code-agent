// ============================================================================
// Subagent Executor 收尾三出口 — 取消 / 正常完成 / 失败（从 subagentExecutor.ts
// 逐字搬出，N-MAXLINES-MINEFIELD-2-FU1-S2）。函数只吃显式入参（deps + 每次调用的
// iterations/latestContextSnapshot），不闭包 executor 状态；terminal 是共享可变盒，
// executeInternal 的 finally 据此 endRun。
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { silence } from '../utils/errorHandling';
import { SubagentPipeline } from './subagentPipeline';
import type { AgentTask } from './agentTask';
import { getSpawnGuard } from './spawnGuard';
import type {
  SubagentConfig,
  SubagentExecutionContext,
  SubagentResult,
} from './subagentExecutorTypes';
import type { SubagentExecutionContext as PipelineExecutionContext } from './subagentPipeline';
import type { createMemberAnswerLedger } from './memberInputWindDown';
import { createSubagentTurnObservability, type SubagentRunEndStatus } from './subagentTurnTrace';
import type { SubagentToolSurface } from './subagentExecutorToolDefs';
import type { buildContextSnapshot } from './subagentExecutorProjection';
import { adoptOrphanTasks } from '../services/planning/taskStore';
import { runRoleWriteBack, recordRoleParticipation } from '../services/roleAssets';
import { SubagentDoomLoopStopError } from './subagentDoomLoopGuard';
import {
  flushSubagentCancellation,
  getSubagentIdleTimeout,
} from './subagentExecutorCancellation';
import {
  agentFailureCodeFromCancellationReason,
  inferAgentFailureCode,
} from '../../shared/contract/agentFailure';
import { normalizeCancellationReason, type CancellationReason } from '../../shared/contract/cancellation';

const logger = createLogger('SubagentExecutor');

type MemberAnswerLedger = ReturnType<typeof createMemberAnswerLedger>;
type SubagentTurnObservability = ReturnType<typeof createSubagentTurnObservability>;
type SubagentContextSnapshot = ReturnType<typeof buildContextSnapshot>;

/** executeInternal 尾段共享的终态盒（finally 里 endRun 读它） */
export interface SubagentCompletionTerminal {
  status: SubagentRunEndStatus;
  error?: string;
}

/** 尾段各出口共用的稳定依赖（循环内变化的量走 SubagentCompletionState 按次传） */
export interface SubagentCompletionDeps {
  config: SubagentConfig;
  context: SubagentExecutionContext;
  prompt: string;
  sessionId: string;
  executionAgentId: string;
  pipeline: SubagentPipeline;
  pipelineContext: PipelineExecutionContext;
  agentTask: AgentTask;
  answerLedger: MemberAnswerLedger;
  surface: SubagentToolSurface;
  turnObservability: SubagentTurnObservability;
  getTotalTokens: () => number;
  getTotalCost: () => number;
  cleanupTimer: () => void;
  stopIdleWatchdog: () => void;
  effectiveSignal: AbortSignal;
  effectiveController: AbortController;
  timeout: number;
  startTime: number;
  toolsUsed: string[];
  instanceArtifacts: Array<{ label: string; ref?: string }>;
  terminal: SubagentCompletionTerminal;
}

export interface SubagentCompletionState {
  iterations: number;
  latestContextSnapshot: SubagentContextSnapshot;
}

/** 循环头的 abort 收口：flush 部分产物 + 结构化取消返回（原 executeInternal 内联块）。 */
export async function handleSubagentAbort(
  deps: SubagentCompletionDeps,
  state: SubagentCompletionState,
): Promise<SubagentResult> {
  const {
    config, context, sessionId, executionAgentId,
    pipeline, pipelineContext, agentTask, answerLedger,
    turnObservability, getTotalTokens, getTotalCost,
    cleanupTimer, stopIdleWatchdog, effectiveSignal, effectiveController,
    timeout, startTime, toolsUsed, terminal,
  } = deps;
  const { iterations, latestContextSnapshot } = state;
  const rawReason: unknown = effectiveSignal.reason;
  const cancellationReason: CancellationReason =
    rawReason === 'timeout'
      ? 'timeout'
      : rawReason === 'idle-timeout'
        ? 'idle-timeout'
        : normalizeCancellationReason(rawReason, 'parent-cancel');

  logger.info(
    `[${config.name}] Execution aborted reason=${cancellationReason} after ${Date.now() - startTime}ms`,
  );
  cleanupTimer();
  stopIdleWatchdog();

  // Phase 3 flush — persist partial transcript + metadata.
  // R5（grace 不等自己）/ sessionDir 约定 / patch 抢救的细节在 helper 里。
  await flushSubagentCancellation({
    agentName: config.name,
    agentTask,
    controller: effectiveController,
    sessionId,
    worktreePath: context.worktreePath,
    cwd: context.cwd,
    logger,
  });

  pipeline.completeContext(pipelineContext.agentId, false, cancellationReason);
  const errorMsg = cancellationReason === 'timeout'
    ? `执行超时 (${Math.round(timeout / 1000)}秒)，已完成 ${iterations} 次迭代`
    : cancellationReason === 'idle-timeout'
      ? `子代理 ${Math.round(getSubagentIdleTimeout(timeout) / 1000)}s 无 stream/progress, 已自动取消 (idle-timeout)`
      : `任务已取消 (${cancellationReason})`;
  terminal.status = 'cancelled';
  terminal.error = errorMsg;
  agentTask.fail(errorMsg);
  // orphan 接管（roadmap 2.6）
  adoptOrphanTasks(sessionId, pipelineContext.agentId);
  if (context.spawnGuardId) {
    getSpawnGuard().cancelDescendants(context.spawnGuardId, 'parent-cancel');
  }
  // Fire SubagentStop on abort/timeout
  context.hooks?.triggerSubagentStop(config.name, answerLedger.settled() || undefined, sessionId, agentTask.id).catch(silence(logger, 'triggerSubagentStop:abort', 'warn'));
  return {
    success: false,
    output: answerLedger.settled(),
    error: errorMsg,
    toolsUsed: [...new Set(toolsUsed)],
    toolCallCount: turnObservability.getToolCallCount(),
    iterations,
    tokensUsed: getTotalTokens(),
    cost: getTotalCost(),
    agentId: executionAgentId,
    contextSnapshot: latestContextSnapshot,
    cancellationReason,
    failureCode: agentFailureCodeFromCancellationReason(cancellationReason)
      ?? inferAgentFailureCode({ error: errorMsg }),
  };
}

/** 正常完成收尾：final cost / transcript close / orphan 回收 / SubagentStop / 角色写回。 */
export function finalizeSubagentSuccess(
  deps: SubagentCompletionDeps,
  state: SubagentCompletionState,
): SubagentResult {
  const {
    config, context, prompt, sessionId, executionAgentId,
    pipeline, pipelineContext, agentTask, answerLedger, surface,
    turnObservability, getTotalTokens, getTotalCost,
    cleanupTimer, stopIdleWatchdog, toolsUsed, instanceArtifacts, terminal,
  } = deps;
  const { iterations, latestContextSnapshot } = state;
  const finalOutput = answerLedger.settled();

  // Get final cost
  cleanupTimer();
  stopIdleWatchdog();
  pipeline.completeContext(pipelineContext.agentId, true);

  // Record final output in transcript and close AgentTask lifecycle
  agentTask.appendTranscript({
    role: 'assistant',
    content: finalOutput || 'Subagent completed without output',
    timestamp: Date.now(),
  });
  agentTask.stop();

  // orphan 接管（roadmap 2.6）：正常结束时名下未收口任务回归主会话
  adoptOrphanTasks(sessionId, pipelineContext.agentId);
  if (context.spawnGuardId) {
    getSpawnGuard().cancelDescendants(context.spawnGuardId, 'parent-gone');
  }

  // Fire SubagentStop hook (fire-and-forget)
  // GAP-012: 带上 agentId 作为 swarm trace 查询入口
  if (context.hooks) {
    context.hooks.triggerSubagentStop(
      config.name,
      finalOutput || undefined,
      sessionId,
      agentTask.id,
    ).catch(() => {});
  }

  // 持久化角色写回（设计 §5 步骤 3，fire-and-forget）：
  // 实例正常结束 → quick model 判断值得记的知识 → write gate → 落盘 + 履历。
  // 非持久角色在 runRoleWriteBack 内部零成本跳过；失败只记日志，绝不影响实例返回。
  if (config.roleId && finalOutput) {
    runRoleWriteBack({
      roleId: config.roleId,
      workspacePath: context.cwd,
      taskPrompt: prompt,
      finalOutput,
      artifacts: instanceArtifacts,
    }).catch(silence(logger, 'runRoleWriteBack', 'warn'));

    // 角色参与记录：主 run 结束后据此触发 event 醒来（内部文档 §2.2）
    recordRoleParticipation(sessionId, config.roleId);
  }

  terminal.status = 'completed';
  return {
    success: true,
    output: finalOutput || 'Subagent completed without output',
    toolsUsed: [...new Set(toolsUsed)],
    toolCallCount: turnObservability.getToolCallCount(),
    iterations,
    tokensUsed: getTotalTokens(),
    cost: getTotalCost(),
      agentId: executionAgentId,
    contextSnapshot: latestContextSnapshot,
    // N-SUBAGENT-ZEROTOOLS：部分声明的工具没装配上时不失败，但清单必须带回
    // 父模型（由调用方透传），让父模型自行裁量这结果可信到什么程度。
    ...(surface.missingToolNames.length > 0 ? { missingTools: [...surface.missingToolNames] } : {}),
  };
}

/** 失败收尾：doom-loop / failureExit 结构化返回，兜底把花费挂到 error 上再抛出。 */
export function handleSubagentFailure(
  deps: SubagentCompletionDeps,
  state: SubagentCompletionState & { error: unknown },
): SubagentResult {
  const {
    config, context, sessionId, executionAgentId,
    pipeline, pipelineContext, agentTask, answerLedger,
    turnObservability, getTotalTokens, getTotalCost,
    cleanupTimer, stopIdleWatchdog, effectiveSignal, toolsUsed, terminal,
  } = deps;
  const { error, iterations, latestContextSnapshot } = state;
  if (effectiveSignal.aborted || error instanceof SubagentDoomLoopStopError) {
    terminal.status = 'cancelled';
  }
  terminal.error = error instanceof Error ? error.message : String(error);
  cleanupTimer();
  stopIdleWatchdog();
  pipeline.completeContext(
    pipelineContext.agentId,
    false,
    error instanceof Error ? error.message : 'Unknown error'
  );

  agentTask.fail(error instanceof Error ? error.message : String(error));

  // orphan 接管（roadmap 2.6）
  adoptOrphanTasks(sessionId, pipelineContext.agentId);
  if (context.spawnGuardId) {
    getSpawnGuard().cancelDescendants(context.spawnGuardId, 'parent-cancel');
  }

  // Fire SubagentStop hook on failure (fire-and-forget)
  // GAP-012: 带上 agentId 作为 swarm trace 查询入口
  if (context.hooks) {
    context.hooks.triggerSubagentStop(
      config.name,
      answerLedger.settled() || undefined,
      sessionId,
      agentTask.id,
    ).catch(() => {});
  }

  if (error instanceof SubagentDoomLoopStopError) return { ...error.toResult(answerLedger.settled(), toolsUsed, iterations, getTotalTokens(), getTotalCost(), executionAgentId, latestContextSnapshot), toolCallCount: turnObservability.getToolCallCount() };
  const preservedExit = answerLedger.failureExit(error, {
    signalAborted: effectiveSignal.aborted,
    signalReason: effectiveSignal.reason,
    toolsUsed,
    toolCallCount: turnObservability.getToolCallCount(),
    iterations,
    tokensUsed: getTotalTokens(),
    cost: getTotalCost(),
    agentId: executionAgentId,
    contextSnapshot: latestContextSnapshot,
  });
  if (preservedExit) return preservedExit;

  // 把已消耗的 outputTokens 挂到 error 上，让 dynamic-workflow 的 BudgetTracker 在抛出路径
  // 也能记账（provider 产出部分 output 后崩的场景，Codex R2 MED#4）。不影响既有错误处理。
  if (error && typeof error === 'object') {
    try {
      (error as { tokensUsed?: number; cost?: number }).tokensUsed = getTotalTokens();
      (error as { tokensUsed?: number; cost?: number }).cost = getTotalCost();
    } catch { /* frozen error, ignore */ }
  }
  throw error; // re-throw to preserve existing error handling
}
