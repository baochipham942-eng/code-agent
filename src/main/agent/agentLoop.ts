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
import { getPromptForTask } from '../generation/prompts/builder';
import { AntiPatternDetector } from './antiPattern/detector';
import { MAX_PARALLEL_TOOLS, READ_ONLY_TOOLS, WRITE_TOOLS, VERIFY_TOOLS, TaskProgressState } from './loopTypes';
import {
  compressToolResult,
  HookMessageBuffer,
  estimateModelMessageTokens,
  MessageHistoryCompressor,
} from '../context/tokenOptimizer';

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
  private maxIterations: number;

  // Planning integration
  private planningService?: PlanningService;
  private enableHooks: boolean;
  private stopHookRetryCount: number = 0;
  private maxStopHookRetries: number = 3;

  // P1 Nudge: Read-only stop pattern detection
  private readOnlyNudgeCount: number = 0;
  private maxReadOnlyNudges: number = 3; // Increased from 2 to give more chances

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

  // Plan Mode support
  private planModeActive: boolean = false;

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

    await this.initializeUserHooks();

    // Task Complexity Analysis
    const complexityAnalysis = taskComplexityAnalyzer.analyze(userMessage);
    const isSimpleTask = complexityAnalysis.complexity === 'simple';
    this.isSimpleTaskMode = isSimpleTask;

    logger.debug(` Task complexity: ${complexityAnalysis.complexity} (${Math.round(complexityAnalysis.confidence * 100)}%)`);
    logCollector.agent('INFO', `Task complexity: ${complexityAnalysis.complexity}`, {
      confidence: complexityAnalysis.confidence,
      reasons: complexityAnalysis.reasons,
      fastPath: isSimpleTask,
    });

    if (!isSimpleTask) {
      const complexityHint = taskComplexityAnalyzer.generateComplexityHint(complexityAnalysis);
      this.injectSystemMessage(complexityHint);
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

    while (!this.isCancelled && !this.circuitBreaker.isTripped() && iterations < this.maxIterations) {
      iterations++;
      logger.debug(` >>>>>> Iteration ${iterations} START <<<<<<`);

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
      this.readOnlyNudgeCount = 0; // Reset nudge counter for new turn
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
    const genNum = parseInt(this.generation.id.replace('gen', ''), 10);
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

    logger.debug('[AgentLoop] ========== run() END, emitting agent_complete ==========');
    logCollector.agent('INFO', `Agent run completed, ${iterations} iterations`);
    this.onEvent({ type: 'agent_complete', data: null });

    langfuse.flush().catch((err) => logger.error('[Langfuse] Flush error:', err));
  }

  cancel(): void {
    this.isCancelled = true;
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

      logger.debug(` Emitting tool_call_end for ${toolCall.name} (error)`);
      this.onEvent({ type: 'tool_call_end', data: toolResult });

      return toolResult;
    }
  }

  // --------------------------------------------------------------------------
  // Inference
  // --------------------------------------------------------------------------

  private async inference(): Promise<ModelResponse> {
    const tools = this.toolRegistry.getToolDefinitions(this.generation.id);
    logger.debug(` Tools for ${this.generation.id}:`, tools.map(t => t.name));

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

    modelMessages.push({
      role: 'system',
      content: systemPrompt,
    });

    // Apply message history compression for long conversations
    const messagesToProcess = this.messages.map(m => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    }));

    const compressionResult = this.messageHistoryCompressor.compress(messagesToProcess);
    const processedMessages = compressionResult.wasCompressed
      ? compressionResult.messages.map((m, i) => ({
          ...this.messages[i] || { id: '', role: m.role, content: m.content, timestamp: m.timestamp || Date.now() },
          content: m.content,
        }))
      : this.messages;

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

      contextHealthService.update(
        this.sessionId,
        messagesForEstimation,
        this.generation.systemPrompt,
        model
      );
    } catch (error) {
      logger.error('[AgentLoop] Failed to update context health:', error);
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
    } catch (error) {
      logger.error('[AgentLoop] Session end learning failed:', error);
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
