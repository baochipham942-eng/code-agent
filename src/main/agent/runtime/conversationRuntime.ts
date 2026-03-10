// ============================================================================
// ConversationRuntime — Main loop, step execution, plan mode, cancel/interrupt/steer
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
import { parseStructuredOutput, generateFormatCorrectionPrompt } from '../../agent/structuredOutput';
import type { ToolRegistryLike } from '../../tools/types';
import type { ToolExecutor } from '../../tools/toolExecutor';
import { getToolSearchService } from '../../tools/search';
import { ModelRouter, ContextLengthExceededError } from '../../model/modelRouter';
import type { PlanningService } from '../../planning';
import { getMemoryService } from '../../memory/memoryService';
import { getContinuousLearningService } from '../../memory/continuousLearningService';
import { sanitizeMemoryContent } from '../../memory/sanitizeMemoryContent';
import { buildSeedMemoryBlock } from '../../memory/seedMemoryInjector';
import { getConfigService, getAuthService, getLangfuseService, getBudgetService, BudgetAlertLevel, getSessionManager } from '../../services';
import { logCollector } from '../../mcp/logCollector.js';
import { generateMessageId } from '../../../shared/utils/id';
import { taskComplexityAnalyzer } from '../../planning/taskComplexityAnalyzer';
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
import { NudgeManager } from '../../agent/nudgeManager';
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
import type { ToolExecutionEngine } from './toolExecutionEngine';
import type { ContextAssembly } from './contextAssembly';
import type { RunFinalizer } from './runFinalizer';
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


