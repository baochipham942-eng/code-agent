// ============================================================================
// Agent Loop - Core event loop for AI agent execution
// Enhanced with Manus-style persistent planning hooks
// ============================================================================

import type {
  Generation,
  ModelConfig,
  Message,
  MessageAttachment,
  ToolCall,
  ToolResult,
  AgentEvent,
  AgentTaskPhase,
} from '../../shared/types';
import type { StructuredOutputConfig, StructuredOutputResult } from './structuredOutput';
import { parseStructuredOutput, toOpenAIResponseFormat, generateFormatCorrectionPrompt } from './structuredOutput';
import type { ToolRegistry } from '../tools/toolRegistry';
import type { ToolExecutor } from '../tools/toolExecutor';
import { ModelRouter, ContextLengthExceededError } from '../model/modelRouter';
import type { PlanningService } from '../planning';
import { getMemoryService } from '../memory/memoryService';
import { getCoreMemoryService } from '../memory/coreMemory';
import { getConfigService, getAuthService, getLangfuseService, getBudgetService, BudgetAlertLevel, getSessionManager } from '../services';
import { getProactiveContextService } from '../memory/proactiveContext';
import { logCollector } from '../mcp/logCollector.js';
import { generateMessageId } from '../../shared/utils/id';
import { taskComplexityAnalyzer } from '../planning/taskComplexityAnalyzer';
import { getMaxIterations } from '../services/cloud/featureFlagService';
import { createLogger } from '../services/infra/logger';
import * as fs from 'fs';
// User-configurable hooks system (Claude Code v2.0 style)
import { HookManager, createHookManager } from '../hooks';
import type { BudgetEventData } from '../../shared/types';
// Context health tracking
import { getContextHealthService } from '../context/contextHealthService';

const logger = createLogger('AgentLoop');

// ----------------------------------------------------------------------------
// Parallel Execution Configuration
// ----------------------------------------------------------------------------

/**
 * Tools that are safe to execute in parallel (stateless, read-only)
 * These tools don't modify state and can be safely parallelized
 */
const PARALLEL_SAFE_TOOLS = new Set([
  'read_file',
  'glob',
  'grep',
  'list_directory',
  'web_fetch',
  'web_search',
  'memory_search',
  'mcp_list_tools',
  'mcp_list_resources',
  'mcp_read_resource',
  'mcp_get_status',
]);

/**
 * Tools that modify state and must be executed sequentially
 */
const SEQUENTIAL_TOOLS = new Set([
  'write_file',
  'edit_file',
  'bash',
  'memory_store',
  'ask_user_question',
  'todo_write',
  'task',
  'spawn_agent',
]);

/**
 * Maximum number of tools to execute in parallel
 */
const MAX_PARALLEL_TOOLS = 4;

/**
 * Check if a tool is safe for parallel execution
 */
