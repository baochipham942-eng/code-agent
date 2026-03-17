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
} from '../../../shared/types';
import type { StructuredOutputConfig, StructuredOutputResult } from '../../agent/structuredOutput';
import type { ToolRegistryLike } from '../../tools/types';
import type { ToolExecutor } from '../../tools/toolExecutor';
import { ModelRouter, ContextLengthExceededError } from '../../model/modelRouter';
import type { PlanningService } from '../../planning';
import { sanitizeMemoryContent } from '../../memory/sanitizeMemoryContent';
import { buildSeedMemoryBlock } from '../../memory/seedMemoryInjector';
import { recordSessionEnd } from '../../lightMemory/sessionMetadata';
import { appendConversationSummary } from '../../lightMemory/recentConversations';
import { getConfigService, getAuthService, getLangfuseService, getBudgetService, BudgetAlertLevel, getSessionManager } from '../../services';
import { logCollector } from '../../mcp/logCollector.js';
import { generateMessageId } from '../../../shared/utils/id';
import { classifyIntent } from '../../routing/intentClassifier';
import { getTaskOrchestrator } from '../../planning/taskOrchestrator';
import { getMaxIterations } from '../../services/cloud/featureFlagService';
import { createLogger } from '../../services/infra/logger';
import { HookManager, createHookManager } from '../../hooks';
import type { BudgetEventData } from '../../../shared/types';
import { getContextHealthService } from '../../context/contextHealthService';
import { getSystemPromptCache } from '../../telemetry/systemPromptCache';
import { DEFAULT_MODELS, MODEL_MAX_TOKENS, CONTEXT_WINDOWS, DEFAULT_CONTEXT_WINDOW, TOOL_PROGRESS, TOOL_TIMEOUT_THRESHOLDS } from '../../../shared/constants';

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
import { getIncompleteTasks } from '../../tools/planning/taskStore';
import {
  parseTodos,
  mergeTodos,
  advanceTodoStatus,
  completeCurrentAndAdvance,
  getSessionTodos,
  setSessionTodos,
  clearSessionTodos,
} from '../../agent/todoParser';
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
import type { ContextAssembly } from './contextAssembly';
import type { LearningPipeline } from './learningPipeline';


const logger = createLogger('AgentLoop');

