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
import { generateFormatCorrectionPrompt } from '../../agent/structuredOutput';
import type { ToolRegistryLike } from '../../tools/types';
import type { ToolExecutor } from '../../tools/toolExecutor';
import { ModelRouter, ContextLengthExceededError } from '../../model/modelRouter';
import type { PlanningService } from '../../planning';
import { publishPlanningStateToRenderer } from '../../planning';
import { buildRecoveredWorkOrchestrationHint, isContinuationLikeRequest, recoverRecentWorkIntoPlanning } from '../../planning/recoveredWorkOrchestrator';
import { syncDesktopTasksToPlanningService } from '../../desktop/desktopActivityPlanningBridge';
import { getDesktopActivityUnderstandingService } from '../../desktop/desktopActivityUnderstandingService';
import { buildWorkspaceActivityContextBlock } from '../../desktop/workspaceActivitySearchService';
import { buildSeedMemoryBlock } from '../../utils/seedMemoryInjector';
import { recordSessionStart } from '../../lightMemory/sessionMetadata';
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
import { decideNextAction, type LoopState } from '../loopDecision';
import { getInputSanitizer } from '../../security/inputSanitizer';
import { getDiffTracker } from '../../services/diff/diffTracker';
import { getCitationService } from '../../services/citation/citationService';
import { createHash } from 'crypto';
import type { RuntimeContext } from './runtimeContext';
import type { ToolExecutionEngine } from './toolExecutionEngine';
import type { ContextAssembly } from './contextAssembly';
import type { RunFinalizer } from './runFinalizer';
import type { LearningPipeline } from './learningPipeline';
import { MessageProcessor } from './messageProcessor';
import { StreamHandler } from './streamHandler';


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

