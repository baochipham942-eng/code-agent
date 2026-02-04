// ============================================================================
// Agent Loop - Core event loop for AI agent execution
// Enhanced with Manus-style persistent planning hooks
// ============================================================================

import type {
  Generation,
  ModelConfig,
  Message,
  ToolCall,
  ToolResult,
  AgentEvent,
  AgentTaskPhase,
} from '../../shared/types';
import type { StructuredOutputConfig, StructuredOutputResult } from './structuredOutput';
import { parseStructuredOutput, generateFormatCorrectionPrompt } from './structuredOutput';
import type { ToolRegistry } from '../tools/toolRegistry';
import type { ToolExecutor } from '../tools/toolExecutor';
import { ModelRouter, ContextLengthExceededError } from '../model/modelRouter';
import type { PlanningService } from '../planning';
import { getMemoryService } from '../memory/memoryService';
import { getConfigService, getAuthService, getLangfuseService, getBudgetService, BudgetAlertLevel, getSessionManager } from '../services';
import { logCollector } from '../mcp/logCollector.js';
import { generateMessageId } from '../../shared/utils/id';
import { taskComplexityAnalyzer } from '../planning/taskComplexityAnalyzer';
import { getTaskOrchestrator } from '../orchestrator/taskOrchestrator';
import { getMaxIterations } from '../services/cloud/featureFlagService';
import { createLogger } from '../services/infra/logger';
import { HookManager, createHookManager } from '../hooks';
import type { BudgetEventData } from '../../shared/types';
import { getContextHealthService } from '../context/contextHealthService';
import { DEFAULT_MODELS } from '../../shared/constants';

// Import refactored modules
import type {
  AgentLoopConfig,
  ModelResponse,
  ModelMessage,
  MessageContent,
} from './loopTypes';
import { isParallelSafeTool, classifyToolCalls } from './toolExecution/parallelStrategy';
import { CircuitBreaker } from './toolExecution/circuitBreaker';
import {
  formatToolCallForHistory,
  sanitizeToolResultsForHistory,
  buildMultimodalContent,
  stripImagesFromMessages,
  extractUserRequestText,
} from './messageHandling/converter';
import {
  injectWorkingDirectoryContext,
  buildEnhancedSystemPrompt,
  buildEnhancedSystemPromptWithProactiveContext,
  buildEnhancedSystemPromptAsync,
} from './messageHandling/contextBuilder';
import { getPromptForTask, buildDynamicPrompt, buildDynamicPromptV2, type AgentMode } from '../generation/prompts/builder';
import { AntiPatternDetector } from './antiPattern/detector';
import { getCurrentTodos } from '../tools/planning/todoWrite';
import { getIncompleteTasks } from '../tools/planning';
import { MAX_PARALLEL_TOOLS, READ_ONLY_TOOLS, WRITE_TOOLS, VERIFY_TOOLS, TaskProgressState } from './loopTypes';
import {
  compressToolResult,
  HookMessageBuffer,
  estimateModelMessageTokens,
  MessageHistoryCompressor,
  estimateTokens,
} from '../context/tokenOptimizer';
import { AutoContextCompressor, getAutoCompressor } from '../context/autoCompressor';
import { getTraceRecorder, type ToolCallWithResult } from '../evolution/traceRecorder';
import { getOutcomeDetector } from '../evolution/outcomeDetector';

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
export class AgentLoop {
  private generation: Generation;
  private modelConfig: ModelConfig;
  private toolRegistry: ToolRegistry;
  private toolExecutor: ToolExecutor;
  private messages: Message[];
  private onEvent: (event: AgentEvent) => void;
  private modelRouter: ModelRouter;
  private isCancelled: boolean = false;
  private isInterrupted: boolean = false;
  private interruptMessage: string | null = null;
  private maxIterations: number;

  // Planning integration
  private planningService?: PlanningService;
  private enableHooks: boolean;
  private stopHookRetryCount: number = 0;
  private maxStopHookRetries: number = 3;

  // P1 Nudge: Read-only stop pattern detection
  private readOnlyNudgeCount: number = 0;
  private maxReadOnlyNudges: number = 3; // Increased from 2 to give more chances
  private todoNudgeCount: number = 0;
  private maxTodoNudges: number = 2; // Nudge to complete todos

  // P3 Nudge: File completion tracking
  private fileNudgeCount: number = 0;
  private maxFileNudges: number = 2;
  private targetFiles: string[] = []; // Files mentioned in prompt that should be modified
  private modifiedFiles: Set<string> = new Set(); // Files actually modified

  // P2 Checkpoint: Task progress state tracking
  private consecutiveExploringCount: number = 0;
  private maxConsecutiveExploring: number = 3;
  private lastProgressState: TaskProgressState = 'exploring';

  // User-configurable hooks (Claude Code v2.0 style)
  private hookManager?: HookManager;
  private userHooksInitialized: boolean = false;

  // Tool call format retry
  private toolCallRetryCount: number = 0;
  private maxToolCallRetries: number = 2;

  // Refactored modules
  private circuitBreaker: CircuitBreaker;
  private antiPatternDetector: AntiPatternDetector;

  // Token optimization
  private hookMessageBuffer: HookMessageBuffer;
  private messageHistoryCompressor: MessageHistoryCompressor;
  private autoCompressor: AutoContextCompressor;

  // Plan Mode support
  private planModeActive: boolean = false;

  // Dynamic Agent Mode (借鉴 Claude Code 模式系统)
  private currentAgentMode: AgentMode = 'normal';

  // Langfuse tracing
  private sessionId: string;
  private userId?: string;
  private traceId: string = '';
  private currentIterationSpanId: string = '';

  // Turn-based message tracking
  private currentTurnId: string = '';

  // Skill system support
  private preApprovedTools: Set<string> = new Set();
  private skillModelOverride?: string;

  // Task progress tracking
  private turnStartTime: number = 0;
  private toolsUsedInTurn: string[] = [];

  // Simple task mode flag
  private isSimpleTaskMode: boolean = false;

  // Working directory context
  private workingDirectory: string;
  private isDefaultWorkingDirectory: boolean;

  // Budget tracking
  private budgetWarningEmitted: boolean = false;

  // Structured output
  private structuredOutput?: StructuredOutputConfig;
  private structuredOutputRetryCount: number = 0;
  private maxStructuredOutputRetries: number = 2;

  // Step-by-step execution mode (for models like DeepSeek that struggle with multi-step tasks)
  private stepByStepMode: boolean = false;

  // Auto-approve plan mode (for CLI/testing)
  private autoApprovePlan: boolean = false;

  // Tool deferred loading (reduce token usage)
  private enableToolDeferredLoading: boolean = false;

  constructor(config: AgentLoopConfig) {
    this.generation = config.generation;
    this.modelConfig = config.modelConfig;
    this.toolRegistry = config.toolRegistry;
    this.toolExecutor = config.toolExecutor;
    this.messages = config.messages;  // Use reference directly so orchestrator can access new messages
    this.onEvent = config.onEvent;
    this.modelRouter = new ModelRouter();
    this.maxIterations = getMaxIterations();

    // Planning service integration
    this.planningService = config.planningService;
    this.enableHooks = config.enableHooks ?? true;
    this.hookManager = config.hookManager;

    // Working directory
    this.workingDirectory = config.workingDirectory;
    this.isDefaultWorkingDirectory = config.isDefaultWorkingDirectory ?? true;

    // Tracing metadata
    this.sessionId = config.sessionId || `session-${Date.now()}`;
    this.userId = config.userId;

    // Structured output
    this.structuredOutput = config.structuredOutput;

    // Step-by-step mode (auto-enable for models that need it)
    this.stepByStepMode = config.stepByStepMode ?? this.shouldAutoEnableStepByStep();

    // Auto-approve plan mode (for CLI/testing)
    this.autoApprovePlan = config.autoApprovePlan ?? false;

    // Tool deferred loading (reduce token usage)
    this.enableToolDeferredLoading = config.enableToolDeferredLoading ?? false;

    // Initialize refactored modules
    this.circuitBreaker = new CircuitBreaker();
    this.antiPatternDetector = new AntiPatternDetector();

    // Initialize token optimization
    this.hookMessageBuffer = new HookMessageBuffer();
    this.messageHistoryCompressor = new MessageHistoryCompressor({
      threshold: 8000,
      targetTokens: 4000,
      preserveRecentCount: 6,
      preserveUserMessages: true,
    });
    this.autoCompressor = getAutoCompressor();
  }

  // --------------------------------------------------------------------------
  // Hook Initialization
  // --------------------------------------------------------------------------

  private async initializeUserHooks(): Promise<void> {
    if (this.userHooksInitialized) return;

    if (!this.hookManager && this.enableHooks) {
      this.hookManager = createHookManager({
        workingDirectory: process.cwd(),
        enabled: this.enableHooks,
      });
    }

    if (this.hookManager) {
      try {
        await this.hookManager.initialize();
        logger.debug('[AgentLoop] User hooks initialized', {
          stats: this.hookManager.getHookStats(),
        });
      } catch (error) {
        logger.error('[AgentLoop] Failed to initialize user hooks', { error });
      }
    }

    this.userHooksInitialized = true;
  }

  // --------------------------------------------------------------------------
  // Plan Mode Methods
  // --------------------------------------------------------------------------

  setPlanMode(active: boolean): void {
    this.planModeActive = active;
    logger.debug(` Plan mode ${active ? 'activated' : 'deactivated'}`);
    this.onEvent({
      type: 'notification',
      data: { message: `Plan mode ${active ? 'activated' : 'deactivated'}` },
    });
  }

  isPlanMode(): boolean {
    return this.planModeActive;
  }

  // --------------------------------------------------------------------------
  // Structured Output Methods
  // --------------------------------------------------------------------------

  setStructuredOutput(config: StructuredOutputConfig | undefined): void {
    this.structuredOutput = config;
    this.structuredOutputRetryCount = 0;
    logger.debug(` Structured output ${config?.enabled ? 'enabled' : 'disabled'}`);
  }

  getStructuredOutput(): StructuredOutputConfig | undefined {
    return this.structuredOutput;
  }

  private parseModelStructuredOutput<T = unknown>(content: string): StructuredOutputResult<T> {
    if (!this.structuredOutput?.enabled) {
      return {
        success: true,
        data: content as unknown as T,
        rawContent: content,
      };
    }
    return parseStructuredOutput<T>(content, this.structuredOutput);
  }

  private shouldRetryStructuredOutput(result: StructuredOutputResult): boolean {
    if (result.success) return false;
    if (!this.structuredOutput?.enabled) return false;
    if (this.structuredOutput.onParseError !== 'retry') return false;
    if (this.structuredOutputRetryCount >= this.maxStructuredOutputRetries) return false;
    return true;
  }

  private injectStructuredOutputCorrection(result: StructuredOutputResult): void {
    if (!this.structuredOutput) return;

    this.structuredOutputRetryCount++;
    const correctionPrompt = generateFormatCorrectionPrompt(
      result.rawContent || '',
      this.structuredOutput.schema,
      result.validationErrors || [result.error || 'Unknown error']
    );

    this.injectSystemMessage(
      `<structured-output-correction>\n${correctionPrompt}\n</structured-output-correction>`
    );

    logger.warn(
      `[AgentLoop] Structured output parse failed, retry ${this.structuredOutputRetryCount}/${this.maxStructuredOutputRetries}`
    );
  }

