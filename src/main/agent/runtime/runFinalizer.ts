// ============================================================================
// RunFinalizer — Session end processing, trace, telemetry, budget, todos
// Extracted from AgentLoop
// ============================================================================

// ============================================================================
// Agent Loop - Core event loop for AI agent execution
// Enhanced with Manus-style persistent planning hooks
// ============================================================================

import type {
  ModelConfig,
  Message,
  ToolCall,
  ToolResult,
  AgentEvent,
  AgentTaskPhase,
} from '../../../shared/contract';
import type { StructuredOutputConfig, StructuredOutputResult } from '../../agent/structuredOutput';
import type { ToolExecutor } from '../../tools/toolExecutor';
import { ModelRouter, ContextLengthExceededError } from '../../model/modelRouter';
import type { PlanningService } from '../../planning';
import { recordSessionEnd } from '../../lightMemory/sessionMetadata';
import { appendConversationSummary, isLoopAutomationSummaryText } from '../../lightMemory/recentConversations';
import { judgeConversation } from '../../lightMemory/conversationJudge';
import { getConfigService, getAuthService, getLangfuseService, getBudgetService, BudgetAlertLevel, getSessionManager } from '../../services';
import { logCollector } from '../../mcp/logCollector.js';
import { generateMessageId } from '../../../shared/utils/id';
import { classifyIntent } from '../../routing/intentClassifier';
import { getTaskOrchestrator } from '../../planning/taskOrchestrator';
import { getMaxIterations } from '../../services/cloud/featureFlagService';
import { createLogger } from '../../services/infra/logger';
import { trackNode } from '../../observability/posthogNode';
import { silence } from '../../utils/errorHandling';
import { HookManager, createHookManager } from '../../hooks';
import type { BudgetEventData } from '../../../shared/contract';
import { getContextHealthService } from '../../context/contextHealthService';
import { getSystemPromptCache } from '../../telemetry/systemPromptCache';
import { DEFAULT_MODELS, MODEL_MAX_TOKENS, getContextWindow, TOOL_PROGRESS, TOOL_TIMEOUT_THRESHOLDS } from '../../../shared/constants';

// Import refactored modules
import type {
  AgentLoopConfig,
  ModelResponse,
  ModelMessage,
} from '../../agent/loopTypes';
import { isParallelSafeTool, classifyToolCalls } from '../../agent/toolExecution/parallelStrategy';
import { CircuitBreaker } from '../../agent/toolExecution/circuitBreaker';
import { classifyExecutionPhase } from '../../tools/executionPhase';
import {
  formatToolCallForHistory,
  sanitizeToolResultsForHistory,
  buildMultimodalContent,
  stripImagesFromMessages,
  extractUserRequestText,
} from '../../agent/messageHandling/converter';
import {
  injectWorkingDirectoryContext,
  buildEnhancedSystemPrompt,
  buildRuntimeModeBlock,
} from '../../agent/messageHandling/contextBuilder';
import { getPromptForTask, buildDynamicPromptV2, type AgentMode } from '../../prompts/builder';
import { AntiPatternDetector } from '../../agent/antiPattern/detector';
import { cleanXmlResidues } from '../../agent/antiPattern/cleanXml';
import { GoalTracker } from '../../agent/goalTracker';
import { getSessionRecoveryService } from '../../agent/sessionRecovery';
import { getIncompleteTasks } from '../../services/planning/taskStore';
import {
  parseTodos,
  extractPlanTitle,
  mergeTodos,
  advanceTodoStatus,
  completeCurrentAndAdvance,
  getSessionTodos,
  setSessionTodos,
  syncTodosToSessionTasks,
  clearSessionTodos,
} from '../../agent/todoParser';
import { getDatabase } from '../../services/core/databaseService';
import { fileReadTracker } from '../../tools/fileReadTracker';
import { dataFingerprintStore } from '../../tools/dataFingerprint';
import { MAX_PARALLEL_TOOLS } from '../../agent/loopTypes';
import {
  compressToolResult,
  HookMessageBuffer,
  estimateModelMessageTokens,
  MessageHistoryCompressor,
  estimateTokens,
} from '../../context/tokenOptimizer';
import { AutoContextCompressor, getAutoCompressor } from '../../context/autoCompressor';
import { getInputSanitizer } from '../../security/inputSanitizer';
import { getDiffTracker } from '../../services/diff/diffTracker';
import { getCitationService } from '../../services/citation/citationService';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import type { RuntimeContext } from './runtimeContext';
import type { LearningPipeline } from './learningPipeline';
import type { MessageWriterPort } from './runtimePorts';
import {
  getRunTerminalAgentEventType,
  getRunTerminalPostHogEvent,
  type RunTerminalInfo,
  type RunTerminalStatus,
} from './runTerminalStatus';
import {
  buildCompletionSummaryRecord,
  persistCompletionSummaryRecord,
} from '../../session/completionSummaryService';