// Re-export types for backward compatibility
export type { AgentLoopConfig };

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
  contextAssembly!: ContextAssembly;
  learningPipeline!: LearningPipeline;

  constructor(protected ctx: RuntimeContext) {}

  setModules(
    contextAssembly: ContextAssembly,
    learningPipeline: LearningPipeline,
  ): void {
    this.contextAssembly = contextAssembly;
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
  ): Promise<void> {
    // Handle loop exit conditions
    if (this.ctx.circuitBreaker.isTripped()) {
      logger.info('[AgentLoop] Loop exited due to circuit breaker');
      logCollector.agent('WARN', `Circuit breaker stopped agent after ${iterations} iterations`);

      const errorMessage: Message = {
        id: this.contextAssembly.generateId(),
        role: 'assistant',
        content: '⚠️ **工具调用异常**\n\n连续多次工具调用失败，已自动停止执行。这可能是由于：\n- 文件路径不存在\n- 网络连接问题\n- 工具参数错误\n\n请检查上面的错误信息，然后告诉我如何继续。',
        timestamp: Date.now(),
      };
      await this.contextAssembly.addAndPersistMessage(errorMessage);
      this.ctx.onEvent({ type: 'message', data: errorMessage });

      langfuse.endTrace(this.ctx.traceId, `Circuit breaker tripped after ${iterations} iterations`, 'ERROR');
      this.ctx.circuitBreaker.reset();
    } else if (iterations >= this.ctx.maxIterations) {
      logger.debug('[AgentLoop] Max iterations reached!');
      logCollector.agent('WARN', `Max iterations reached (${this.ctx.maxIterations})`);
      this.ctx.onEvent({
        type: 'error',
        data: { message: 'Max iterations reached' },
      });
      langfuse.endTrace(this.ctx.traceId, `Max iterations (${this.ctx.maxIterations}) reached`, 'WARNING');
    } else {
      langfuse.endTrace(this.ctx.traceId, `Completed in ${iterations} iterations`);
    }

    // === Mechanism Stats (observability) ===
    logger.info(`[AgentLoop] === Mechanism Stats ===`);

    // Session end learning (Gen5+)
    // genNum already declared above in dynamic mode detection
    if (genNum >= 5 && this.ctx.messages.length > 0) {
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

    // Light Memory: Record session stats + conversation summary
    const messageCount = this.ctx.messages.length;
    recordSessionEnd(messageCount).catch(() => { /* non-critical */ });

    // Extract conversation summary from user messages
    this.extractAndSaveConversationSummary().catch((err) => {
      logger.error('[RunFinalizer] Conversation summary extraction failed:', err);
    });

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

    logger.debug('[AgentLoop] ========== run() END, emitting agent_complete ==========');
    logCollector.agent('INFO', `Agent run completed, ${iterations} iterations`);
    this.ctx.onEvent({ type: 'agent_complete', data: null });

    // Async: generate context-aware follow-up suggestions (non-blocking)
    this.generateFollowUpSuggestions();

    langfuse.flush().catch((err) => logger.error('[Langfuse] Flush error:', err));
  }

  tryParseTodosFromResponse(response: { content?: string; thinking?: string }): void {
    // 优先从 thinking content 中解析（计划通常出现在思考过程中）
    let parsed: import('../../../shared/types').TodoItem[] | null = null;

    if (response.thinking) {
      parsed = parseTodos(response.thinking);
    }

    // 如果 thinking 中没有，从 text content 中解析
    if (!parsed && response.content) {
      parsed = parseTodos(response.content);
    }

    if (!parsed || parsed.length === 0) return;

    // 合并到会话级任务存储
    const existing = getSessionTodos(this.ctx.sessionId);
    const merged = existing.length > 0 ? mergeTodos(existing, parsed) : parsed;

    // 自动推进状态：确保有一个 in_progress 的任务
    const { todos: advanced } = advanceTodoStatus(merged);
    setSessionTodos(this.ctx.sessionId, advanced);

    // 推送到前端
    this.ctx.onEvent({ type: 'todo_update', data: advanced });

    logger.debug(`[AgentLoop] 自动解析到 ${parsed.length} 个任务，合并后 ${advanced.length} 个`);
  }

  /**
   * 工具执行完成后自动推进任务状态
   * 当工具执行成功时，将当前 in_progress 的任务标记为 completed 并推进下一个
   */

  autoAdvanceTodos(
    toolCalls: Array<{ name: string; id: string }>,
    toolResults: Array<{ success: boolean; toolCallId: string }>,
  ): void {
    const todos = getSessionTodos(this.ctx.sessionId);
    if (todos.length === 0) return;

    const hasSuccessfulTool = toolResults.some(r => r.success);
    if (!hasSuccessfulTool) return;

    const hasInProgress = todos.some(t => t.status === 'in_progress');
    if (!hasInProgress) return;

    // 只在有修改类操作时才推进任务（纯读取不算完成任务）
    const hasModification = toolCalls.some(tc => {
      const name = tc.name.toLowerCase();
      return name === 'edit' || name === 'write' || name === 'bash' || name === 'notebookedit';
    });
    if (!hasModification) return;

    const { updated, todos: advanced } = completeCurrentAndAdvance(todos);
    if (updated) {
      setSessionTodos(this.ctx.sessionId, advanced);
      this.ctx.onEvent({ type: 'todo_update', data: advanced });
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
      const contextWindow = CONTEXT_WINDOWS[this.ctx.modelConfig.model] || DEFAULT_CONTEXT_WINDOW;
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

  processSkillActivation(skillResult: import('../../../shared/types/agentSkill').SkillToolResult): void {
    logger.debug('[AgentLoop] Processing Skill activation result');

    if (skillResult.newMessages) {
      for (const msg of skillResult.newMessages) {
        const messageToInject: Message = {
          id: this.contextAssembly.generateId(),
          role: msg.role,
          content: msg.content,
          timestamp: Date.now(),
          isMeta: msg.isMeta,
          source: 'skill',
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
        const { generateContextSuggestions } = await import('../../services/promptSuggestions');
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
   * Extract a conversation summary from user messages and save it.
   * Only summarizes what the user asked — not assistant replies (following ChatGPT pattern).
   */
  private async extractAndSaveConversationSummary(): Promise<void> {
    const userMessages = this.ctx.messages
      .filter((m: { role: string; content?: string }) => m.role === 'user' && m.content)
      .map((m: { content?: string }) => m.content || '');

    if (userMessages.length === 0) return;

    // Extract title from first user message (truncate to 50 chars)
    const firstMsg = userMessages[0];
    const title = firstMsg.length > 50 ? firstMsg.slice(0, 50).trim() + '...' : firstMsg.trim();

    // Extract highlights: take first line of each unique user message (up to 3)
    const highlights = userMessages
      .slice(0, 5)
      .map(msg => {
        const firstLine = msg.split('\n')[0].trim();
        return firstLine.length > 60 ? firstLine.slice(0, 60) + '...' : firstLine;
      })
      .filter((v, i, a) => a.indexOf(v) === i) // dedupe
      .slice(0, 3);

    const today = new Date().toISOString().split('T')[0];

    await appendConversationSummary({
      date: today,
      title: title.replace(/"/g, "'"),
      highlights,
    });
  }
}