  // --------------------------------------------------------------------------
  // Step-by-Step Execution Methods (for DeepSeek etc.)
  // --------------------------------------------------------------------------

  private shouldAutoEnableStepByStep(): boolean {
    const model = this.modelConfig.model?.toLowerCase() || '';
    const provider = this.modelConfig.provider?.toLowerCase() || '';
    if (provider === 'deepseek' || model.includes('deepseek')) return true;
    if (provider === 'zhipu' && model.includes('glm')) return true;
    return false;
  }

  private parseMultiStepTask(prompt: string): { steps: string[]; isMultiStep: boolean } {
    const stepRegex = /^\s*(\d+)[.\)]\s*(.+?)(?=\n\s*\d+[.\)]|\n*$)/gms;
    const steps: string[] = [];
    let match;
    while ((match = stepRegex.exec(prompt)) !== null) {
      const instruction = match[2].trim();
      if (instruction.length > 10) steps.push(instruction);
    }
    return { steps, isMultiStep: steps.length >= 2 };
  }

  private async runStepByStep(userMessage: string, steps: string[]): Promise<boolean> {
    logger.info(`[AgentLoop] Step-by-step mode: ${steps.length} steps`);
    this.onEvent({ type: 'notification', data: { message: `分步执行: ${steps.length} 步` } });

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
      this.messages.push(stepMessage);
      this.onEvent({ type: 'message', data: stepMessage });
      this.onEvent({ type: 'notification', data: { message: `[${stepNum}/${steps.length}] ${step.substring(0, 30)}...` } });

      let stepIterations = 0;
      while (!this.isCancelled && stepIterations < 5) {
        stepIterations++;
        const response = await this.inference();
        if (response.type === 'text') {
          const msg: Message = { id: generateMessageId(), role: 'assistant', content: response.content || '', timestamp: Date.now() };
          this.messages.push(msg);
          this.onEvent({ type: 'message', data: msg });
          break;
        }
        if (response.type === 'tool_use' && response.toolCalls) {
          const results = await this.executeToolsWithHooks(response.toolCalls);
          const toolMsg: Message = { id: generateMessageId(), role: 'assistant', content: '', timestamp: Date.now(), toolCalls: response.toolCalls, toolResults: results };
          this.messages.push(toolMsg);
        }
      }
    }
    this.onEvent({ type: 'notification', data: { message: `分步执行完成` } });
    return true;
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  async run(userMessage: string): Promise<void> {
    logger.debug('[AgentLoop] ========== run() START ==========');
    logger.debug('[AgentLoop] Message:', userMessage.substring(0, 100));

    logCollector.agent('INFO', `Agent run started: "${userMessage.substring(0, 80)}..."`);
    logCollector.agent('DEBUG', `Generation: ${this.generation.id}, Model: ${this.modelConfig.provider}`);

    // Langfuse: Start trace
    const langfuse = getLangfuseService();
    this.traceId = `trace-${this.sessionId}-${Date.now()}`;
    langfuse.startTrace(this.traceId, {
      sessionId: this.sessionId,
      userId: this.userId,
      generationId: this.generation.id,
      modelProvider: this.modelConfig.provider,
      modelName: this.modelConfig.model,
    }, userMessage);

    // Gen8: Start trace recording for self-evolution
    const evolutionTraceRecorder = getTraceRecorder();
    evolutionTraceRecorder.startTrace(this.sessionId, userMessage, this.workingDirectory);

    await this.initializeUserHooks();

    // Task Complexity Analysis
    const complexityAnalysis = taskComplexityAnalyzer.analyze(userMessage);
    const isSimpleTask = complexityAnalysis.complexity === 'simple';
    this.isSimpleTaskMode = isSimpleTask;

    // Store target files for P3 Nudge
    this.targetFiles = complexityAnalysis.targetFiles || [];
    this.modifiedFiles.clear();
    this.fileNudgeCount = 0;

    // Reset nudge counters at task start (not per-turn, to allow cumulative effect)
    this.readOnlyNudgeCount = 0;
    this.todoNudgeCount = 0;

    logger.debug(` Task complexity: ${complexityAnalysis.complexity} (${Math.round(complexityAnalysis.confidence * 100)}%)`);
    if (this.targetFiles.length > 0) {
      logger.debug(` Target files: ${this.targetFiles.join(', ')}`);
    }
    logCollector.agent('INFO', `Task complexity: ${complexityAnalysis.complexity}`, {
      confidence: complexityAnalysis.confidence,
      reasons: complexityAnalysis.reasons,
      fastPath: isSimpleTask,
      targetFiles: this.targetFiles,
    });

    if (!isSimpleTask) {
      const complexityHint = taskComplexityAnalyzer.generateComplexityHint(complexityAnalysis);
      this.injectSystemMessage(complexityHint);

      // Parallel Judgment via small model (Groq)
      try {
        const orchestrator = getTaskOrchestrator();
        const judgment = await orchestrator.judge(userMessage);

        if (judgment.shouldParallel && judgment.confidence >= 0.7) {
          const parallelHint = orchestrator.generateParallelHint(judgment);
          this.injectSystemMessage(parallelHint);

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

    // Dynamic Agent Mode Detection V2 (基于优先级和预算的动态提醒)
    // 注意：这里移出了 !isSimpleTask 条件，因为即使简单任务也可能需要动态提醒（如 PPT 格式选择）
    const genNum = parseInt(this.generation.id.replace('gen', ''), 10);
    logger.info(`[AgentLoop] Checking dynamic mode for gen${genNum}`);
    if (genNum >= 3) {
      try {
        // 使用 V2 版本，支持 toolsUsedInTurn 上下文
        const dynamicResult = buildDynamicPromptV2(this.generation.id, userMessage, {
          toolsUsedInTurn: this.toolsUsedInTurn,
          iterationCount: this.toolsUsedInTurn.length, // 使用工具调用数量作为迭代近似
          hasError: false,
          maxReminderTokens: 800,
          includeFewShot: genNum >= 4, // Gen4+ 启用 few-shot 示例
        });
        this.currentAgentMode = dynamicResult.mode;

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
            this.injectSystemMessage(reminder);
          }
        }
      } catch (error) {
        logger.error('[AgentLoop] Dynamic mode detection failed:', error);
      }
    }

    // Step-by-step execution for models that need it (DeepSeek, etc.)
    if (this.stepByStepMode && !isSimpleTask) {
      const { steps, isMultiStep } = this.parseMultiStepTask(userMessage);
      if (isMultiStep) {
        logger.info(`[AgentLoop] Multi-step task detected (${steps.length} steps), using step-by-step mode`);
        await this.runStepByStep(userMessage, steps);
        return; // Step-by-step mode handles the entire execution
      }
    }

    // User-configurable hooks: UserPromptSubmit
    if (this.hookManager) {
      const promptResult = await this.hookManager.triggerUserPromptSubmit(userMessage, this.sessionId);
      if (!promptResult.shouldProceed) {
        logger.info('[AgentLoop] User prompt blocked by hook', { message: promptResult.message });
        this.onEvent({
          type: 'notification',
          data: { message: promptResult.message || 'Prompt blocked by hook' },
        });
        return;
      }
      if (promptResult.message) {
        this.injectSystemMessage(`<user-prompt-hook>\n${promptResult.message}\n</user-prompt-hook>`);
      }
    }

    // Session start hooks
    const shouldRunHooks = this.enableHooks && this.planningService && !isSimpleTask;
    if (shouldRunHooks) {
      await this.runSessionStartHook();
    }

    if (this.hookManager && !isSimpleTask) {
      const sessionResult = await this.hookManager.triggerSessionStart(this.sessionId);
      if (sessionResult.message) {
        this.injectSystemMessage(`<session-start-hook>\n${sessionResult.message}\n</session-start-hook>`);
      }
    }

    let iterations = 0;

    while (!this.isCancelled && !this.isInterrupted && !this.circuitBreaker.isTripped() && iterations < this.maxIterations) {
      iterations++;
      logger.debug(` >>>>>> Iteration ${iterations} START <<<<<<`);

      // Check for interrupt at the start of each iteration
      if (this.isInterrupted && this.interruptMessage) {
        logger.info('[AgentLoop] Interrupt detected, breaking loop');
        this.onEvent({
          type: 'interrupt_acknowledged',
          data: { message: '已收到新指令，正在调整方向...' },
        });
        break;
      }

      // Budget check
      const budgetBlocked = this.checkAndEmitBudgetStatus();
      if (budgetBlocked) {
        logger.warn('[AgentLoop] Budget exceeded, stopping execution');
        logCollector.agent('WARN', 'Budget exceeded, execution blocked');
        this.onEvent({
          type: 'error',
          data: { message: 'Budget exceeded. Please increase budget or wait for reset.', code: 'BUDGET_EXCEEDED' },
        });
        break;
      }

      // Generate turn ID
      this.currentTurnId = generateMessageId();

      // Langfuse: Start iteration span
      this.currentIterationSpanId = `iteration-${this.traceId}-${iterations}`;
      langfuse.startSpan(this.traceId, this.currentIterationSpanId, {
        name: `Iteration ${iterations}`,
        metadata: { iteration: iterations, turnId: this.currentTurnId },
      });

      this.onEvent({
        type: 'turn_start',
        data: { turnId: this.currentTurnId, iteration: iterations },
      });

      this.turnStartTime = Date.now();
      this.toolsUsedInTurn = [];
      // Note: readOnlyNudgeCount and todoNudgeCount are NOT reset here
      // They accumulate across turns to allow escalating nudges
      this.emitTaskProgress('thinking', '分析请求中...');

      // 1. Call model
      logger.debug('[AgentLoop] Calling inference...');
      const inferenceStartTime = Date.now();
      let response = await this.inference();
      const inferenceDuration = Date.now() - inferenceStartTime;
      logger.debug('[AgentLoop] Inference response type:', response.type);

      langfuse.logEvent(this.traceId, 'inference_complete', {
        iteration: iterations,
        responseType: response.type,
        duration: inferenceDuration,
      });

      // 2. Handle text response - check for text-described tool calls
      if (response.type === 'text' && response.content) {
        const failedToolCallMatch = this.antiPatternDetector.detectFailedToolCallPattern(response.content);
        if (failedToolCallMatch) {
          const forceExecuteResult = this.antiPatternDetector.tryForceExecuteTextToolCall(failedToolCallMatch, response.content);
          if (forceExecuteResult) {
            logger.info(`[AgentLoop] Force executing text-described tool call: ${failedToolCallMatch.toolName}`);
            logCollector.agent('INFO', `Force executing text tool call: ${failedToolCallMatch.toolName}`);
            response = {
              type: 'tool_use',
              toolCalls: [forceExecuteResult],
            };
          } else if (this.toolCallRetryCount < this.maxToolCallRetries) {
            this.toolCallRetryCount++;
            logger.warn(`[AgentLoop] Detected text description of tool call: "${failedToolCallMatch.toolName}"`);
            logCollector.agent('WARN', `Model described tool call as text: ${failedToolCallMatch.toolName}`);
            this.injectSystemMessage(
              this.antiPatternDetector.generateToolCallFormatError(failedToolCallMatch.toolName, response.content)
            );
            logger.debug(`[AgentLoop] Tool call retry ${this.toolCallRetryCount}/${this.maxToolCallRetries}`);
            continue;
          }
        }
      }

      // 2b. Handle actual text response
      if (response.type === 'text' && response.content) {
        this.emitTaskProgress('generating', '生成回复中...');

        // User-configurable Stop hook
        if (this.hookManager && !isSimpleTask) {
          try {
            const userStopResult = await this.hookManager.triggerStop(response.content, this.sessionId);
            if (!userStopResult.shouldProceed) {
              logger.info('[AgentLoop] Stop prevented by user hook', { message: userStopResult.message });
              if (userStopResult.message) {
                this.injectSystemMessage(`<stop-hook>\n${userStopResult.message}\n</stop-hook>`);
              }
              continue;
            }
            if (userStopResult.message) {
              this.injectSystemMessage(`<stop-hook>\n${userStopResult.message}\n</stop-hook>`);
            }
          } catch (error) {
            logger.error('[AgentLoop] User stop hook error:', error);
          }
        }

        // Planning stop hook
        if (shouldRunHooks) {
          const stopResult = await this.planningService!.hooks.onStop();

          if (!stopResult.shouldContinue && stopResult.injectContext) {
            this.stopHookRetryCount++;

            if (this.stopHookRetryCount <= this.maxStopHookRetries) {
              this.injectSystemMessage(stopResult.injectContext);
              if (stopResult.notification) {
                this.onEvent({
                  type: 'notification',
                  data: { message: stopResult.notification },
                });
              }
              logger.debug(` Stop hook retry ${this.stopHookRetryCount}/${this.maxStopHookRetries}`);
              continue;
            } else {
              logger.debug('[AgentLoop] Stop hook max retries reached, allowing stop');
              logCollector.agent('WARN', `Stop hook max retries (${this.maxStopHookRetries}) reached`);
              this.onEvent({
                type: 'notification',
                data: { message: 'Plan may be incomplete - max verification retries reached' },
              });
            }
          }

          if (stopResult.notification && stopResult.shouldContinue) {
            this.onEvent({
              type: 'notification',
              data: { message: stopResult.notification },
            });
          }
        }

        // P1 Nudge: Detect read-only stop pattern
        // If agent read files but didn't write, nudge it to continue with actual modifications
        if (this.toolsUsedInTurn.length > 0 && this.readOnlyNudgeCount < this.maxReadOnlyNudges) {
          const nudgeMessage = this.antiPatternDetector.detectReadOnlyStopPattern(this.toolsUsedInTurn);
          if (nudgeMessage) {
            this.readOnlyNudgeCount++;
            logger.debug(`[AgentLoop] Read-only stop pattern detected, nudge ${this.readOnlyNudgeCount}/${this.maxReadOnlyNudges}`);
            logCollector.agent('INFO', `Read-only stop pattern detected, nudge ${this.readOnlyNudgeCount}/${this.maxReadOnlyNudges}`);
            this.injectSystemMessage(nudgeMessage);
            this.onEvent({
              type: 'notification',
              data: { message: `检测到只读模式，提示继续执行修改 (${this.readOnlyNudgeCount}/${this.maxReadOnlyNudges})...` },
            });
            continue; // Skip stop, continue execution
          }
        }

        // P2 Nudge: Check for incomplete todos AND tasks in complex tasks
        // If agent wants to stop but has incomplete items, nudge it to complete them
        if (!this.isSimpleTaskMode && this.todoNudgeCount < this.maxTodoNudges) {
          const todos = getCurrentTodos(this.sessionId);
          const incompleteTodos = todos.filter(t => t.status !== 'completed');
          const incompleteTasks = getIncompleteTasks(this.sessionId);

          const totalIncomplete = incompleteTodos.length + incompleteTasks.length;

          if (totalIncomplete > 0) {
            this.todoNudgeCount++;

            // Build combined list
            const itemList: string[] = [];
            if (incompleteTodos.length > 0) {
              itemList.push(...incompleteTodos.map(t => `- [Todo] ${t.content}`));
            }
            if (incompleteTasks.length > 0) {
              itemList.push(...incompleteTasks.map(t => `- [Task #${t.id}] ${t.subject}`));
            }
            const combinedList = itemList.join('\n');

            logger.debug(`[AgentLoop] Incomplete items detected, nudge ${this.todoNudgeCount}/${this.maxTodoNudges}`);
            logCollector.agent('INFO', `Incomplete items detected: ${totalIncomplete} items`, {
              nudgeCount: this.todoNudgeCount,
              incompleteTodos: incompleteTodos.map(t => t.content),
              incompleteTasks: incompleteTasks.map(t => ({ id: t.id, subject: t.subject })),
            });
            this.injectSystemMessage(
              `<task-completion-check>\n` +
              `STOP! You have ${totalIncomplete} incomplete item(s):\n${combinedList}\n\n` +
              `You MUST complete these tasks before finishing. Do NOT provide a final summary until all items are marked as completed.\n` +
              `- For Todos: use todo_write to update status to "completed"\n` +
              `- For Tasks: use task_update with status="completed" (or status="deleted" if no longer needed)\n` +
              `Continue working on the remaining items NOW.\n` +
              `</task-completion-check>`
            );
            this.onEvent({
              type: 'notification',
              data: { message: `检测到 ${totalIncomplete} 个未完成的任务，提示继续执行 (${this.todoNudgeCount}/${this.maxTodoNudges})...` },
            });
            continue; // Skip stop, continue execution
          }
        }

        // P3 Nudge: Check if all target files have been modified
        if (this.targetFiles.length > 0 && this.fileNudgeCount < this.maxFileNudges) {
          const missingFiles: string[] = [];
          for (const targetFile of this.targetFiles) {
            // Normalize target file path for comparison
            const normalizedTarget = targetFile.replace(/^\.\//, '').replace(/^\//, '');
            // Check if any modified file matches or contains the target
            const found = Array.from(this.modifiedFiles).some(modFile =>
              modFile === normalizedTarget ||
              modFile.endsWith(normalizedTarget) ||
              normalizedTarget.endsWith(modFile)
            );
            if (!found) {
              missingFiles.push(targetFile);
            }
          }

          if (missingFiles.length > 0) {
            this.fileNudgeCount++;
            const fileList = missingFiles.map(f => `- ${f}`).join('\n');
            logger.debug(`[AgentLoop] P3 Nudge: Missing files detected, nudge ${this.fileNudgeCount}/${this.maxFileNudges}`);
            logCollector.agent('INFO', `P3 Nudge: Missing file modifications`, {
              nudgeCount: this.fileNudgeCount,
              missingFiles,
              modifiedFiles: Array.from(this.modifiedFiles),
              targetFiles: this.targetFiles,
            });
            this.injectSystemMessage(
              `<file-completion-check>\n` +
              `STOP! The following files were mentioned in the task but have not been modified:\n${fileList}\n\n` +
              `Modified files so far: ${Array.from(this.modifiedFiles).join(', ') || 'none'}\n\n` +
              `You MUST modify ALL required files before finishing. Continue working on the missing files NOW.\n` +
              `</file-completion-check>`
            );
            this.onEvent({
              type: 'notification',
              data: { message: `检测到 ${missingFiles.length} 个文件未修改，提示继续执行 (${this.fileNudgeCount}/${this.maxFileNudges})...` },
            });
            continue; // Skip stop, continue execution
          }
        }

        const assistantMessage: Message = {
          id: this.generateId(),
          role: 'assistant',
          content: response.content,
          timestamp: Date.now(),
        };
        await this.addAndPersistMessage(assistantMessage);
        this.onEvent({ type: 'message', data: assistantMessage });

        langfuse.endSpan(this.currentIterationSpanId, { type: 'text_response' });

        this.emitTaskProgress('completed', '回复完成');
        this.emitTaskComplete();

        this.onEvent({
          type: 'turn_end',
          data: { turnId: this.currentTurnId },
        });

        this.updateContextHealth();
        break;
      }

      // 3. Handle tool calls
      if (response.type === 'tool_use' && response.toolCalls) {
        logger.debug(` Tool calls received: ${response.toolCalls.length} calls`);

        this.emitTaskProgress('tool_pending', `准备执行 ${response.toolCalls.length} 个工具`, {
          toolTotal: response.toolCalls.length,
        });

        // Handle truncation warning
        if (response.truncated) {
          logger.warn('[AgentLoop] ⚠️ Tool call was truncated due to max_tokens limit!');
          logCollector.agent('WARN', 'Tool call truncated - content may be incomplete');

          const writeFileCall = response.toolCalls.find(tc => tc.name === 'write_file');
          if (writeFileCall) {
            const content = writeFileCall.arguments?.content as string;
            if (content) {
              logger.warn(`write_file content length: ${content.length} chars - may be truncated!`);
              this.injectSystemMessage(this.generateTruncationWarning());
            }
          }
        }

        response.toolCalls.forEach((tc, i) => {
          logger.debug(`   Tool ${i + 1}: ${tc.name}, args keys: ${Object.keys(tc.arguments || {}).join(', ')}`);
          logCollector.tool('INFO', `Tool call: ${tc.name}`, { toolId: tc.id, args: tc.arguments });
        });

        const assistantMessage: Message = {
          id: this.generateId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          toolCalls: response.toolCalls,
        };
        await this.addAndPersistMessage(assistantMessage);

        logger.debug('[AgentLoop] Emitting message event for tool calls');
        this.onEvent({ type: 'message', data: assistantMessage });

        // Execute tools
        logger.debug('[AgentLoop] Starting executeToolsWithHooks...');
        const toolResults = await this.executeToolsWithHooks(response.toolCalls);
        logger.debug(` executeToolsWithHooks completed, ${toolResults.length} results`);

        toolResults.forEach((r, i) => {
          logger.debug(`   Result ${i + 1}: success=${r.success}, error=${r.error || 'none'}`);
          if (r.success) {
            logCollector.tool('INFO', `Tool result: success`, {
              toolCallId: r.toolCallId,
              outputLength: r.output?.length || 0,
              duration: r.duration,
            });
          } else {
            logCollector.tool('ERROR', `Tool result: failed - ${r.error}`, { toolCallId: r.toolCallId });
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
          id: this.generateId(),
          role: 'tool',
          content: JSON.stringify(compressedResults),
          timestamp: Date.now(),
          toolResults: compressedResults,
        };
        await this.addAndPersistMessage(toolMessage);

        // Flush hook message buffer at end of iteration
        this.flushHookMessageBuffer();

        langfuse.endSpan(this.currentIterationSpanId, {
          type: 'tool_calls',
          toolCount: response.toolCalls.length,
          successCount: toolResults.filter(r => r.success).length,
        });

        this.onEvent({
          type: 'turn_end',
          data: { turnId: this.currentTurnId },
        });

        this.updateContextHealth();

        // 检查并执行自动压缩（在每轮工具调用后）
        await this.checkAndAutoCompress();

        // P2 Checkpoint: Evaluate task progress state and nudge if stuck in exploring
        const currentState = this.evaluateProgressState(this.toolsUsedInTurn);
        if (currentState === 'exploring') {
          this.consecutiveExploringCount++;
          if (this.consecutiveExploringCount >= this.maxConsecutiveExploring) {
            logger.debug(`[AgentLoop] P2 Checkpoint: ${this.consecutiveExploringCount} consecutive exploring iterations, injecting nudge`);
            logCollector.agent('INFO', `P2 Checkpoint nudge: ${this.consecutiveExploringCount} exploring iterations`);
            this.injectSystemMessage(this.generateExploringNudge());
            this.consecutiveExploringCount = 0; // Reset after nudge
          }
        } else {
          this.consecutiveExploringCount = 0; // Reset on progress
        }
        this.lastProgressState = currentState;

        logger.debug(` >>>>>> Iteration ${iterations} END (continuing) <<<<<<`);
        continue;
      }

      break;
    }

    // Handle loop exit conditions
    if (this.circuitBreaker.isTripped()) {
      logger.info('[AgentLoop] Loop exited due to circuit breaker');
      logCollector.agent('WARN', `Circuit breaker stopped agent after ${iterations} iterations`);

      const errorMessage: Message = {
        id: this.generateId(),
        role: 'assistant',
        content: '⚠️ **工具调用异常**\n\n连续多次工具调用失败，已自动停止执行。这可能是由于：\n- 文件路径不存在\n- 网络连接问题\n- 工具参数错误\n\n请检查上面的错误信息，然后告诉我如何继续。',
        timestamp: Date.now(),
      };
      await this.addAndPersistMessage(errorMessage);
      this.onEvent({ type: 'message', data: errorMessage });

      langfuse.endTrace(this.traceId, `Circuit breaker tripped after ${iterations} iterations`, 'ERROR');
      this.circuitBreaker.reset();
    } else if (iterations >= this.maxIterations) {
      logger.debug('[AgentLoop] Max iterations reached!');
      logCollector.agent('WARN', `Max iterations reached (${this.maxIterations})`);
      this.onEvent({
        type: 'error',
        data: { message: 'Max iterations reached' },
      });
      langfuse.endTrace(this.traceId, `Max iterations (${this.maxIterations}) reached`, 'WARNING');
    } else {
      langfuse.endTrace(this.traceId, `Completed in ${iterations} iterations`);
    }

    // Session end learning (Gen5+)
    // genNum already declared above in dynamic mode detection
    if (genNum >= 5 && this.messages.length > 0) {
      this.runSessionEndLearning().catch((err) => {
        logger.error('[AgentLoop] Session end learning error:', err);
      });
    }

    // User-configurable SessionEnd hook
    if (this.hookManager) {
      try {
        await this.hookManager.triggerSessionEnd(this.sessionId);
      } catch (error) {
        logger.error('[AgentLoop] Session end hook error:', error);
      }
    }

    // Pre-completion Hook: Check for incomplete todos AND tasks
    const finalTodos = getCurrentTodos(this.sessionId);
    const incompleteFinalTodos = finalTodos.filter(t => t.status !== 'completed');
    const incompleteFinalTasks = getIncompleteTasks(this.sessionId);
    const totalIncomplete = incompleteFinalTodos.length + incompleteFinalTasks.length;

    if (totalIncomplete > 0) {
      const todoDetails = incompleteFinalTodos.map(t => t.content);
      const taskDetails = incompleteFinalTasks.map(t => `#${t.id}: ${t.subject}`);
      const allDetails = [...todoDetails, ...taskDetails].join(', ');

      logger.warn(`[AgentLoop] Agent completing with ${totalIncomplete} incomplete item(s): ${allDetails}`);
      logCollector.agent('WARN', `Agent completing with incomplete items`, {
        incompleteCount: totalIncomplete,
        incompleteTodos: incompleteFinalTodos.map(t => ({ content: t.content, status: t.status })),
        incompleteTasks: incompleteFinalTasks.map(t => ({ id: t.id, subject: t.subject, status: t.status })),
      });

      this.onEvent({
        type: 'notification',
        data: {
          message: `⚠️ 任务可能未完成：${totalIncomplete} 个待办项未完成 (${allDetails})`,
        },
      });
    }

    // Gen8: End trace recording and determine outcome
    if (evolutionTraceRecorder.hasActiveTrace()) {
      try {
        // 确定执行结果
        const outcomeDetector = getOutcomeDetector();
        const traceOutcome = this.determineTraceOutcome(iterations);

        const trace = await evolutionTraceRecorder.endTrace(
          traceOutcome.outcome,
          traceOutcome.reason,
          traceOutcome.confidence
        );

        // 如果有轨迹，持久化信号并触发学习
        if (trace) {
          const outcomeResult = await outcomeDetector.detectOutcome(trace);
          await outcomeDetector.persistSignals(trace.id, outcomeResult.signals);

          // 触发元学习（异步，不阻塞主流程）
          this.triggerEvolutionLearning(trace, outcomeResult).catch((err) => {
            logger.error('[AgentLoop] Evolution learning error:', err);
          });
        }
      } catch (error) {
        logger.error('[AgentLoop] Trace recording error:', error);
      }
    }

    logger.debug('[AgentLoop] ========== run() END, emitting agent_complete ==========');
    logCollector.agent('INFO', `Agent run completed, ${iterations} iterations`);
    this.onEvent({ type: 'agent_complete', data: null });

    langfuse.flush().catch((err) => logger.error('[Langfuse] Flush error:', err));
  }

  cancel(): void {
    this.isCancelled = true;
  }

  /**
   * 中断当前执行并设置新的用户消息
   * 用于 Claude Code 风格的中断功能：用户输入新指令时中断当前任务
   */
  interrupt(newMessage: string): void {
    this.isInterrupted = true;
    this.interruptMessage = newMessage;
    logger.info('[AgentLoop] Interrupt requested with new message');
  }

  /**
   * 检查是否被中断
   */
  wasInterrupted(): boolean {
    return this.isInterrupted;
  }

  /**
   * 获取中断时的新消息
   */
  getInterruptMessage(): string | null {
    return this.interruptMessage;
  }

  /**
   * 检查是否正在运行（用于外部检查状态）
   */
  isRunning(): boolean {
    return !this.isCancelled && !this.isInterrupted;
  }

  getPlanningService(): PlanningService | undefined {
    return this.planningService;
  }

  // --------------------------------------------------------------------------
  // Task Progress Methods
  // --------------------------------------------------------------------------

  private emitTaskProgress(
    phase: AgentTaskPhase,
    step?: string,
    extra?: { progress?: number; tool?: string; toolIndex?: number; toolTotal?: number; parallel?: boolean }
  ): void {
    this.onEvent({
      type: 'task_progress',
      data: {
        turnId: this.currentTurnId,
        phase,
        step,
        ...extra,
      },
    });
  }

  private emitTaskComplete(): void {
    const duration = Date.now() - this.turnStartTime;
    this.onEvent({
      type: 'task_complete',
      data: {
        turnId: this.currentTurnId,
        duration,
        toolsUsed: [...new Set(this.toolsUsedInTurn)],
      },
    });
  }

  // --------------------------------------------------------------------------
  // Budget Methods
  // --------------------------------------------------------------------------

  private checkAndEmitBudgetStatus(): boolean {
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
        this.onEvent({ type: 'budget_exceeded', data: eventData });
        return true;

      case BudgetAlertLevel.WARNING:
        if (!this.budgetWarningEmitted) {
          logger.warn(`[AgentLoop] Budget warning: ${status.message}`);
          logCollector.agent('WARN', `Budget warning: ${(status.usagePercentage * 100).toFixed(0)}% used`);
          this.onEvent({ type: 'budget_warning', data: eventData });
          this.budgetWarningEmitted = true;
        }
        return false;

      default:
        return false;
    }
  }

  private recordTokenUsage(inputTokens: number, outputTokens: number): void {
    const budgetService = getBudgetService();
    budgetService.recordUsage({
      inputTokens,
      outputTokens,
      model: this.modelConfig.model,
      provider: this.modelConfig.provider,
      timestamp: Date.now(),
    });
  }

  // --------------------------------------------------------------------------
  // Hook Methods
  // --------------------------------------------------------------------------

  private async runSessionStartHook(): Promise<void> {
    if (!this.planningService) return;

    try {
      const result = await this.planningService.hooks.onSessionStart();

      if (result.injectContext) {
        this.injectSystemMessage(result.injectContext);
      }

      if (result.notification) {
        this.onEvent({
          type: 'notification',
          data: { message: result.notification },
        });
      }
    } catch (error) {
      logger.error('Session start hook error:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Tool Execution
  // --------------------------------------------------------------------------

  private async executeToolsWithHooks(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    logger.debug(` executeToolsWithHooks called with ${toolCalls.length} tool calls`);

    const { parallelGroup, sequentialGroup } = classifyToolCalls(toolCalls);
    logger.debug(` Tool classification: ${parallelGroup.length} parallel-safe, ${sequentialGroup.length} sequential`);

    const results: ToolResult[] = new Array(toolCalls.length);

    // Execute parallel-safe tools first
    if (parallelGroup.length > 1) {
      logger.debug(` Executing ${parallelGroup.length} parallel-safe tools in parallel (max ${MAX_PARALLEL_TOOLS})`);

      for (let batchStart = 0; batchStart < parallelGroup.length; batchStart += MAX_PARALLEL_TOOLS) {
        const batch = parallelGroup.slice(batchStart, batchStart + MAX_PARALLEL_TOOLS);

        for (const { index, toolCall } of batch) {
          this.toolsUsedInTurn.push(toolCall.name);
          this.emitTaskProgress('tool_running', `并行执行 ${batch.length} 个工具`, {
            tool: toolCall.name,
            toolIndex: index,
            toolTotal: toolCalls.length,
            parallel: true,
          });
          this.onEvent({ type: 'tool_call_start', data: { ...toolCall, _index: index, turnId: this.currentTurnId } });
        }

        const batchPromises = batch.map(async ({ index, toolCall }) => {
          const result = await this.executeSingleTool(toolCall, index, toolCalls.length);
          return { index, result };
        });

        const batchResults = await Promise.all(batchPromises);

        for (const { index, result } of batchResults) {
          results[index] = result;
        }
      }
    } else if (parallelGroup.length === 1) {
      const { index, toolCall } = parallelGroup[0];
      this.toolsUsedInTurn.push(toolCall.name);
      this.emitTaskProgress('tool_running', `执行 ${toolCall.name}`, {
        tool: toolCall.name,
        toolIndex: index,
        toolTotal: toolCalls.length,
      });
      this.onEvent({ type: 'tool_call_start', data: { ...toolCall, _index: index, turnId: this.currentTurnId } });
      results[index] = await this.executeSingleTool(toolCall, index, toolCalls.length);
    }

    // Execute sequential tools one by one
    for (const { index, toolCall } of sequentialGroup) {
      if (this.isCancelled) {
        logger.debug('[AgentLoop] Cancelled, breaking out of sequential tool execution');
        break;
      }

      this.toolsUsedInTurn.push(toolCall.name);
      const progress = Math.round((index / toolCalls.length) * 100);
      this.emitTaskProgress('tool_running', `执行 ${toolCall.name}`, {
        tool: toolCall.name,
        toolIndex: index,
        toolTotal: toolCalls.length,
        progress,
      });
      this.onEvent({ type: 'tool_call_start', data: { ...toolCall, _index: index, turnId: this.currentTurnId } });
      results[index] = await this.executeSingleTool(toolCall, index, toolCalls.length);
    }

    return results.filter((r): r is ToolResult => r !== undefined);
  }

  private async executeSingleTool(
    toolCall: ToolCall,
    index: number,
    total: number
  ): Promise<ToolResult> {
    logger.debug(` [${index + 1}/${total}] Processing tool: ${toolCall.name}, id: ${toolCall.id}`);

    // User-configurable Pre-Tool Hook
    if (this.hookManager && !isParallelSafeTool(toolCall.name)) {
      try {
        const toolInput = JSON.stringify(toolCall.arguments);
        const userHookResult = await this.hookManager.triggerPreToolUse(
          toolCall.name,
          toolInput,
          this.sessionId
        );

        if (!userHookResult.shouldProceed) {
          logger.info('[AgentLoop] Tool blocked by user hook', {
            tool: toolCall.name,
            message: userHookResult.message,
          });

          const blockedResult: ToolResult = {
            toolCallId: toolCall.id,
            success: false,
            error: `Tool blocked by hook: ${userHookResult.message || 'User-defined hook rejected this tool call'}`,
            duration: userHookResult.totalDuration,
          };

          this.injectSystemMessage(
            `<tool-blocked-by-hook>\n` +
            `⚠️ The tool "${toolCall.name}" was blocked by a user-defined hook.\n` +
            `Reason: ${userHookResult.message || 'No reason provided'}\n` +
            `You may need to adjust your approach or ask the user for guidance.\n` +
            `</tool-blocked-by-hook>`
          );

          this.onEvent({ type: 'tool_call_end', data: blockedResult });
          return blockedResult;
        }

        if (userHookResult.message) {
          this.injectSystemMessage(`<pre-tool-hook>\n${userHookResult.message}\n</pre-tool-hook>`);
        }
      } catch (error) {
        logger.error('[AgentLoop] User pre-tool hook error:', error);
      }
    }

    // Planning Pre-Tool Hook
    if (this.enableHooks && this.planningService && !isParallelSafeTool(toolCall.name)) {
      try {
        const preResult = await this.planningService.hooks.preToolUse({
          toolName: toolCall.name,
          toolParams: toolCall.arguments,
        });

        if (preResult.injectContext) {
          this.injectSystemMessage(preResult.injectContext);
        }
      } catch (error) {
        logger.error('Pre-tool hook error:', error);
      }
    }

    // Langfuse: Start tool span
    const langfuse = getLangfuseService();
    const toolSpanId = `tool-${toolCall.id}`;
    langfuse.startNestedSpan(this.currentIterationSpanId, toolSpanId, {
      name: `Tool: ${toolCall.name}`,
      input: toolCall.arguments,
      metadata: { toolId: toolCall.id, toolName: toolCall.name },
    });

    const startTime = Date.now();

    // Check for parse errors in arguments
    const args = toolCall.arguments as Record<string, unknown>;
    if (args && args.__parseError === true) {
      const errorMessage = args.__errorMessage as string || 'Unknown JSON parse error';
      const rawArgs = args.__rawArguments as string || '';

      logger.error(`[AgentLoop] Tool ${toolCall.name} arguments failed to parse: ${errorMessage}`);
      logCollector.tool('ERROR', `Tool ${toolCall.name} arguments parse error: ${errorMessage}`, {
        toolCallId: toolCall.id,
        rawArguments: rawArgs.substring(0, 500),
      });

      const toolResult: ToolResult = {
        toolCallId: toolCall.id,
        success: false,
        error: `Tool arguments JSON parse error: ${errorMessage}. Raw: ${rawArgs.substring(0, 200)}...`,
        duration: Date.now() - startTime,
      };

      this.injectSystemMessage(
        `<tool-arguments-parse-error>\n` +
        `⚠️ ERROR: Failed to parse JSON arguments for tool "${toolCall.name}".\n` +
        `Parse error: ${errorMessage}\n` +
        `Raw arguments (truncated): ${rawArgs.substring(0, 300)}\n\n` +
        `Please ensure your tool call arguments are valid JSON.\n` +
        `</tool-arguments-parse-error>`
      );

      this.onEvent({ type: 'tool_call_end', data: toolResult });
      return toolResult;
    }

    try {
      logger.debug(` Calling toolExecutor.execute for ${toolCall.name}...`);

      const currentAttachments = this.getCurrentAttachments();

      const result = await this.toolExecutor.execute(
        toolCall.name,
        toolCall.arguments,
        {
          generation: this.generation,
          planningService: this.planningService,
          modelConfig: this.modelConfig,
          setPlanMode: this.setPlanMode.bind(this),
          isPlanMode: this.isPlanMode.bind(this),
          emitEvent: (event: string, data: unknown) => this.onEvent({ type: event, data, sessionId: this.sessionId } as AgentEvent),
          sessionId: this.sessionId,
          preApprovedTools: this.preApprovedTools,
          currentAttachments,
          // 传递当前工具调用 ID（用于 subagent 追踪）
          currentToolCallId: toolCall.id,
        }
      );
      logger.debug(` toolExecutor.execute returned for ${toolCall.name}: success=${result.success}`);

      const toolResult: ToolResult = {
        toolCallId: toolCall.id,
        success: result.success,
        output: result.output,
        error: result.error,
        duration: Date.now() - startTime,
        metadata: result.metadata,
      };

      logger.debug(` Tool ${toolCall.name} completed in ${toolResult.duration}ms`);

      // Circuit breaker tracking
      if (!result.success) {
        if (this.circuitBreaker.recordFailure(result.error)) {
          this.injectSystemMessage(this.circuitBreaker.generateWarningMessage(result.error));
          this.onEvent({
            type: 'error',
            data: {
              message: this.circuitBreaker.generateUserErrorMessage(result.error),
              code: 'CIRCUIT_BREAKER_TRIPPED',
            },
          });
        }
      } else {
        this.circuitBreaker.recordSuccess();
      }

      // Anti-pattern tracking for tool failures
      if (!result.success && result.error) {
        const failureWarning = this.antiPatternDetector.trackToolFailure(toolCall, result.error);
        if (failureWarning) {
          this.injectSystemMessage(failureWarning);
        }
      } else if (result.success) {
        this.antiPatternDetector.clearToolFailure(toolCall);

        // Track duplicate calls
        const duplicateWarning = this.antiPatternDetector.trackDuplicateCall(toolCall);
        if (duplicateWarning) {
          this.injectSystemMessage(duplicateWarning);
        }
      }

      // Auto-continuation detection for truncated files
      if (toolCall.name === 'write_file' && result.success && result.output) {
        const outputStr = result.output;
        if (outputStr.includes('⚠️ **代码完整性警告**') || outputStr.includes('代码完整性警告')) {
          logger.debug('[AgentLoop] ⚠️ Detected truncated file! Injecting auto-continuation prompt');
          this.injectSystemMessage(this.generateAutoContinuationPrompt());
        }
      }

      // P3 Nudge: Track modified files for completion checking
      if ((toolCall.name === 'edit_file' || toolCall.name === 'write_file') && result.success) {
        const filePath = toolCall.arguments?.path as string;
        if (filePath) {
          // Normalize path for comparison
          const normalizedPath = filePath.replace(/^\.\//, '').replace(/^\//, '');
          this.modifiedFiles.add(normalizedPath);
          logger.debug(`[AgentLoop] P3 Nudge: Tracked modified file: ${normalizedPath}`);
        }
      }

      // Track read vs write operations
      const readWriteWarning = this.antiPatternDetector.trackToolExecution(toolCall.name, result.success);
      if (readWriteWarning === 'HARD_LIMIT') {
        return {
          toolCallId: toolCall.id,
          success: false,
          error: this.antiPatternDetector.generateHardLimitError(),
          duration: Date.now() - startTime,
        };
      } else if (readWriteWarning) {
        this.injectSystemMessage(readWriteWarning);
      }

      // User-configurable Post-Tool Hook
      if (this.hookManager) {
        try {
          const toolInput = JSON.stringify(toolCall.arguments);
          const toolOutput = result.output || '';
          const userPostResult = await this.hookManager.triggerPostToolUse(
            toolCall.name,
            toolInput,
            toolOutput,
            this.sessionId
          );

          if (userPostResult.message) {
            this.injectSystemMessage(`<post-tool-hook>\n${userPostResult.message}\n</post-tool-hook>`);
          }
        } catch (error) {
          logger.error('[AgentLoop] User post-tool hook error:', error);
        }
      }

      // Skill system support
      if (
        toolCall.name === 'skill' &&
        result.success &&
        result.metadata?.isSkillActivation &&
        result.metadata?.skillResult
      ) {
        this.processSkillActivation(
          result.metadata.skillResult as import('../../shared/types/agentSkill').SkillToolResult
        );
      }

      // Auto-approve plan mode (for CLI/testing)
      if (
        this.autoApprovePlan &&
        toolCall.name === 'exit_plan_mode' &&
        result.success &&
        result.metadata?.requiresUserConfirmation
      ) {
        logger.info('[AgentLoop] Auto-approving plan (autoApprovePlan enabled)');
        this.messages.push({
          id: `auto-approve-${Date.now()}`,
          role: 'user',
          content: '确认执行，请按计划开始实现。',
          timestamp: Date.now(),
        });
      }

      // Planning Post-Tool Hook
      if (this.enableHooks && this.planningService) {
        try {
          const postResult = await this.planningService.hooks.postToolUse({
            toolName: toolCall.name,
            toolParams: toolCall.arguments,
            toolResult: result,
          });

          if (postResult.injectContext) {
            this.injectSystemMessage(postResult.injectContext);
          }
        } catch (error) {
          logger.error('Post-tool hook error:', error);
        }
      }

      langfuse.endSpan(toolSpanId, {
        success: result.success,
        outputLength: result.output?.length || 0,
        duration: toolResult.duration,
      });

      // Gen8: Record tool call for self-evolution
      const traceRecorder = getTraceRecorder();
      if (traceRecorder.hasActiveTrace()) {
        traceRecorder.recordToolCall({
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.arguments as Record<string, unknown>,
          result: {
            success: result.success,
            output: result.output?.substring(0, 1000), // 限制输出长度
            error: result.error,
          },
          durationMs: toolResult.duration || 0,
          timestamp: Date.now(),
        });
      }

      logger.debug(` Emitting tool_call_end for ${toolCall.name} (success)`);
      this.onEvent({ type: 'tool_call_end', data: toolResult });

      return toolResult;
    } catch (error) {
      logger.error(`Tool ${toolCall.name} threw exception:`, error);
      const toolResult: ToolResult = {
        toolCallId: toolCall.id,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime,
      };

      logger.debug(` Tool ${toolCall.name} failed with error: ${toolResult.error}`);

      // Circuit breaker tracking for exceptions
      if (this.circuitBreaker.recordFailure(toolResult.error)) {
        this.injectSystemMessage(this.circuitBreaker.generateWarningMessage(toolResult.error));
        this.onEvent({
          type: 'error',
          data: {
            message: this.circuitBreaker.generateUserErrorMessage(toolResult.error),
            code: 'CIRCUIT_BREAKER_TRIPPED',
          },
        });
      }

      // User-configurable Post-Tool Failure Hook
      if (this.hookManager) {
        try {
          const toolInput = JSON.stringify(toolCall.arguments);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const userFailResult = await this.hookManager.triggerPostToolUseFailure(
            toolCall.name,
            toolInput,
            errorMessage,
            this.sessionId
          );

          if (userFailResult.message) {
            this.injectSystemMessage(`<post-tool-failure-hook>\n${userFailResult.message}\n</post-tool-failure-hook>`);
          }
        } catch (hookError) {
          logger.error('[AgentLoop] User post-tool failure hook error:', hookError);
        }
      }

      // Planning Error Hook
      if (this.enableHooks && this.planningService) {
        try {
          const errorResult = await this.planningService.hooks.onError({
            toolName: toolCall.name,
            toolParams: toolCall.arguments,
            error: error instanceof Error ? error : new Error('Unknown error'),
          });

          if (errorResult.injectContext) {
            this.injectSystemMessage(errorResult.injectContext);
          }
        } catch (hookError) {
          logger.error('Error hook error:', hookError);
        }
      }

      langfuse.endSpan(toolSpanId, {
        success: false,
        error: toolResult.error,
        duration: toolResult.duration,
      }, 'ERROR', toolResult.error);

      // Gen8: Record failed tool call for self-evolution
      const traceRecorder = getTraceRecorder();
      if (traceRecorder.hasActiveTrace()) {
        traceRecorder.recordToolCall({
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.arguments as Record<string, unknown>,
          result: {
            success: false,
            error: toolResult.error,
          },
          durationMs: toolResult.duration || 0,
          timestamp: Date.now(),
        });
      }

      logger.debug(` Emitting tool_call_end for ${toolCall.name} (error)`);
      this.onEvent({ type: 'tool_call_end', data: toolResult });

      return toolResult;
    }
  }

  // --------------------------------------------------------------------------
  // Inference
  // --------------------------------------------------------------------------

  private async inference(): Promise<ModelResponse> {
    // 根据配置决定使用全量工具还是核心+延迟工具
    let tools;
    if (this.enableToolDeferredLoading) {
      // 使用核心工具 + 已加载的延迟工具
      const coreTools = this.toolRegistry.getCoreToolDefinitions(this.generation.id);
      const loadedDeferredTools = this.toolRegistry.getLoadedDeferredToolDefinitions(this.generation.id);
      tools = [...coreTools, ...loadedDeferredTools];
      logger.debug(`Tools for ${this.generation.id} (deferred loading): ${coreTools.length} core + ${loadedDeferredTools.length} deferred = ${tools.length} total`);
    } else {
      // 传统模式：发送所有工具
      tools = this.toolRegistry.getToolDefinitions(this.generation.id);
      logger.debug(`Tools for ${this.generation.id}:`, tools.map(t => t.name));
    }

    let modelMessages = this.buildModelMessages();
    logger.debug('[AgentLoop] Model messages count:', modelMessages.length);
    logger.debug('[AgentLoop] Model config:', {
      provider: this.modelConfig.provider,
      model: this.modelConfig.model,
      hasApiKey: !!this.modelConfig.apiKey,
    });

    const langfuse = getLangfuseService();
    const generationId = `gen-${this.traceId}-${Date.now()}`;
    const startTime = new Date();

    const inputSummary = modelMessages.map(m => ({
      role: m.role,
      contentLength: m.content.length,
      contentPreview: typeof m.content === 'string' ? m.content.substring(0, 200) : '[multimodal]',
    }));

    langfuse.startGenerationInSpan(this.currentIterationSpanId, generationId, `LLM: ${this.modelConfig.model}`, {
      model: this.modelConfig.model,
      modelParameters: {
        provider: this.modelConfig.provider,
        temperature: this.modelConfig.temperature,
        maxTokens: this.modelConfig.maxTokens,
      },
      input: {
        messageCount: modelMessages.length,
        toolCount: tools.length,
        messages: inputSummary,
      },
      startTime,
    });

    try {
      // Capability detection and model fallback
      let effectiveConfig = this.modelConfig;
      const lastUserMessage = modelMessages.filter(m => m.role === 'user').pop();
      const currentTurnMessages = lastUserMessage ? [lastUserMessage] : [];
      const requiredCapabilities = this.modelRouter.detectRequiredCapabilities(currentTurnMessages);
      let needsVisionFallback = false;
      let visionFallbackSucceeded = false;

      const userRequestText = extractUserRequestText(lastUserMessage);
      const needsToolForImage = /标[注记]|画框|框[出住]|圈[出住]|矩形|annotate|mark|highlight|draw/i.test(userRequestText);

      if (needsToolForImage && requiredCapabilities.includes('vision')) {
        logger.info('[AgentLoop] 用户请求需要工具处理图片（标注/画框），跳过视觉 fallback');
        const visionIndex = requiredCapabilities.indexOf('vision');
        if (visionIndex > -1) {
          requiredCapabilities.splice(visionIndex, 1);
        }
        modelMessages = stripImagesFromMessages(modelMessages);
      }

      if (requiredCapabilities.length > 0) {
        const currentModelInfo = this.modelRouter.getModelInfo(
          this.modelConfig.provider,
          this.modelConfig.model
        );

        for (const capability of requiredCapabilities) {
          const hasCapability = currentModelInfo?.capabilities?.includes(capability) ||
            (capability === 'vision' && currentModelInfo?.supportsVision);

          if (!hasCapability) {
            if (capability === 'vision') {
              needsVisionFallback = true;
            }

            const fallbackConfig = this.modelRouter.getFallbackConfig(capability, this.modelConfig);
            if (fallbackConfig) {
              const configService = getConfigService();
              const authService = getAuthService();
              const currentUser = authService.getCurrentUser();
              const isAdmin = currentUser?.isAdmin === true;

              const fallbackApiKey = configService.getApiKey(fallbackConfig.provider);
              logger.info(`[Fallback] provider=${fallbackConfig.provider}, model=${fallbackConfig.model}, hasLocalKey=${!!fallbackApiKey}, isAdmin=${isAdmin}`);

              if (fallbackApiKey) {
                fallbackConfig.apiKey = fallbackApiKey;
                logger.info(`[Fallback] 使用本地 ${fallbackConfig.provider} Key 切换到 ${fallbackConfig.model}`);
                this.onEvent({
                  type: 'model_fallback',
                  data: {
                    reason: capability,
                    from: this.modelConfig.model,
                    to: fallbackConfig.model,
                  },
                });
                effectiveConfig = fallbackConfig;
                if (capability === 'vision') {
                  visionFallbackSucceeded = true;
                }
                break;
              } else if (isAdmin) {
                fallbackConfig.useCloudProxy = true;
                logger.info(`[Fallback] 本地无 ${fallbackConfig.provider} Key，管理员使用云端代理 ${fallbackConfig.model}`);
                this.onEvent({
                  type: 'model_fallback',
                  data: {
                    reason: capability,
                    from: this.modelConfig.model,
                    to: `${fallbackConfig.model} (云端)`,
                  },
                });
                effectiveConfig = fallbackConfig;
                if (capability === 'vision') {
                  visionFallbackSucceeded = true;
                }
                break;
              } else {
                logger.info(`[Fallback] 非管理员，${fallbackConfig.provider} 未配置 Key，无法切换`);
                this.onEvent({
                  type: 'api_key_required',
                  data: {
                    provider: fallbackConfig.provider,
                    capability: capability,
                    message: `需要 ${capability} 能力，但 ${fallbackConfig.provider} API Key 未配置。请在设置中配置 ${fallbackConfig.provider.toUpperCase()}_API_KEY。`,
                  },
                });
              }
            }
          }
        }
      }

      if (needsVisionFallback && !visionFallbackSucceeded) {
        logger.warn('[AgentLoop] 无法使用视觉模型，将图片转换为文字描述');
        modelMessages = stripImagesFromMessages(modelMessages);
      }

      if (effectiveConfig === this.modelConfig) {
        const mainModelInfo = this.modelRouter.getModelInfo(
          this.modelConfig.provider,
          this.modelConfig.model
        );
        if (!mainModelInfo?.supportsVision) {
          const hasImages = modelMessages.some(msg =>
            Array.isArray(msg.content) && msg.content.some((c: any) => c.type === 'image')
          );
          if (hasImages) {
            logger.warn('[AgentLoop] 主模型不支持视觉，但历史消息中包含图片，移除图片避免 API 错误');
            modelMessages = stripImagesFromMessages(modelMessages);
          }
        }
      }

      let effectiveTools = tools;
      if (effectiveConfig !== this.modelConfig) {
        const fallbackModelInfo = this.modelRouter.getModelInfo(
          effectiveConfig.provider,
          effectiveConfig.model
        );
        if (fallbackModelInfo && !fallbackModelInfo.supportsTool) {
          logger.warn(`[AgentLoop] Fallback 模型 ${effectiveConfig.model} 不支持 tool calls，清空工具列表`);
          effectiveTools = [];

          const simplifiedPrompt = `你是一个图片理解助手。请仔细观察图片内容，按照用户的要求进行分析。

输出要求：
- 使用清晰、结构化的格式
- 如果用户要求识别文字(OCR)，按阅读顺序列出所有文字
- 如果用户要求描述位置，使用相对位置描述（如"左上角"、"中央"）
- 只输出分析结果，不要解释你的能力或限制`;

          if (modelMessages.length > 0 && modelMessages[0].role === 'system') {
            modelMessages[0].content = simplifiedPrompt;
            logger.info(`[AgentLoop] 简化视觉模型 system prompt (${simplifiedPrompt.length} chars)`);
          }

          this.onEvent({
            type: 'notification',
            data: {
              message: `视觉模型 ${effectiveConfig.model} 不支持工具调用，本次请求将仅使用纯文本回复`,
            },
          });
        }
      }

      logger.debug('[AgentLoop] Calling modelRouter.inference()...');
      logger.debug('[AgentLoop] Effective model:', effectiveConfig.model);
      logger.debug('[AgentLoop] Effective tools count:', effectiveTools.length);

      const response = await this.modelRouter.inference(
        modelMessages,
        effectiveTools,
        effectiveConfig,
        (chunk) => {
          if (typeof chunk === 'string') {
            this.onEvent({ type: 'stream_chunk', data: { content: chunk, turnId: this.currentTurnId } });
          } else if (chunk.type === 'text') {
            this.onEvent({ type: 'stream_chunk', data: { content: chunk.content, turnId: this.currentTurnId } });
          } else if (chunk.type === 'reasoning') {
            // 推理模型的思考过程 (glm-4.7 等)
            this.onEvent({ type: 'stream_reasoning', data: { content: chunk.content, turnId: this.currentTurnId } });
          } else if (chunk.type === 'tool_call_start') {
            this.onEvent({
              type: 'stream_tool_call_start',
              data: {
                index: chunk.toolCall?.index,
                id: chunk.toolCall?.id,
                name: chunk.toolCall?.name,
                turnId: this.currentTurnId,
              },
            });
          } else if (chunk.type === 'tool_call_delta') {
            this.onEvent({
              type: 'stream_tool_call_delta',
              data: {
                index: chunk.toolCall?.index,
                name: chunk.toolCall?.name,
                argumentsDelta: chunk.toolCall?.argumentsDelta,
                turnId: this.currentTurnId,
              },
            });
          }
        }
      );

      logger.debug('[AgentLoop] Model response received:', response.type);

      // Record token usage with precise estimation
      const estimatedInputTokens = estimateModelMessageTokens(
        modelMessages.map(m => ({
          role: m.role,
          content: m.content,
        }))
      );
      const outputContent = (response.content || '') +
        (response.toolCalls?.map(tc => JSON.stringify(tc.arguments || {})).join('') || '');
      const estimatedOutputTokens = estimateModelMessageTokens([
        { role: 'assistant', content: outputContent },
      ]);
      this.recordTokenUsage(estimatedInputTokens, estimatedOutputTokens);

      langfuse.endGeneration(generationId, {
        type: response.type,
        contentLength: response.content?.length || 0,
        toolCallCount: response.toolCalls?.length || 0,
      });

      return response;
    } catch (error) {
      logger.error('[AgentLoop] Model inference error:', error);

      langfuse.endGeneration(
        generationId,
        { error: error instanceof Error ? error.message : 'Unknown error' },
        undefined,
        'ERROR',
        error instanceof Error ? error.message : 'Unknown error'
      );

      if (error instanceof ContextLengthExceededError) {
        logger.warn(`[AgentLoop] Context length exceeded: ${error.requestedTokens} > ${error.maxTokens}`);
        logCollector.agent('ERROR', `Context length exceeded: requested ${error.requestedTokens}, max ${error.maxTokens}`);

        this.onEvent({
          type: 'error',
          data: {
            code: 'CONTEXT_LENGTH_EXCEEDED',
            message: '对话内容过长，已超出模型上下文限制。',
            suggestion: '建议新开一个会话继续对话，或清理当前会话的历史消息。',
            details: {
              requested: error.requestedTokens,
              max: error.maxTokens,
              provider: error.provider,
            },
          },
        });

        this.emitTaskProgress('failed', '上下文超限');
        return { type: 'text', content: '' };
      }

      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // Message Building
  // --------------------------------------------------------------------------

  private buildModelMessages(): ModelMessage[] {
    const modelMessages: ModelMessage[] = [];

    // Use optimized prompt based on task complexity
    let systemPrompt = getPromptForTask(this.generation.id, this.isSimpleTaskMode);

    const genNum = parseInt(this.generation.id.replace('gen', ''), 10);
    if (genNum >= 3 && !this.isSimpleTaskMode) {
      // Only enhance with RAG for non-simple tasks
      const lastUserMessage = [...this.messages].reverse().find((m) => m.role === 'user');
      const userQuery = lastUserMessage?.content || '';
      systemPrompt = buildEnhancedSystemPrompt(systemPrompt, userQuery, this.generation.id, this.isSimpleTaskMode);
    }

    systemPrompt = injectWorkingDirectoryContext(systemPrompt, this.workingDirectory, this.isDefaultWorkingDirectory);

    // 注入延迟工具提示
    if (this.enableToolDeferredLoading) {
      const deferredToolsSummary = this.toolRegistry.getDeferredToolsSummary(this.generation.id);
      if (deferredToolsSummary) {
        systemPrompt += `

<deferred-tools>
以下工具可通过 tool_search 发现和加载：
${deferredToolsSummary}

使用方法：
- 关键字搜索：tool_search("pdf") → 搜索 PDF 相关工具
- 直接选择：tool_search("select:web_fetch") → 加载指定工具
- 必须前缀：tool_search("+mcp search") → 只搜索 MCP 相关工具
</deferred-tools>`;
      }
    }

    // Check system prompt length and warn if too long
    const systemPromptTokens = estimateTokens(systemPrompt);
    const MAX_SYSTEM_PROMPT_TOKENS = 4000;
    if (systemPromptTokens > MAX_SYSTEM_PROMPT_TOKENS) {
      logger.warn(`[AgentLoop] System prompt too long: ${systemPromptTokens} tokens (limit: ${MAX_SYSTEM_PROMPT_TOKENS})`);
      logCollector.agent('WARN', 'System prompt exceeds recommended limit', {
        tokens: systemPromptTokens,
        limit: MAX_SYSTEM_PROMPT_TOKENS,
      });
    }

    modelMessages.push({
      role: 'system',
      content: systemPrompt,
    });

    // Apply message history compression for long conversations
    // Include message ID for index-safe mapping after compression
    const messagesToProcess = this.messages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    }));

    const compressionResult = this.messageHistoryCompressor.compress(messagesToProcess);
    let processedMessages: Message[];

    if (compressionResult.wasCompressed) {
      // Use ID-based mapping to avoid index mismatch after compression
      const messageById = new Map(this.messages.map(m => [m.id, m]));
      processedMessages = compressionResult.messages.map(m => {
        const original = m.id ? messageById.get(m.id) : undefined;
        return {
          id: m.id || this.generateId(),
          role: m.role as Message['role'],
          content: m.content,
          timestamp: original?.timestamp || m.timestamp || Date.now(),
          attachments: original?.attachments,
          toolCalls: original?.toolCalls,
        };
      });
    } else {
      processedMessages = this.messages;
    }

    if (compressionResult.wasCompressed) {
      logger.debug(`[AgentLoop] Message history compressed, saved ${compressionResult.stats.savedTokens} tokens`);
      logCollector.agent('INFO', `Message history compressed`, {
        savedTokens: compressionResult.stats.savedTokens,
        totalSavedTokens: compressionResult.stats.totalSavedTokens,
        compressionCount: compressionResult.stats.compressionCount,
      });
    }

    logger.debug('[AgentLoop] Building model messages, total messages:', processedMessages.length);
    for (const message of processedMessages) {
      logger.debug(` Message role=${message.role}, hasAttachments=${!!(message as Message).attachments?.length}, attachmentCount=${(message as Message).attachments?.length || 0}`);

      if (message.role === 'tool') {
        modelMessages.push({
          role: 'user',
          content: `Tool results:\n${message.content}`,
        });
      } else if (message.role === 'assistant' && (message as Message).toolCalls) {
        const toolCallsStr = (message as Message).toolCalls!
          .map((tc) => formatToolCallForHistory(tc))
          .join('\n');
        modelMessages.push({
          role: 'assistant',
          content: toolCallsStr || message.content,
        });
      } else if (message.role === 'user' && (message as Message).attachments?.length) {
        const multimodalContent = buildMultimodalContent(message.content, (message as Message).attachments!);
        modelMessages.push({
          role: 'user',
          content: multimodalContent,
        });
      } else {
        modelMessages.push({
          role: message.role,
          content: message.content,
        });
      }
    }

    // Proactive compression check: trigger at 75% capacity to prevent hitting hard limits
    // 注意：maxTokens 是模型的最大输出限制，不是上下文窗口大小
    // 上下文窗口大小应该更大（如 64K-128K），这里使用保守估计 64000
    const currentTokens = estimateModelMessageTokens(modelMessages);
    const contextWindowSize = 64000; // 上下文窗口大小（保守估计）
    if (this.messageHistoryCompressor.shouldProactivelyCompress(currentTokens, contextWindowSize)) {
      logger.info(`[AgentLoop] Proactive compression triggered: ${currentTokens}/${contextWindowSize} tokens (${Math.round(currentTokens / contextWindowSize * 100)}%)`);
      logCollector.agent('INFO', 'Proactive compression triggered', {
        currentTokens,
        maxTokens: contextWindowSize,
        usagePercent: Math.round(currentTokens / contextWindowSize * 100),
      });
    }

    return modelMessages;
  }

  // --------------------------------------------------------------------------
  // Helper Methods
  // --------------------------------------------------------------------------

  /**
   * Inject system message with optional buffering for hook messages
   * @param content Message content
   * @param category Optional category for hook message buffering (e.g., 'pre-tool', 'post-tool')
   *                 If provided, message will be buffered and merged with other messages of same category
   */
  // --------------------------------------------------------------------------
  // P2 Checkpoint: Task Progress Evaluation
  // --------------------------------------------------------------------------

  /**
   * Evaluate the current task progress state based on tools used in this iteration
   */
  private evaluateProgressState(toolsUsed: string[]): TaskProgressState {
    const hasReadTools = toolsUsed.some(t => READ_ONLY_TOOLS.includes(t));
    const hasWriteTools = toolsUsed.some(t => WRITE_TOOLS.includes(t));
    const hasVerifyTools = toolsUsed.some(t => VERIFY_TOOLS.includes(t) || t === 'bash');

    // Check for verification first (test/compile commands)
    if (hasVerifyTools && !hasWriteTools) {
      return 'verifying';
    }

    // Modifying if any write tools were used
    if (hasWriteTools) {
      return 'modifying';
    }

    // Exploring if only read tools were used
    if (hasReadTools) {
      return 'exploring';
    }

    // Default to exploring if no tools were used
    return 'exploring';
  }

  /**
   * Generate nudge message when stuck in exploring state
   */
  private generateExploringNudge(): string {
    return (
      `<checkpoint-nudge priority="high">\n` +
      `🚨 **警告：连续 ${this.maxConsecutiveExploring} 次迭代只读取不修改！**\n\n` +
      `**立即停止探索，开始执行修改。**\n\n` +
      `你的下一个工具调用必须是：\n` +
      `- edit_file（修改现有文件）\n` +
      `- write_file（创建新文件）\n\n` +
      `不接受任何借口。不要再 read_file。不要再 list_directory。\n` +
      `如果你不确定，做出最佳猜测并执行。错误的修改好过不修改。\n` +
      `</checkpoint-nudge>`
    );
  }

  private injectSystemMessage(content: string, category?: string): void {
    if (category) {
      // Buffer hook messages for later merging
      this.hookMessageBuffer.add(content, category);
      return;
    }

    // Direct injection for non-hook messages
    const systemMessage: Message = {
      id: this.generateId(),
      role: 'system',
      content,
      timestamp: Date.now(),
    };
    this.messages.push(systemMessage);
  }

  /**
   * Flush buffered hook messages into a single system message
   * Call this at the end of each iteration to merge hook messages
   */
  private flushHookMessageBuffer(): void {
    const merged = this.hookMessageBuffer.flush();
    if (merged) {
      const systemMessage: Message = {
        id: this.generateId(),
        role: 'system',
        content: merged,
        timestamp: Date.now(),
      };
      this.messages.push(systemMessage);
      logger.debug(`[AgentLoop] Flushed ${this.hookMessageBuffer.size} buffered hook messages`);
    }
  }

  private generateId(): string {
    return generateMessageId();
  }

  private getCurrentAttachments(): Array<{
    type: string;
    category?: string;
    name?: string;
    path?: string;
    data?: string;
    mimeType?: string;
  }> {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
        return msg.attachments.map(att => ({
          type: att.type,
          category: att.category,
          name: att.name,
          path: att.path,
          data: att.data,
          mimeType: att.mimeType,
        }));
      }
    }
    return [];
  }

  private async addAndPersistMessage(message: Message): Promise<void> {
    this.messages.push(message);

    // CLI 模式下跳过持久化（由 CLIAgent 自行处理）
    if (process.env.CODE_AGENT_CLI_MODE === 'true') {
      return;
    }

    try {
      const sessionManager = getSessionManager();
      await sessionManager.addMessage(message);
    } catch (error) {
      logger.error('Failed to persist message:', error);
    }
  }

  private updateContextHealth(): void {
    try {
      const contextHealthService = getContextHealthService();
      const model = this.modelConfig.model || DEFAULT_MODELS.chat;

      const messagesForEstimation = this.messages.map(msg => ({
        role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
        content: msg.content,
        toolResults: msg.toolResults?.map(tr => ({
          output: tr.output,
          error: tr.error,
        })),
      }));

      const health = contextHealthService.update(
        this.sessionId,
        messagesForEstimation,
        this.generation.systemPrompt,
        model
      );

      // 更新压缩统计到健康状态
      const compressionStats = this.autoCompressor.getStats();
      if (compressionStats.compressionCount > 0 && health.compression) {
        health.compression.compressionCount = compressionStats.compressionCount;
        health.compression.totalSavedTokens = compressionStats.totalSavedTokens;
        health.compression.lastCompressionAt = compressionStats.lastCompressionAt;
      }
    } catch (error) {
      logger.error('[AgentLoop] Failed to update context health:', error);
    }
  }

  /**
   * 检查并执行自动上下文压缩
   */
  private async checkAndAutoCompress(): Promise<void> {
    try {
      const messagesForCompression = this.messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        id: msg.id,
        timestamp: msg.timestamp,
      }));

      const result = await this.autoCompressor.checkAndCompress(
        this.sessionId,
        messagesForCompression,
        this.generation.systemPrompt,
        this.modelConfig.model || DEFAULT_MODELS.chat,
        this.hookManager
      );

      if (result.compressed) {
        logger.info(`[AgentLoop] Auto compression: saved ${result.savedTokens} tokens using ${result.strategy}`);
        logCollector.agent('INFO', 'Auto context compression', {
          savedTokens: result.savedTokens,
          strategy: result.strategy,
          messageCount: result.messages.length,
        });

        // 发送压缩事件
        this.onEvent({
          type: 'context_compressed',
          data: {
            savedTokens: result.savedTokens,
            strategy: result.strategy,
            newMessageCount: result.messages.length,
          },
        } as AgentEvent);
      }
    } catch (error) {
      logger.error('[AgentLoop] Auto compression failed:', error);
    }
  }

  private async runSessionEndLearning(): Promise<void> {
    try {
      const memoryService = getMemoryService();
      const result = await memoryService.learnFromSession(this.messages);

      logger.info(
        `[AgentLoop] Session learning completed: ` +
        `${result.knowledgeExtracted} knowledge, ` +
        `${result.codeStylesLearned} code styles, ` +
        `${result.toolPreferencesUpdated} tool preferences`
      );

      logCollector.agent('INFO', 'Session learning completed', {
        knowledgeExtracted: result.knowledgeExtracted,
        codeStylesLearned: result.codeStylesLearned,
        toolPreferencesUpdated: result.toolPreferencesUpdated,
      });

      if (result.knowledgeExtracted > 0 || result.codeStylesLearned > 0) {
        this.onEvent({
          type: 'memory_learned',
          data: {
            sessionId: this.sessionId,
            knowledgeExtracted: result.knowledgeExtracted,
            codeStylesLearned: result.codeStylesLearned,
            toolPreferencesUpdated: result.toolPreferencesUpdated,
          },
        } as AgentEvent);
      }

      // 从会话中提取错误模式并学习
      await this.runErrorPatternLearning();

      // 清理低置信度的记忆
      const cleanedCount = memoryService.cleanupDecayedMemories();
      if (cleanedCount > 0) {
        logger.info(`[AgentLoop] Cleaned up ${cleanedCount} decayed memories`);
      }

      // 记录记忆衰减统计
      const decayStats = memoryService.getMemoryDecayStats();
      logger.debug('[AgentLoop] Memory decay stats', {
        total: decayStats.total,
        valid: decayStats.valid,
        needsCleanup: decayStats.needsCleanup,
        avgConfidence: decayStats.avgConfidence.toFixed(2),
      });

    } catch (error) {
      logger.error('[AgentLoop] Session end learning failed:', error);
    }
  }

  /**
   * 从会话中提取错误模式并学习
   */
  private async runErrorPatternLearning(): Promise<void> {
    try {
      const memoryService = getMemoryService();

      // 从消息历史中提取错误
      for (const message of this.messages) {
        if (message.toolResults && message.toolCalls) {
          // 创建 toolCallId -> toolName 映射
          const toolCallMap = new Map<string, string>();
          for (const tc of message.toolCalls) {
            toolCallMap.set(tc.id, tc.name);
          }

          for (const result of message.toolResults) {
            if (!result.success && result.error) {
              // 通过 toolCallId 获取工具名称
              const toolName = toolCallMap.get(result.toolCallId) || 'unknown';

              // 记录错误到学习服务
              memoryService.recordError(
                result.error,
                {
                  toolName,
                  sessionId: this.sessionId,
                  timestamp: message.timestamp,
                },
                toolName
              );

              // 检查后续是否有成功的重试（简单启发式）
              const errorTime = message.timestamp;
              const laterSuccess = this.messages.some((m) => {
                if (m.timestamp <= errorTime) return false;
                if (!m.toolResults || !m.toolCalls) return false;
                // 检查是否有同一工具的成功调用
                const laterToolMap = new Map<string, string>();
                for (const tc of m.toolCalls) {
                  laterToolMap.set(tc.id, tc.name);
                }
                return m.toolResults.some((r) => {
                  const laterToolName = laterToolMap.get(r.toolCallId);
                  return laterToolName === toolName && r.success;
                });
              });

              if (laterSuccess) {
                // 如果后来同一工具成功了，记录为已解决
                const pattern = memoryService.getSuggestedErrorFixes(result.error, toolName);
                if (pattern.length > 0) {
                  memoryService.recordErrorResolution(
                    `${toolName}:${result.error.slice(0, 50)}`,
                    'retry_with_modification',
                    true
                  );
                }
              }
            }
          }
        }
      }

      // 记录错误学习统计
      const errorStats = memoryService.getErrorLearningStats();
      if (errorStats.totalErrors > 0) {
        logger.info('[AgentLoop] Error learning stats', {
          totalPatterns: errorStats.totalPatterns,
          totalErrors: errorStats.totalErrors,
          topCategories: Object.entries(errorStats.byCategory)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([cat, count]) => `${cat}:${count}`)
            .join(', '),
        });
      }
    } catch (error) {
      logger.error('[AgentLoop] Error pattern learning failed:', error);
    }
  }

  private processSkillActivation(skillResult: import('../../shared/types/agentSkill').SkillToolResult): void {
    logger.debug('[AgentLoop] Processing Skill activation result');

    if (skillResult.newMessages) {
      for (const msg of skillResult.newMessages) {
        const messageToInject: Message = {
          id: this.generateId(),
          role: msg.role,
          content: msg.content,
          timestamp: Date.now(),
          isMeta: msg.isMeta,
          source: 'skill',
        };
        this.messages.push(messageToInject);

        if (!msg.isMeta) {
          this.onEvent({ type: 'message', data: messageToInject });
        }
      }
      logger.debug(`[AgentLoop] Injected ${skillResult.newMessages.length} skill messages`);
    }

    if (skillResult.contextModifier) {
      if (skillResult.contextModifier.preApprovedTools) {
        for (const tool of skillResult.contextModifier.preApprovedTools) {
          this.preApprovedTools.add(tool);
        }
        logger.debug(`[AgentLoop] Pre-approved tools: ${[...this.preApprovedTools].join(', ')}`);
      }

      if (skillResult.contextModifier.modelOverride) {
        this.skillModelOverride = skillResult.contextModifier.modelOverride;
        logger.debug(`[AgentLoop] Model override set to: ${this.skillModelOverride}`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Gen8 Self-Evolution Methods
  // --------------------------------------------------------------------------

  /**
   * 根据执行状态确定轨迹结果
   */
  private determineTraceOutcome(iterations: number): {
    outcome: 'success' | 'failure' | 'partial';
    reason: string;
    confidence: number;
  } {
    // 检查是否被取消
    if (this.isCancelled) {
      return {
        outcome: 'partial',
        reason: '用户取消执行',
        confidence: 0.9,
      };
    }

    // 检查是否达到最大迭代次数
    if (iterations >= this.maxIterations) {
      return {
        outcome: 'partial',
        reason: '达到最大迭代次数',
        confidence: 0.7,
      };
    }

    // 检查 circuit breaker 是否触发
    if (this.circuitBreaker.isTripped()) {
      return {
        outcome: 'failure',
        reason: '连续工具调用失败',
        confidence: 0.85,
      };
    }

    // 检查未完成的任务
    const incompleteTodos = getCurrentTodos(this.sessionId).filter(t => t.status !== 'completed');
    const incompleteTasks = getIncompleteTasks(this.sessionId);

    if (incompleteTodos.length > 0 || incompleteTasks.length > 0) {
      return {
        outcome: 'partial',
        reason: `${incompleteTodos.length + incompleteTasks.length} 个待办项未完成`,
        confidence: 0.75,
      };
    }

    // 检查工具使用情况
    const hasWriteTools = this.toolsUsedInTurn.some(t =>
      ['write_file', 'edit_file', 'bash'].includes(t)
    );

    if (!hasWriteTools && this.toolsUsedInTurn.length > 0) {
      // 只有读取操作，可能是信息收集任务
      return {
        outcome: 'success',
        reason: '信息收集任务完成',
        confidence: 0.7,
      };
    }

    // 正常完成
    return {
      outcome: 'success',
      reason: '任务正常完成',
      confidence: 0.8,
    };
  }

  /**
   * 触发进化学习（异步）
   */
  private async triggerEvolutionLearning(
    trace: import('../evolution/traceRecorder').ExecutionTrace,
    outcomeResult: import('../evolution/outcomeDetector').OutcomeResult
  ): Promise<void> {
    // 只从成功案例学习
    if (outcomeResult.outcome !== 'success' || outcomeResult.confidence < 0.7) {
      logger.debug('[AgentLoop] Skipping evolution learning: not a confident success');
      return;
    }

    const genNum = parseInt(this.generation.id.replace('gen', ''), 10);
    if (genNum < 8) {
      logger.debug('[AgentLoop] Skipping evolution learning: requires Gen8+');
      return;
    }

    try {
      // 动态导入以避免循环依赖
      const { getLLMInsightExtractor } = await import('../evolution/llmInsightExtractor');
      const { getSafeInjector } = await import('../evolution/safeInjector');
      const { getSkillEvolutionService } = await import('../evolution/skillEvolutionService');

      const extractor = getLLMInsightExtractor();
      extractor.setModelRouter(this.modelRouter);

      // 提取洞察
      const insights = await extractor.extractFromSuccessfulTraces([trace]);

      logger.info('[AgentLoop] Evolution learning completed', {
        traceId: trace.id,
        insightsExtracted: insights.length,
      });

      // 保存洞察
      for (const insight of insights) {
        const saved = await extractor.saveInsight(insight, trace.projectPath);

        // 如果是 Skill 类型，创建提案
        if (insight.type === 'skill') {
          const skillService = getSkillEvolutionService();
          await skillService.proposeSkill(insight);
        }
      }
    } catch (error) {
      logger.error('[AgentLoop] Evolution learning failed:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Warning Message Generators
  // --------------------------------------------------------------------------

  private generateTruncationWarning(): string {
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

  private generateAutoContinuationPrompt(): string {
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
}
