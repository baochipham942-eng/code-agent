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
import type { ToolRegistry } from '../tools/toolRegistry';
import type { ToolExecutor } from '../tools/toolExecutor';
import { ModelRouter } from '../model/modelRouter';
import type { PlanningService } from '../planning';
import { getMemoryService } from '../memory/memoryService';
import { getConfigService, getAuthService, getLangfuseService } from '../services';
import { getProactiveContextService } from '../memory/proactiveContext';
import { logCollector } from '../mcp/logCollector.js';
import { generateMessageId, generateToolCallId } from '../../shared/utils/id';
import { taskComplexityAnalyzer } from '../planning/taskComplexityAnalyzer';
import { getMaxIterations } from '../services/cloud/featureFlagService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('AgentLoop');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface AgentLoopConfig {
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
  // Session metadata for tracing
  sessionId?: string;
  userId?: string;
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

  // Anti-pattern detection: track consecutive read-only operations
  private consecutiveReadOps: number = 0;
  private maxConsecutiveReadsBeforeWarning: number = 5;
  private hasWrittenFile: boolean = false;

  // Plan Mode support (borrowed from Claude Code v2.0)
  private planModeActive: boolean = false;

  // Langfuse tracing
  private sessionId: string;
  private userId?: string;
  private traceId: string = '';
  private currentIterationSpanId: string = '';

  // Turn-based message tracking
  private currentTurnId: string = '';

  // Task progress tracking (长时任务进度追踪)
  private turnStartTime: number = 0;
  private toolsUsedInTurn: string[] = [];

  constructor(config: AgentLoopConfig) {
    this.generation = config.generation;
    this.modelConfig = config.modelConfig;
    this.toolRegistry = config.toolRegistry;
    this.toolExecutor = config.toolExecutor;
    this.messages = config.messages;
    this.onEvent = config.onEvent;
    this.modelRouter = new ModelRouter();

    // Max iterations from Feature Flag (云端热更新)
    this.maxIterations = getMaxIterations();

    // Planning service integration
    this.planningService = config.planningService;
    this.enableHooks = config.enableHooks ?? true;

    // Tracing metadata
    this.sessionId = config.sessionId || `session-${Date.now()}`;
    this.userId = config.userId;
  }

  // --------------------------------------------------------------------------
  // Plan Mode Methods (borrowed from Claude Code v2.0)
  // --------------------------------------------------------------------------

  /**
   * Set the plan mode state
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
   * Check if plan mode is active
   */
  isPlanMode(): boolean {
    return this.planModeActive;
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

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

    // Task Complexity Analysis - 自动检测任务复杂度并注入提示
    const complexityAnalysis = taskComplexityAnalyzer.analyze(userMessage);
    const complexityHint = taskComplexityAnalyzer.generateComplexityHint(complexityAnalysis);

    logger.debug(` Task complexity: ${complexityAnalysis.complexity} (${Math.round(complexityAnalysis.confidence * 100)}%)`);
    logCollector.agent('INFO', `Task complexity: ${complexityAnalysis.complexity}`, {
      confidence: complexityAnalysis.confidence,
      reasons: complexityAnalysis.reasons,
    });

    // Inject complexity hint as system message
    this.injectSystemMessage(complexityHint);

    // Session Start Hook
    if (this.enableHooks && this.planningService) {
      await this.runSessionStartHook();
    }

    let iterations = 0;

    while (!this.isCancelled && iterations < this.maxIterations) {
      iterations++;
      logger.debug(` >>>>>> Iteration ${iterations} START <<<<<<`);

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
      const response = await this.inference();
      const inferenceDuration = Date.now() - inferenceStartTime;
      logger.debug('[AgentLoop] Inference response type:', response.type);

      // Langfuse: Log inference event
      langfuse.logEvent(this.traceId, 'inference_complete', {
        iteration: iterations,
        responseType: response.type,
        duration: inferenceDuration,
      });

      // 2. Handle text response
      if (response.type === 'text' && response.content) {
        // 发送生成中进度
        this.emitTaskProgress('generating', '生成回复中...');
        // Stop Hook - verify completion before stopping
        if (this.enableHooks && this.planningService) {
          const stopResult = await this.planningService.hooks.onStop();

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
        this.messages.push(assistantMessage);
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
        break;
      }

      // 3. Handle tool calls
      if (response.type === 'tool_use' && response.toolCalls) {
        logger.debug(` Tool calls received: ${response.toolCalls.length} calls`);

        // 发送工具等待状态
        const toolNames = response.toolCalls.map(tc => tc.name).join(', ');
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
        this.messages.push(assistantMessage);

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
        const toolMessage: Message = {
          id: this.generateId(),
          role: 'tool',
          content: JSON.stringify(toolResults),
          timestamp: Date.now(),
          toolResults,
        };
        this.messages.push(toolMessage);

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

        // Continue loop
        logger.debug(` >>>>>> Iteration ${iterations} END (continuing) <<<<<<`);
        continue;
      }

      // No response, break
      break;
    }

    if (iterations >= this.maxIterations) {
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

    // Signal completion to frontend
    logger.debug('[AgentLoop] ========== run() END, emitting agent_complete ==========');
    logCollector.agent('INFO', `Agent run completed, ${iterations} iterations`);
    this.onEvent({ type: 'agent_complete', data: null });

    // Langfuse: Flush to ensure data is sent
    langfuse.flush().catch((err) => logger.error('[Langfuse] Flush error:', err));
  }

  cancel(): void {
    this.isCancelled = true;
  }

  // Getter for planning service (for tools that need it)
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
    extra?: { progress?: number; tool?: string; toolIndex?: number; toolTotal?: number }
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
    const results: ToolResult[] = [];

    for (let i = 0; i < toolCalls.length; i++) {
      const toolCall = toolCalls[i];
      logger.debug(` [${i + 1}/${toolCalls.length}] Processing tool: ${toolCall.name}, id: ${toolCall.id}`);

      // 记录使用的工具
      this.toolsUsedInTurn.push(toolCall.name);

      // 发送工具执行进度（显示当前是第几个，从 0 开始计数）
      const progress = Math.round((i / toolCalls.length) * 100);
      this.emitTaskProgress('tool_running', `执行 ${toolCall.name}`, {
        tool: toolCall.name,
        toolIndex: i,
        toolTotal: toolCalls.length,
        progress,
      });

      if (this.isCancelled) {
        logger.debug('[AgentLoop] Cancelled, breaking out of tool execution loop');
        break;
      }

      // Pre-Tool Hook
      if (this.enableHooks && this.planningService) {
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

      // Emit tool call start event with index and turnId for frontend matching
      logger.debug(` Emitting tool_call_start for ${toolCall.name} (index: ${i}, turnId: ${this.currentTurnId})`);
      this.onEvent({ type: 'tool_call_start', data: { ...toolCall, _index: i, turnId: this.currentTurnId } });

      // Langfuse: Start tool span
      const langfuse = getLangfuseService();
      const toolSpanId = `tool-${toolCall.id}`;
      langfuse.startNestedSpan(this.currentIterationSpanId, toolSpanId, {
        name: `Tool: ${toolCall.name}`,
        input: toolCall.arguments,
        metadata: { toolId: toolCall.id, toolName: toolCall.name },
      });

      const startTime = Date.now();

      try {
        // Execute tool
        logger.debug(` Calling toolExecutor.execute for ${toolCall.name}...`);
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
            // emitEvent allows tools to emit custom events - use type assertion for flexibility
            emitEvent: (event: string, data: unknown) => this.onEvent({ type: event, data } as AgentEvent),
          }
        );
        logger.debug(` toolExecutor.execute returned for ${toolCall.name}: success=${result.success}`);

        const toolResult: ToolResult = {
          toolCallId: toolCall.id,
          success: result.success,
          output: result.output,
          error: result.error,
          duration: Date.now() - startTime,
        };

        results.push(toolResult);
        logger.debug(` Tool ${toolCall.name} completed in ${toolResult.duration}ms`);

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

        // Post-Tool Hook
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
      } catch (error) {
        logger.error(`Tool ${toolCall.name} threw exception:`, error);
        const toolResult: ToolResult = {
          toolCallId: toolCall.id,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          duration: Date.now() - startTime,
        };

        results.push(toolResult);
        logger.debug(` Tool ${toolCall.name} failed with error: ${toolResult.error}`);

        // Error Hook
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
      }
    }

    logger.debug(` executeToolsWithHooks finished, returning ${results.length} results`);
    return results;
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
      let effectiveConfig = this.modelConfig;
      const requiredCapabilities = this.modelRouter.detectRequiredCapabilities(modelMessages);
      let needsVisionFallback = false;
      let visionFallbackSucceeded = false;

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

              // 管理员走云端代理，非管理员走本地 API Key
              if (isAdmin) {
                // 管理员：使用云端代理（标记为使用云端 Key）
                fallbackConfig.useCloudProxy = true;
                logger.debug(` 管理员账号，主模型 ${this.modelConfig.model} 不支持 ${capability}，切换到云端代理 ${fallbackConfig.model}`);
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
                // 非管理员：使用本地 API Key
                const fallbackApiKey = configService.getApiKey(fallbackConfig.provider);

                if (fallbackApiKey) {
                  fallbackConfig.apiKey = fallbackApiKey;
                  logger.debug(` 主模型 ${this.modelConfig.model} 不支持 ${capability}，切换到备用模型 ${fallbackConfig.model}`);
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
                } else {
                  // 非管理员且未配置本地 Key，发送提示事件
                  logger.warn(`备用模型 ${fallbackConfig.provider} 未配置 API Key，无法切换`);
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
      }

      // 如果需要视觉能力但无法切换到视觉模型，则移除图片内容避免 API 错误
      if (needsVisionFallback && !visionFallbackSucceeded) {
        logger.warn('[AgentLoop] 无法使用视觉模型，将图片转换为文字描述');
        modelMessages = this.stripImagesFromMessages(modelMessages);
      }

      // Call model through router
      logger.debug('[AgentLoop] Calling modelRouter.inference()...');
      logger.debug('[AgentLoop] Effective model:', effectiveConfig.model);
      const response = await this.modelRouter.inference(
        modelMessages,
        tools,
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
      if (!attachment.data) continue;

      // 检查总大小是否超限
      if (totalAttachmentChars >= MAX_TOTAL_ATTACHMENT_CHARS) {
        contents.push({
          type: 'text',
          text: `⚠️ 附件内容已达上限，跳过: ${attachment.name}`,
        });
        continue;
      }

      const category = attachment.category || (attachment.type === 'image' ? 'image' : 'other');

      switch (category) {
        case 'image': {
          // 图片：转换为 base64 图片内容块
          let base64Data = attachment.data;
          let mediaType = attachment.mimeType;

          if (attachment.data.startsWith('data:')) {
            const match = attachment.data.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              mediaType = match[1];
              base64Data = match[2];
            }
          }

          contents.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Data,
            },
          });
          break;
        }

        case 'pdf': {
          // PDF：文档结构化文本
          const pageInfo = attachment.pageCount ? ` (${attachment.pageCount} 页)` : '';
          const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
          const filePath = attachment.path || attachment.name;

          let contentText: string;
          if (isLargeFile(attachment.data)) {
            contentText = `📄 **PDF 文档: ${attachment.name}**${pageInfo}${pathInfo}\n\n${generateFilePreview(attachment.data, filePath, 'text')}`;
          } else {
            contentText = `📄 **PDF 文档: ${attachment.name}**${pageInfo}${pathInfo}\n\n${attachment.data}`;
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

          let contentText: string;
          if (isLargeFile(attachment.data)) {
            contentText = `📝 **代码文件: ${attachment.name}** (${lang})${pathInfo}\n\n${generateFilePreview(attachment.data, filePath, lang)}`;
          } else {
            contentText = `📝 **代码文件: ${attachment.name}** (${lang})${pathInfo}\n\`\`\`${lang}\n${attachment.data}\n\`\`\``;
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

          let contentText: string;
          if (isLargeFile(attachment.data)) {
            contentText = `📊 **数据文件: ${attachment.name}**${pathInfo}\n\n${generateFilePreview(attachment.data, filePath, lang)}`;
          } else {
            contentText = `📊 **数据文件: ${attachment.name}**${pathInfo}\n\`\`\`${lang}\n${attachment.data}\n\`\`\``;
          }
          totalAttachmentChars += contentText.length;
          contents.push({ type: 'text', text: contentText });
          break;
        }

        case 'html': {
          // HTML 文件
          const pathInfo = attachment.path ? `\n📍 路径: ${attachment.path}` : '';
          const filePath = attachment.path || attachment.name;

          let contentText: string;
          if (isLargeFile(attachment.data)) {
            contentText = `🌐 **HTML 文件: ${attachment.name}**${pathInfo}\n\n${generateFilePreview(attachment.data, filePath, 'html')}`;
          } else {
            contentText = `🌐 **HTML 文件: ${attachment.name}**${pathInfo}\n\`\`\`html\n${attachment.data}\n\`\`\``;
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

          let contentText: string;
          if (isLargeFile(attachment.data)) {
            contentText = `${icon} **${fileType}: ${attachment.name}**${pathInfo}\n\n${generateFilePreview(attachment.data, filePath, lang)}`;
          } else {
            contentText = `${icon} **${fileType}: ${attachment.name}**${pathInfo}\n\n${attachment.data}`;
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

          let contentText: string;
          if (isLargeFile(attachment.data)) {
            contentText = `📎 **文件: ${attachment.name}**${pathInfo}\n\n${generateFilePreview(attachment.data, filePath, 'text')}`;
          } else {
            contentText = `📎 **文件: ${attachment.name}**${pathInfo}\n\`\`\`\n${attachment.data}\n\`\`\``;
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
          // 将图片替换为文字说明
          newContent.push({
            type: 'text',
            text: '[图片内容: 当前模型不支持图片分析，请配置 OPENROUTER_API_KEY 以启用视觉模型]',
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
   */
  private buildEnhancedSystemPrompt(basePrompt: string): string {
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

      // Add user coding preferences (all Gen3+)
      const codingStyle = memoryService.getUserPreference<Record<string, unknown>>('coding_style');
      if (codingStyle && Object.keys(codingStyle).length > 0) {
        const styleStr = Object.entries(codingStyle)
          .map(([key, value]) => `- ${key}: ${value}`)
          .join('\n');
        enhancedPrompt += `\n\n## User Coding Preferences\n\n${styleStr}`;
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

      default:
        // 对于其他工具，只显示名称和简短参数
        const argsStr = JSON.stringify(args);
        const shortArgs = argsStr.length > 80 ? argsStr.slice(0, 77) + '...' : argsStr;
        return `Called ${name}(${shortArgs})`;
    }
  }
}