const logger = createLogger('AgentLoop');

type AutoAdvanceToolCall = {
  name: string;
  id: string;
  arguments?: Record<string, unknown>;
};

type AutoAdvanceToolResult = {
  success: boolean;
  toolCallId: string;
  metadata?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

function isTruthyMarker(value: unknown): boolean {
  return value === true || value === 'true' || value === 'passed' || value === 'verification' || value === 'task-linked';
}

function hasAnyMarker(record: Record<string, unknown> | undefined, keys: string[]): boolean {
  if (!record) return false;
  return keys.some((key) => isTruthyMarker(record[key]));
}

function isMarkedBashForTaskAdvance(
  toolCall: AutoAdvanceToolCall,
  toolResult: AutoAdvanceToolResult | undefined,
): boolean {
  const args = toolCall.arguments;
  const metadata = toolResult?.metadata ?? toolResult?.meta;
  const markerKeys = [
    'verification',
    'isVerification',
    'taskLinked',
    'task_linked',
    'task-linked',
    'linkedTaskId',
    'sessionTaskId',
  ];
  if (hasAnyMarker(args, markerKeys) || hasAnyMarker(metadata, markerKeys)) {
    return true;
  }

  const purpose = args?.purpose ?? metadata?.purpose ?? args?.kind ?? metadata?.kind ?? args?.category ?? metadata?.category;
  return purpose === 'verification' || purpose === 'task-linked';
}

function pushRuntimeDiagnostic(ctx: RuntimeContext, message: string): void {
  const trimmed = message.trim();
  if (!trimmed) return;
  if (ctx.currentTurnId) {
    ctx.onEvent({
      type: 'stream_reasoning',
      data: {
        content: `\n[runtime] ${trimmed}\n`,
        turnId: ctx.currentTurnId,
        ...(ctx.historyVisibility === 'meta' ? { isMeta: true } : {}),
      },
    });
    return;
  }
  ctx.pendingRuntimeDiagnostics.push(trimmed);
}

function hasCheckboxChecklist(content: string | undefined): boolean {
  if (!content) return false;
  return /^[-*]\s+\[[ xX✓✗-]\]\s+.+$/m.test(content);
}

// Re-export types for backward compatibility
export type { AgentLoopConfig };
export type { RunTerminalInfo, RunTerminalStatus };

function formatTerminalError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return error === undefined ? 'Unknown runtime error' : String(error);
}

function hasVisibleAssistantTextAfterLastUser(messages: Message[]): boolean {
  let seenLastUser = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') {
      seenLastUser = true;
      break;
    }

    if (message.role !== 'assistant') {
      continue;
    }

    if (typeof message.content === 'string' && message.content.trim().length > 0) {
      return true;
    }
  }

  return !seenLastUser;
}

// ----------------------------------------------------------------------------
// Agent Loop
// ----------------------------------------------------------------------------