function isParallelSafeTool(toolName: string): boolean {
  // MCP tools that are read-only
  if (toolName.startsWith('mcp_') && !toolName.includes('write') && !toolName.includes('create')) {
    return true;
  }
  return PARALLEL_SAFE_TOOLS.has(toolName);
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Agent Loop 配置
 * @internal
 */
export interface AgentLoopConfig {
  generation: Generation;
  modelConfig: ModelConfig;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  messages: Message[];
  onEvent: (event: AgentEvent) => void;
  // New: optional planning service for persistent planning
  planningService?: PlanningService;
  // New: enable/disable hooks
  enableHooks?: boolean;
  // New: user-configurable hook manager (Claude Code v2.0 style)
  hookManager?: HookManager;
  // Session metadata for tracing
  sessionId?: string;
  userId?: string;
  // Working directory for file operations
  workingDirectory: string;
  // Whether the working directory is the default sandbox (not user-specified)
  isDefaultWorkingDirectory?: boolean;
  // T6: Structured output configuration for adaptive output mode
  // When enabled, the model will return JSON that conforms to the specified schema
  structuredOutput?: StructuredOutputConfig;
}

interface ModelResponse {
  type: 'text' | 'tool_use';
  content?: string;
  toolCalls?: ToolCall[];
  truncated?: boolean; // 标记输出是否因 max_tokens 限制被截断
  finishReason?: string; // 原始的 finish_reason
}

// 多模态消息内容类型（与 ModelRouter 保持一致）
interface MessageContent {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

interface ModelMessage {
  role: string;
  content: string | MessageContent[];
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
 *
 * 增强功能：
 * - Turn-Based 消息模型（每轮迭代 = 一条前端消息）
 * - 任务复杂度自动分析
 * - Anti-pattern 检测（防止无限读取循环）
 * - Planning Hooks 集成
 * - Plan Mode 支持（Claude Code v2.0 风格）
 * - Langfuse 追踪集成
 *
 * @example
 * ```typescript
 * const loop = new AgentLoop({
 *   generation,
 *   modelConfig,
 *   toolRegistry,
 *   toolExecutor,
 *   messages: [],
 *   onEvent: (event) => console.log(event),
 * });
 *
 * await loop.run('帮我创建一个 React 组件');
 * loop.cancel(); // 取消执行
 * ```
 *
 * @see AgentOrchestrator - 上层控制器
 * @see PlanningService - 规划服务
 * @see ToolExecutor - 工具执行器
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

  // User-configurable hooks (Claude Code v2.0 style)
  private hookManager?: HookManager;
  private userHooksInitialized: boolean = false;

  // Tool call format retry (when model describes tool call as text instead of using tool_use)
  private toolCallRetryCount: number = 0;
  private maxToolCallRetries: number = 2;

  // Anti-pattern detection: track consecutive read-only operations
  private consecutiveReadOps: number = 0;
  private maxConsecutiveReadsBeforeWarning: number = 5;
  private hasWrittenFile: boolean = false;

  // Anti-pattern detection: track repeated tool failures with same error
  private toolFailureTracker: Map<string, { count: number; lastError: string }> = new Map();
  private maxSameToolFailures: number = 3;

  // Anti-pattern detection: track repeated SUCCESSFUL calls with same arguments (infinite loop prevention)
  private duplicateCallTracker: Map<string, number> = new Map();
  private readonly MAX_DUPLICATE_CALLS: number = 3;

  // Circuit breaker: consecutive tool call failures
  private consecutiveToolFailures: number = 0;
  private readonly MAX_CONSECUTIVE_FAILURES: number = 5;
  private circuitBreakerTripped: boolean = false; // 熔断标志，触发后强制中断循环

  // Hard limit for consecutive read operations (force stop, not just warning)
  private readonly MAX_CONSECUTIVE_READS_HARD_LIMIT: number = 15;

  // Plan Mode support (borrowed from Claude Code v2.0)
  private planModeActive: boolean = false;

  // Langfuse tracing
  private sessionId: string;
  private userId?: string;
  private traceId: string = '';
  private currentIterationSpanId: string = '';

  // Turn-based message tracking
  private currentTurnId: string = '';

  // Skill 系统支持 (Agent Skills 标准)
  // 预授权工具：Skill 激活后，这些工具可以跳过权限确认
  private preApprovedTools: Set<string> = new Set();
  // Skill 指定的模型覆盖
  private skillModelOverride?: string;

  // Task progress tracking (长时任务进度追踪)
  private turnStartTime: number = 0;
  private toolsUsedInTurn: string[] = [];

  // PERFORMANCE OPTIMIZATION: Track if current task is simple to skip expensive operations
  private isSimpleTaskMode: boolean = false;

  // Working directory context
  private workingDirectory: string;
  private isDefaultWorkingDirectory: boolean;

  // Budget tracking (预算追踪)
  private budgetWarningEmitted: boolean = false;

  // T6: Structured output configuration
  private structuredOutput?: StructuredOutputConfig;
  private structuredOutputRetryCount: number = 0;
  private maxStructuredOutputRetries: number = 2;

  constructor(config: AgentLoopConfig) {
    this.generation = config.generation;
    this.modelConfig = config.modelConfig;
    this.toolRegistry = config.toolRegistry;
    this.toolExecutor = config.toolExecutor;
    // 复制消息数组，确保并行会话之间的隔离
    // 注意：这是浅拷贝，Message 对象本身是引用，但足够安全因为我们不修改已有消息
    this.messages = [...config.messages];
    this.onEvent = config.onEvent;
    this.modelRouter = new ModelRouter();

    // Max iterations from Feature Flag (云端热更新)
    this.maxIterations = getMaxIterations();

    // Planning service integration
    this.planningService = config.planningService;
    this.enableHooks = config.enableHooks ?? true;

    // User-configurable hooks (from .claude/settings.json)
    // Can be provided externally or created on demand
    this.hookManager = config.hookManager;

    // Working directory
    this.workingDirectory = config.workingDirectory;
    this.isDefaultWorkingDirectory = config.isDefaultWorkingDirectory ?? true;

    // Tracing metadata
    this.sessionId = config.sessionId || `session-${Date.now()}`;
    this.userId = config.userId;

    // T6: Structured output configuration
    this.structuredOutput = config.structuredOutput;
  }

  /**
   * Initialize user-configurable hooks if not already done
   */
  private async initializeUserHooks(): Promise<void> {
    if (this.userHooksInitialized) return;

    // Create hook manager if not provided and hooks are enabled
    if (!this.hookManager && this.enableHooks) {
      // Use current working directory since Generation doesn't have workingDirectory
      this.hookManager = createHookManager({
        workingDirectory: process.cwd(),
        enabled: this.enableHooks,
      });
    }

    // Initialize the hook manager
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
  // Plan Mode Methods (borrowed from Claude Code v2.0)
  // --------------------------------------------------------------------------

  /**
   * 设置 Plan Mode 状态
   *
   * Plan Mode 是 Claude Code v2.0 引入的规划模式：
   * - 激活时：Agent 进入只读模式，专注于分析和规划
   * - 停用时：Agent 恢复正常执行，可以进行写操作
   *
   * @param active - true 激活 Plan Mode，false 停用
   */
  setPlanMode(active: boolean): void {
    this.planModeActive = active;
    logger.debug(` Plan mode ${active ? 'activated' : 'deactivated'}`);
    // Emit event to notify frontend
    this.onEvent({
      type: 'notification',
      data: { message: `Plan mode ${active ? 'activated' : 'deactivated'}` },
    });
  }

  /**
   * 检查 Plan Mode 是否处于激活状态
   *
   * @returns true 表示 Plan Mode 激活，false 表示正常模式
   */
  isPlanMode(): boolean {
    return this.planModeActive;
  }

  // --------------------------------------------------------------------------
  // Structured Output Methods (T6: Adaptive Output Mode)
  // --------------------------------------------------------------------------

  /**
   * Set structured output configuration
   *
   * Used for adaptive output mode switching:
   * - For humans: Call with undefined to disable structured output
   * - For machines/APIs: Call with config to enable JSON schema output
   *
   * @param config - Structured output configuration, or undefined to disable
   */
  setStructuredOutput(config: StructuredOutputConfig | undefined): void {
    this.structuredOutput = config;
    this.structuredOutputRetryCount = 0;
    logger.debug(` Structured output ${config?.enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get current structured output configuration
   */
  getStructuredOutput(): StructuredOutputConfig | undefined {
    return this.structuredOutput;
  }

  /**
   * Parse structured output from model response
   *
   * @param content - Raw content from model response
   * @returns Parsed result with success flag and data or errors
   */
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

  /**
   * Check if structured output retry is needed and possible
   */
  private shouldRetryStructuredOutput(result: StructuredOutputResult): boolean {
    if (result.success) return false;
    if (!this.structuredOutput?.enabled) return false;
    if (this.structuredOutput.onParseError !== 'retry') return false;
    if (this.structuredOutputRetryCount >= this.maxStructuredOutputRetries) return false;
    return true;
  }

  /**
   * Inject format correction prompt for structured output retry
   */
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
  // Public Methods
  // --------------------------------------------------------------------------

  /**
   * 启动 Agent 执行循环
   *
   * 核心执行流程：
   * 1. 分析任务复杂度并注入提示
   * 2. 运行 Session Start Hook（如果启用）
   * 3. 进入主循环：推理 → 执行工具 → 反馈
   * 4. 运行 Session End Hook（如果启用）
   *
   * @param userMessage - 用户输入的消息内容
   * @returns Promise 在循环完成后 resolve
   * @throws 可能抛出模型调用或工具执行相关的错误
   */
  async run(userMessage: string): Promise<void> {
    logger.debug('[AgentLoop] ========== run() START ==========');
    logger.debug('[AgentLoop] Message:', userMessage.substring(0, 100));

    // Log to centralized collector
    logCollector.agent('INFO', `Agent run started: "${userMessage.substring(0, 80)}..."`);
    logCollector.agent('DEBUG', `Generation: ${this.generation.id}, Model: ${this.modelConfig.provider}`);

    // Langfuse: Start trace for this agent run
    const langfuse = getLangfuseService();
    this.traceId = `trace-${this.sessionId}-${Date.now()}`;
    langfuse.startTrace(this.traceId, {
      sessionId: this.sessionId,
      userId: this.userId,
      generationId: this.generation.id,
      modelProvider: this.modelConfig.provider,
      modelName: this.modelConfig.model,
    }, userMessage);

    // Initialize user-configurable hooks (Claude Code v2.0 style)
    // This loads hooks from .claude/settings.json
    await this.initializeUserHooks();

    // Task Complexity Analysis - 自动检测任务复杂度并注入提示
    const complexityAnalysis = taskComplexityAnalyzer.analyze(userMessage);
    const isSimpleTask = complexityAnalysis.complexity === 'simple';

    // Store in instance for use by buildEnhancedSystemPrompt
    this.isSimpleTaskMode = isSimpleTask;

    logger.debug(` Task complexity: ${complexityAnalysis.complexity} (${Math.round(complexityAnalysis.confidence * 100)}%)`);
    logCollector.agent('INFO', `Task complexity: ${complexityAnalysis.complexity}`, {
      confidence: complexityAnalysis.confidence,
      reasons: complexityAnalysis.reasons,
      fastPath: isSimpleTask, // 简单任务使用快速路径
    });

    // PERFORMANCE OPTIMIZATION: Skip complexity hint injection for simple tasks
    // Simple tasks don't need explicit guidance - just execute directly
    if (!isSimpleTask) {
      const complexityHint = taskComplexityAnalyzer.generateComplexityHint(complexityAnalysis);
      this.injectSystemMessage(complexityHint);
    }

    // User-configurable hooks: Trigger UserPromptSubmit
    // This allows hooks to modify or block user prompts
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
        // Hook wants to inject context
        this.injectSystemMessage(`<user-prompt-hook>\n${promptResult.message}\n</user-prompt-hook>`);
      }
    }

    // PERFORMANCE OPTIMIZATION: Skip session start hook for simple tasks
    // Planning hooks add ~200-500ms overhead that simple tasks don't need
    const shouldRunHooks = this.enableHooks && this.planningService && !isSimpleTask;
    if (shouldRunHooks) {
      await this.runSessionStartHook();
    }

    // User-configurable hooks: Trigger SessionStart (runs alongside planning hooks)
    if (this.hookManager && !isSimpleTask) {
      const sessionResult = await this.hookManager.triggerSessionStart(this.sessionId);
      if (sessionResult.message) {
        this.injectSystemMessage(`<session-start-hook>\n${sessionResult.message}\n</session-start-hook>`);
      }
    }

    let iterations = 0;

    while (!this.isCancelled && !this.circuitBreakerTripped && iterations < this.maxIterations) {
      iterations++;
      logger.debug(` >>>>>> Iteration ${iterations} START <<<<<<`);

      // Budget check before each iteration
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

      // Generate turn ID for this iteration
      // Turn-based message model: 每轮迭代对应一条前端消息
      this.currentTurnId = generateMessageId();

      // Langfuse: Start iteration span
      this.currentIterationSpanId = `iteration-${this.traceId}-${iterations}`;
      langfuse.startSpan(this.traceId, this.currentIterationSpanId, {
        name: `Iteration ${iterations}`,
        metadata: { iteration: iterations, turnId: this.currentTurnId },
      });

      // Emit turn_start event - 前端据此创建新的 assistant 消息
      this.onEvent({
        type: 'turn_start',
        data: { turnId: this.currentTurnId, iteration: iterations },
      });

      // 记录本轮开始时间，重置工具使用记录
      this.turnStartTime = Date.now();
      this.toolsUsedInTurn = [];

      // 发送 thinking 进度状态
      this.emitTaskProgress('thinking', '分析请求中...');

      // 1. Call model
      logger.debug('[AgentLoop] Calling inference...');
      const inferenceStartTime = Date.now();
      let response = await this.inference();
      const inferenceDuration = Date.now() - inferenceStartTime;
      logger.debug('[AgentLoop] Inference response type:', response.type);

      // Langfuse: Log inference event
      langfuse.logEvent(this.traceId, 'inference_complete', {
        iteration: iterations,
        responseType: response.type,
        duration: inferenceDuration,
      });

      // 2. Handle text response - check for text-described tool calls first
      if (response.type === 'text' && response.content) {
        // 检测模型是否错误地用文本描述工具调用而非实际调用
        const failedToolCallMatch = this.detectFailedToolCallPattern(response.content);
        if (failedToolCallMatch) {
          // 尝试解析参数并强制执行
          const forceExecuteResult = this.tryForceExecuteTextToolCall(failedToolCallMatch, response.content);
          if (forceExecuteResult) {
            logger.info(`[AgentLoop] Force executing text-described tool call: ${failedToolCallMatch.toolName}`);
            logCollector.agent('INFO', `Force executing text tool call: ${failedToolCallMatch.toolName}`);

            // 转换为 tool_use 响应，跳过后续 text 处理
            response = {
              type: 'tool_use',
              toolCalls: [forceExecuteResult],
            };
            // 注意：这里不 continue，下面的 if 块检查会失败，自动进入 tool_use 处理
          } else if (this.toolCallRetryCount < this.maxToolCallRetries) {
            // 无法解析参数，使用原有重试逻辑
            this.toolCallRetryCount++;
            logger.warn(`[AgentLoop] Detected text description of tool call instead of actual tool_use: "${failedToolCallMatch.toolName}"`);
            logCollector.agent('WARN', `Model described tool call as text instead of using tool_use: ${failedToolCallMatch.toolName}`);

            // 注入系统消息提醒模型正确使用工具
            this.injectSystemMessage(
              `<tool-call-format-error>\n` +
              `⚠️ ERROR: You just described a tool call as text instead of actually calling the tool.\n` +
              `You wrote: "${response.content.slice(0, 200)}..."\n\n` +
              `This is WRONG. You must use the actual tool calling mechanism, not describe it in text.\n` +
              `Please call the "${failedToolCallMatch.toolName}" tool properly using the tool_use format.\n` +
              `</tool-call-format-error>`
            );

            // 继续循环，让模型重新调用
            logger.debug(`[AgentLoop] Tool call retry ${this.toolCallRetryCount}/${this.maxToolCallRetries}`);
            continue;
          }
        }
      }

      // 2b. Handle actual text response (not converted to tool_use)
      if (response.type === 'text' && response.content) {

        // 发送生成中进度
        this.emitTaskProgress('generating', '生成回复中...');

        // User-configurable Stop hook
        if (this.hookManager && !isSimpleTask) {
          try {
            const userStopResult = await this.hookManager.triggerStop(response.content, this.sessionId);
            if (!userStopResult.shouldProceed) {
              // User hook wants to prevent stopping (continue execution)
              logger.info('[AgentLoop] Stop prevented by user hook', { message: userStopResult.message });
              if (userStopResult.message) {
                this.injectSystemMessage(`<stop-hook>\n${userStopResult.message}\n</stop-hook>`);
              }
              continue; // Force another iteration
            }
            if (userStopResult.message) {
              this.injectSystemMessage(`<stop-hook>\n${userStopResult.message}\n</stop-hook>`);
            }
          } catch (error) {
            logger.error('[AgentLoop] User stop hook error:', error);
          }
        }

        // PERFORMANCE OPTIMIZATION: Skip planning stop hook for simple tasks
        // Stop hook reads plan from disk which adds ~100-200ms latency
        if (shouldRunHooks) {
          const stopResult = await this.planningService!.hooks.onStop();

          if (!stopResult.shouldContinue && stopResult.injectContext) {
            // Check retry limit to avoid infinite loops
            this.stopHookRetryCount++;

            if (this.stopHookRetryCount <= this.maxStopHookRetries) {
              // Plan not complete, inject warning and continue
              this.injectSystemMessage(stopResult.injectContext);

              if (stopResult.notification) {
                this.onEvent({
                  type: 'notification',
                  data: { message: stopResult.notification },
                });
              }

              logger.debug(` Stop hook retry ${this.stopHookRetryCount}/${this.maxStopHookRetries}`);
              continue; // Force another iteration
            } else {
              // Max retries reached, let AI stop with a warning
              logger.debug('[AgentLoop] Stop hook max retries reached, allowing stop');
              logCollector.agent('WARN', `Stop hook max retries (${this.maxStopHookRetries}) reached, plan may be incomplete`);

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

        const assistantMessage: Message = {
          id: this.generateId(),
          role: 'assistant',
          content: response.content,
          timestamp: Date.now(),
        };
        await this.addAndPersistMessage(assistantMessage);
        this.onEvent({ type: 'message', data: assistantMessage });

        // Langfuse: End iteration span and break
        langfuse.endSpan(this.currentIterationSpanId, { type: 'text_response' });

        // 发送任务完成进度
        this.emitTaskProgress('completed', '回复完成');
        this.emitTaskComplete();

        // Emit turn_end event - 本轮 Agent Loop 结束
        this.onEvent({
          type: 'turn_end',
          data: { turnId: this.currentTurnId },
        });

        // Update context health after turn completes
        this.updateContextHealth();
        break;
      }

      // 3. Handle tool calls
      if (response.type === 'tool_use' && response.toolCalls) {
        logger.debug(` Tool calls received: ${response.toolCalls.length} calls`);

        // 发送工具等待状态
        this.emitTaskProgress('tool_pending', `准备执行 ${response.toolCalls.length} 个工具`, {
          toolTotal: response.toolCalls.length,
        });

        // 检测工具调用是否因为 max_tokens 被截断
        if (response.truncated) {
          logger.warn('[AgentLoop] ⚠️ Tool call was truncated due to max_tokens limit!');
          logCollector.agent('WARN', 'Tool call truncated - content may be incomplete');

          // 检查是否有 write_file 工具调用，其 content 可能被截断
          const writeFileCall = response.toolCalls.find(tc => tc.name === 'write_file');
          if (writeFileCall) {
            const content = writeFileCall.arguments?.content as string;
            if (content) {
              logger.warn(`write_file content length: ${content.length} chars - may be truncated!`);

              // 注入系统消息强制使用分步生成
              this.injectSystemMessage(
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
          }
        }

        response.toolCalls.forEach((tc, i) => {
          logger.debug(`   Tool ${i + 1}: ${tc.name}, args keys: ${Object.keys(tc.arguments || {}).join(', ')}`);
          // Log tool calls to centralized collector
          logCollector.tool('INFO', `Tool call: ${tc.name}`, { toolId: tc.id, args: tc.arguments });
        });

        // Create assistant message with tool calls
        const assistantMessage: Message = {
          id: this.generateId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          toolCalls: response.toolCalls,
        };
        await this.addAndPersistMessage(assistantMessage);

        // Send the message event to frontend so it can display tool calls
        logger.debug('[AgentLoop] Emitting message event for tool calls');
        this.onEvent({ type: 'message', data: assistantMessage });

        // Execute tools (with hooks)
        logger.debug('[AgentLoop] Starting executeToolsWithHooks...');
        const toolResults = await this.executeToolsWithHooks(response.toolCalls);
        logger.debug(` executeToolsWithHooks completed, ${toolResults.length} results`);
        toolResults.forEach((r, i) => {
          logger.debug(`   Result ${i + 1}: success=${r.success}, error=${r.error || 'none'}`);
          // Log tool results to centralized collector
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

        // Create tool result message
        // 清理大型二进制数据（如 imageBase64）以避免上下文超限
        // 前端已通过 tool_call_end 事件获取完整数据用于渲染
        const sanitizedResults = this.sanitizeToolResultsForHistory(toolResults);

        const toolMessage: Message = {
          id: this.generateId(),
          role: 'tool',
          content: JSON.stringify(sanitizedResults),
          timestamp: Date.now(),
          toolResults: sanitizedResults,
        };
        await this.addAndPersistMessage(toolMessage);

        // Langfuse: End iteration span
        langfuse.endSpan(this.currentIterationSpanId, {
          type: 'tool_calls',
          toolCount: response.toolCalls.length,
          successCount: toolResults.filter(r => r.success).length,
        });

        // Emit turn_end event - 本轮 Agent Loop 结束（工具调用完成）
        this.onEvent({
          type: 'turn_end',
          data: { turnId: this.currentTurnId },
        });

        // Update context health after turn completes
        this.updateContextHealth();

        // Continue loop
        logger.debug(` >>>>>> Iteration ${iterations} END (continuing) <<<<<<`);
        continue;
      }

      // No response, break
      break;
    }

    if (this.circuitBreakerTripped) {
      // 熔断触发，生成一条 assistant 消息告知用户
      logger.info('[AgentLoop] Loop exited due to circuit breaker');
      logCollector.agent('WARN', `Circuit breaker stopped agent after ${iterations} iterations`);

      // 发送一条文本消息给用户，解释发生了什么
      const errorMessage: Message = {
        id: this.generateId(),
        role: 'assistant',
        content: '⚠️ **工具调用异常**\n\n连续多次工具调用失败，已自动停止执行。这可能是由于：\n- 文件路径不存在\n- 网络连接问题\n- 工具参数错误\n\n请检查上面的错误信息，然后告诉我如何继续。',
        timestamp: Date.now(),
      };
      await this.addAndPersistMessage(errorMessage);
      this.onEvent({ type: 'message', data: errorMessage });

      // Langfuse: End trace with error
      langfuse.endTrace(this.traceId, `Circuit breaker tripped after ${iterations} iterations`, 'ERROR');

      // 重置熔断标志，允许用户在新消息中继续
      this.circuitBreakerTripped = false;
    } else if (iterations >= this.maxIterations) {
      logger.debug('[AgentLoop] Max iterations reached!');
      logCollector.agent('WARN', `Max iterations reached (${this.maxIterations})`);
      this.onEvent({
        type: 'error',
        data: { message: 'Max iterations reached' },
      });

      // Langfuse: End trace with warning
      langfuse.endTrace(this.traceId, `Max iterations (${this.maxIterations}) reached`, 'WARNING');
    } else {
      // Langfuse: End trace normally
      langfuse.endTrace(this.traceId, `Completed in ${iterations} iterations`);
    }

    // Session End Learning (Gen5+ Memory System)
    // 会话结束时自动提取知识，异步执行不阻塞主流程
    const genNum = parseInt(this.generation.id.replace('gen', ''), 10);
    if (genNum >= 5 && this.messages.length > 0) {
      this.runSessionEndLearning().catch((err) => {
        logger.error('[AgentLoop] Session end learning error:', err);
      });
    }

    // User-configurable hooks: Trigger SessionEnd
    if (this.hookManager) {
      try {
        await this.hookManager.triggerSessionEnd(this.sessionId);
      } catch (error) {
        logger.error('[AgentLoop] Session end hook error:', error);
      }
    }

    // Signal completion to frontend
    logger.debug('[AgentLoop] ========== run() END, emitting agent_complete ==========');
    logCollector.agent('INFO', `Agent run completed, ${iterations} iterations`);
    this.onEvent({ type: 'agent_complete', data: null });

    // Langfuse: Flush to ensure data is sent
    langfuse.flush().catch((err) => logger.error('[Langfuse] Flush error:', err));
  }

  /**
   * 更新上下文健康度
   * 在每轮迭代结束后调用，计算并发送上下文使用情况
   */
  private updateContextHealth(): void {
    try {
      const contextHealthService = getContextHealthService();
      const model = this.modelConfig.model || 'deepseek-chat';

      // 将内部消息转换为 ContextMessage 格式
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

  /**
   * 会话结束自动学习
   * 从本次对话中提取知识并存储到 Memory 系统
   * 仅 Gen5+ 启用
   */
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

      // 发送学习完成事件到前端
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

  /**
   * 取消当前执行循环
   *
   * 设置取消标志，循环将在当前迭代完成后退出
   */
  cancel(): void {
    this.isCancelled = true;
  }

  /**
   * 获取规划服务实例
   *
   * 供工具（如 plan_mode）获取规划服务以进行状态管理
   *
   * @returns PlanningService 实例，如果未配置则返回 undefined
   */
  getPlanningService(): PlanningService | undefined {
    return this.planningService;
  }

  // --------------------------------------------------------------------------
  // Task Progress Methods (长时任务进度追踪)
  // --------------------------------------------------------------------------

  /**
   * 发送任务进度事件
   */
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

  /**
   * 发送任务完成事件
   */
  private emitTaskComplete(): void {
    const duration = Date.now() - this.turnStartTime;
    this.onEvent({
      type: 'task_complete',
      data: {
        turnId: this.currentTurnId,
        duration,
        toolsUsed: [...new Set(this.toolsUsedInTurn)], // 去重
      },
    });
  }

  // --------------------------------------------------------------------------
  // Budget Methods (预算管理)
  // --------------------------------------------------------------------------

  /**
   * Check budget status and emit events if thresholds are reached
   * @returns true if execution should be blocked due to budget
   */
  private checkAndEmitBudgetStatus(): boolean {
    const budgetService = getBudgetService();
    const status = budgetService.checkBudget();

    // Build event data
    const eventData: BudgetEventData = {
      currentCost: status.currentCost,
      maxBudget: status.maxBudget,
      usagePercentage: status.usagePercentage,
      remaining: status.remaining,
      alertLevel: status.alertLevel === BudgetAlertLevel.BLOCKED ? 'blocked' :
                  status.alertLevel === BudgetAlertLevel.WARNING ? 'warning' : 'silent',
      message: status.message,
    };

    // Handle different alert levels
    switch (status.alertLevel) {
      case BudgetAlertLevel.BLOCKED:
        // Emit budget_exceeded event and return true to block
        this.onEvent({ type: 'budget_exceeded', data: eventData });
        return true;

      case BudgetAlertLevel.WARNING:
        // Emit budget_warning event (only once per session)
        if (!this.budgetWarningEmitted) {
          logger.warn(`[AgentLoop] Budget warning: ${status.message}`);
          logCollector.agent('WARN', `Budget warning: ${(status.usagePercentage * 100).toFixed(0)}% used`);
          this.onEvent({ type: 'budget_warning', data: eventData });
          this.budgetWarningEmitted = true;
        }
        return false;

      case BudgetAlertLevel.SILENT:
        // Silent log already handled by BudgetService
        return false;

      default:
        return false;
    }
  }

  /**
   * Record token usage after model inference
   * Called after each successful model call
   */
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

  private async executeToolsWithHooks(
    toolCalls: ToolCall[]
  ): Promise<ToolResult[]> {
    logger.debug(` executeToolsWithHooks called with ${toolCalls.length} tool calls`);

    // Phase 1: Classify tools into parallel-safe and sequential groups
    const parallelGroup: Array<{ index: number; toolCall: ToolCall }> = [];
    const sequentialGroup: Array<{ index: number; toolCall: ToolCall }> = [];

    for (let i = 0; i < toolCalls.length; i++) {
      const toolCall = toolCalls[i];
      if (isParallelSafeTool(toolCall.name)) {
        parallelGroup.push({ index: i, toolCall });
      } else {
        sequentialGroup.push({ index: i, toolCall });
      }
    }

    logger.debug(` Tool classification: ${parallelGroup.length} parallel-safe, ${sequentialGroup.length} sequential`);

    // Results array to maintain original order
    const results: ToolResult[] = new Array(toolCalls.length);

    // Phase 2: Execute parallel-safe tools first (if any)
    if (parallelGroup.length > 1) {
      logger.debug(` Executing ${parallelGroup.length} parallel-safe tools in parallel (max ${MAX_PARALLEL_TOOLS})`);

      // Execute in batches of MAX_PARALLEL_TOOLS
      for (let batchStart = 0; batchStart < parallelGroup.length; batchStart += MAX_PARALLEL_TOOLS) {
        const batch = parallelGroup.slice(batchStart, batchStart + MAX_PARALLEL_TOOLS);

        // Emit start events for all tools in batch
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

        // Execute batch in parallel
        const batchPromises = batch.map(async ({ index, toolCall }) => {
          const result = await this.executeSingleTool(toolCall, index, toolCalls.length);
          return { index, result };
        });

        const batchResults = await Promise.all(batchPromises);

        // Store results in correct positions
        for (const { index, result } of batchResults) {
          results[index] = result;
        }
      }
    } else if (parallelGroup.length === 1) {
      // Single parallel-safe tool - execute normally
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

    // Phase 3: Execute sequential tools one by one
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

    // Filter out undefined results (from cancelled executions)
    return results.filter((r): r is ToolResult => r !== undefined);
  }

  /**
   * Execute a single tool with hooks and event emission
   * Extracted to support both parallel and sequential execution
   */
  private async executeSingleTool(
    toolCall: ToolCall,
    index: number,
    total: number
  ): Promise<ToolResult> {
    logger.debug(` [${index + 1}/${total}] Processing tool: ${toolCall.name}, id: ${toolCall.id}`);

    // User-configurable Pre-Tool Hook (can block tool execution)
    // Run before planning hooks so user hooks can veto tool calls
    if (this.hookManager && !isParallelSafeTool(toolCall.name)) {
      try {
        const toolInput = JSON.stringify(toolCall.arguments);
        const userHookResult = await this.hookManager.triggerPreToolUse(
          toolCall.name,
          toolInput,
          this.sessionId
        );

        if (!userHookResult.shouldProceed) {
          // User hook blocked this tool call
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

    // Planning Pre-Tool Hook (only for sequential tools to avoid race conditions)
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

    // 检测工具参数是否解析失败
    const args = toolCall.arguments as Record<string, unknown>;
    if (args && args.__parseError === true) {
      const errorMessage = args.__errorMessage as string || 'Unknown JSON parse error';
      const rawArgs = args.__rawArguments as string || '';

      logger.error(`[AgentLoop] Tool ${toolCall.name} arguments failed to parse: ${errorMessage}`);
      logger.error(`[AgentLoop] Raw arguments: ${rawArgs.substring(0, 200)}`);
      logCollector.tool('ERROR', `Tool ${toolCall.name} arguments parse error: ${errorMessage}`, {
        toolCallId: toolCall.id,
        rawArguments: rawArgs.substring(0, 500),
      });

      // 返回解析错误作为工具执行失败
      const toolResult: ToolResult = {
        toolCallId: toolCall.id,
        success: false,
        error: `Tool arguments JSON parse error: ${errorMessage}. Raw: ${rawArgs.substring(0, 200)}...`,
        duration: Date.now() - startTime,
      };

      // 注入系统消息提醒模型
      this.injectSystemMessage(
        `<tool-arguments-parse-error>\n` +
        `⚠️ ERROR: Failed to parse JSON arguments for tool "${toolCall.name}".\n` +
        `Parse error: ${errorMessage}\n` +
        `Raw arguments (truncated): ${rawArgs.substring(0, 300)}\n\n` +
        `Please ensure your tool call arguments are valid JSON.\n` +
        `</tool-arguments-parse-error>`
      );

      // 发送工具调用结束事件
      this.onEvent({ type: 'tool_call_end', data: toolResult });
      return toolResult;
    }

    try {
      // Execute tool
      logger.debug(` Calling toolExecutor.execute for ${toolCall.name}...`);

      // Get current attachments from the latest user message (for multi-agent workflows)
      const currentAttachments = this.getCurrentAttachments();

      const result = await this.toolExecutor.execute(
        toolCall.name,
        toolCall.arguments,
        {
          generation: this.generation,
          planningService: this.planningService, // Pass planning service to tools
          modelConfig: this.modelConfig, // Pass model config for subagent execution
          // Plan Mode support (borrowed from Claude Code v2.0)
          setPlanMode: this.setPlanMode.bind(this),
          isPlanMode: this.isPlanMode.bind(this),
          // emitEvent allows tools to emit custom events - automatically includes sessionId
          emitEvent: (event: string, data: unknown) => this.onEvent({ type: event, data, sessionId: this.sessionId } as AgentEvent),
          // Session ID for cross-session isolation (fixes todo pollution)
          sessionId: this.sessionId,
          // Skill 系统支持：预授权工具列表
          preApprovedTools: this.preApprovedTools,
          // Current message attachments for multi-agent workflows (images, files)
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
        metadata: result.metadata, // 保留工具返回的元数据（如图片路径、base64 等）
      };

      logger.debug(` Tool ${toolCall.name} completed in ${toolResult.duration}ms`);

      // Circuit breaker: track consecutive tool failures
      if (!result.success) {
        this.consecutiveToolFailures++;
        logger.debug(`[AgentLoop] Consecutive tool failures: ${this.consecutiveToolFailures}/${this.MAX_CONSECUTIVE_FAILURES}`);

        // Check if circuit breaker should trip
        if (this.consecutiveToolFailures >= this.MAX_CONSECUTIVE_FAILURES) {
          logger.error(`[AgentLoop] Circuit breaker tripped! ${this.consecutiveToolFailures} consecutive failures`);
          logCollector.agent('ERROR', `Circuit breaker tripped after ${this.consecutiveToolFailures} consecutive tool failures`);

          // Inject a strong warning to the model
          this.injectSystemMessage(
            `<circuit-breaker-tripped>\n` +
            `🛑 CRITICAL ERROR: ${this.consecutiveToolFailures} consecutive tool calls have FAILED.\n\n` +
            `The last error was: ${result.error}\n\n` +
            `You MUST:\n` +
            `1. STOP calling tools immediately\n` +
            `2. Report this error to the user clearly\n` +
            `3. Explain what you were trying to do and why it failed\n` +
            `4. Ask the user for guidance on how to proceed\n\n` +
            `DO NOT continue attempting tool calls until the user responds.\n` +
            `</circuit-breaker-tripped>`
          );

          // Emit error event to frontend
          this.onEvent({
            type: 'error',
            data: {
              message: `连续 ${this.consecutiveToolFailures} 次工具调用失败，已触发熔断机制。最后错误: ${result.error || 'Unknown error'}`,
              code: 'CIRCUIT_BREAKER_TRIPPED',
            },
          });

          // 设置熔断标志，强制中断 Agent 循环
          // 不能依赖模型遵守"停止调用工具"的指令，必须在代码层面强制停止
          this.circuitBreakerTripped = true;
          logger.info(`[AgentLoop] Circuit breaker flag set, will exit loop after current iteration`);

          // Reset counter to allow future attempts after user intervention (new session)
          this.consecutiveToolFailures = 0;
        }
      } else {
        // Reset consecutive failure counter on success
        if (this.consecutiveToolFailures > 0) {
          logger.debug(`[AgentLoop] Tool succeeded, resetting consecutive failure counter (was ${this.consecutiveToolFailures})`);
        }
        this.consecutiveToolFailures = 0;
      }

      // Anti-pattern detection: track repeated tool failures with same error
      if (!result.success && result.error) {
        const toolKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
        const tracker = this.toolFailureTracker.get(toolKey);

        if (tracker && tracker.lastError === result.error) {
          tracker.count++;
          if (tracker.count >= this.maxSameToolFailures) {
            logger.warn(`[AgentLoop] Tool ${toolCall.name} failed ${tracker.count} times with same error`);
            this.injectSystemMessage(
              `<repeated-failure-warning>\n` +
              `CRITICAL: The tool "${toolCall.name}" has failed ${tracker.count} times with the SAME error:\n` +
              `Error: ${result.error}\n\n` +
              `You MUST:\n` +
              `1. STOP retrying this exact operation - it will NOT work\n` +
              `2. Analyze WHY it's failing (network issue? invalid parameters? missing config?)\n` +
              `3. Either try a DIFFERENT approach or inform the user that you cannot complete this task\n` +
              `4. If this is a network error, tell the user to check their network connection\n` +
              `</repeated-failure-warning>`
            );
            // Clear tracker to avoid spamming
            this.toolFailureTracker.delete(toolKey);
          }
        } else {
          this.toolFailureTracker.set(toolKey, { count: 1, lastError: result.error });
        }
      } else if (result.success) {
        // Clear failure tracker on success
        const toolKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
        this.toolFailureTracker.delete(toolKey);

        // Track duplicate successful calls (infinite loop prevention)
        const duplicateCount = (this.duplicateCallTracker.get(toolKey) || 0) + 1;
        this.duplicateCallTracker.set(toolKey, duplicateCount);

        if (duplicateCount >= this.MAX_DUPLICATE_CALLS) {
          logger.warn(`[AgentLoop] Detected ${duplicateCount} duplicate calls to ${toolCall.name} with same arguments`);
          this.injectSystemMessage(
            `<duplicate-call-warning>\n` +
            `CRITICAL: You have called "${toolCall.name}" ${duplicateCount} times with the EXACT SAME arguments!\n` +
            `This indicates an infinite loop. You MUST:\n` +
            `1. STOP calling this tool with the same parameters\n` +
            `2. The data you need is already available from previous calls\n` +
            `3. If the task is complete, respond with a completion message\n` +
            `4. If you need different data, use DIFFERENT parameters\n` +
            `</duplicate-call-warning>`
          );
          // Clear tracker to avoid spamming
          this.duplicateCallTracker.delete(toolKey);
        }
      }

      // Auto-continuation detection for truncated files
      if (toolCall.name === 'write_file' && result.success && result.output) {
        const outputStr = result.output;
        if (outputStr.includes('⚠️ **代码完整性警告**') || outputStr.includes('代码完整性警告')) {
          logger.debug('[AgentLoop] ⚠️ Detected truncated file! Injecting auto-continuation prompt');
          this.injectSystemMessage(
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

      // Track read vs write operations for anti-pattern detection
      const readOnlyTools = ['read_file', 'glob', 'grep', 'list_directory', 'web_fetch'];
      const writeTools = ['write_file', 'edit_file'];

      if (writeTools.includes(toolCall.name) && result.success) {
        this.hasWrittenFile = true;
        this.consecutiveReadOps = 0;
      } else if (readOnlyTools.includes(toolCall.name)) {
        this.consecutiveReadOps++;

        // HARD LIMIT: Force stop if too many consecutive reads (prevents infinite loops)
        if (this.consecutiveReadOps >= this.MAX_CONSECUTIVE_READS_HARD_LIMIT) {
          logger.error(`[AgentLoop] HARD LIMIT: ${this.consecutiveReadOps} consecutive read ops! Force stopping.`);
          logCollector.agent('ERROR', `Hard limit reached: ${this.consecutiveReadOps} consecutive reads, forcing stop`);

          // Return a forced error result to break the loop
          return {
            toolCallId: toolCall.id,
            success: false,
            error: `操作已被系统中止：检测到无限循环（连续 ${this.consecutiveReadOps} 次只读操作）。请检查任务是否已完成，或尝试其他方法。`,
            duration: Date.now() - startTime,
          };
        }

        // Warning threshold: 5 reads before first write, 10 reads after first write
        const warningThreshold = this.hasWrittenFile
          ? this.maxConsecutiveReadsBeforeWarning * 2  // 10 after writing
          : this.maxConsecutiveReadsBeforeWarning;      // 5 before writing

        // Inject warning if too many consecutive reads
        if (this.consecutiveReadOps >= warningThreshold) {
          logger.debug(` WARNING: ${this.consecutiveReadOps} consecutive read ops! hasWritten=${this.hasWrittenFile}`);

          if (this.hasWrittenFile) {
            // Already wrote a file - stop over-verifying
            this.injectSystemMessage(
              `<critical-warning>\n` +
              `WARNING: You have performed ${this.consecutiveReadOps} consecutive read operations!\n` +
              `You have ALREADY created/modified files. The task may be COMPLETE.\n` +
              `Options:\n` +
              `1. If the task is done, respond with a completion message\n` +
              `2. If you need to make ONE more edit, do it now and then STOP\n` +
              `3. Do NOT keep reading the same file repeatedly\n` +
              `</critical-warning>`
            );
          } else {
            // Haven't written yet - need to start creating
            this.injectSystemMessage(
              `<critical-warning>\n` +
              `WARNING: You have performed ${this.consecutiveReadOps} read operations without creating any files!\n` +
              `If this is a CREATION task (like "create a snake game"), you must:\n` +
              `1. STOP reading files\n` +
              `2. IMMEDIATELY use write_file to create the requested content\n` +
              `3. Do NOT continue researching - just CREATE!\n` +
              `</critical-warning>`
            );
          }
        }
      }

      // User-configurable Post-Tool Hook (for successful tool execution)
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

      // Skill 系统支持：处理 Skill 工具的特殊返回值
      if (
        toolCall.name === 'skill' &&
        result.success &&
        result.metadata?.isSkillActivation &&
        result.metadata?.skillResult
      ) {
        const skillResult = result.metadata.skillResult as import('../../shared/types/agentSkill').SkillToolResult;
        logger.debug('[AgentLoop] Processing Skill activation result');

        // 注入消息到 this.messages
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

            // 非 meta 消息需要发送事件通知前端
            if (!msg.isMeta) {
              this.onEvent({ type: 'message', data: messageToInject });
            }
          }
          logger.debug(`[AgentLoop] Injected ${skillResult.newMessages.length} skill messages`);
        }

        // 应用上下文修改
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

      // Langfuse: End tool span (success)
      langfuse.endSpan(toolSpanId, {
        success: result.success,
        outputLength: result.output?.length || 0,
        duration: toolResult.duration,
      });

      // Emit tool call end event
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

      // Circuit breaker: count exception as failure
      this.consecutiveToolFailures++;
      logger.debug(`[AgentLoop] Consecutive tool failures (exception): ${this.consecutiveToolFailures}/${this.MAX_CONSECUTIVE_FAILURES}`);

      if (this.consecutiveToolFailures >= this.MAX_CONSECUTIVE_FAILURES) {
        logger.error(`[AgentLoop] Circuit breaker tripped! ${this.consecutiveToolFailures} consecutive failures`);
        logCollector.agent('ERROR', `Circuit breaker tripped after ${this.consecutiveToolFailures} consecutive tool failures (exception)`);

        this.injectSystemMessage(
          `<circuit-breaker-tripped>\n` +
          `🛑 CRITICAL ERROR: ${this.consecutiveToolFailures} consecutive tool calls have FAILED.\n\n` +
          `The last error was: ${toolResult.error}\n\n` +
          `You MUST:\n` +
          `1. STOP calling tools immediately\n` +
          `2. Report this error to the user clearly\n` +
          `3. Explain what you were trying to do and why it failed\n` +
          `4. Ask the user for guidance on how to proceed\n\n` +
          `DO NOT continue attempting tool calls until the user responds.\n` +
          `</circuit-breaker-tripped>`
        );

        this.onEvent({
          type: 'error',
          data: {
            message: `连续 ${this.consecutiveToolFailures} 次工具调用失败，已触发熔断机制。最后错误: ${toolResult.error || 'Unknown error'}`,
            code: 'CIRCUIT_BREAKER_TRIPPED',
          },
        });

        // 设置熔断标志，强制中断 Agent 循环
        this.circuitBreakerTripped = true;
        logger.info(`[AgentLoop] Circuit breaker flag set (exception path), will exit loop after current iteration`);

        this.consecutiveToolFailures = 0;
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

      // Langfuse: End tool span (error)
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
  // Private Methods
  // --------------------------------------------------------------------------

  private async inference(): Promise<ModelResponse> {
    // Get available tools for current generation
    const tools = this.toolRegistry.getToolDefinitions(this.generation.id);
    logger.debug(` Tools for ${this.generation.id}:`, tools.map(t => t.name));

    // Build messages for model
    let modelMessages = this.buildModelMessages();
    logger.debug('[AgentLoop] Model messages count:', modelMessages.length);
    logger.debug('[AgentLoop] Model config:', {
      provider: this.modelConfig.provider,
      model: this.modelConfig.model,
      hasApiKey: !!this.modelConfig.apiKey,
    });

    // Langfuse: Start generation tracking
    const langfuse = getLangfuseService();
    const generationId = `gen-${this.traceId}-${Date.now()}`;
    const startTime = new Date();

    // Create generation input (limit message content to avoid huge payloads)
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
      // 检测任务是否需要特殊能力，如果主模型不支持则自动切换
      // 重要：只检测当前 turn 的消息（最后一条用户消息），避免历史消息中的图片导致后续所有请求都 fallback 到视觉模型
      let effectiveConfig = this.modelConfig;
      const lastUserMessage = modelMessages.filter(m => m.role === 'user').pop();
      const currentTurnMessages = lastUserMessage ? [lastUserMessage] : [];
      const requiredCapabilities = this.modelRouter.detectRequiredCapabilities(currentTurnMessages);
      let needsVisionFallback = false;
      let visionFallbackSucceeded = false;

      // 检查用户请求是否需要使用工具处理图片（如标注、画框等）
      // 这种情况下不应该 fallback 到纯视觉模型，而应该让主模型调用 image_annotate 等工具
      const userRequestText = this.extractUserRequestText(lastUserMessage);
      const needsToolForImage = /标[注记]|画框|框[出住]|圈[出住]|矩形|annotate|mark|highlight|draw/i.test(userRequestText);

      if (needsToolForImage && requiredCapabilities.includes('vision')) {
        logger.info('[AgentLoop] 用户请求需要工具处理图片（标注/画框），跳过视觉 fallback，让主模型调用 image_annotate');
        // 移除 vision 能力需求，让主模型处理并调用工具
        const visionIndex = requiredCapabilities.indexOf('vision');
        if (visionIndex > -1) {
          requiredCapabilities.splice(visionIndex, 1);
        }
        // 同时需要移除消息中的图片，因为主模型不支持图片
        // image_annotate 工具会自己读取图片文件
        modelMessages = this.stripImagesFromMessages(modelMessages);
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
            // 主模型缺少此能力，尝试获取备用模型
            const fallbackConfig = this.modelRouter.getFallbackConfig(capability, this.modelConfig);
            if (fallbackConfig) {
              const configService = getConfigService();
              const authService = getAuthService();
              const currentUser = authService.getCurrentUser();
              const isAdmin = currentUser?.isAdmin === true;

              // 优先使用本地 API Key，本地没有且是管理员时才用云端代理
              const fallbackApiKey = configService.getApiKey(fallbackConfig.provider);
              // 使用 console.log 确保日志可见
              console.log(`🔄 [FALLBACK] provider=${fallbackConfig.provider}, model=${fallbackConfig.model}, hasLocalKey=${!!fallbackApiKey}, isAdmin=${isAdmin}`);
              logger.info(`[Fallback] provider=${fallbackConfig.provider}, model=${fallbackConfig.model}, hasLocalKey=${!!fallbackApiKey}, isAdmin=${isAdmin}`);

              if (fallbackApiKey) {
                // 本地有 API Key，优先使用本地
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
                // 本地没有 API Key，但是管理员，使用云端代理
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
                // 非管理员且未配置本地 Key，发送提示事件
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

      // 如果需要视觉能力但无法切换到视觉模型，则移除图片内容避免 API 错误
      if (needsVisionFallback && !visionFallbackSucceeded) {
        logger.warn('[AgentLoop] 无法使用视觉模型，将图片转换为文字描述');
        modelMessages = this.stripImagesFromMessages(modelMessages);
      }

      // 额外安全检查：确保主模型不支持视觉时，历史消息中不包含图片
      // 这处理了以下场景：
      // 1. 第一轮用户发送图片+标注请求，图片被移除，主模型调用 image_annotate 工具
      // 2. 第二轮工具返回结果，但 buildModelMessages() 重新构建了包含图片的历史消息
      // 3. 由于工具结果文本不含"标注"等关键词，needsToolForImage=false，图片没被移除
      // 4. 主模型收到它不支持的图片数据 → API 错误
      if (effectiveConfig === this.modelConfig) {
        const mainModelInfo = this.modelRouter.getModelInfo(
          this.modelConfig.provider,
          this.modelConfig.model
        );
        if (!mainModelInfo?.supportsVision) {
          // 检查消息中是否包含图片
          const hasImages = modelMessages.some(msg =>
            Array.isArray(msg.content) && msg.content.some((c: any) => c.type === 'image')
          );
          if (hasImages) {
            logger.warn('[AgentLoop] 主模型不支持视觉，但历史消息中包含图片，移除图片避免 API 错误');
            modelMessages = this.stripImagesFromMessages(modelMessages);
          }
        }
      }

      // 检查 fallback 后的模型是否支持 tool calls
      // 如果不支持（如视觉模型 glm-4v-flash），需要清空工具列表避免 API 错误
      let effectiveTools = tools;
      if (effectiveConfig !== this.modelConfig) {
        const fallbackModelInfo = this.modelRouter.getModelInfo(
          effectiveConfig.provider,
          effectiveConfig.model
        );
        if (fallbackModelInfo && !fallbackModelInfo.supportsTool) {
          logger.warn(`[AgentLoop] Fallback 模型 ${effectiveConfig.model} 不支持 tool calls，清空工具列表`);
          effectiveTools = [];

          // 简化 system prompt: 视觉模型不需要复杂的工具描述和宪法内容
          // 只保留简洁的视觉任务指导，避免 token 浪费和模型混淆
          const simplifiedPrompt = `你是一个图片理解助手。请仔细观察图片内容，按照用户的要求进行分析。

输出要求：
- 使用清晰、结构化的格式
- 如果用户要求识别文字(OCR)，按阅读顺序列出所有文字
- 如果用户要求描述位置，使用相对位置描述（如"左上角"、"中央"）
- 只输出分析结果，不要解释你的能力或限制`;

          // 替换 system prompt
          if (modelMessages.length > 0 && modelMessages[0].role === 'system') {
            modelMessages[0].content = simplifiedPrompt;
            logger.info(`[AgentLoop] 简化视觉模型 system prompt (${simplifiedPrompt.length} chars)`);
          }

          // 发送事件通知前端
          this.onEvent({
            type: 'notification',
            data: {
              message: `视觉模型 ${effectiveConfig.model} 不支持工具调用，本次请求将仅使用纯文本回复`,
            },
          });
        }
      }

      // Call model through router
      logger.debug('[AgentLoop] Calling modelRouter.inference()...');
      logger.debug('[AgentLoop] Effective model:', effectiveConfig.model);
      logger.debug('[AgentLoop] Effective tools count:', effectiveTools.length);
      const response = await this.modelRouter.inference(
        modelMessages,
        effectiveTools,
        effectiveConfig,
        (chunk) => {
          // Handle streaming chunks - 支持新的结构化流式事件
          // 所有事件都携带 turnId 以支持精确的消息定位
          if (typeof chunk === 'string') {
            // 兼容旧的字符串格式
            this.onEvent({ type: 'stream_chunk', data: { content: chunk, turnId: this.currentTurnId } });
          } else if (chunk.type === 'text') {
            // 文本流式更新
            this.onEvent({ type: 'stream_chunk', data: { content: chunk.content, turnId: this.currentTurnId } });
          } else if (chunk.type === 'tool_call_start') {
            // 工具调用开始 - 流式通知前端
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
            // 工具调用参数增量更新
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

      // Record token usage for budget tracking (estimate: ~4 chars per token)
      const inputChars = modelMessages.reduce((sum, m) => {
        const content = m.content;
        if (typeof content === 'string') {
          return sum + content.length;
        }
        // Multimodal: estimate text parts only
        return sum + content.reduce((acc, part) => acc + (part.text?.length || 0), 0);
      }, 0);
      const outputChars = (response.content?.length || 0) +
        (response.toolCalls?.reduce((sum, tc) => sum + JSON.stringify(tc.arguments || {}).length, 0) || 0);
      const estimatedInputTokens = Math.ceil(inputChars / 4);
      const estimatedOutputTokens = Math.ceil(outputChars / 4);
      this.recordTokenUsage(estimatedInputTokens, estimatedOutputTokens);

      // Langfuse: End generation (success)
      langfuse.endGeneration(generationId, {
        type: response.type,
        contentLength: response.content?.length || 0,
        toolCallCount: response.toolCalls?.length || 0,
      });

      return response;
    } catch (error) {
      logger.error('[AgentLoop] Model inference error:', error);

      // Langfuse: End generation (error)
      langfuse.endGeneration(
        generationId,
        { error: error instanceof Error ? error.message : 'Unknown error' },
        undefined,
        'ERROR',
        error instanceof Error ? error.message : 'Unknown error'
      );

      // 特殊处理：上下文长度超限错误
      if (error instanceof ContextLengthExceededError) {
        logger.warn(`[AgentLoop] Context length exceeded: ${error.requestedTokens} > ${error.maxTokens}`);
        logCollector.agent('ERROR', `Context length exceeded: requested ${error.requestedTokens}, max ${error.maxTokens}`);

        // 发送友好的错误事件给前端
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

        // 发送任务失败状态
        this.emitTaskProgress('failed', '上下文超限');

        // 不再抛出错误，让循环正常结束
        return { type: 'text', content: '' };
      }

      throw error;
    }
  }

  private buildModelMessages(): ModelMessage[] {
    const modelMessages: ModelMessage[] = [];

    // Build enhanced system prompt for Gen3+
    // Gen3-4: 轻量级 RAG（仅项目知识）
    // Gen5+: 完整 RAG（包含云端搜索）
    let systemPrompt = this.generation.systemPrompt;

    const genNum = parseInt(this.generation.id.replace('gen', ''), 10);
    if (genNum >= 3) {
      systemPrompt = this.buildEnhancedSystemPrompt(systemPrompt);
    }

    // Inject working directory context
    systemPrompt = this.injectWorkingDirectoryContext(systemPrompt);

    // Add system prompt
    modelMessages.push({
      role: 'system',
      content: systemPrompt,
    });

    // Add conversation history
    logger.debug('[AgentLoop] Building model messages, total messages:', this.messages.length);
    for (const message of this.messages) {
      logger.debug(` Message role=${message.role}, hasAttachments=${!!message.attachments?.length}, attachmentCount=${message.attachments?.length || 0}`);
      if (message.role === 'tool') {
        // Convert tool results to user message format
        // Tool results are kept complete as they contain important execution context
        modelMessages.push({
          role: 'user',
          content: `Tool results:\n${message.content}`,
        });
      } else if (message.role === 'assistant' && message.toolCalls) {
        // Format tool calls using optimized summary (saves tokens)
        const toolCallsStr = message.toolCalls
          .map((tc) => this.formatToolCallForHistory(tc))
          .join('\n');
        modelMessages.push({
          role: 'assistant',
          content: toolCallsStr || message.content,
        });
      } else if (message.role === 'user' && message.attachments?.length) {
        // 处理带附件的用户消息（多模态）
        const multimodalContent = this.buildMultimodalContent(message.content, message.attachments);
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

  /**
   * 将附件转换为多模态消息内容
   * 按文件类别精细化处理，生成对模型最友好的格式
   */
  private buildMultimodalContent(text: string, attachments: MessageAttachment[]): MessageContent[] {
    const contents: MessageContent[] = [];

    // 附件大小阈值：超过此值的文件只发送摘要，让 Agent 用 read_file 按需读取
    const LARGE_FILE_THRESHOLD = 8000; // 约 2000 tokens
    const MAX_PREVIEW_LINES = 30; // 大文件预览行数
    const MAX_TOTAL_ATTACHMENT_CHARS = 50000; // 所有附件总字符数
    let totalAttachmentChars = 0;

    /**
     * 判断是否为大文件，需要延迟加载
     */
    const isLargeFile = (content: string): boolean => content.length > LARGE_FILE_THRESHOLD;

    /**
     * 生成大文件的摘要（只包含前 N 行预览）
     */
    const generateFilePreview = (content: string, filePath: string, lang: string): string => {
      const lines = content.split('\n');
      const totalLines = lines.length;
      const previewLines = lines.slice(0, MAX_PREVIEW_LINES).join('\n');
      const sizeKB = (content.length / 1024).toFixed(1);

      return `**预览 (前 ${Math.min(MAX_PREVIEW_LINES, totalLines)} 行 / 共 ${totalLines} 行, ${sizeKB} KB):**
\`\`\`${lang}
${previewLines}
\`\`\`
${totalLines > MAX_PREVIEW_LINES ? `\n⚠️ 还有 ${totalLines - MAX_PREVIEW_LINES} 行未显示。这只是预览，要分析完整代码必须用 \`read_file\` 读取: \`${filePath}\`` : ''}`;
    };

    // 添加用户文本
    if (text.trim()) {
      contents.push({ type: 'text', text });
    }

    // 按类别处理每个附件
    for (const attachment of attachments) {
      // 图片可以从 path 加载，其他类型需要 data
      const category = attachment.category || (attachment.type === 'image' ? 'image' : 'other');
      if (!attachment.data && category !== 'image') continue;
      if (!attachment.data && !attachment.path) continue;

      // 检查总大小是否超限
      if (totalAttachmentChars >= MAX_TOTAL_ATTACHMENT_CHARS) {
        contents.push({
          type: 'text',
          text: `⚠️ 附件内容已达上限，跳过: ${attachment.name}`,
        });
        continue;
      }

      switch (category) {
        case 'image': {
          // 图片：转换为 base64 图片内容块
          let base64Data = attachment.data;
          let mediaType = attachment.mimeType;

          // 如果没有 data 但有 path，从本地文件读取
          if (!base64Data && attachment.path) {
            try {
              if (fs.existsSync(attachment.path)) {
                const imageBuffer = fs.readFileSync(attachment.path);
                base64Data = imageBuffer.toString('base64');
                logger.debug('[AgentLoop] Loaded image from path:', attachment.path);
              } else {
                logger.warn('[AgentLoop] Image file not found:', attachment.path);
                contents.push({
                  type: 'text',
                  text: `⚠️ 图片文件不存在: ${attachment.path}`,
                });
                break;
              }
            } catch (err) {
              logger.error('[AgentLoop] Failed to read image file:', err);
              contents.push({
                type: 'text',
                text: `⚠️ 无法读取图片: ${attachment.name}`,
              });
              break;
            }
          }

          if (base64Data?.startsWith('data:')) {
            const match = base64Data.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              mediaType = match[1];
              base64Data = match[2];
            }
          }

          if (!base64Data) {
            logger.warn('[AgentLoop] No image data available for:', attachment.name);
            break;
          }

          contents.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Data,
            },
          });

          // 添加图片路径信息，以便工具（如 image_annotate）可以使用
          if (attachment.path) {
            contents.push({
              type: 'text',
              text: `📍 图片文件路径: ${attachment.path}`,
            });
          }
          break;
        }

        case 'pdf': {
          // PDF：文档结构化文本
          const pageInfo = attachment.pageCount ? ` (${attachment.pageCount} 页)` : '';
          const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
          const filePath = attachment.path || attachment.name;

          let contentText: string;
          const data = attachment.data || '';
          if (isLargeFile(data)) {
            contentText = `📄 **PDF 文档: ${attachment.name}**${pageInfo}${pathInfo}\n\n${generateFilePreview(data, filePath || attachment.name, 'text')}`;
          } else {
            contentText = `📄 **PDF 文档: ${attachment.name}**${pageInfo}${pathInfo}\n\n${data}`;
          }
          totalAttachmentChars += contentText.length;
          contents.push({ type: 'text', text: contentText });
          break;
        }

        case 'code': {
          // 代码文件：带语法高亮提示
          const lang = attachment.language || 'plaintext';
          const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
          const filePath = attachment.path || attachment.name;
          const data = attachment.data || '';

          let contentText: string;
          if (isLargeFile(data)) {
            contentText = `📝 **代码文件: ${attachment.name}** (${lang})${pathInfo}\n\n${generateFilePreview(data, filePath, lang)}`;
          } else {
            contentText = `📝 **代码文件: ${attachment.name}** (${lang})${pathInfo}\n\`\`\`${lang}\n${data}\n\`\`\``;
          }
          totalAttachmentChars += contentText.length;
          contents.push({ type: 'text', text: contentText });
          break;
        }

        case 'data': {
          // 数据文件：JSON/CSV/XML 等
          const lang = attachment.language || 'json';
          const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
          const filePath = attachment.path || attachment.name;
          const data = attachment.data || '';

          let contentText: string;
          if (isLargeFile(data)) {
            contentText = `📊 **数据文件: ${attachment.name}**${pathInfo}\n\n${generateFilePreview(data, filePath, lang)}`;
          } else {
            contentText = `📊 **数据文件: ${attachment.name}**${pathInfo}\n\`\`\`${lang}\n${data}\n\`\`\``;
          }
          totalAttachmentChars += contentText.length;
          contents.push({ type: 'text', text: contentText });
          break;
        }

        case 'html': {
          // HTML 文件
          const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
          const filePath = attachment.path || attachment.name;
          const data = attachment.data || '';

          let contentText: string;
          if (isLargeFile(data)) {
            contentText = `🌐 **HTML 文件: ${attachment.name}**${pathInfo}\n\n${generateFilePreview(data, filePath, 'html')}`;
          } else {
            contentText = `🌐 **HTML 文件: ${attachment.name}**${pathInfo}\n\`\`\`html\n${data}\n\`\`\``;
          }
          totalAttachmentChars += contentText.length;
          contents.push({ type: 'text', text: contentText });
          break;
        }

        case 'text': {
          // 纯文本/Markdown
          const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
          const isMarkdown = attachment.language === 'markdown';
          const filePath = attachment.path || attachment.name;
          const icon = isMarkdown ? '📝' : '📄';
          const fileType = isMarkdown ? 'Markdown 文件' : '文本文件';
          const lang = isMarkdown ? 'markdown' : 'text';
          const data = attachment.data || '';

          let contentText: string;
          if (isLargeFile(data)) {
            contentText = `${icon} **${fileType}: ${attachment.name}**${pathInfo}\n\n${generateFilePreview(data, filePath, lang)}`;
          } else {
            contentText = `${icon} **${fileType}: ${attachment.name}**${pathInfo}\n\n${data}`;
          }
          totalAttachmentChars += contentText.length;
          contents.push({ type: 'text', text: contentText });
          break;
        }

        case 'excel': {
          // Excel 文件：已在前端解析为 CSV 格式文本
          const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
          const sheetInfo = attachment.sheetCount ? ` (${attachment.sheetCount} 个工作表` : '';
          const rowInfo = attachment.rowCount ? `, ${attachment.rowCount} 行数据)` : sheetInfo ? ')' : '';
          const filePath = attachment.path || attachment.name;
          const data = attachment.data || '';

          let contentText: string;
          if (isLargeFile(data)) {
            contentText = `📊 **Excel 文件: ${attachment.name}**${sheetInfo}${rowInfo}${pathInfo}\n\n⚠️ 以下是已解析的表格数据（CSV 格式），无需调用工具读取：\n\n${generateFilePreview(data, filePath, 'csv')}`;
          } else {
            contentText = `📊 **Excel 文件: ${attachment.name}**${sheetInfo}${rowInfo}${pathInfo}\n\n⚠️ 以下是已解析的表格数据（CSV 格式），无需调用工具读取：\n\n\`\`\`csv\n${data}\n\`\`\``;
          }
          totalAttachmentChars += contentText.length;
          contents.push({ type: 'text', text: contentText });
          break;
        }

        case 'folder': {
          // 文件夹：只展示目录结构，不发送文件内容
          // Agent 可以用 read_file 工具按需读取具体文件
          const pathInfo = attachment.path ? `\n📍 绝对路径: ${attachment.path}` : '';
          const stats = attachment.folderStats;
          const statsInfo = stats
            ? `\n📊 统计: ${stats.totalFiles} 个文件, ${(stats.totalSize / 1024).toFixed(1)} KB`
            : '';

          // 构建文件列表（只显示路径和大小，不包含内容）
          let fileList = '';
          if (attachment.files && attachment.files.length > 0) {
            fileList = '\n\n**文件列表：**\n';
            for (const file of attachment.files) {
              const sizeKB = file.content ? (file.content.length / 1024).toFixed(1) : '?';
              const fullPath = attachment.path ? `${attachment.path}/${file.path}` : file.path;
              fileList += `- ${file.path} (${sizeKB} KB) → \`${fullPath}\`\n`;
            }
            fileList += '\n⚠️ **注意**: 以上只是文件列表，不包含文件内容。要分析代码，必须先用 `read_file` 工具读取文件。';
          }

          const folderContent = `📁 **文件夹: ${attachment.name}**${pathInfo}${statsInfo}\n\n${attachment.data || ''}${fileList}`;
          totalAttachmentChars += folderContent.length;
          contents.push({
            type: 'text',
            text: folderContent,
          });
          break;
        }

        default: {
          // 其他文件类型
          const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
          const filePath = attachment.path || attachment.name;
          const data = attachment.data || '';

          let contentText: string;
          if (isLargeFile(data)) {
            contentText = `📎 **文件: ${attachment.name}**${pathInfo}\n\n${generateFilePreview(data, filePath, 'text')}`;
          } else {
            contentText = `📎 **文件: ${attachment.name}**${pathInfo}\n\`\`\`\n${data}\n\`\`\``;
          }
          totalAttachmentChars += contentText.length;
          contents.push({ type: 'text', text: contentText });
        }
      }
    }

    // 如果没有任何内容，返回空文本
    if (contents.length === 0) {
      contents.push({ type: 'text', text: text || '' });
    }

    return contents;
  }

  /**
   * 从用户消息中提取文本内容
   * 用于分析用户请求意图
   */
  private extractUserRequestText(message: ModelMessage | undefined): string {
    if (!message) return '';

    if (typeof message.content === 'string') {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      return message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join(' ');
    }

    return '';
  }

  /**
   * 从消息中移除图片内容，替换为文字描述
   * 用于当视觉模型不可用时的降级处理
   */
  private stripImagesFromMessages(messages: ModelMessage[]): ModelMessage[] {
    return messages.map((msg) => {
      if (!Array.isArray(msg.content)) {
        return msg;
      }

      const newContent: MessageContent[] = [];
      let hasImage = false;

      for (const part of msg.content) {
        if (part.type === 'image') {
          hasImage = true;
          // 移除图片数据，但保留文字描述
          // 注意：图片路径信息已经作为单独的 text 部分添加，会被保留
          newContent.push({
            type: 'text',
            text: '[用户上传了图片，但当前模型不支持直接处理图片。如需在图片上标注，请使用 image_annotate 工具并提供图片路径]',
          });
        } else {
          newContent.push(part);
        }
      }

      if (hasImage) {
        return { ...msg, content: newContent };
      }
      return msg;
    });
  }

  /**
   * Build enhanced system prompt with RAG context
   * Gen3-4: 轻量级 RAG（仅项目知识和用户偏好）
   * Gen5+: 完整 RAG（包含代码、知识库，支持云端搜索 + 主动上下文）
   *
   * PERFORMANCE OPTIMIZATION: Skip RAG entirely for simple tasks
   * RAG adds 500ms-2s latency for vector search that simple tasks don't need
   */
  private buildEnhancedSystemPrompt(basePrompt: string): string {
    // PERFORMANCE OPTIMIZATION: Skip all RAG for simple tasks
    // Simple tasks like "generate Excel" or "create hello world" don't need context
    if (this.isSimpleTaskMode) {
      logger.debug(' Skipping RAG for simple task (fast path)');
      return basePrompt;
    }

    try {
      const memoryService = getMemoryService();
      let enhancedPrompt = basePrompt;

      // Get user query from the last user message
      const lastUserMessage = [...this.messages]
        .reverse()
        .find((m) => m.role === 'user');
      const userQuery = lastUserMessage?.content || '';

      if (!userQuery) {
        return basePrompt;
      }

      // Determine RAG level based on generation
      const genNum = parseInt(this.generation.id.replace('gen', ''), 10);
      const isFullRAG = genNum >= 5;
      const isLightRAG = genNum >= 3 && genNum < 5;

      if (isFullRAG) {
        // Gen5+: Full RAG with code, knowledge, and cloud search
        const ragContext = memoryService.getRAGContext(userQuery, {
          includeCode: true,
          includeKnowledge: true,
          includeConversations: false, // Avoid duplication with message history
          maxTokens: 1500,
        });

        if (ragContext && ragContext.trim().length > 0) {
          enhancedPrompt += `\n\n## Relevant Context from Memory\n\nThe following context was retrieved from your knowledge base and may be helpful:\n\n${ragContext}`;
        }

        // Note: Cloud search is triggered asynchronously in buildEnhancedSystemPromptAsync
        // This sync version uses local search only for backward compatibility
      } else if (isLightRAG) {
        // Gen3-4: Lightweight RAG - only project knowledge, no code/conversation search
        // This prevents overwhelming the context for simpler tasks
      }

      // Add project knowledge (all Gen3+)
      const projectKnowledge = memoryService.getProjectKnowledge();
      if (projectKnowledge.length > 0) {
        const knowledgeStr = projectKnowledge
          .slice(0, 5)
          .map((k) => `- **${k.key}**: ${typeof k.value === 'string' ? k.value : JSON.stringify(k.value)}`)
          .join('\n');
        enhancedPrompt += `\n\n## Project Knowledge\n\n${knowledgeStr}`;
      }

      // Add user preferences from Core Memory (all Gen3+)
      try {
        const coreMemory = getCoreMemoryService();
        const preferencesPrompt = coreMemory.formatForSystemPrompt();
        if (preferencesPrompt) {
          enhancedPrompt += `\n\n${preferencesPrompt}`;
        }
      } catch {
        // Fallback to legacy KV-based preferences if CoreMemory fails
        const codingStyle = memoryService.getUserPreference<Record<string, unknown>>('coding_style');
        if (codingStyle && Object.keys(codingStyle).length > 0) {
          const styleStr = Object.entries(codingStyle)
            .map(([key, value]) => `- ${key}: ${value}`)
            .join('\n');
          enhancedPrompt += `\n\n## User Coding Preferences\n\n${styleStr}`;
        }
      }

      const ragType = isFullRAG ? 'full' : isLightRAG ? 'light' : 'none';
      logger.debug(` Enhanced system prompt with ${ragType} RAG for ${this.generation.id}`);
      return enhancedPrompt;
    } catch (error) {
      logger.error('[AgentLoop] Failed to build enhanced system prompt:', error);
      return basePrompt;
    }
  }

  /**
   * Build enhanced system prompt with proactive context (async version)
   * Detects entities in user message and auto-fetches relevant context
   * Used for Gen5+ to provide intelligent context injection
   */
  private async buildEnhancedSystemPromptWithProactiveContext(
    basePrompt: string,
    workingDirectory?: string
  ): Promise<{ prompt: string; proactiveSummary: string }> {
    try {
      // First build the standard enhanced prompt
      let enhancedPrompt = this.buildEnhancedSystemPrompt(basePrompt);

      // Get user query from the last user message
      const lastUserMessage = [...this.messages]
        .reverse()
        .find((m) => m.role === 'user');
      const userQuery = lastUserMessage?.content || '';

      if (!userQuery) {
        return { prompt: enhancedPrompt, proactiveSummary: '' };
      }

      // Determine if we should use proactive context
      const genNum = parseInt(this.generation.id.replace('gen', ''), 10);
      if (genNum < 5) {
        // Proactive context is only for Gen5+
        return { prompt: enhancedPrompt, proactiveSummary: '' };
      }

      // Use ProactiveContextService to detect entities and fetch context
      const proactiveService = getProactiveContextService();
      const proactiveResult = await proactiveService.analyzeAndFetchContext(
        userQuery,
        workingDirectory
      );

      // If we found relevant context, format and add it
      if (proactiveResult.context.length > 0) {
        const formattedContext = proactiveService.formatContextForPrompt(proactiveResult);
        enhancedPrompt += `\n\n${formattedContext}`;

        logger.info(
          `Proactive context injected: ${proactiveResult.totalItems} items ` +
          `(${proactiveResult.cloudItems} from cloud), entities: ${proactiveResult.entities.map(e => e.type).join(', ')}`
        );

        logCollector.agent('INFO', 'Proactive context injected', {
          totalItems: proactiveResult.totalItems,
          cloudItems: proactiveResult.cloudItems,
          entities: proactiveResult.entities.map(e => ({ type: e.type, value: e.value })),
        });
      }

      return {
        prompt: enhancedPrompt,
        proactiveSummary: proactiveResult.summary,
      };
    } catch (error) {
      logger.error('[AgentLoop] Failed to build proactive context:', error);
      return { prompt: this.buildEnhancedSystemPrompt(basePrompt), proactiveSummary: '' };
    }
  }

  /**
   * Build enhanced system prompt with cloud RAG context (async version)
   * Used when cloud search is enabled for Gen5+
   */
  private async buildEnhancedSystemPromptAsync(basePrompt: string): Promise<{
    prompt: string;
    cloudSources: Array<{ type: string; path?: string; score: number; fromCloud: boolean }>;
  }> {
    try {
      const memoryService = getMemoryService();

      // Get user query from the last user message
      const lastUserMessage = [...this.messages]
        .reverse()
        .find((m) => m.role === 'user');
      const userQuery = lastUserMessage?.content || '';

      if (!userQuery) {
        return { prompt: basePrompt, cloudSources: [] };
      }

      // Determine if we should use cloud search
      const genNum = parseInt(this.generation.id.replace('gen', ''), 10);
      const shouldUseCloud = genNum >= 5;

      if (!shouldUseCloud) {
        // Fall back to sync version for Gen3-4
        return { prompt: this.buildEnhancedSystemPrompt(basePrompt), cloudSources: [] };
      }

      // Gen5+: Use cloud-enhanced system prompt builder
      const result = await memoryService.buildEnhancedSystemPromptWithCloud(
        basePrompt,
        userQuery,
        {
          includeCloud: true,
          crossProject: false, // Default to current project only
          maxTokens: 2000,
        }
      );

      logger.debug(` Cloud-enhanced system prompt, ${result.sources.length} sources`);
      return {
        prompt: result.prompt,
        cloudSources: result.sources,
      };
    } catch (error) {
      logger.error('[AgentLoop] Failed to build cloud-enhanced system prompt:', error);
      return { prompt: this.buildEnhancedSystemPrompt(basePrompt), cloudSources: [] };
    }
  }

  /**
   * Inject working directory context into system prompt
   * This helps the model understand where it can operate and what to do when uncertain
   */
  private injectWorkingDirectoryContext(basePrompt: string): string {
    const workingDirInfo = this.isDefaultWorkingDirectory
      ? `## Working Directory

**Default working directory**: \`${this.workingDirectory}\`

**File Path Rules**:
- **Relative paths** (e.g., \`game/index.html\`) → resolved against working directory
- **Absolute paths** (e.g., \`/Users/xxx/project/file.txt\`) → used directly
- **Home paths** (e.g., \`~/Desktop/file.txt\`) → expanded to user's home directory

**When user intent is UNCLEAR about location**, use \`ask_user_question\`:
\`\`\`json
{
  "question": "你想把文件保存在哪里？",
  "options": [
    { "label": "桌面", "description": "~/Desktop" },
    { "label": "下载文件夹", "description": "~/Downloads" },
    { "label": "默认工作区", "description": "${this.workingDirectory}" }
  ]
}
\`\`\`

**When user intent is CLEAR**, just use the appropriate path directly.`
      : `## Working Directory

**Current working directory**: \`${this.workingDirectory}\`

Use relative paths (resolved against this directory) or absolute paths.`;

    return `${basePrompt}\n\n${workingDirInfo}`;
  }

  /**
   * Inject a system message into the conversation
   * Used by hooks to add context reminders
   */
  private injectSystemMessage(content: string): void {
    const systemMessage: Message = {
      id: this.generateId(),
      role: 'system',
      content,
      timestamp: Date.now(),
    };
    this.messages.push(systemMessage);
  }

  private generateId(): string {
    return generateMessageId();
  }

  /**
   * Get attachments from the most recent user message
   * Used by multi-agent workflows to pass images/files to subagents
   */
  private getCurrentAttachments(): Array<{
    type: string;
    category?: string;
    name?: string;
    path?: string;
    data?: string;
    mimeType?: string;
  }> {
    // Find the most recent user message with attachments
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

  /**
   * 添加消息到历史并持久化到数据库
   * 确保 AI 回复不会丢失
   */
  private async addAndPersistMessage(message: Message): Promise<void> {
    this.messages.push(message);

    // 持久化到数据库（非阻塞，失败只记录日志不影响流程）
    try {
      const sessionManager = getSessionManager();
      await sessionManager.addMessage(message);
    } catch (error) {
      logger.error('Failed to persist message:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Tool Result Sanitization (Token Optimization)
  // --------------------------------------------------------------------------

  /**
   * 需要从工具结果中过滤的大型二进制数据字段
   * 这些字段通常包含 base64 编码的图片、音频等数据
   */
  private static readonly LARGE_DATA_FIELDS = [
    'imageBase64',      // image_generate 返回的图片
    'screenshotData',   // screenshot (Gen6) 返回的截图
    'pdfImages',        // read_pdf 视觉模式返回的页面图片
    'audioData',        // 未来的音频工具
    'videoData',        // 未来的视频工具
    'base64',           // 通用 base64 字段
    'data',             // 可能包含大型数据的通用字段（需要检测）
  ];

  /**
   * 大型数据阈值（字节）
   * 超过此大小的字符串字段会被检测是否为 base64 数据
   */
  private static readonly LARGE_DATA_THRESHOLD = 10000; // ~10KB

  /**
   * 清理工具结果用于历史存储
   *
   * 设计原则：
   * 1. 大型二进制数据（base64 图片等）只保留引用，不存入历史
   * 2. 前端通过 tool_call_end 事件获取完整数据用于渲染
   * 3. 模型只需要知道"图片已生成"，不需要看到图片内容
   *
   * @param result 原始工具结果
   * @returns 清理后的工具结果（不含大型二进制数据）
   */
  private sanitizeToolResultForHistory(result: ToolResult): ToolResult {
    // 如果没有 metadata，无需处理
    if (!result.metadata) {
      return result;
    }

    // 深拷贝避免修改原始数据
    const sanitized: ToolResult = {
      ...result,
      metadata: { ...result.metadata },
    };

    // 过滤已知的大型数据字段
    for (const field of AgentLoop.LARGE_DATA_FIELDS) {
      if (sanitized.metadata![field]) {
        const data = sanitized.metadata![field];
        if (typeof data === 'string' && data.length > 100) {
          // 替换为占位符，保留大小信息便于调试
          const sizeKB = (data.length / 1024).toFixed(1);
          sanitized.metadata![field] = `[BINARY_DATA_FILTERED: ${sizeKB}KB]`;
        }
      }
    }

    // 检查其他可能的大型字段（动态检测）
    for (const [key, value] of Object.entries(sanitized.metadata!)) {
      // 跳过已处理的字段
      if (AgentLoop.LARGE_DATA_FIELDS.includes(key)) continue;

      // 检测大型字符串
      if (typeof value === 'string' && value.length > AgentLoop.LARGE_DATA_THRESHOLD) {
        // 检测是否为 base64 数据
        const isBase64 = value.startsWith('data:') ||
          /^[A-Za-z0-9+/]{1000,}={0,2}$/.test(value.slice(0, 1100));

        if (isBase64) {
          const sizeKB = (value.length / 1024).toFixed(1);
          sanitized.metadata![key] = `[LARGE_BASE64_FILTERED: ${sizeKB}KB]`;
          logger.debug(`[AgentLoop] Filtered large base64 field: ${key} (${sizeKB}KB)`);
        }
      }
    }

    return sanitized;
  }

  /**
   * 批量清理工具结果
   */
  private sanitizeToolResultsForHistory(results: ToolResult[]): ToolResult[] {
    return results.map(r => this.sanitizeToolResultForHistory(r));
  }

  /**
   * 格式化工具调用用于历史记录
   * 只保留关键信息，避免 token 浪费
   */
  private formatToolCallForHistory(tc: ToolCall): string {
    const { name, arguments: args } = tc;

    switch (name) {
      case 'edit_file':
        return `Edited ${args.file_path}`;

      case 'bash': {
        const cmd = (args.command as string) || '';
        const shortCmd = cmd.length > 100 ? cmd.slice(0, 97) + '...' : cmd;
        return `Ran: ${shortCmd}`;
      }

      case 'read_file':
        return `Read ${args.file_path}`;

      case 'write_file':
        return `Created ${args.file_path}`;

      case 'glob':
        return `Found files matching: ${args.pattern}`;

      case 'grep':
        return `Searched for: ${args.pattern}`;

      case 'list_directory':
        return `Listed: ${args.path || '.'}`;

      case 'task':
        return `Delegated task: ${(args.description as string)?.slice(0, 50) || 'subagent'}`;

      case 'todo_write':
        return `Updated todo list`;

      case 'ask_user_question':
        return `Asked user a question`;

      case 'skill':
        return `Invoked skill: ${args.skill}`;

      case 'web_fetch':
        return `Fetched: ${args.url}`;

      default: {
        // 对于其他工具，只显示名称和简短参数
        const argsStr = JSON.stringify(args);
        const shortArgs = argsStr.length > 80 ? argsStr.slice(0, 77) + '...' : argsStr;
        return `Called ${name}(${shortArgs})`;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Tool Call Format Detection
  // --------------------------------------------------------------------------

  /**
   * 检测模型是否错误地用文本描述工具调用而非实际使用 tool_use
   * 这是一种常见的模型行为问题，特别是在长上下文或复杂任务中
   *
   * 检测策略：
   * 1. 历史格式模式 - 基于 formatToolCallForHistory 的逆向解析
   * 2. 通用调用模式 - "Called toolname({...})"
   * 3. 意图描述模式 - "I'll call the toolname tool..."
   * 4. JSON 格式模式 - {"name": "toolname", "arguments": ...}
   */
  private detectFailedToolCallPattern(content: string): { toolName: string; args?: string } | null {
    const trimmed = content.trim();

    // ========== 历史格式模式（逆向解析 formatToolCallForHistory）==========
    // 这些是我们写入历史的格式，模型可能会"模仿"输出

    // bash: "Ran: <command>"
    const ranMatch = trimmed.match(/^Ran:\s*(.+)$/is);
    if (ranMatch) {
      return { toolName: 'bash', args: JSON.stringify({ command: ranMatch[1].trim() }) };
    }

    // edit_file: "Edited <path>"
    const editedMatch = trimmed.match(/^Edited\s+(.+)$/i);
    if (editedMatch) {
      return { toolName: 'edit_file', args: JSON.stringify({ file_path: editedMatch[1].trim() }) };
    }

    // read_file: "Read <path>"
    const readMatch = trimmed.match(/^Read\s+(.+)$/i);
    if (readMatch) {
      return { toolName: 'read_file', args: JSON.stringify({ file_path: readMatch[1].trim() }) };
    }

    // write_file: "Created <path>"
    const createdMatch = trimmed.match(/^Created\s+(.+)$/i);
    if (createdMatch) {
      return { toolName: 'write_file', args: JSON.stringify({ file_path: createdMatch[1].trim() }) };
    }

    // glob: "Found files matching: <pattern>"
    const globMatch = trimmed.match(/^Found files matching:\s*(.+)$/i);
    if (globMatch) {
      return { toolName: 'glob', args: JSON.stringify({ pattern: globMatch[1].trim() }) };
    }

    // grep: "Searched for: <pattern>"
    const grepMatch = trimmed.match(/^Searched for:\s*(.+)$/i);
    if (grepMatch) {
      return { toolName: 'grep', args: JSON.stringify({ pattern: grepMatch[1].trim() }) };
    }

    // list_directory: "Listed: <path>"
    const listedMatch = trimmed.match(/^Listed:\s*(.+)$/i);
    if (listedMatch) {
      return { toolName: 'list_directory', args: JSON.stringify({ path: listedMatch[1].trim() }) };
    }

    // web_fetch: "Fetched: <url>"
    const fetchedMatch = trimmed.match(/^Fetched:\s*(.+)$/i);
    if (fetchedMatch) {
      return { toolName: 'web_fetch', args: JSON.stringify({ url: fetchedMatch[1].trim() }) };
    }

    // skill: "Invoked skill: <name>"
    const skillMatch = trimmed.match(/^Invoked skill:\s*(.+)$/i);
    if (skillMatch) {
      return { toolName: 'skill', args: JSON.stringify({ name: skillMatch[1].trim() }) };
    }

    // ========== 通用调用模式 ==========

    // "Called toolname({...})" - 最常见的错误模式
    const calledPattern = /Called\s+(\w+)\s*\(\s*(\{[\s\S]*?\})\s*\)/i;
    const calledMatch = trimmed.match(calledPattern);
    if (calledMatch) {
      return { toolName: calledMatch[1], args: calledMatch[2] };
    }

    // ========== 意图描述模式 ==========

    // "I'll/Let me call/use the toolname tool" - 描述意图但未执行
    const intentPattern = /(?:I'll|Let me|I will|I'm going to)\s+(?:call|use|invoke|execute)\s+(?:the\s+)?(\w+)\s+tool/i;
    const intentMatch = trimmed.match(intentPattern);
    if (intentMatch) {
      // 只有当内容较短（可能是纯意图描述）且包含工具参数描述时才触发
      if (trimmed.length < 500 && /\{[\s\S]*?\}/.test(trimmed)) {
        return { toolName: intentMatch[1] };
      }
    }

    // ========== JSON 格式模式 ==========

    // {"name": "toolname", "arguments": ...} 或 {"tool": "toolname", ...}
    const jsonToolPattern = /\{\s*"(?:name|tool)"\s*:\s*"(\w+)"\s*,\s*"(?:arguments|params|input)"\s*:/i;
    const jsonMatch = trimmed.match(jsonToolPattern);
    if (jsonMatch && trimmed.startsWith('{')) {
      return { toolName: jsonMatch[1] };
    }

    return null;
  }

  /**
   * 尝试从文本描述中解析工具参数并构造 ToolCall
   * 用于强制执行模型用文本描述的工具调用
   */
  private tryForceExecuteTextToolCall(
    match: { toolName: string; args?: string },
    content: string
  ): ToolCall | null {
    const { toolName, args: matchedArgs } = match;

    // 优先使用正则匹配到的参数
    if (matchedArgs) {
      try {
        const parsedArgs = JSON.parse(matchedArgs);
        logger.debug(`[AgentLoop] Parsed tool args from regex match: ${JSON.stringify(parsedArgs)}`);
        return {
          id: `force_${Date.now()}_${crypto.randomUUID().split('-')[0]}`,
          name: toolName,
          arguments: parsedArgs,
        };
      } catch (e) {
        logger.debug(`[AgentLoop] Failed to parse matched args: ${matchedArgs}`);
      }
    }

    // 尝试从内容中提取完整的 JSON 参数
    // 模式: mcp({...}) 或 tool_name({...})
    const jsonExtractPattern = new RegExp(
      `${toolName}\\s*\\(\\s*(\\{[\\s\\S]*\\})\\s*\\)`,
      'i'
    );
    const jsonMatch = content.match(jsonExtractPattern);
    if (jsonMatch) {
      try {
        // 尝试修复常见的 JSON 问题
        let jsonStr = jsonMatch[1];
        // 修复单引号
        jsonStr = jsonStr.replace(/'/g, '"');
        // 修复没有引号的 key
        jsonStr = jsonStr.replace(/(\w+)(?=\s*:)/g, '"$1"');
        // 修复重复引号
        jsonStr = jsonStr.replace(/""(\w+)""/g, '"$1"');

        const parsedArgs = JSON.parse(jsonStr);
        logger.debug(`[AgentLoop] Parsed tool args from content: ${JSON.stringify(parsedArgs)}`);
        return {
          id: `force_${Date.now()}_${crypto.randomUUID().split('-')[0]}`,
          name: toolName,
          arguments: parsedArgs,
        };
      } catch (e) {
        logger.debug(`[AgentLoop] Failed to parse JSON from content: ${jsonMatch[1]?.slice(0, 200)}`);
      }
    }

    // 尝试提取 JSON 块（可能在代码块中）
    const codeBlockPattern = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/;
    const codeBlockMatch = content.match(codeBlockPattern);
    if (codeBlockMatch) {
      try {
        const parsedArgs = JSON.parse(codeBlockMatch[1]);
        // 检查是否包含工具调用相关字段
        if (parsedArgs.server || parsedArgs.tool || parsedArgs.arguments || parsedArgs.file_path || parsedArgs.command) {
          logger.debug(`[AgentLoop] Parsed tool args from code block: ${JSON.stringify(parsedArgs)}`);
          return {
            id: `force_${Date.now()}_${crypto.randomUUID().split('-')[0]}`,
            name: toolName,
            arguments: parsedArgs,
          };
        }
      } catch (e) {
        logger.debug(`[AgentLoop] Failed to parse JSON from code block`);
      }
    }

    return null;
  }
}