export class ConversationRuntime {
  toolEngine!: ToolExecutionEngine;
  contextAssembly!: ContextAssembly;
  runFinalizer!: RunFinalizer;
  learningPipeline!: LearningPipeline;
  private messageProcessor!: MessageProcessor;
  private streamHandler!: StreamHandler;

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
    this.messageProcessor = new MessageProcessor(this.ctx, contextAssembly, runFinalizer, toolEngine);
    this.streamHandler = new StreamHandler(this.ctx, contextAssembly, runFinalizer);
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
      });
    }

    if (this.ctx.hookManager) {
      await this.ctx.hookManager.initialize();
      this.ctx.userHooksInitialized = true;
    }
  }

  private async bootstrapDesktopDerivedContext(userMessage?: string): Promise<void> {
    try {
      const desktopActivity = getDesktopActivityUnderstandingService();
      await desktopActivity.ensureFreshData(2 * 60 * 1000);

      const existingTodos = getSessionTodos(this.ctx.sessionId);
      const persistedTodos = await getSessionManager().getTodos(this.ctx.sessionId);
      const desktopTodos = desktopActivity.listTodoItems({
        limit: 3,
        sinceHours: 6,
      });

      let mergedTodos = desktopTodos;
      if (persistedTodos.length > 0) {
        mergedTodos = mergedTodos.length > 0
          ? mergeTodos(mergedTodos, persistedTodos)
          : persistedTodos;
      }
      if (existingTodos.length > 0) {
        mergedTodos = mergedTodos.length > 0
          ? mergeTodos(mergedTodos, existingTodos)
          : existingTodos;
      }

      if (mergedTodos.length > 0) {
        const { todos: advancedTodos } = advanceTodoStatus(mergedTodos);
        const changed = JSON.stringify(existingTodos) !== JSON.stringify(advancedTodos);
        if (changed) {
          setSessionTodos(this.ctx.sessionId, advancedTodos);
          this.ctx.onEvent({ type: 'todo_update', data: advancedTodos });
          logger.info('[AgentLoop] Desktop-derived todos merged into session todos', {
            count: advancedTodos.length,
          });
        }
      }

      const taskSync = desktopActivity.syncTodoCandidatesToTasks(this.ctx.sessionId, {
        limit: 3,
        sinceHours: 6,
      });
      if (taskSync.created.length > 0 || taskSync.updated.length > 0) {
        this.ctx.onEvent({
          type: 'task_update',
          data: {
            tasks: taskSync.tasks,
            action: 'sync',
            taskIds: [
              ...taskSync.created.map((task) => task.id),
              ...taskSync.updated.map((task) => task.id),
            ],
            source: 'desktop_activity',
          },
        });
        logger.info('[AgentLoop] Desktop-derived tasks synced into task store', {
          created: taskSync.created.length,
          updated: taskSync.updated.length,
          total: taskSync.tasks.length,
        });
      }

      if (this.ctx.planningService) {
        const planningSync = await syncDesktopTasksToPlanningService(
          this.ctx.planningService,
          taskSync.tasks,
        );
        if (
          planningSync.createdPlan
          || planningSync.createdPhase
          || planningSync.addedSteps.length > 0
          || planningSync.updatedSteps.length > 0
        ) {
          await publishPlanningStateToRenderer(this.ctx.planningService);
          logger.info('[AgentLoop] Desktop-derived tasks synced into planning service', {
            createdPlan: planningSync.createdPlan,
            createdPhase: planningSync.createdPhase,
            addedSteps: planningSync.addedSteps.length,
            updatedSteps: planningSync.updatedSteps.length,
          });
        }
      }

      const desktopContextBlock = desktopActivity.buildContextBlock({
        summaryLimit: 3,
        todoLimit: 3,
        sinceHours: 6,
      });
      if (desktopContextBlock) {
        this.contextAssembly.injectSystemMessage(
          `<desktop-activity-context>\n${desktopContextBlock}\n</desktop-activity-context>`
        );
        logger.info('[AgentLoop] Desktop activity context injected');
      }

      const existingSystemContextTokens =
        estimateTokens(this.ctx.systemPrompt)
        + estimateTokens(this.ctx.persistentSystemContext.join('\n\n'))
        + this.ctx.messages
          .filter((message) => message.role === 'system')
          .reduce((sum, message) => sum + estimateTokens(message.content || ''), 0);
      const contextWindowSize = CONTEXT_WINDOWS[this.ctx.modelConfig.model] || DEFAULT_CONTEXT_WINDOW;
      const contextPressure = existingSystemContextTokens / contextWindowSize;
      const workspaceContextMaxTokens =
        contextPressure >= 0.12 ? 120
          : contextPressure >= 0.08 ? 160
            : 220;
      const workspaceContextMaxItems =
        contextPressure >= 0.12 ? 1
          : contextPressure >= 0.08 ? 2
            : 3;

      const workspaceContextBlock = userMessage
        ? await buildWorkspaceActivityContextBlock(userMessage, {
          sinceHours: 24,
          limit: 5,
          refreshDesktop: false,
          minScore: 0.52,
          contextMaxTokens: workspaceContextMaxTokens,
          contextMaxItems: workspaceContextMaxItems,
        })
        : null;
      if (workspaceContextBlock) {
        this.contextAssembly.injectSystemMessage(
          `<workspace-activity-context>\n${workspaceContextBlock}\n</workspace-activity-context>`
        );
        logger.info('[AgentLoop] Workspace activity context injected', {
          maxTokens: workspaceContextMaxTokens,
          maxItems: workspaceContextMaxItems,
          contextPressure: Number(contextPressure.toFixed(4)),
        });
      }

      const recoveredWorkHint = userMessage
        ? await buildRecoveredWorkOrchestrationHint({
          userMessage,
          planningService: this.ctx.planningService,
          recoveredTaskCount: taskSync.totalCandidates,
          hasWorkspaceContext: Boolean(workspaceContextBlock),
        })
        : null;
      if (recoveredWorkHint) {
        this.contextAssembly.injectSystemMessage(
          `<recovered-work-orchestration>\n${recoveredWorkHint}\n</recovered-work-orchestration>`
        );
        logger.info('[AgentLoop] Recovered work orchestration hint injected');
      }

      // Auto-trigger recovery for continuation-like requests
      if (
        userMessage
        && isContinuationLikeRequest(userMessage)
        && this.ctx.planningService
        && taskSync.totalCandidates > 0
      ) {
        try {
          const recoveryResult = await recoverRecentWorkIntoPlanning({
            planningService: this.ctx.planningService,
            sessionId: this.ctx.sessionId,
            query: userMessage,
            sinceHours: 24,
            refreshDesktop: false,
          });
          if (recoveryResult.planChanged) {
            await publishPlanningStateToRenderer(this.ctx.planningService);
            logger.info('[AgentLoop] Auto-recovery triggered for continuation request', {
              addedSteps: recoveryResult.planningSync.addedSteps.length,
              workspaceItems: recoveryResult.workspaceResult?.items.length || 0,
            });
          }
        } catch (autoRecoveryError) {
          logger.warn('[AgentLoop] Auto-recovery for continuation failed', {
            error: String(autoRecoveryError),
          });
        }
      }
    } catch (error) {
      logger.warn('[AgentLoop] Desktop-derived context bootstrap failed, continuing without it', {
        error: String(error),
      });
    }
  }

  setPlanMode(active: boolean): void {
    this.ctx.isPlanModeActive = active;
    this.ctx.planModeActive = active;

    if (active) {
      this.ctx.savedMessages = [...this.ctx.messages];
      this.contextAssembly.injectSystemMessage(
        `<plan-mode>\n` +
        `You are now in PLAN MODE. Do NOT execute any tools.\n` +
        `Instead, analyze the request and provide a detailed step-by-step plan.\n` +
        `Format your plan as a numbered list with clear, actionable steps.\n` +
        `Wait for user approval before proceeding with execution.\n` +
        `</plan-mode>`
      );
      logger.info('[AgentLoop] Plan mode activated');
    } else {
      if (this.ctx.savedMessages) {
        this.ctx.messages.length = 0;
        this.ctx.messages.push(...this.ctx.savedMessages);
        this.ctx.savedMessages = null;
      }
      logger.info('[AgentLoop] Plan mode deactivated');
    }
  }

  isPlanMode(): boolean {
    return this.ctx.isPlanModeActive;
  }

  setStructuredOutput(config: StructuredOutputConfig | undefined): void {
    this.ctx.structuredOutput = config;
    this.ctx.structuredOutputRetryCount = 0;
  }

  getStructuredOutput(): StructuredOutputConfig | undefined {
    return this.ctx.structuredOutput;
  }

  shouldRetryStructuredOutput(result: StructuredOutputResult): boolean {
    if (result.success) return false;
    return this.ctx.structuredOutputRetryCount < this.ctx.maxStructuredOutputRetries;
  }
  injectStructuredOutputCorrection(result: StructuredOutputResult): void {
    if (!this.ctx.structuredOutput) return;

    this.ctx.structuredOutputRetryCount++;
    const correctionPrompt = generateFormatCorrectionPrompt(
      result.rawContent || '',
      this.ctx.structuredOutput.schema,
      result.validationErrors || [result.error || 'Unknown error']
    );
    this.contextAssembly.injectSystemMessage(correctionPrompt);
    logger.debug(`[AgentLoop] Structured output correction injected (retry ${this.ctx.structuredOutputRetryCount}/${this.ctx.maxStructuredOutputRetries})`);
  }

  shouldAutoEnableStepByStep(): boolean {
    return this.ctx.stepByStepMode;
  }

  parseMultiStepTask(prompt: string): { steps: string[]; isMultiStep: boolean } {
    const lines = prompt.split('\n').filter(l => /^\s*(\d+[\.\)]\s|[-*]\s)/.test(l));
    return {
      steps: lines.map(l => l.replace(/^\s*(\d+[\.\)]\s|[-*]\s)/, '').trim()),
      isMultiStep: lines.length >= 2,
    };
  }

  async runStepByStep(userMessage: string, steps: string[]): Promise<boolean> {
    logger.info(`[AgentLoop] Running step-by-step mode with ${steps.length} steps`);

    this.contextAssembly.injectSystemMessage(
      `<step-by-step-mode>\n` +
      `This task has been broken down into ${steps.length} steps.\n` +
      `Execute each step one at a time, verifying completion before moving to the next.\n` +
      `Steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n` +
      `\nStart with step 1. After completing each step, explicitly state "Step N completed" before moving on.\n` +
      `</step-by-step-mode>`
    );

    for (let i = 0; i < steps.length; i++) {
      const stepPrompt = i === 0
        ? userMessage
        : `Continue with step ${i + 1}: ${steps[i]}. Previous steps have been completed.`;

      logger.debug(`[AgentLoop] Step ${i + 1}/${steps.length}: ${steps[i].substring(0, 50)}`);

      await this.run(stepPrompt);

      if (this.ctx.isCancelled || this.ctx.isInterrupted) {
        logger.info(`[AgentLoop] Step-by-step interrupted at step ${i + 1}`);
        return false;
      }
    }

    return true;
  }

  async run(userMessage: string): Promise<void> {

    const initResult = await this.initializeRun(userMessage);
    if (!initResult) return; // Early exit (step-by-step mode or hook blocked)
    const { langfuse, isSimpleTask, genNum } = initResult;

    let iterations = 0;
    let userTurnId: string | undefined;

    while (!this.ctx.isCancelled && !this.ctx.isInterrupted && !this.ctx.isPaused && !this.ctx.circuitBreaker.isTripped() && iterations < this.ctx.maxIterations) {
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

      // Setup iteration (turn ID, spans, events, goal checkpoints)
      this.streamHandler.setupIteration(iterations, userMessage, langfuse);
      if (iterations === 1) {
        userTurnId = this.ctx.currentTurnId;
      }

      // Telemetry: record turn start (only first iteration has the real user prompt)
      this.ctx.telemetryAdapter?.onTurnStart(this.ctx.currentTurnId, iterations, iterations === 1 ? userMessage : '', iterations > 1 ? userTurnId : undefined);

      // Plan Feedback Loop
      await this.streamHandler.injectPlanContext(iterations);

      // Contextual Memory Retrieval — on first iteration
      if (iterations === 1) {
        await this.streamHandler.injectContextualMemory(userMessage);
      }

      // 1. Call model
      logger.debug('[AgentLoop] Calling inference...');
      const inferenceStartTime = Date.now();
      let response = await this.contextAssembly.inference();
      const inferenceDuration = Date.now() - inferenceStartTime;
      logger.debug('[AgentLoop] Inference response type:', response.type);

      // h2A 实时转向
      if (this.ctx.needsReinference) {
        this.ctx.needsReinference = false;
        logger.info('[AgentLoop] Steer detected after inference — re-inferring with new user message');
        this.ctx.onEvent({
          type: 'interrupt_acknowledged',
          data: { message: '已收到新指令，正在调整方向...' },
        });
        continue;
      }

      // Emit model_response and accumulate tokens
      this.streamHandler.emitModelResponse(response, inferenceDuration);

      langfuse.logEvent(this.ctx.traceId, 'inference_complete', {
        iteration: iterations,
        responseType: response.type,
        duration: inferenceDuration,
      });

      // Telemetry: record model call
      this.messageProcessor.recordModelCallTelemetry(response, iterations, inferenceDuration);

      // M1: Loop decision engine — augments existing loop control (does NOT replace it)
      {
        const loopState: LoopState = {
          stopReason: response.finishReason ?? (response.truncated ? 'max_tokens' : 'end_turn'),
          tokenUsage: {
            input: this.ctx.totalInputTokens,
            output: this.ctx.totalOutputTokens,
          },
          maxTokens: CONTEXT_WINDOWS[this.ctx.modelConfig.model] ?? DEFAULT_CONTEXT_WINDOW,
          errorType: null,
          consecutiveErrors: this.ctx.consecutiveErrors,
          budgetRemaining: 1.0, // TODO: wire to budgetService
          iterationCount: iterations,
          maxIterations: this.ctx.maxIterations,
        };

        const decision = decideNextAction(loopState);
        logger.debug(`[AgentLoop] Loop decision: ${decision.action} — ${decision.reason}`);

        // Handle continuation (most impactful new behavior)
        if (decision.action === 'continuation' && decision.params?.continuationPrompt) {
          this.contextAssembly.injectSystemMessage(decision.params.continuationPrompt as string);
          // Don't break — let existing loop continue to next iteration
        }

        // Log other decisions for now — full handling will be refined incrementally
        if (decision.action === 'terminate') {
          logger.info(`[AgentLoop] Loop decision: terminate — ${decision.reason}`);
        }
        if (decision.action === 'compact') {
          logger.info(`[AgentLoop] Loop decision: compression needed — ${decision.reason}`);
        }
        if (decision.action === 'fallback') {
          logger.info(`[AgentLoop] Loop decision: fallback suggested — ${decision.reason}`);
        }
      }

      // 2. Handle text response - check for text-described tool calls
      const forceExecResult = this.messageProcessor.detectAndForceExecuteTextToolCall(response);
      if (forceExecResult.shouldContinue) continue;
      response = forceExecResult.response;
      const wasForceExecuted = forceExecResult.wasForceExecuted;

      // 2b. Handle actual text response
      if (response.type === 'text' && response.content) {
        const textAction = await this.messageProcessor.handleTextResponse(response, isSimpleTask, iterations, true, langfuse);
        if (textAction === 'break') break;
        if (textAction === 'continue') continue;
      }

      // 3. Handle tool calls
      if (response.type === 'tool_use' && response.toolCalls) {
        const toolAction = await this.messageProcessor.handleToolResponse(response, wasForceExecuted, iterations, langfuse);
        if (toolAction === 'continue') continue;
      }

      break;
    }

    await this.runFinalizer.finalizeRun(iterations, userMessage, langfuse, genNum);
  }

  // ========================================================================
  // Initialization
  // ========================================================================

  async initializeRun(userMessage: string): Promise<{
    langfuse: ReturnType<typeof getLangfuseService>;
    isSimpleTask: boolean;
    genNum: number;
  } | null> {
    
    logger.debug('[AgentLoop] ========== run() START ==========');
    logger.debug('[AgentLoop] Message:', userMessage.substring(0, 100));

    logCollector.agent('INFO', `Agent run started: "${userMessage.substring(0, 200)}${userMessage.length > 200 ? '...' : ''}"`);
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


    this.ctx.externalDataCallCount = 0;
    this.ctx.runStartTime = Date.now();
    this.ctx.totalIterations = 0;
    this.ctx.totalTokensUsed = 0;
    this.ctx.totalToolCallCount = 0;



    // F1: Goal Re-Injection
    this.ctx.goalTracker.initialize(userMessage);

    logger.debug(` Task complexity: ${complexityAnalysis.complexity} (${Math.round(complexityAnalysis.confidence * 100)}%)`);
    if ((complexityAnalysis.targetFiles || []).length > 0) {
      logger.debug(` Target files: ${(complexityAnalysis.targetFiles || []).join(', ')}`);
    }
    logCollector.agent('INFO', `Task complexity: ${complexityAnalysis.complexity}`, {
      confidence: complexityAnalysis.confidence,
      reasons: complexityAnalysis.reasons,
      fastPath: isSimpleTask,
      targetFiles: complexityAnalysis.targetFiles || [],
    });

    if (!isSimpleTask) {
      const complexityHint = taskComplexityAnalyzer.generateComplexityHint(complexityAnalysis);
      // 持久化到 system context，确保每轮推理都可见（而非注入消息历史后被淹没）
      this.contextAssembly.pushPersistentSystemContext(complexityHint);

      // Parallel Judgment via small model (Groq)
      try {
        const orchestrator = getTaskOrchestrator();
        const judgment = await orchestrator.judge(userMessage);

        if (judgment.shouldParallel && judgment.confidence >= 0.7) {
          const parallelHint = orchestrator.generateParallelHint(judgment);
          this.contextAssembly.pushPersistentSystemContext(parallelHint);

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
        logger.warn('[AgentLoop] Parallel judgment failed, continuing without hint', error);
      }
    }

    // LLM-based intent classification (for research routing)
    if (complexityAnalysis.complexity === 'simple' || complexityAnalysis.complexity === 'moderate') {
      try {
        const intent = await classifyIntent(userMessage, this.ctx.modelRouter);
        logger.info('Intent classified', { intent, message: userMessage.substring(0, 50) });

        if (intent === 'research') {
          // 研究模式 prompt 持久化到 system context
          this.contextAssembly.injectResearchModePrompt(userMessage);
        }
      } catch (error) {
        logger.warn('Intent classification failed, continuing with normal mode', { error: String(error) });
      }
    }

    // Dynamic Agent Mode Detection V2
    const genNum = 8;
    
    logger.info(`[AgentLoop] Checking dynamic mode for gen${genNum}`);
    if (genNum >= 3) {
      try {
        const dynamicResult = buildDynamicPromptV2(userMessage, {
          toolsUsedInTurn: this.ctx.toolsUsedInTurn,
          iterationCount: this.ctx.toolsUsedInTurn.length,
          hasError: false,
          maxReminderTokens: 1200,
          includeFewShot: genNum >= 4,
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

        if (dynamicResult.userMessage !== userMessage) {
          const reminder = dynamicResult.userMessage.substring(userMessage.length).trim();
          if (reminder) {
            logger.info(`[AgentLoop] Injecting mode reminder (${reminder.length} chars, ${dynamicResult.tokensUsed} tokens) to persistent context`);
            // 任务模式 reminder（含 DATA_PROCESSING 等）持久化到 system context
            this.contextAssembly.pushPersistentSystemContext(reminder);
          }
        }
      } catch (error) {
        logger.error('[AgentLoop] Dynamic mode detection failed:', error);
      }
    }

    // Step-by-step execution for models that need it
    if (this.ctx.stepByStepMode && !isSimpleTask) {
      const { steps, isMultiStep } = this.parseMultiStepTask(userMessage);
      if (isMultiStep) {
        logger.info(`[AgentLoop] Multi-step task detected (${steps.length} steps), using step-by-step mode`);
        await this.runStepByStep(userMessage, steps);
        return null;
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

    // Record session start for usage tracking (Light Memory)
    recordSessionStart().catch(() => { /* non-critical */ });

    // Session start hooks
    if (this.ctx.hookManager && !isSimpleTask) {
      const sessionResult = await this.ctx.hookManager.triggerSessionStart(this.ctx.sessionId);
      if (sessionResult.message) {
        this.contextAssembly.injectSystemMessage(`<session-start-hook>\n${sessionResult.message}\n</session-start-hook>`);
      }
    }

    // F5: 跨会话任务恢复
    if (!isSimpleTask) {
      try {
        const recovery = await getSessionRecoveryService().checkPreviousSession(
          this.ctx.sessionId,
          this.ctx.workingDirectory
        );
        if (recovery) {
          this.contextAssembly.injectSystemMessage(`<session-recovery>\n${recovery}\n</session-recovery>`);
          logger.info('[AgentLoop] Session recovery summary injected');
        }
      } catch {
        // Graceful: recovery failure doesn't block execution
      }
    }

    // Seed Memory Injection
    try {
      const seedMemoryBlock = buildSeedMemoryBlock(this.ctx.workingDirectory);
      if (seedMemoryBlock) {
        this.contextAssembly.injectSystemMessage(`<seed-memory>\n${seedMemoryBlock}\n</seed-memory>`);
        logger.info('[AgentLoop] Seed memory injected at session start');
      }
    } catch {
      logger.warn('[AgentLoop] Seed memory injection failed, continuing without');
    }

    if (!isSimpleTask) {
      await this.bootstrapDesktopDerivedContext(userMessage);
    }

    return { langfuse, isSimpleTask, genNum };
  }

  // ========================================================================
  // Control methods (cancel, interrupt, steer)
  // ========================================================================

  cancel(): void {
    // Preserve partial streaming content before aborting
    if (this.ctx.lastStreamedContent) {
      const partialMessage: Message = {
        id: generateMessageId(),
        role: 'assistant',
        content: this.ctx.lastStreamedContent + '\n\n[cancelled]',
        timestamp: Date.now(),
      };
      this.ctx.messages.push(partialMessage);
      this.ctx.persistMessage?.(partialMessage);
      this.ctx.lastStreamedContent = '';
    }
    this.ctx.isCancelled = true;
    this.ctx.abortController?.abort();
  }

  pause(): void {
    this.ctx.isPaused = true;
    logger.info('[ConversationRuntime] Paused — will stop after current iteration');
  }

  resume(): void {
    this.ctx.isPaused = false;
    logger.info('[ConversationRuntime] Resumed');
  }

  interrupt(newMessage: string): void {
    this.ctx.isInterrupted = true;
    this.ctx.interruptMessage = newMessage;
    this.ctx.abortController?.abort();
    logger.info('[AgentLoop] Interrupt requested with new message');
  }

  steer(newMessage: string): void {
    this.ctx.abortController?.abort();
    this.messageProcessor.injectSteerMessage(newMessage);
    this.ctx.needsReinference = true;
    logger.info('[AgentLoop] Steer requested — message injected, will re-infer on next cycle');
  }

  wasInterrupted(): boolean {
    return this.ctx.isInterrupted;
  }

  getInterruptMessage(): string | null {
    return this.ctx.interruptMessage;
  }

  isRunning(): boolean {
    return !this.ctx.isCancelled && !this.ctx.isInterrupted;
  }

  getPlanningService(): PlanningService | undefined {
    return this.ctx.planningService;
  }

  setEffortLevel(level: import('../../../shared/types/agent').EffortLevel): void {
    this.ctx.effortLevel = level;
    this.ctx.thinkingStepCount = 0;
    logger.debug(`[AgentLoop] Effort level set to: ${level}`);
  }

  getEffortLevel(): import('../../../shared/types/agent').EffortLevel {
    return this.ctx.effortLevel;
  }

  setInteractionMode(mode: import('../../../shared/types/agent').InteractionMode): void {
    this.ctx.interactionMode = mode;
    logger.debug(`[AgentLoop] Interaction mode set to: ${mode}`);
  }

  generateTruncationWarning(): string {
    return this.messageProcessor.generateTruncationWarning();
  }

  generateAutoContinuationPrompt(): string {
    return this.messageProcessor.generateAutoContinuationPrompt();
  }
}