/**
 * Agent Loop - AI Agent 的核心执行循环
 *
 * 实现 ReAct 模式的推理-行动循环：
 * 1. 调用模型进行推理（inference）
 * 2. 解析响应（文本或工具调用）
 * 3. 执行工具（带权限检查）
 * 4. 将结果反馈给模型
 * 5. 重复直到完成或达到最大迭代次数
 */

export class RunFinalizer {
  messageWriter!: MessageWriterPort;
  learningPipeline!: LearningPipeline;

  constructor(protected ctx: RuntimeContext) {}

  setModules(
    messageWriter: MessageWriterPort,
    learningPipeline: LearningPipeline,
  ): void {
    this.messageWriter = messageWriter;
    this.learningPipeline = learningPipeline;
  }

  // Convenience: emit event through context
  protected onEvent(event: AgentEvent): void {
    this.ctx.onEvent(event);
  }

  async finalizeRun(
    iterations: number,
    userMessage: string,
    langfuse: ReturnType<typeof getLangfuseService>,
    genNum: number,
    terminal: RunTerminalInfo = {},
  ): Promise<void> {
    const terminalStatus = terminal.status
      ?? (this.ctx.isCancelled
        ? 'cancelled'
        : this.ctx.isInterrupted
          ? 'interrupted'
          : 'completed');

    const runEvent = getRunTerminalPostHogEvent(terminalStatus);
    trackNode(runEvent, {
      sessionId: this.ctx.sessionId,
      iterations,
      status: terminalStatus,
    });

    // Handle loop exit conditions
    if (terminalStatus === 'failed') {
      const errorMessage = formatTerminalError(terminal.error);
      if (this.ctx.goalMode?.isPending()) {
        const reason = `运行失败：${errorMessage}`;
        this.ctx.goalMode.markAborted(reason);
        this.ctx.onEvent({
          type: 'goal_complete',
          data: {
            status: 'aborted',
            reason,
            turns: iterations,
            tokensUsed: this.ctx.totalInputTokens + this.ctx.totalOutputTokens,
          },
        });
      }
      logger.error('[AgentLoop] Loop exited due to runtime error', terminal.error);
      logCollector.agent('ERROR', `Agent run failed: ${errorMessage}`);
      this.ctx.onEvent({
        type: 'error',
        data: { message: errorMessage, code: 'RUN_FAILED' },
      });

      this.ctx.hookManager?.triggerStopFailure(
        errorMessage,
        'runtime_error',
        this.ctx.sessionId,
      ).catch(silence(logger, 'triggerStopFailure:runtime_error', 'error'));

      langfuse.endTrace(this.ctx.traceId, errorMessage, 'ERROR');
    } else if (terminalStatus === 'cancelled') {
      logger.info('[AgentLoop] Loop exited due to cancellation');
      logCollector.agent('INFO', `Agent run cancelled after ${iterations} iterations`);
      langfuse.endTrace(this.ctx.traceId, `Cancelled after ${iterations} iterations`, 'WARNING');
    } else if (terminalStatus === 'interrupted') {
      logger.info('[AgentLoop] Loop exited due to interrupt');
      logCollector.agent('INFO', `Agent run interrupted after ${iterations} iterations`);
      langfuse.endTrace(this.ctx.traceId, `Interrupted after ${iterations} iterations`, 'WARNING');
    } else if (this.ctx.circuitBreaker.isTripped()) {
      logger.info('[AgentLoop] Loop exited due to circuit breaker');
      logCollector.agent('WARN', `Circuit breaker stopped agent after ${iterations} iterations`);

      const errorMessage: Message = {
        id: this.messageWriter.generateId(),
        role: 'assistant',
        content: '⚠️ **工具调用异常**\n\n连续多次工具调用失败，已自动停止执行。这可能是由于：\n- 文件路径不存在\n- 网络连接问题\n- 工具参数错误\n\n请检查上面的错误信息，然后告诉我如何继续。',
        timestamp: Date.now(),
      };
      await this.messageWriter.addAndPersistMessage(errorMessage);
      this.ctx.onEvent({ type: 'message', data: errorMessage });

      // Fire-and-forget: emit StopFailure hook
      this.ctx.hookManager?.triggerStopFailure(
        `Circuit breaker tripped after ${iterations} iterations`,
        'circuit_breaker',
        this.ctx.sessionId,
      ).catch(silence(logger, 'triggerStopFailure:circuit_breaker', 'error'));

      langfuse.endTrace(this.ctx.traceId, `Circuit breaker tripped after ${iterations} iterations`, 'ERROR');
      this.ctx.circuitBreaker.reset();
    } else if (iterations >= this.ctx.maxIterations) {
      logger.debug('[AgentLoop] Max iterations reached!');
      logCollector.agent('WARN', `Max iterations reached (${this.ctx.maxIterations})`);
      this.ctx.onEvent({
        type: 'error',
        data: { message: 'Max iterations reached' },
      });

      // Fire-and-forget: emit StopFailure hook
      this.ctx.hookManager?.triggerStopFailure(
        `Max iterations reached (${this.ctx.maxIterations})`,
        'max_iterations',
        this.ctx.sessionId,
      ).catch(silence(logger, 'triggerStopFailure:max_iterations', 'error'));

      langfuse.endTrace(this.ctx.traceId, `Max iterations (${this.ctx.maxIterations}) reached`, 'WARNING');
    } else {
      if (!hasVisibleAssistantTextAfterLastUser(this.ctx.messages)) {
        const fallbackMessage: Message = {
          id: this.messageWriter.generateId(),
          role: 'assistant',
          content: '任务已结束，执行记录和产物已保留。这一轮没有生成最终说明，请直接查看上面的工具结果。',
          timestamp: Date.now(),
        };
        await this.messageWriter.addAndPersistMessage(fallbackMessage);
        this.ctx.onEvent({ type: 'message', data: fallbackMessage });
      }
      langfuse.endTrace(this.ctx.traceId, `Completed in ${iterations} iterations`);
    }

    try {
      const completionSummary = await buildCompletionSummaryRecord({
        ctx: this.ctx,
        status: terminalStatus,
        iterations,
        userMessage,
        error: terminal.error,
      });
      await persistCompletionSummaryRecord(completionSummary);
      logger.info('[CompletionSummary] persisted run completion contract', {
        sessionId: this.ctx.sessionId,
        summaryId: completionSummary.id,
        status: completionSummary.status,
      });
    } catch (error) {
      logger.warn('[CompletionSummary] failed to persist run completion contract', {
        sessionId: this.ctx.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 先落内部 completion contract，再通知前端关闭 "组织回复中" loading。
    // 后续 post-processing（hooks / learning / summary）跑在后台，不再阻塞 UI。
    const terminalEventType = getRunTerminalAgentEventType(terminalStatus);
    logger.debug(`[AgentLoop] ========== run() END, emitting ${terminalEventType} ==========`);
    logCollector.agent('INFO', `Agent run ${terminalStatus}, ${iterations} iterations`);
    this.ctx.onEvent({ type: terminalEventType, data: null });

    // === Mechanism Stats (observability) ===
    logger.info(`[AgentLoop] === Mechanism Stats ===`);

    // Session end learning
    // GAP-005: 学习管线只读本会话 telemetry（本地 DB，开销极低），
    // 不再用 genNum>=5 门槛——短会话里重复 3 次的失败模式同样值得沉淀。
    if (this.ctx.messages.length > 0) {
      this.learningPipeline.runSessionEndLearning().catch((err) => {
        logger.error('[AgentLoop] Session end learning error:', err);
      });
    }

    // User-configurable SessionEnd hook
    if (this.ctx.hookManager) {
      try {
        await this.ctx.hookManager.triggerSessionEnd(this.ctx.sessionId);
      } catch (error) {
        logger.error('[AgentLoop] Session end hook error:', error);
      }
    }

    // CU 跨会话锁：run 结束即释放（锁的临界区是一次活跃轨迹，不是整个会话；
    // 不释放会让其他会话/工具的 computer use 阻塞到 TTL）。未持有时是 no-op。
    import('../../mcp/cuaSessionLock')
      .then(({ releaseCuaLock }) => releaseCuaLock(this.ctx.sessionId))
      .catch(() => { /* non-critical */ });
    // CUA 轨迹预算：同一临界区，run 结束重置计数
    import('../../mcp/cuaTrajectoryBudget')
      .then(({ resetCuaBudget }) => resetCuaBudget(this.ctx.sessionId))
      .catch(() => { /* non-critical */ });

    // Light Memory: Record session stats + conversation summary
    const messageCount = this.ctx.messages.length;
    recordSessionEnd(messageCount, this.ctx.modelConfig.model, this.ctx.sessionId)
      .catch(() => { /* non-critical */ });

    // Extract conversation summary from user messages
    this.extractAndSaveConversationSummary().catch((err) => {
      logger.error('[RunFinalizer] Conversation summary extraction failed:', err);
    });

    // 角色主动性：长任务跑完 → 参与过的持久化角色 event 醒来总结 + 提 next steps
    // （fire-and-forget；门槛/防递归/预算护栏都在 triggerEventWakes 内部，docs/designs/role-proactivity.md §2.2）
    if (terminalStatus === 'completed') {
      const lastAssistant = [...this.ctx.messages].reverse().find((m) => m.role === 'assistant' && m.content);
      import('../../services/roleAssets/roleProactivity')
        .then(({ triggerEventWakes }) => triggerEventWakes(this.ctx.sessionId, iterations, lastAssistant?.content))
        .catch(silence(logger, 'triggerEventWakes', 'warn'));
    }

    // Pre-completion Hook: Only check explicit Tasks (persistent), not auto-parsed todos
    // 对标 Claude Code：模型返回 text response 即视为完成，不覆盖模型的判断
    // auto-parsed todos 误报率高（编号列表/建议性文本被误识别），不作为完成度依据
    const incompleteFinalTasks = getIncompleteTasks(this.ctx.sessionId);

    if (incompleteFinalTasks.length > 0) {
      const taskDetails = incompleteFinalTasks.map(t => `#${t.id}: ${t.subject}`);
      const allDetails = taskDetails.join(', ');

      logger.warn(`[AgentLoop] Agent completing with ${incompleteFinalTasks.length} incomplete task(s): ${allDetails}`);
      logCollector.agent('WARN', `Agent completing with incomplete tasks`, {
        incompleteCount: incompleteFinalTasks.length,
        incompleteTasks: incompleteFinalTasks.map(t => ({ id: t.id, subject: t.subject, status: t.status })),
      });

      this.ctx.onEvent({
        type: 'notification',
        data: {
          message: `⚠️ ${incompleteFinalTasks.length} 个显式任务未完成 (${allDetails})`,
        },
      });
    }

    // Async: generate context-aware follow-up suggestions (non-blocking)
    this.generateFollowUpSuggestions();

    langfuse.flush().catch((err) => logger.error('[Langfuse] Flush error:', err));
  }

  tryParseTodosFromResponse(response: { content?: string; thinking?: string }): void {
    // 优先从 thinking content 中解析（计划通常出现在思考过程中）
    let parsed: import('../../../shared/contract').TodoItem[] | null = null;
    let parsedFrom: string | null = null;

    if (response.thinking) {
      parsed = parseTodos(response.thinking);
      if (parsed) parsedFrom = response.thinking;
      if (!parsed && hasCheckboxChecklist(response.thinking)) {
        pushRuntimeDiagnostic(this.ctx, 'thinking 中的 checklist 没有显式任务标记，未提升为右侧待办');
      }
    }

    // 如果 thinking 中没有，从 text content 中解析
    if (!parsed && response.content) {
      parsed = parseTodos(response.content);
      if (parsed) parsedFrom = response.content;
      if (!parsed && hasCheckboxChecklist(response.content)) {
        pushRuntimeDiagnostic(this.ctx, '正文 checklist 仅作为回复内容展示，未自动写入待办面板');
      }
    }

    if (!parsed || parsed.length === 0) return;

    // 解析成功后顺带提取显式 plan 标题；没有标题时保留现有值。
    if (parsedFrom) {
      const planTitle = extractPlanTitle(parsedFrom);
      try {
        const db = getDatabase();
        if (db.isReady && planTitle !== null) {
          db.updateSessionPlanTitle(this.ctx.sessionId, planTitle);
        }
      } catch (err) {
        logger.warn('[TodoParser] Failed to persist plan_title', err);
      }
    }

    // 合并到会话级任务存储
    const existing = getSessionTodos(this.ctx.sessionId);
    const merged = existing.length > 0 ? mergeTodos(existing, parsed) : parsed;

    // 自动推进状态：确保有一个 in_progress 的任务
    const { todos: advanced } = advanceTodoStatus(merged);
    setSessionTodos(this.ctx.sessionId, advanced);
    const taskSync = syncTodosToSessionTasks(this.ctx.sessionId, advanced);

    // 推送到前端
    this.ctx.onEvent({ type: 'todo_update', data: advanced });
    this.ctx.onEvent({
      type: 'task_update',
      data: {
        tasks: taskSync.tasks,
        action: 'sync',
        taskIds: [
          ...taskSync.created.map((task) => task.id),
          ...taskSync.updated.map((task) => task.id),
        ],
        source: 'todo_parser',
      },
    });
    pushRuntimeDiagnostic(this.ctx, `识别到显式任务清单，已同步 ${advanced.length} 条待办`);

    logger.debug(`[AgentLoop] 自动解析到 ${parsed.length} 个任务，合并后 ${advanced.length} 个`);
  }

  /**
   * 工具执行完成后自动推进任务状态
   * 当工具执行成功时，将当前 in_progress 的任务标记为 completed 并推进下一个
   */

  autoAdvanceTodos(
    toolCalls: AutoAdvanceToolCall[],
    toolResults: AutoAdvanceToolResult[],
  ): void {
    const todos = getSessionTodos(this.ctx.sessionId);
    if (todos.length === 0) return;

    const successfulResultsById = new Map(
      toolResults
        .filter((result) => result.success)
        .map((result) => [result.toolCallId, result]),
    );
    if (successfulResultsById.size === 0) return;

    const hasInProgress = todos.some(t => t.status === 'in_progress');
    if (!hasInProgress) return;

    // 只在有修改类操作时才推进任务（纯读取不算完成任务）
    const hasModification = toolCalls.some(tc => {
      const result = successfulResultsById.get(tc.id);
      if (!result) return false;
      const name = tc.name.toLowerCase();
      if (name === 'bash') {
        return isMarkedBashForTaskAdvance(tc, result);
      }
      return name === 'edit' || name === 'write' || name === 'notebookedit';
    });
    if (!hasModification) return;

    const { updated, todos: advanced } = completeCurrentAndAdvance(todos);
    if (updated) {
      setSessionTodos(this.ctx.sessionId, advanced);
      const taskSync = syncTodosToSessionTasks(this.ctx.sessionId, advanced);
      this.ctx.onEvent({ type: 'todo_update', data: advanced });
      this.ctx.onEvent({
        type: 'task_update',
        data: {
          tasks: taskSync.tasks,
          action: 'sync',
          taskIds: [
            ...taskSync.created.map((task) => task.id),
            ...taskSync.updated.map((task) => task.id),
          ],
          source: 'todo_parser',
        },
      });
      logger.debug(`[AgentLoop] 自动推进任务状态（检测到修改类操作）`);
    }
  }

  // --------------------------------------------------------------------------
  // Task Progress Methods
  // --------------------------------------------------------------------------

  emitTaskProgress(
    phase: AgentTaskPhase,
    step?: string,
    extra?: { progress?: number; tool?: string; toolIndex?: number; toolTotal?: number; parallel?: boolean }
  ): void {
    this.ctx.onEvent({
      type: 'task_progress',
      data: {
        turnId: this.ctx.currentTurnId,
        phase,
        step,
        ...extra,
      },
    });
  }

  emitTaskComplete(): void {
    const duration = Date.now() - this.ctx.turnStartTime;
    this.ctx.onEvent({
      type: 'task_complete',
      data: {
        turnId: this.ctx.currentTurnId,
        duration,
        toolsUsed: [...new Set(this.ctx.toolsUsedInTurn)],
      },
    });
  }

  emitTaskStats(iterations: number): void {
    try {
      const healthService = getContextHealthService();
      const health = healthService.get(this.ctx.sessionId);
      const contextWindow = getContextWindow(this.ctx.modelConfig.model);
      this.ctx.totalIterations = iterations;
      this.ctx.onEvent({
        type: 'task_stats',
        data: {
          elapsed_ms: Date.now() - this.ctx.runStartTime,
          iterations,
          tokensUsed: this.ctx.totalTokensUsed,
          contextUsage: health.usagePercent / 100,
          toolCallCount: this.ctx.totalToolCallCount,
          contextWindow,
        },
      });
    } catch (error) {
      logger.debug('[AgentLoop] Failed to emit task stats:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Budget Methods
  // --------------------------------------------------------------------------

  checkAndEmitBudgetStatus(): boolean {
    const budgetService = getBudgetService();
    const status = budgetService.checkBudget();

    const eventData: BudgetEventData = {
      currentCost: status.currentCost,
      maxBudget: status.maxBudget,
      usagePercentage: status.usagePercentage,
      remaining: status.remaining,
      alertLevel: status.alertLevel === BudgetAlertLevel.BLOCKED ? 'blocked' :
                  status.alertLevel === BudgetAlertLevel.WARNING ? 'warning' : 'silent',
      message: status.message,
    };

    switch (status.alertLevel) {
      case BudgetAlertLevel.BLOCKED:
        this.ctx.onEvent({ type: 'budget_exceeded', data: eventData });
        return true;

      case BudgetAlertLevel.WARNING:
        if (!this.ctx.budgetWarningEmitted) {
          logger.warn(`[AgentLoop] Budget warning: ${status.message}`);
          logCollector.agent('WARN', `Budget warning: ${(status.usagePercentage * 100).toFixed(0)}% used`);
          this.ctx.onEvent({ type: 'budget_warning', data: eventData });
          this.ctx.budgetWarningEmitted = true;
        }
        return false;

      default:
        return false;
    }
  }

  processSkillActivation(skillResult: import('../../../shared/contract/agentSkill').SkillToolResult): void {
    logger.debug('[AgentLoop] Processing Skill activation result');
    const skillName = skillResult.data?.commandName;

    if (skillResult.newMessages) {
      for (const msg of skillResult.newMessages) {
        const messageToInject: Message = {
          id: this.messageWriter.generateId(),
          role: msg.role,
          content: msg.content,
          timestamp: Date.now(),
          isMeta: msg.isMeta,
          source: 'skill',
          ...(skillName ? {
            metadata: {
              skill: {
                skillName,
                phase: msg.isMeta ? 'instructions' : 'status',
              },
            },
          } : {}),
        };
        this.ctx.messages.push(messageToInject);

        if (!msg.isMeta) {
          this.ctx.onEvent({ type: 'message', data: messageToInject });
        }
      }
      logger.debug(`[AgentLoop] Injected ${skillResult.newMessages.length} skill messages`);
    }

    if (skillResult.contextModifier) {
      if (skillResult.contextModifier.preApprovedTools) {
        for (const tool of skillResult.contextModifier.preApprovedTools) {
          this.ctx.preApprovedTools.add(tool);
        }
        logger.debug(`[AgentLoop] Pre-approved tools: ${[...this.ctx.preApprovedTools].join(', ')}`);
      }

      // GAP-001: skill allowed-tools 限权边界（边界外的工具调用强制用户审批）
      if (skillResult.contextModifier.toolBoundary) {
        this.ctx.skillToolBoundary = skillResult.contextModifier.toolBoundary;
        logger.debug(`[AgentLoop] Skill tool boundary set by "${skillResult.contextModifier.toolBoundary.skillName}": ${skillResult.contextModifier.toolBoundary.allowedTools.join(', ')}`);
      }

      if (skillResult.contextModifier.modelOverride) {
        this.ctx.skillModelOverride = skillResult.contextModifier.modelOverride;
        logger.debug(`[AgentLoop] Model override set to: ${this.ctx.skillModelOverride}`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Warning Message Generators
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // Context-Aware Follow-Up Suggestions
  // --------------------------------------------------------------------------

  private generateFollowUpSuggestions(): void {
    // Fire-and-forget: don't block agent completion
    (async () => {
      try {
        const { generateContextSuggestions } = await import('../../services/core/promptSuggestions');
        const suggestions = await generateContextSuggestions(this.ctx.messages);
        if (suggestions.length > 0) {
          this.ctx.onEvent({ type: 'suggestions_update', data: suggestions });
        }
      } catch (error) {
        logger.debug('[RunFinalizer] Failed to generate follow-up suggestions', { error });
      }
    })();
  }

  /**
   * Judge a conversation at session end and save it to Light Memory if worth keeping.
   * Only the user side is summarized (following the ChatGPT recent-conversations pattern);
   * the last assistant reply is passed only as context for the judgment.
   *
   * Uses the quick model to judge worth / isMeeting / title / worthKnowledge, and
   * degrades to the previous truncation heuristic on any failure (see conversationJudge).
   */
  private async extractAndSaveConversationSummary(): Promise<void> {
    const userMessages = this.ctx.messages
      .filter((m: { role: string; content?: string; isMeta?: boolean }) =>
        m.role === 'user'
        && !m.isMeta
        && m.content
        && !isLoopAutomationSummaryText(m.content)
      )
      .map((m: { content?: string }) => m.content || '');

    if (userMessages.length === 0) return;

    // Last assistant text gives the judge context for the title (it is not summarized itself).
    const lastAssistant = [...this.ctx.messages]
      .reverse()
      .find((m: { role: string; content?: string; isMeta?: boolean }) =>
        m.role === 'assistant'
        && !m.isMeta
        && typeof m.content === 'string'
        && m.content.trim().length > 0
        && !isLoopAutomationSummaryText(m.content));
    const lastAssistantText = typeof lastAssistant?.content === 'string' ? lastAssistant.content : undefined;

    const judgment = await judgeConversation({ userMessages, lastAssistant: lastAssistantText });

    // "只存值得留的" — skip trivial chats (greetings, "继续"/"ok", no-signal turns).
    if (!judgment.worth || !judgment.title) {
      logger.debug('[RunFinalizer] Conversation judged not worth saving, skipping summary');
      return;
    }

    const title = judgment.isMeeting ? `[会议] ${judgment.title}` : judgment.title;
    const today = new Date().toISOString().split('T')[0];

    await appendConversationSummary({
      date: today,
      title: title.replace(/"/g, "'"),
      highlights: judgment.worthKnowledge,
    });
  }
}