function extractAbsoluteFilePaths(text: string): string[] {
  const pattern = /\/[\w.~-]+\/[^\s,，。、;；:：""""'']+\.\w{2,5}/g;
  const files: string[] = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const p = match[0];
    const tokenStart = text.lastIndexOf(' ', match.index) + 1;
    const prefix = text.substring(tokenStart, match.index);
    if (prefix.includes('://') || prefix.endsWith('/') || prefix.endsWith(':')) continue;
    if (!files.includes(p)) files.push(p);
  }
  return files;
}

export class ConversationRuntime {
  toolEngine!: ToolExecutionEngine;
  contextAssembly!: ContextAssembly;
  runFinalizer!: RunFinalizer;
  learningPipeline!: LearningPipeline;

  constructor(protected ctx: RuntimeContext) {}

  setModules(
    toolEngine: ToolExecutionEngine,
    contextAssembly: ContextAssembly,
    runFinalizer: RunFinalizer,
    learningPipeline: LearningPipeline,
  ): void {
    this.toolEngine = toolEngine;
    this.contextAssembly = contextAssembly;
    this.runFinalizer = runFinalizer;
    this.learningPipeline = learningPipeline;
  }

  // Convenience: emit event through context
  protected onEvent(event: AgentEvent): void {
    this.ctx.onEvent(event);
  }

  async initializeUserHooks(): Promise<void> {
    if (this.ctx.userHooksInitialized) return;

    if (!this.ctx.hookManager && this.ctx.enableHooks) {
      this.ctx.hookManager = createHookManager({
        workingDirectory: process.cwd(),
        enabled: this.ctx.enableHooks,
      });
    }

    if (this.ctx.hookManager) {
      try {
        await this.ctx.hookManager.initialize();
        logger.debug('[AgentLoop] User hooks initialized', {
          stats: this.ctx.hookManager.getHookStats(),
        });
      } catch (error) {
        logger.error('[AgentLoop] Failed to initialize user hooks', { error });
      }
    }

    this.ctx.userHooksInitialized = true;
  }

  // --------------------------------------------------------------------------
  // Plan Mode Methods
  // --------------------------------------------------------------------------

  setPlanMode(active: boolean): void {
    const wasActive = this.ctx.planModeActive;
    this.ctx.planModeActive = active;
    logger.debug(` Plan mode ${active ? 'activated' : 'deactivated'}`);

    if (active && !wasActive) {
      // Entering plan mode: save current context and start fresh
      this.ctx.savedMessages = [...this.ctx.messages];
      this.ctx.messages.length = 0;
      this.ctx.messages.push({
        id: this.contextAssembly.generateId(),
        role: 'system',
        content: 'You are now in Plan Mode. Focus on understanding the task, exploring the codebase, and creating a step-by-step plan. Use read-only tools only (read_file, glob, grep, web_search). Do not make any changes.',
        timestamp: Date.now(),
      });
      logger.info('[AgentLoop] Plan mode entered: context saved, messages isolated');
      this.ctx.onEvent({
        type: 'plan_mode_entered',
        data: { reason: 'Plan mode activated' },
      } as AgentEvent);
    }

    this.ctx.onEvent({
      type: 'notification',
      data: { message: `Plan mode ${active ? 'activated' : 'deactivated'}` },
    });
  }

  isPlanMode(): boolean {
    return this.ctx.planModeActive;
  }

  // --------------------------------------------------------------------------
  // Structured Output Methods
  // --------------------------------------------------------------------------

  setStructuredOutput(config: StructuredOutputConfig | undefined): void {
    this.ctx.structuredOutput = config;
    this.ctx.structuredOutputRetryCount = 0;
    logger.debug(` Structured output ${config?.enabled ? 'enabled' : 'disabled'}`);
  }

  getStructuredOutput(): StructuredOutputConfig | undefined {
    return this.ctx.structuredOutput;
  }

  parseModelStructuredOutput<T = unknown>(content: string): StructuredOutputResult<T> {
    if (!this.ctx.structuredOutput?.enabled) {
      return {
        success: true,
        data: content as unknown as T,
        rawContent: content,
      };
    }
    return parseStructuredOutput<T>(content, this.ctx.structuredOutput);
  }

  shouldRetryStructuredOutput(result: StructuredOutputResult): boolean {
    if (result.success) return false;
    if (!this.ctx.structuredOutput?.enabled) return false;
    if (this.ctx.structuredOutput.onParseError !== 'retry') return false;
    if (this.ctx.structuredOutputRetryCount >= this.ctx.maxStructuredOutputRetries) return false;
    return true;
  }

  injectStructuredOutputCorrection(result: StructuredOutputResult): void {
    if (!this.ctx.structuredOutput) return;

    this.ctx.structuredOutputRetryCount++;
    const correctionPrompt = generateFormatCorrectionPrompt(
      result.rawContent || '',
      this.ctx.structuredOutput.schema,
      result.validationErrors || [result.error || 'Unknown error']
    );

    this.contextAssembly.injectSystemMessage(
      `<structured-output-correction>\n${correctionPrompt}\n</structured-output-correction>`
    );

    logger.warn(
      `[AgentLoop] Structured output parse failed, retry ${this.ctx.structuredOutputRetryCount}/${this.ctx.maxStructuredOutputRetries}`
    );
  }

  // --------------------------------------------------------------------------
  // Step-by-Step Execution Methods (for DeepSeek etc.)
  // --------------------------------------------------------------------------

  shouldAutoEnableStepByStep(): boolean {
    const model = this.ctx.modelConfig.model?.toLowerCase() || '';
    const provider = this.ctx.modelConfig.provider?.toLowerCase() || '';
    if (provider === 'deepseek' || model.includes('deepseek')) return true;
    if (provider === 'zhipu' && model.includes('glm')) return true;
    return false;
  }

  parseMultiStepTask(prompt: string): { steps: string[]; isMultiStep: boolean } {
    const stepRegex = /^\s*(\d+)[.\)]\s*(.+?)(?=\n\s*\d+[.\)]|\n*$)/gms;
    const steps: string[] = [];
    let match;
    while ((match = stepRegex.exec(prompt)) !== null) {
      const instruction = match[2].trim();
      if (instruction.length > 10) steps.push(instruction);
    }
    return { steps, isMultiStep: steps.length >= 2 };
  }

  async runStepByStep(userMessage: string, steps: string[]): Promise<boolean> {
    logger.info(`[AgentLoop] Step-by-step mode: ${steps.length} steps`);
    this.ctx.onEvent({ type: 'notification', data: { message: `分步执行: ${steps.length} 步` } });

    for (let i = 0; i < steps.length; i++) {
      const stepNum = i + 1;
      const step = steps[i];
      const stepPrompt = `执行第 ${stepNum}/${steps.length} 步: ${step}\n\n背景: ${userMessage}`;

      const stepMessage: Message = {
        id: generateMessageId(),
        role: 'user',
        content: stepPrompt,
        timestamp: Date.now(),
      };
      this.ctx.messages.push(stepMessage);
      this.ctx.onEvent({ type: 'message', data: stepMessage });
      this.ctx.onEvent({ type: 'notification', data: { message: `[${stepNum}/${steps.length}] ${step.substring(0, 30)}...` } });

      let stepIterations = 0;
      while (!this.ctx.isCancelled && stepIterations < 5) {
        stepIterations++;
        const response = await this.contextAssembly.inference();
        if (response.type === 'text') {
          const msg: Message = { id: generateMessageId(), role: 'assistant', content: response.content || '', timestamp: Date.now(), inputTokens: response.usage?.inputTokens, outputTokens: response.usage?.outputTokens };
          this.ctx.messages.push(msg);
          this.ctx.onEvent({ type: 'message', data: msg });
          break;
        }
        if (response.type === 'tool_use' && response.toolCalls) {
          const results = await this.toolEngine.executeToolsWithHooks(response.toolCalls);
          const toolMsg: Message = { id: generateMessageId(), role: 'assistant', content: response.content || '', timestamp: Date.now(), toolCalls: response.toolCalls, toolResults: results, inputTokens: response.usage?.inputTokens, outputTokens: response.usage?.outputTokens };
          this.ctx.messages.push(toolMsg);
        }
      }
    }
    this.ctx.onEvent({ type: 'notification', data: { message: `分步执行完成` } });
    return true;
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  async run(userMessage: string): Promise<void> {

    const initResult = await this.initializeRun(userMessage);
    if (!initResult) return; // Early exit (step-by-step mode or hook blocked)
    const { langfuse, isSimpleTask, shouldRunHooks, genNum } = initResult;

    let iterations = 0;
    let userTurnId: string | undefined;

    while (!this.ctx.isCancelled && !this.ctx.isInterrupted && !this.ctx.circuitBreaker.isTripped() && iterations < this.ctx.maxIterations) {
      iterations++;
      logger.debug(` >>>>>> Iteration ${iterations} START <<<<<<`);

      // Check for interrupt at the start of each iteration
      if (this.ctx.isInterrupted && this.ctx.interruptMessage) {
        logger.info('[AgentLoop] Interrupt detected, breaking loop');
        this.ctx.onEvent({
          type: 'interrupt_acknowledged',
          data: { message: '已收到新指令，正在调整方向...' },
        });
        break;
      }

      // Budget check
      const budgetBlocked = this.runFinalizer.checkAndEmitBudgetStatus();
      if (budgetBlocked) {
        logger.warn('[AgentLoop] Budget exceeded, stopping execution');
        logCollector.agent('WARN', 'Budget exceeded, execution blocked');
        this.ctx.onEvent({
          type: 'error',
          data: { message: 'Budget exceeded. Please increase budget or wait for reset.', code: 'BUDGET_EXCEEDED' },
        });
        break;
      }

      // Generate turn ID
      this.ctx.currentTurnId = generateMessageId();
      if (iterations === 1) {
        userTurnId = this.ctx.currentTurnId;
      }

      // Langfuse: Start iteration span
      this.ctx.currentIterationSpanId = `iteration-${this.ctx.traceId}-${iterations}`;
      langfuse.startSpan(this.ctx.traceId, this.ctx.currentIterationSpanId, {
        name: `Iteration ${iterations}`,
        metadata: { iteration: iterations, turnId: this.ctx.currentTurnId },
      });

      this.ctx.onEvent({
        type: 'turn_start',
        data: { turnId: this.ctx.currentTurnId, iteration: iterations },
      });

      // Telemetry: record turn start (only first iteration has the real user prompt)
      this.ctx.telemetryAdapter?.onTurnStart(this.ctx.currentTurnId, iterations, iterations === 1 ? userMessage : '', iterations > 1 ? userTurnId : undefined);

      this.ctx.turnStartTime = Date.now();
      this.ctx.toolsUsedInTurn = [];
      // Note: readOnlyNudgeCount and todoNudgeCount are NOT reset here
      // They accumulate across turns to allow escalating nudges
      // Research mode: emit search round progress
      if (this.ctx._researchModeActive) {
        this.ctx._researchIterationCount++;
        this.runFinalizer.emitTaskProgress('thinking', `正在搜索 (第${this.ctx._researchIterationCount}轮)`);
      } else {
        this.runFinalizer.emitTaskProgress('thinking', '分析请求中...');
      }

      // Emit task stats at each iteration
      this.runFinalizer.emitTaskStats(iterations);

      // F1: Goal Re-Injection — 每 N 轮注入目标检查点
      const goalCheckpoint = this.ctx.goalTracker.getGoalCheckpoint(iterations);
      if (goalCheckpoint) {
        this.contextAssembly.injectSystemMessage(goalCheckpoint);
        logger.debug(`[AgentLoop] Goal checkpoint injected at iteration ${iterations}`);
      }

      // Plan Feedback Loop — inject current plan progress so the model is aware of plan state
      try {
        if (this.ctx.planningService) {
          const planContext = await this.contextAssembly.buildPlanContextMessage();
          if (planContext) {
            // Remove any existing plan context message to prevent unbounded accumulation.
            // There should be at most ONE plan context message at any time.
            this.ctx.messages = this.ctx.messages.filter(
              m => !(m.role === 'system' && typeof m.content === 'string' && m.content.includes('<current-plan>'))
            );
            this.contextAssembly.injectSystemMessage(planContext);
            logger.debug(`[AgentLoop] Plan context injected at iteration ${iterations}`);
          }
        }
      } catch (planContextError) {
        // Planning failures must never block the agent loop
        logger.debug(`[AgentLoop] Plan context injection skipped: ${planContextError instanceof Error ? planContextError.message : 'unknown error'}`);
      }

      // Contextual Memory Retrieval — on first iteration, search stored memories
      // using the user's message and inject top-3 relevant results as context
      if (iterations === 1) {
        try {
          const memoryService = getMemoryService();
          const memoryResults: Array<{ source: string; content: string; score: number }> = [];

          // Search knowledge base
          const knowledgeHits = memoryService.searchKnowledge(userMessage, undefined, 3);
          for (const hit of knowledgeHits) {
            memoryResults.push({
              source: (hit.document.metadata?.category as string) || hit.document.metadata?.source || 'knowledge',
              content: hit.document.content,
              score: hit.score,
            });
          }

          // Search conversations for additional context
          const convHits = memoryService.searchRelevantConversations(userMessage, 3);
          for (const hit of convHits) {
            memoryResults.push({
              source: 'conversation',
              content: hit.document.content,
              score: hit.score,
            });
          }

          // Sort by score, take top 3
          memoryResults.sort((a, b) => b.score - a.score);
          const top3 = memoryResults.slice(0, 3).filter(r => r.score > 0.3);

          if (top3.length > 0) {
            const lines = top3.map(r => {
              const preview = sanitizeMemoryContent(r.content);
              return `- [${r.source}]: ${preview} (relevance: ${Math.round(r.score * 100)}%)`;
            });
            this.contextAssembly.injectSystemMessage(
              `<contextual-memory>\n## Related Memories\n${lines.join('\n')}\n</contextual-memory>`
            );
            logger.debug(`[AgentLoop] Contextual memory: injected ${top3.length} relevant memories`);
          }
        } catch (memoryError) {
          // Memory search failure should never block the agent
          logger.debug(`[AgentLoop] Contextual memory retrieval skipped: ${memoryError instanceof Error ? memoryError.message : 'unknown error'}`);
        }
      }

      // 1. Call model
      logger.debug('[AgentLoop] Calling inference...');
      const inferenceStartTime = Date.now();
      let response = await this.contextAssembly.inference();
      const inferenceDuration = Date.now() - inferenceStartTime;
      logger.debug('[AgentLoop] Inference response type:', response.type);

      // h2A 实时转向：如果在 inference 期间收到了 steer()，跳过当前结果，重新推理
      if (this.ctx.needsReinference) {
        this.ctx.needsReinference = false;
        logger.info('[AgentLoop] Steer detected after inference — re-inferring with new user message');
        this.ctx.onEvent({
          type: 'interrupt_acknowledged',
          data: { message: '已收到新指令，正在调整方向...' },
        });
        continue;
      }

      // Emit model_response BEFORE tool execution (logical order: think → act)
      this.ctx.onEvent({
        type: 'model_response',
        data: {
          model: this.ctx.modelConfig.model,
          provider: this.ctx.modelConfig.provider,
          responseType: response.type,
          duration: inferenceDuration,
          toolCalls: response.toolCalls?.map(tc => tc.name) || [],
          textLength: (response.content || '').length,
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
        },
      });

      // Accumulate token usage for task stats
      this.ctx.totalTokensUsed += (response.usage?.inputTokens || 0) + (response.usage?.outputTokens || 0);

      langfuse.logEvent(this.ctx.traceId, 'inference_complete', {
        iteration: iterations,
        responseType: response.type,
        duration: inferenceDuration,
      });

      // Telemetry: record model call (with truncated prompt/completion for eval replay)
      if (this.ctx.telemetryAdapter) {
        const MAX_PROMPT_LENGTH = 8000;
        const MAX_COMPLETION_LENGTH = 4000;

        // 提取最近 3 条消息作为 prompt 摘要
        const recentMessages = this.ctx.messages.slice(-3);
        const promptSummary = recentMessages.map(m =>
          `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
        ).join('\n---\n');

        // 提取 completion（response.content 或 tool_calls 摘要）
        let completionText = '';
        if (response.content) {
          completionText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
        }
        if (response.toolCalls?.length) {
          const toolsSummary = response.toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.arguments).substring(0, 200)})`).join('; ');
          completionText += (completionText ? '\n' : '') + `[tools: ${toolsSummary}]`;
        }

        // API 返回的 usage 优先，为 0 时使用本地估算值（某些 SSE 代理不返回 usage）
        const apiInputTokens = response.usage?.inputTokens ?? 0;
        const apiOutputTokens = response.usage?.outputTokens ?? 0;
        let effectiveInputTokens = apiInputTokens;
        let effectiveOutputTokens = apiOutputTokens;
        if (apiInputTokens === 0 || apiOutputTokens === 0) {
          const estInput = estimateModelMessageTokens(
            this.ctx.messages.slice(-10).map(m => ({ role: m.role, content: m.content }))
          );
          const outContent = (response.content || '') +
            (response.toolCalls?.map(tc => JSON.stringify(tc.arguments || {})).join('') || '');
          const estOutput = estimateModelMessageTokens([{ role: 'assistant', content: outContent }]);
          if (apiInputTokens === 0) effectiveInputTokens = estInput;
          if (apiOutputTokens === 0) effectiveOutputTokens = estOutput;
        }

        this.ctx.telemetryAdapter.onModelCall(this.ctx.currentTurnId, {
          id: `mc-${this.ctx.currentTurnId}-${iterations}`,
          timestamp: Date.now(),
          provider: this.ctx.modelConfig.provider,
          model: this.ctx.modelConfig.model,
          temperature: this.ctx.modelConfig.temperature,
          maxTokens: this.ctx.modelConfig.maxTokens,
          inputTokens: effectiveInputTokens,
          outputTokens: effectiveOutputTokens,
          latencyMs: inferenceDuration,
          responseType: response.type as 'text' | 'tool_use' | 'thinking',
          toolCallCount: response.toolCalls?.length ?? 0,
          truncated: !!response.truncated,
          prompt: promptSummary.substring(0, MAX_PROMPT_LENGTH),
          completion: completionText.substring(0, MAX_COMPLETION_LENGTH),
        });
      }

      // 2. Handle text response - check for text-described tool calls (extracted)
      const forceExecResult = this.detectAndForceExecuteTextToolCall(response);
      if (forceExecResult.shouldContinue) continue;
      response = forceExecResult.response;
      const wasForceExecuted = forceExecResult.wasForceExecuted;
      // 2b. Handle actual text response (extracted)
      if (response.type === 'text' && response.content) {
        const textAction = await this.handleTextResponse(response, isSimpleTask, iterations, shouldRunHooks, langfuse);
        if (textAction === 'break') break;
        if (textAction === 'continue') continue;
      }

      // 3. Handle tool calls (extracted)
      if (response.type === 'tool_use' && response.toolCalls) {
        const toolAction = await this.handleToolResponse(response, wasForceExecuted, iterations, langfuse);
        if (toolAction === 'continue') continue;
      }

      break;
    }

    await this.runFinalizer.finalizeRun(iterations, userMessage, langfuse, genNum);
  }


  /**
   * Detect text-described tool calls and force-execute them.
   * Returns the (possibly modified) response and flags.
   */

  detectAndForceExecuteTextToolCall(response: ModelResponse): {
    response: ModelResponse;
    wasForceExecuted: boolean;
    shouldContinue: boolean;
  } {
      let wasForceExecuted = false;
      if (response.type === 'text' && response.content) {
        const failedToolCallMatch = this.ctx.antiPatternDetector.detectFailedToolCallPattern(response.content);
        if (failedToolCallMatch) {
          const forceExecuteResult = this.ctx.antiPatternDetector.tryForceExecuteTextToolCall(failedToolCallMatch, response.content);
          if (forceExecuteResult) {
            logger.info(`[AgentLoop] Force executing text-described tool call: ${failedToolCallMatch.toolName}`);
            logCollector.agent('INFO', `Force executing text tool call: ${failedToolCallMatch.toolName}`);
            response = {
              type: 'tool_use',
              toolCalls: [forceExecuteResult],
            };
            wasForceExecuted = true;
          } else if (this.ctx.toolCallRetryCount < this.ctx.maxToolCallRetries) {
            this.ctx.toolCallRetryCount++;
            logger.warn(`[AgentLoop] Detected text description of tool call: "${failedToolCallMatch.toolName}"`);
            logCollector.agent('WARN', `Model described tool call as text: ${failedToolCallMatch.toolName}`);
            this.contextAssembly.injectSystemMessage(
              this.ctx.antiPatternDetector.generateToolCallFormatError(failedToolCallMatch.toolName, response.content)
            );
            logger.debug(`[AgentLoop] Tool call retry ${this.ctx.toolCallRetryCount}/${this.ctx.maxToolCallRetries}`);
            return { response, wasForceExecuted, shouldContinue: true };
          }
        }
      }
      return { response, wasForceExecuted, shouldContinue: false };
  }

  /**
   * Handle text response: hooks, nudge checks, truncation recovery, output validation.
   * Returns 'break' to exit loop, 'continue' to retry, or null to fall through.
   */

  async handleTextResponse(
    response: ModelResponse,
    isSimpleTask: boolean,
    iterations: number,
    shouldRunHooks: boolean,
    langfuse: ReturnType<typeof getLangfuseService>,
  ): Promise<'break' | 'continue'> {
        // Research mode: indicate report generation phase
        if (this.ctx._researchModeActive) {
          this.runFinalizer.emitTaskProgress('generating', '正在生成报告...');
        } else {
          this.runFinalizer.emitTaskProgress('generating', '生成回复中...');
        }

        // User-configurable Stop hook
        if (this.ctx.hookManager && !isSimpleTask) {
          try {
            const userStopResult = await this.ctx.hookManager.triggerStop(response.content, this.ctx.sessionId);
            if (!userStopResult.shouldProceed) {
              logger.info('[AgentLoop] Stop prevented by user hook', { message: userStopResult.message });
              if (userStopResult.message) {
                this.contextAssembly.injectSystemMessage(`<stop-hook>\n${userStopResult.message}\n</stop-hook>`);
              }
              return 'continue';
            }
            if (userStopResult.message) {
              this.contextAssembly.injectSystemMessage(`<stop-hook>\n${userStopResult.message}\n</stop-hook>`);
            }
          } catch (error) {
            logger.error('[AgentLoop] User stop hook error:', error);
          }
        }

        // Planning stop hook
        if (shouldRunHooks) {
          const stopResult = await this.ctx.planningService!.hooks.onStop();

          if (!stopResult.shouldContinue && stopResult.injectContext) {
            this.ctx.stopHookRetryCount++;

            if (this.ctx.stopHookRetryCount <= this.ctx.maxStopHookRetries) {
              this.contextAssembly.injectSystemMessage(stopResult.injectContext);
              if (stopResult.notification) {
                this.ctx.onEvent({
                  type: 'notification',
                  data: { message: stopResult.notification },
                });
              }
              logger.debug(` Stop hook retry ${this.ctx.stopHookRetryCount}/${this.ctx.maxStopHookRetries}`);
              return 'continue';
            } else {
              logger.debug('[AgentLoop] Stop hook max retries reached, allowing stop');
              logCollector.agent('WARN', `Stop hook max retries (${this.ctx.maxStopHookRetries}) reached`);
              this.ctx.onEvent({
                type: 'notification',
                data: { message: 'Plan may be incomplete - max verification retries reached' },
              });
            }
          }

          if (stopResult.notification && stopResult.shouldContinue) {
            this.ctx.onEvent({
              type: 'notification',
              data: { message: stopResult.notification },
            });
          }
        }

        // P1-P5 Nudge checks (delegated to NudgeManager)
        const nudgeTriggered = this.ctx.nudgeManager.runNudgeChecks({
          toolsUsedInTurn: this.ctx.toolsUsedInTurn,
          isSimpleTaskMode: this.ctx.isSimpleTaskMode,
          sessionId: this.ctx.sessionId,
          iterations,
          workingDirectory: this.ctx.workingDirectory,
          injectSystemMessage: (msg: string) => this.contextAssembly.injectSystemMessage(msg),
          onEvent: (event: { type: string; data: unknown }) => this.ctx.onEvent(event as any),
          goalTracker: this.ctx.goalTracker,
        });
        if (nudgeTriggered) {
          return 'continue';
        }
        // P7 + P0 Output validation (delegated to NudgeManager)
        const validationTriggered = this.ctx.nudgeManager.runOutputValidation(
          (msg: string) => this.contextAssembly.injectSystemMessage(msg),
        );
        if (validationTriggered) {
          return 'continue';
        }
        // 动态 maxTokens: 文本响应截断自动恢复
        if (response.truncated && !this.ctx._truncationRetried) {
          this.ctx._truncationRetried = true;
          const originalMaxTokens = this.ctx.modelConfig.maxTokens || MODEL_MAX_TOKENS.DEFAULT;
          const newMaxTokens = Math.min(originalMaxTokens * 2, MODEL_MAX_TOKENS.EXTENDED);
          if (newMaxTokens > originalMaxTokens) {
            logger.info(`[AgentLoop] Text response truncated, retrying with maxTokens: ${originalMaxTokens} → ${newMaxTokens}`);
            logCollector.agent('INFO', `Text truncation recovery: maxTokens ${originalMaxTokens} → ${newMaxTokens}`);
            this.ctx.modelConfig.maxTokens = newMaxTokens;
            try {
              response = await this.contextAssembly.inference();
            } finally {
              this.ctx._truncationRetried = false;
              this.ctx.modelConfig.maxTokens = originalMaxTokens;
            }
            // 重试后如果变成了 tool_use，跳到下一轮处理
            if (response.type === 'tool_use') return 'continue';
          } else {
            this.ctx._truncationRetried = false;
          }
        }

        // 连续截断断路器: 检测模型陷入重复循环（连续 N 次 finishReason=length）
        if (response.truncated || response.finishReason === 'length') {
          this.ctx._consecutiveTruncations++;
          if (this.ctx._consecutiveTruncations >= this.ctx.MAX_CONSECUTIVE_TRUNCATIONS) {
            logger.warn(`[AgentLoop] Consecutive truncation circuit breaker: ${this.ctx._consecutiveTruncations} consecutive truncations`);
            logCollector.agent('WARN', `Consecutive truncation breaker triggered (${this.ctx._consecutiveTruncations}x)`);
            this.ctx._consecutiveTruncations = 0;
            this.contextAssembly.injectSystemMessage(
              `<truncation-recovery>\n` +
              `你已连续 ${this.ctx.MAX_CONSECUTIVE_TRUNCATIONS} 次输出被截断，可能陷入了重复循环。请立即：\n` +
              `1. 停止当前冗长的文字输出\n` +
              `2. 用 1-2 句话总结当前进展\n` +
              `3. 直接调用工具执行下一步操作\n` +
              `</truncation-recovery>`
            );
            return 'continue';
          }
        } else {
          this.ctx._consecutiveTruncations = 0; // 非截断响应，重置计数
        }

        const assistantMessage: Message = {
          id: this.contextAssembly.generateId(),
          role: 'assistant',
          content: this.contextAssembly.stripInternalFormatMimicry(response.content || ''),
          timestamp: Date.now(),
          thinking: response.thinking,
          effortLevel: this.ctx.effortLevel,
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
        };
        await this.contextAssembly.addAndPersistMessage(assistantMessage);

        // Adaptive Thinking: 流式阶段已通过 stream_reasoning 逐 chunk 发送，此处不再重发
        // （重发会导致前端 append 两遍完整 reasoning 文本）

        this.ctx.onEvent({ type: 'message', data: assistantMessage });

        // === 自动解析任务列表（替代 TodoWrite 工具） ===
        this.runFinalizer.tryParseTodosFromResponse(response);

        langfuse.endSpan(this.ctx.currentIterationSpanId, { type: 'text_response' });

        this.runFinalizer.emitTaskProgress('completed', '回复完成');
        this.runFinalizer.emitTaskComplete();

        // Telemetry: record turn end (text response)
        this.ctx.telemetryAdapter?.onTurnEnd(this.ctx.currentTurnId, response.content || '', response.thinking, this.ctx.currentSystemPromptHash);

        this.ctx.onEvent({
          type: 'turn_end',
          data: { turnId: this.ctx.currentTurnId },
        });

        this.contextAssembly.updateContextHealth();

        // PostExecution hook: trigger async health checks (GC, codebase scans)
        if (this.ctx.hookManager) {
          this.ctx.hookManager.triggerPostExecution?.(
            this.ctx.sessionId,
            iterations,
            this.ctx.toolsUsedInTurn,
            Array.from(this.ctx.nudgeManager.getModifiedFiles()),
          ).catch((err: unknown) => {
            logger.error('[AgentLoop] PostExecution hook error:', err);
          });
        }



        return 'break';
  }

  /**
   * Handle tool_use response: truncation detection, heredoc protection, execution, result compression.
   * Returns 'continue' to loop back for next iteration.
   */

  async handleToolResponse(
    response: ModelResponse,
    wasForceExecuted: boolean,
    iterations: number,
    langfuse: ReturnType<typeof getLangfuseService>,
  ): Promise<'continue'> {
        const toolCalls = response.toolCalls!;
        logger.debug(` Tool calls received: ${toolCalls.length} calls`);

        this.ctx.totalToolCallCount += toolCalls.length;
        this.runFinalizer.emitTaskProgress('tool_pending', `准备执行 ${toolCalls.length} 个工具`, {
          toolTotal: toolCalls.length,
        });

        // Handle truncation warning + 动态 maxTokens 提升
        if (response.truncated) {
          logger.warn('[AgentLoop] ⚠️ Tool call was truncated due to max_tokens limit!');
          logCollector.agent('WARN', 'Tool call truncated - content may be incomplete');

          // 提高 maxTokens 防止后续截断
          const currentMax = this.ctx.modelConfig.maxTokens || MODEL_MAX_TOKENS.DEFAULT;
          const boostedMax = Math.min(currentMax * 2, MODEL_MAX_TOKENS.EXTENDED);
          if (boostedMax > currentMax) {
            this.ctx.modelConfig.maxTokens = boostedMax;
            logger.info(`[AgentLoop] Tool truncation: boosted maxTokens ${currentMax} → ${boostedMax}`);
          }

          const writeFileCall = toolCalls.find(tc => tc.name === 'write_file' || tc.name === 'Write');
          if (writeFileCall) {
            const content = writeFileCall.arguments?.content as string;
            if (content) {
              logger.warn(`write_file content length: ${content.length} chars - may be truncated!`);
              this.contextAssembly.injectSystemMessage(this.generateTruncationWarning());
            }
          } else {
            // 检测截断的 bash heredoc —— 执行不完整的 heredoc 会导致 SyntaxError
            const truncatedBashHeredocs = toolCalls.filter(tc =>
              (tc.name === 'bash' || tc.name === 'Bash') &&
              typeof tc.arguments?.command === 'string' &&
              /<<\s*['"]?\w+['"]?/.test(tc.arguments.command as string)
            );

            if (truncatedBashHeredocs.length > 0) {
              logger.warn(`[AgentLoop] Skipping ${truncatedBashHeredocs.length} truncated bash heredoc(s) to avoid SyntaxError`);

              // 保存 assistant 消息（含截断的 tool calls）
              const truncAssistantMsg: Message = {
                id: this.contextAssembly.generateId(),
                role: 'assistant',
                content: response.content || '',
                timestamp: Date.now(),
                toolCalls: toolCalls,
                thinking: response.thinking,
                effortLevel: this.ctx.effortLevel,
                inputTokens: response.usage?.inputTokens,
                outputTokens: response.usage?.outputTokens,
              };
              await this.contextAssembly.addAndPersistMessage(truncAssistantMsg);
              this.ctx.onEvent({ type: 'message', data: truncAssistantMsg });

              // 构造合成错误结果，不实际执行
              const syntheticResults: ToolResult[] = toolCalls.map(tc => ({
                toolCallId: tc.id,
                success: false,
                output: '',
                error: (tc.name === 'bash' || tc.name === 'Bash') && /<<\s*['"]?\w+['"]?/.test((tc.arguments?.command as string) || '')
                  ? '⚠️ 此 bash heredoc 命令因 max_tokens 截断而不完整，已跳过执行以避免 SyntaxError。请重新生成完整命令。'
                  : '⚠️ 此工具调用因同批次存在截断的 heredoc 而被跳过。',
                duration: 0,
              }));

              const toolMsg: Message = {
                id: this.contextAssembly.generateId(),
                role: 'tool',
                content: JSON.stringify(syntheticResults),
                timestamp: Date.now(),
                toolResults: syntheticResults,
              };
              await this.contextAssembly.addAndPersistMessage(toolMsg);

              // 注入恢复提示
              this.contextAssembly.injectSystemMessage(
                `<truncation-recovery>\n` +
                `上一次的 bash 命令包含 heredoc（<<EOF...EOF），但因 max_tokens 限制被截断，命令不完整。\n` +
                `已跳过执行以避免 SyntaxError。请重新生成完整的命令。\n` +
                `提示：如果内联脚本很长，考虑先用 write_file 写入临时文件再用 bash 执行，而不是使用 heredoc。\n` +
                `</truncation-recovery>`
              );

              return 'continue'; // 跳到下一轮推理，让模型重新生成
            }

            // 非 heredoc 截断：注入续写提示让模型继续
            this.contextAssembly.injectSystemMessage(
              `<truncation-recovery>\n` +
              `上一次输出因 max_tokens 限制被截断。请继续完成未完成的操作。\n` +
              `</truncation-recovery>`
            );
          }
        }

        toolCalls.forEach((tc, i) => {
          logger.debug(`   Tool ${i + 1}: ${tc.name}, args keys: ${Object.keys(tc.arguments || {}).join(', ')}`);
          logCollector.tool('INFO', `Tool call: ${tc.name}`, { toolId: tc.id, phase: classifyExecutionPhase(tc.name), args: tc.arguments });
        });

        // 清理模型输出中模仿内部格式的文本（"Ran:", "Tool results:", "[Compressed tool results:]"）
        // 当 response 有 toolCalls 时，这些文本是模型模仿会话历史格式的副产物，不应显示
        const cleanedContent = this.contextAssembly.stripInternalFormatMimicry(response.content || '');

        const assistantMessage: Message = {
          id: this.contextAssembly.generateId(),
          role: 'assistant',
          content: cleanedContent,
          timestamp: Date.now(),
          toolCalls: toolCalls,
          // Adaptive Thinking: 保留模型的原生思考过程
          thinking: response.thinking,
          effortLevel: this.ctx.effortLevel,
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
        };
        await this.contextAssembly.addAndPersistMessage(assistantMessage);

        // Adaptive Thinking: 流式阶段已通过 stream_reasoning 逐 chunk 发送，此处不再重发
        // （重发会导致前端 append 两遍完整 reasoning 文本）

        logger.debug('[AgentLoop] Emitting message event for tool calls');
        this.ctx.onEvent({ type: 'message', data: assistantMessage });

        // Execute tools
        logger.debug('[AgentLoop] Starting executeToolsWithHooks...');
        const toolResults = await this.toolEngine.executeToolsWithHooks(toolCalls);
        logger.debug(` executeToolsWithHooks completed, ${toolResults.length} results`);

        // h2A 实时转向：工具执行期间收到 steer()，保存已有结果后跳到下一轮推理
        if (this.ctx.needsReinference) {
          this.ctx.needsReinference = false;
          logger.info('[AgentLoop] Steer detected during tool execution — saving results and re-inferring');
          // 保存已完成的 tool results（不浪费已执行的工作）
          if (toolResults.length > 0) {
            const partialResults = sanitizeToolResultsForHistory(toolResults);
            const partialToolMessage: Message = {
              id: this.contextAssembly.generateId(),
              role: 'tool',
              content: JSON.stringify(partialResults),
              timestamp: Date.now(),
              toolResults: partialResults,
            };
            await this.contextAssembly.addAndPersistMessage(partialToolMessage);
          }
          this.ctx.onEvent({
            type: 'interrupt_acknowledged',
            data: { message: '已收到新指令，正在调整方向...' },
          });
          return 'continue';
        }

        toolResults.forEach((r, i) => {
          const matchedToolCall = toolCalls.find(tc => tc.id === r.toolCallId);
          const phase = matchedToolCall ? classifyExecutionPhase(matchedToolCall.name) : undefined;
          logger.debug(`   Result ${i + 1}: success=${r.success}, phase=${phase || 'unknown'}, error=${r.error || 'none'}`);
          if (r.success) {
            logCollector.tool('INFO', `Tool result: success`, {
              toolCallId: r.toolCallId,
              phase,
              outputLength: r.output?.length || 0,
              duration: r.duration,
            });
          } else {
            logCollector.tool('ERROR', `Tool result: failed - ${r.error}`, { toolCallId: r.toolCallId, phase });
          }
        });

        const sanitizedResults = sanitizeToolResultsForHistory(toolResults);

        // Compress tool results to save tokens
        const compressedResults = sanitizedResults.map(result => {
          if (result.output && typeof result.output === 'string') {
            const { content, compressed, savedTokens } = compressToolResult(result.output);
            if (compressed) {
              logger.debug(`[AgentLoop] Tool result compressed, saved ${savedTokens} tokens`);
              return { ...result, output: content };
            }
          }
          return result;
        });

        const toolMessage: Message = {
          id: this.contextAssembly.generateId(),
          role: 'tool',
          content: JSON.stringify(compressedResults),
          timestamp: Date.now(),
          toolResults: compressedResults,
        };
        await this.contextAssembly.addAndPersistMessage(toolMessage);

        // === 工具执行后自动推进任务状态 ===
        this.runFinalizer.autoAdvanceTodos(toolCalls, toolResults);

        // 如果模型在 tool_use 轮次也有 thinking/content，尝试从中解析任务列表
        this.runFinalizer.tryParseTodosFromResponse(response);

        // Flush hook message buffer at end of iteration
        this.contextAssembly.flushHookMessageBuffer();

        langfuse.endSpan(this.ctx.currentIterationSpanId, {
          type: 'tool_calls',
          toolCount: toolCalls.length,
          successCount: toolResults.filter(r => r.success).length,
        });

        // Telemetry: record turn end (tool execution)
        this.ctx.telemetryAdapter?.onTurnEnd(this.ctx.currentTurnId, '', response.thinking, this.ctx.currentSystemPromptHash);

        this.ctx.onEvent({
          type: 'turn_end',
          data: { turnId: this.ctx.currentTurnId },
        });

        this.contextAssembly.updateContextHealth();

        // 检查并执行自动压缩（在每轮工具调用后）
        await this.contextAssembly.checkAndAutoCompress();

        // Adaptive Thinking: 在 tool call 之间插入思考步骤
        await this.contextAssembly.maybeInjectThinking(toolCalls, toolResults);

        // P2 Checkpoint: Evaluate task progress state (delegated to NudgeManager)
        this.ctx.nudgeManager.checkProgressState(
          this.ctx.toolsUsedInTurn,
          (msg: string) => this.contextAssembly.injectSystemMessage(msg),
        );

        // P5 after force-execute (delegated to NudgeManager)
        if (wasForceExecuted) {
          this.ctx.nudgeManager.checkPostForceExecute(
            this.ctx.workingDirectory,
            (msg: string) => this.contextAssembly.injectSystemMessage(msg),
          );
        }

        logger.debug(` >>>>>> Iteration ${iterations} END (continuing) <<<<<<`);
        return 'continue';
  }

  // ========================================================================
  // Extracted sub-methods from run() — pure method extraction, no logic changes
  // ========================================================================

  /**
   * Initialization logic extracted from run(): Langfuse trace, complexity analysis,
   * target files, goal tracker, hooks, session recovery, dynamic mode detection.
   */

  async initializeRun(userMessage: string): Promise<{
    langfuse: ReturnType<typeof getLangfuseService>;
    isSimpleTask: boolean;
    shouldRunHooks: boolean;
    genNum: number;
  } | null> {
    
    logger.debug('[AgentLoop] ========== run() START ==========');
    logger.debug('[AgentLoop] Message:', userMessage.substring(0, 100));

    logCollector.agent('INFO', `Agent run started: "${userMessage.substring(0, 80)}..."`);
    logCollector.agent('DEBUG', `Model: ${this.ctx.modelConfig.provider}`);

    // Langfuse: Start trace
    const langfuse = getLangfuseService();
    this.ctx.traceId = `trace-${this.ctx.sessionId}-${Date.now()}`;
    langfuse.startTrace(this.ctx.traceId, {
      sessionId: this.ctx.sessionId,
      userId: this.ctx.userId,
      generationId: 'gen8',
      modelProvider: this.ctx.modelConfig.provider,
      modelName: this.ctx.modelConfig.model,
    }, userMessage);

    await this.initializeUserHooks();

    // Task Complexity Analysis
    const complexityAnalysis = taskComplexityAnalyzer.analyze(userMessage);
    const isSimpleTask = complexityAnalysis.complexity === 'simple';
    this.ctx.isSimpleTaskMode = isSimpleTask;

    // P5: Extract expected output file paths from user prompt (existence diff)
    const allPaths = extractAbsoluteFilePaths(userMessage);
    const expectedOutputFiles = allPaths.filter((f: any) => !existsSync(f));

    // Reset all nudge state via NudgeManager
    this.ctx.nudgeManager.reset(
      complexityAnalysis.targetFiles || [],
      userMessage,
      this.ctx.workingDirectory,
      expectedOutputFiles,
    );

    this.ctx.externalDataCallCount = 0;
    this.ctx.runStartTime = Date.now();
    this.ctx.totalIterations = 0;
    this.ctx.totalTokensUsed = 0;
    this.ctx.totalToolCallCount = 0;
    this.ctx._consecutiveTruncations = 0;

    // P8: Task-specific prompt hardening — 对特定任务模式注入针对性提示
    const taskHints = this.contextAssembly._detectTaskPatterns(userMessage);
    if (taskHints.length > 0) {
      this.contextAssembly.injectSystemMessage(
        `<task-specific-hints>\n${taskHints.join('\n')}\n</task-specific-hints>`
      );
      logger.debug(`[AgentLoop] P8: Injected ${taskHints.length} task-specific hints`);
    }

    // F1: Goal Re-Injection — 从用户消息提取目标
    this.ctx.goalTracker.initialize(userMessage);

    logger.debug(` Task complexity: ${complexityAnalysis.complexity} (${Math.round(complexityAnalysis.confidence * 100)}%)`);
    if (this.ctx.nudgeManager.getTargetFiles().length > 0) {
      logger.debug(` Target files: ${this.ctx.nudgeManager.getTargetFiles().join(', ')}`);
    }
    logCollector.agent('INFO', `Task complexity: ${complexityAnalysis.complexity}`, {
      confidence: complexityAnalysis.confidence,
      reasons: complexityAnalysis.reasons,
      fastPath: isSimpleTask,
      targetFiles: this.ctx.nudgeManager.getTargetFiles(),
    });

    if (!isSimpleTask) {
      const complexityHint = taskComplexityAnalyzer.generateComplexityHint(complexityAnalysis);
      this.contextAssembly.injectSystemMessage(complexityHint);

      // Parallel Judgment via small model (Groq)
      try {
        const orchestrator = getTaskOrchestrator();
        const judgment = await orchestrator.judge(userMessage);

        if (judgment.shouldParallel && judgment.confidence >= 0.7) {
          const parallelHint = orchestrator.generateParallelHint(judgment);
          this.contextAssembly.injectSystemMessage(parallelHint);

          logger.info('[AgentLoop] Parallel execution suggested', {
            dimensions: judgment.parallelDimensions,
            criticalPath: judgment.criticalPathLength,
            speedup: judgment.estimatedSpeedup,
          });
          logCollector.agent('INFO', 'Parallel execution suggested', {
            dimensions: judgment.suggestedDimensions,
            confidence: judgment.confidence,
          });
        }
      } catch (error) {
        // 并行判断失败不影响主流程
        logger.warn('[AgentLoop] Parallel judgment failed, continuing without hint', error);
      }
    }

    // LLM-based intent classification (for research routing)
    // Only run if task wasn't already classified as complex by keywords
    if (complexityAnalysis.complexity === 'simple' || complexityAnalysis.complexity === 'moderate') {
      try {
        const intent = await classifyIntent(userMessage, this.ctx.modelRouter);
        logger.info('Intent classified', { intent, message: userMessage.substring(0, 50) });

        if (intent === 'research') {
          this.contextAssembly.injectResearchModePrompt(userMessage);
        }
      } catch (error) {
        logger.warn('Intent classification failed, continuing with normal mode', { error: String(error) });
      }
    }

    // Dynamic Agent Mode Detection V2 (基于优先级和预算的动态提醒)
    // 注意：这里移出了 !isSimpleTask 条件，因为即使简单任务也可能需要动态提醒（如 PPT 格式选择）
    const genNum = 8;
    
    logger.info(`[AgentLoop] Checking dynamic mode for gen${genNum}`);
    if (genNum >= 3) {
      try {
        // 使用 V2 版本，支持 toolsUsedInTurn 上下文
        // 预算增加到 1200 tokens 以支持 PPT 等大型提醒 (700+ tokens)
        const dynamicResult = buildDynamicPromptV2(userMessage, {
          toolsUsedInTurn: this.ctx.toolsUsedInTurn,
          iterationCount: this.ctx.toolsUsedInTurn.length, // 使用工具调用数量作为迭代近似
          hasError: false,
          maxReminderTokens: 1200,
          includeFewShot: genNum >= 4, // Gen4+ 启用 few-shot 示例
        });
        this.ctx.currentAgentMode = dynamicResult.mode;

        logger.info(`[AgentLoop] Dynamic mode detected: ${dynamicResult.mode}`, {
          features: dynamicResult.features,
          readOnly: dynamicResult.modeConfig.readOnly,
          remindersSelected: dynamicResult.reminderStats.deduplication.selected,
          tokensUsed: dynamicResult.tokensUsed,
        });
        logCollector.agent('INFO', `Dynamic mode: ${dynamicResult.mode}`, {
          readOnly: dynamicResult.modeConfig.readOnly,
          isMultiDimension: dynamicResult.features.isMultiDimension,
          reminderStats: dynamicResult.reminderStats,
        });

        // 注入模式系统提醒（如果有）
        if (dynamicResult.userMessage !== userMessage) {
          const reminder = dynamicResult.userMessage.substring(userMessage.length).trim();
          if (reminder) {
            logger.info(`[AgentLoop] Injecting mode reminder (${reminder.length} chars, ${dynamicResult.tokensUsed} tokens)`);
            this.contextAssembly.injectSystemMessage(reminder);
          }
        }
      } catch (error) {
        logger.error('[AgentLoop] Dynamic mode detection failed:', error);
      }
    }

    // Step-by-step execution for models that need it (DeepSeek, etc.)
    if (this.ctx.stepByStepMode && !isSimpleTask) {
      const { steps, isMultiStep } = this.parseMultiStepTask(userMessage);
      if (isMultiStep) {
        logger.info(`[AgentLoop] Multi-step task detected (${steps.length} steps), using step-by-step mode`);
        await this.runStepByStep(userMessage, steps);
        return null; // Step-by-step mode handles the entire execution
      }
    }

    // User-configurable hooks: UserPromptSubmit
    if (this.ctx.hookManager) {
      const promptResult = await this.ctx.hookManager.triggerUserPromptSubmit(userMessage, this.ctx.sessionId);
      if (!promptResult.shouldProceed) {
        logger.info('[AgentLoop] User prompt blocked by hook', { message: promptResult.message });
        this.ctx.onEvent({
          type: 'notification',
          data: { message: promptResult.message || 'Prompt blocked by hook' },
        });
        return null;
      }
      if (promptResult.message) {
        this.contextAssembly.injectSystemMessage(`<user-prompt-hook>\n${promptResult.message}\n</user-prompt-hook>`);
      }
    }

    // Session start hooks
    const shouldRunHooks = !!(this.ctx.enableHooks && this.ctx.planningService && !isSimpleTask);
    if (shouldRunHooks) {
      await this.toolEngine.runSessionStartHook();
    }

    if (this.ctx.hookManager && !isSimpleTask) {
      const sessionResult = await this.ctx.hookManager.triggerSessionStart(this.ctx.sessionId);
      if (sessionResult.message) {
        this.contextAssembly.injectSystemMessage(`<session-start-hook>\n${sessionResult.message}\n</session-start-hook>`);
      }
    }

    // F5: 跨会话任务恢复 — 查询同目录的上一个会话，注入恢复摘要
    if (!isSimpleTask) {
      try {
        const recovery = await getSessionRecoveryService().checkPreviousSession(
          this.ctx.sessionId,
          this.ctx.workingDirectory
        );
        if (recovery) {
          this.contextAssembly.injectSystemMessage(recovery);
          logger.info('[AgentLoop] Session recovery summary injected');
        }
      } catch {
        // Graceful: recovery failure doesn't block execution
      }
    }

    // Seed Memory Injection — load recent memories into context at session start
    try {
      const seedMemoryBlock = buildSeedMemoryBlock(this.ctx.workingDirectory);
      if (seedMemoryBlock) {
        this.contextAssembly.injectSystemMessage(`<seed-memory>\n${seedMemoryBlock}\n</seed-memory>`);
        logger.info('[AgentLoop] Seed memory injected at session start');
      }
    } catch {
      // Memory failures must never block the agent loop
      logger.warn('[AgentLoop] Seed memory injection failed, continuing without');
    }

    return { langfuse, isSimpleTask, shouldRunHooks, genNum };
  }



  /**
   * Post-loop cleanup: mechanism stats, session end learning, evolution trace.
   */

  cancel(): void {
    this.ctx.isCancelled = true;
    this.ctx.abortController?.abort();
  }

  /**
   * 中断当前执行并设置新的用户消息（旧版，保留向后兼容）
   * 会停止当前 Loop，由 Orchestrator 创建新 Loop
   */

  interrupt(newMessage: string): void {
    this.ctx.isInterrupted = true;
    this.ctx.interruptMessage = newMessage;
    this.ctx.abortController?.abort();
    logger.info('[AgentLoop] Interrupt requested with new message');
  }

  /**
   * 实时转向：将用户新消息注入当前 Loop，不销毁 Loop
   * Claude Code h2A 风格 — 保留所有中间状态，模型在下一次推理时自然看到新消息
   */

  steer(newMessage: string): void {
    // 1. 中止当前正在进行的 API 调用
    this.ctx.abortController?.abort();

    // 2. 将用户消息注入消息历史（直接作为 user message，模型自然理解上下文切换）
    const steerMessage: Message = {
      id: generateMessageId(),
      role: 'user',
      content: newMessage,
      timestamp: Date.now(),
    };
    this.ctx.messages.push(steerMessage);

    // 3. 持久化到数据库（异步，不阻塞转向）
    if (process.env.CODE_AGENT_CLI_MODE !== 'true') {
      const sessionManager = getSessionManager();
      sessionManager.addMessage(steerMessage).catch((err) => {
        logger.error('[AgentLoop] Failed to persist steer message:', err);
      });
    }

    // 4. 设置标志让主循环跳过当前结果，重新推理
    this.ctx.needsReinference = true;

    logger.info('[AgentLoop] Steer requested — message injected, will re-infer on next cycle');
  }

  /**
   * 检查是否被中断
   */

  wasInterrupted(): boolean {
    return this.ctx.isInterrupted;
  }

  /**
   * 获取中断时的新消息
   */

  getInterruptMessage(): string | null {
    return this.ctx.interruptMessage;
  }

  /**
   * 检查是否正在运行（用于外部检查状态）
   */

  isRunning(): boolean {
    return !this.ctx.isCancelled && !this.ctx.isInterrupted;
  }

  getPlanningService(): PlanningService | undefined {
    return this.ctx.planningService;
  }

  // --------------------------------------------------------------------------
  // 自动任务列表解析（替代 TodoWrite 工具）
  // --------------------------------------------------------------------------

  /**
   * 从模型的 thinking/text content 中提取任务列表，推送到前端
   */

  setEffortLevel(level: import('../../../shared/types/agent').EffortLevel): void {
    this.ctx.effortLevel = level;
    this.ctx.thinkingStepCount = 0;
    logger.debug(`[AgentLoop] Effort level set to: ${level}`);
  }

  getEffortLevel(): import('../../../shared/types/agent').EffortLevel {
    return this.ctx.effortLevel;
  }

  generateTruncationWarning(): string {
    return (
      `<truncation-detected>\n` +
      `⚠️ CRITICAL: Your previous tool call was TRUNCATED due to output length limits!\n` +
      `The file content is INCOMPLETE and will not work correctly.\n\n` +
      `You MUST use a MULTI-STEP approach for large files:\n` +
      `1. First, create a SKELETON file with just the structure (HTML head, empty body, empty script tag)\n` +
      `2. Then use edit_file to ADD sections one at a time:\n` +
      `   - Step 1: Add CSS styles\n` +
      `   - Step 2: Add HTML body content\n` +
      `   - Step 3: Add JavaScript variables and constants\n` +
      `   - Step 4: Add JavaScript functions (one or two at a time)\n` +
      `   - Step 5: Add event listeners and initialization\n\n` +
      `DO NOT try to write the entire file in one write_file call!\n` +
      `</truncation-detected>`
    );
  }

  generateAutoContinuationPrompt(): string {
    return (
      `<auto-continuation-required>\n` +
      `CRITICAL: The file you just wrote appears to be INCOMPLETE (truncated).\n` +
      `The write_file tool detected missing closing brackets/tags.\n\n` +
      `You MUST immediately:\n` +
      `1. Use edit_file to APPEND the remaining code to complete the file\n` +
      `2. Start from where the code was cut off\n` +
      `3. Ensure all functions, classes, and HTML tags are properly closed\n\n` +
      `DO NOT start over or rewrite the entire file - just APPEND the missing parts!\n` +
      `</auto-continuation-required>`
    );
  }

  // ===========================================================================
  // E7: Content Quality Gate — 内容质量门禁
  // ===========================================================================

  /**
   * 判断是否应触发内容质量验证
   * 仅在内容生成完成信号时触发（write_file/bash 成功执行，输出为内容类型文件）
   */
}
