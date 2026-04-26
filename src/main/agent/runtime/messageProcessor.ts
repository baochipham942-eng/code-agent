// ============================================================================
// MessageProcessor — Message building, parsing, and telemetry recording
// Extracted from ConversationRuntime
// ============================================================================

import type {
  Message,
  AgentEvent,
  ToolCall,
  ToolResult,
} from '../../../shared/contract';
import type { ModelResponse, AgentLoopConfig } from '../../agent/loopTypes';
import {
  sanitizeToolCallsForHistory,
  sanitizeToolResultsForHistoryWithCalls,
} from '../../agent/messageHandling/converter';
import {
  compressToolResult,
  estimateModelMessageTokens,
} from '../../context/tokenOptimizer';
import { classifyExecutionPhase } from '../../tools/executionPhase';
import { createLogger } from '../../services/infra/logger';
import { logCollector } from '../../mcp/logCollector.js';
import { MODEL_MAX_TOKENS } from '../../../shared/constants';
import {
  sanitizeBrowserComputerToolArguments,
  sanitizeBrowserComputerToolResult,
} from '../../../shared/utils/browserComputerRedaction';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';
import type { RunFinalizer } from './runFinalizer';
import type { ToolExecutionEngine } from './toolExecutionEngine';
import { generateMessageId } from '../../../shared/utils/id';
import { getSessionManager } from '../../services';
import { extractArtifacts } from '../artifactExtractor';

const logger = createLogger('MessageProcessor');

function sanitizeToolArgumentsForObservation(toolCall: Pick<ToolCall, 'name' | 'arguments'>): Record<string, unknown> | undefined {
  return sanitizeBrowserComputerToolArguments(toolCall.name, toolCall.arguments) || toolCall.arguments;
}

function sanitizeToolResultForObservation(
  toolCall: Pick<ToolCall, 'name' | 'arguments'> | undefined,
  result: ToolResult,
): ToolResult {
  if (!toolCall) {
    return result;
  }
  return sanitizeBrowserComputerToolResult(toolCall.name, toolCall.arguments, result);
}

/**
 * Extracts absolute file paths from text (e.g. user messages).
 */
export function extractAbsoluteFilePaths(text: string): string[] {
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

export class MessageProcessor {
  constructor(
    private ctx: RuntimeContext,
    private contextAssembly: ContextAssembly,
    private runFinalizer: RunFinalizer,
    private toolEngine: ToolExecutionEngine,
  ) {}

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
   * Returns 'break' to exit loop, 'continue' to retry.
   */
  async handleTextResponse(
    response: ModelResponse,
    isSimpleTask: boolean,
    iterations: number,
    shouldRunHooks: boolean,
    langfuse: any,
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
    if (shouldRunHooks && this.ctx.planningService) {
      try {
        const stopResult = await this.ctx.planningService.hooks.onStop();

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
      } catch (error) {
        logger.error('[AgentLoop] Planning stop hook error:', error);
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

    // 连续截断断路器
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
      this.ctx._consecutiveTruncations = 0;
    }

    const strippedContent = this.contextAssembly.stripInternalFormatMimicry(response.content || '');
    const assistantMessage: Message = {
      id: this.contextAssembly.generateId(),
      role: 'assistant',
      content: strippedContent,
      timestamp: Date.now(),
      thinking: response.thinking,
      effortLevel: this.ctx.effortLevel,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      contentParts: response.contentParts?.map(p =>
        p.type === 'text' ? { type: 'text' as const, text: this.contextAssembly.stripInternalFormatMimicry(p.text) } : p
      ),
    };

    // Artifact extraction
    const artifacts = extractArtifacts(strippedContent);
    if (artifacts.length > 0) {
      assistantMessage.artifacts = artifacts;
    }

    await this.contextAssembly.addAndPersistMessage(assistantMessage);

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
    langfuse: any,
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

      const writeFileCall = toolCalls.find((tc: ToolCall) => tc.name === 'write_file' || tc.name === 'Write');
      if (writeFileCall) {
        const content = writeFileCall.arguments?.content as string;
        if (content) {
          logger.warn(`write_file content length: ${content.length} chars - may be truncated!`);
          this.contextAssembly.injectSystemMessage(this.generateTruncationWarning());
        }
      } else {
        // 检测截断的 bash heredoc
        const truncatedBashHeredocs = toolCalls.filter((tc: ToolCall) =>
          (tc.name === 'bash' || tc.name === 'Bash') &&
          typeof tc.arguments?.command === 'string' &&
          /<<\s*['"]?\w+['"]?/.test(tc.arguments.command as string)
        );

        if (truncatedBashHeredocs.length > 0) {
          logger.warn(`[AgentLoop] Skipping ${truncatedBashHeredocs.length} truncated bash heredoc(s) to avoid SyntaxError`);

          const truncAssistantMsg: Message = {
            id: this.contextAssembly.generateId(),
            role: 'assistant',
            content: response.content || '',
            timestamp: Date.now(),
            toolCalls: sanitizeToolCallsForHistory(toolCalls),
            thinking: response.thinking,
            effortLevel: this.ctx.effortLevel,
            inputTokens: response.usage?.inputTokens,
            outputTokens: response.usage?.outputTokens,
          };
          await this.contextAssembly.addAndPersistMessage(truncAssistantMsg);
          this.ctx.onEvent({ type: 'message', data: truncAssistantMsg });

          const syntheticResults: ToolResult[] = toolCalls.map((tc: ToolCall) => ({
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

          this.contextAssembly.injectSystemMessage(
            `<truncation-recovery>\n` +
            `上一次的 bash 命令包含 heredoc（<<EOF...EOF），但因 max_tokens 限制被截断，命令不完整。\n` +
            `已跳过执行以避免 SyntaxError。请重新生成完整的命令。\n` +
            `提示：如果内联脚本很长，考虑先用 write_file 写入临时文件再用 bash 执行，而不是使用 heredoc。\n` +
            `</truncation-recovery>`
          );

          return 'continue';
        }

        this.contextAssembly.injectSystemMessage(
          `<truncation-recovery>\n` +
          `上一次输出因 max_tokens 限制被截断。请继续完成未完成的操作。\n` +
          `</truncation-recovery>`
        );
      }
    }

    toolCalls.forEach((tc: ToolCall, i: number) => {
      logger.debug(`   Tool ${i + 1}: ${tc.name}, args keys: ${Object.keys(tc.arguments || {}).join(', ')}`);
      logCollector.tool('INFO', `Tool call: ${tc.name}`, {
        toolId: tc.id,
        phase: classifyExecutionPhase(tc.name),
        args: sanitizeToolArgumentsForObservation(tc),
      });
    });

    // 清理模型输出中模仿内部格式的文本
    const cleanedContent = this.contextAssembly.stripInternalFormatMimicry(response.content || '');

    const assistantMessage: Message = {
      id: this.contextAssembly.generateId(),
      role: 'assistant',
      content: cleanedContent,
      timestamp: Date.now(),
      toolCalls: sanitizeToolCallsForHistory(toolCalls),
      thinking: response.thinking,
      effortLevel: this.ctx.effortLevel,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      contentParts: response.contentParts?.map(p =>
        p.type === 'text' ? { type: 'text' as const, text: this.contextAssembly.stripInternalFormatMimicry(p.text) } : p
      ),
    };

    // Artifact extraction
    if (cleanedContent) {
      const artifacts = extractArtifacts(cleanedContent);
      if (artifacts.length > 0) {
        assistantMessage.artifacts = artifacts;
      }
    }

    await this.contextAssembly.addAndPersistMessage(assistantMessage);

    logger.debug('[AgentLoop] Emitting message event for tool calls');
    this.ctx.onEvent({ type: 'message', data: assistantMessage });

    // Execute tools
    logger.debug('[AgentLoop] Starting executeToolsWithHooks...');
    const toolResults = await this.toolEngine.executeToolsWithHooks(toolCalls);
    logger.debug(` executeToolsWithHooks completed, ${toolResults.length} results`);

    // h2A 实时转向
    if (this.ctx.needsReinference) {
      this.ctx.needsReinference = false;
      logger.info('[AgentLoop] Steer detected during tool execution — saving results and re-inferring');
      if (toolResults.length > 0) {
        const partialResults = sanitizeToolResultsForHistoryWithCalls(toolResults, toolCalls);
        const partialToolMessage: Message = {
          id: this.contextAssembly.generateId(),
          role: 'tool',
          content: JSON.stringify(partialResults),
          timestamp: Date.now(),
          toolResults: partialResults,
        };
        await this.contextAssembly.addAndPersistMessage(partialToolMessage);
        this.applyDeferredSkillActivations(toolResults);
      }
      this.ctx.onEvent({
        type: 'interrupt_acknowledged',
        data: { message: '已收到新指令，正在调整方向...' },
      });
      return 'continue';
    }

    toolResults.forEach((r: ToolResult, i: number) => {
      const matchedToolCall = toolCalls.find((tc: ToolCall) => tc.id === r.toolCallId);
      const phase = matchedToolCall ? classifyExecutionPhase(matchedToolCall.name) : undefined;
      const safeResult = sanitizeToolResultForObservation(matchedToolCall, r);
      logger.debug(`   Result ${i + 1}: success=${r.success}, phase=${phase || 'unknown'}, error=${safeResult.error || 'none'}`);
      if (r.success) {
        logCollector.tool('INFO', `Tool result: success`, {
          toolCallId: r.toolCallId,
          phase,
          outputLength: r.output?.length || 0,
          duration: r.duration,
        });
      } else {
        logCollector.tool('ERROR', `Tool result: failed - ${safeResult.error}`, { toolCallId: r.toolCallId, phase });
      }
    });

    const sanitizedResults = sanitizeToolResultsForHistoryWithCalls(toolResults, toolCalls);

    // Compress tool results to save tokens
    const compressedResults = sanitizedResults.map((result: ToolResult) => {
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
    this.applyDeferredSkillActivations(toolResults);

    // === 先解析模型输出的任务列表（模型显式标记优先） ===
    this.runFinalizer.tryParseTodosFromResponse(response);

    // === 再根据工具执行情况自动推进（仅对修改类操作生效） ===
    this.runFinalizer.autoAdvanceTodos(toolCalls, toolResults);

    // Flush hook message buffer at end of iteration
    this.contextAssembly.flushHookMessageBuffer();

    langfuse.endSpan(this.ctx.currentIterationSpanId, {
      type: 'tool_calls',
      toolCount: toolCalls.length,
      successCount: toolResults.filter((r: ToolResult) => r.success).length,
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

    // Adaptive Thinking
    await this.contextAssembly.maybeInjectThinking(toolCalls, toolResults);

    // P2 Checkpoint
    this.ctx.nudgeManager.checkProgressState(
      this.ctx.toolsUsedInTurn,
      (msg: string) => this.contextAssembly.injectSystemMessage(msg),
    );

    // P5 after force-execute
    if (wasForceExecuted) {
      this.ctx.nudgeManager.checkPostForceExecute(
        this.ctx.workingDirectory,
        (msg: string) => this.contextAssembly.injectSystemMessage(msg),
      );
    }

    logger.debug(` >>>>>> Iteration ${iterations} END (continuing) <<<<<<`);
    return 'continue';
  }

  /**
   * Record telemetry for a model call.
   */
  recordModelCallTelemetry(
    response: ModelResponse,
    iterations: number,
    inferenceDuration: number,
  ): void {
    if (!this.ctx.telemetryAdapter) return;

    const MAX_PROMPT_LENGTH = 8000;
    const MAX_COMPLETION_LENGTH = 4000;

    const recentMessages = this.ctx.messages.slice(-3);
    const promptSummary = recentMessages.map((m: Message) =>
      `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
    ).join('\n---\n');

    let completionText = '';
    if (response.content) {
      completionText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    }
    if (response.toolCalls?.length) {
      const toolsSummary = response.toolCalls.map((tc: ToolCall) => `${tc.name}(${JSON.stringify(tc.arguments).substring(0, 200)})`).join('; ');
      completionText += (completionText ? '\n' : '') + `[tools: ${toolsSummary}]`;
    }

    const apiInputTokens = response.usage?.inputTokens ?? 0;
    const apiOutputTokens = response.usage?.outputTokens ?? 0;
    let effectiveInputTokens = apiInputTokens;
    let effectiveOutputTokens = apiOutputTokens;
    if (apiInputTokens === 0 || apiOutputTokens === 0) {
      const estInput = estimateModelMessageTokens(
        this.ctx.messages.slice(-10).map((m: Message) => ({ role: m.role, content: m.content }))
      );
      const outContent = (response.content || '') +
        (response.toolCalls?.map((tc: ToolCall) => JSON.stringify(tc.arguments || {})).join('') || '');
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

  /**
   * Inject steer message into conversation history.
   */
  injectSteerMessage(newMessage: string): void {
    const steerMessage: Message = {
      id: generateMessageId(),
      role: 'user',
      content: newMessage,
      timestamp: Date.now(),
    };
    this.ctx.messages.push(steerMessage);

    if (process.env.CODE_AGENT_CLI_MODE !== 'true') {
      const sessionManager = getSessionManager();
      sessionManager.addMessage(steerMessage).catch((err: unknown) => {
        logger.error('[AgentLoop] Failed to persist steer message:', err);
      });
    }
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

  private applyDeferredSkillActivations(toolResults: ToolResult[]): void {
    for (const result of toolResults) {
      if (!result.success || !result.metadata?.isSkillActivation || !result.metadata?.skillResult) {
        continue;
      }
      this.runFinalizer.processSkillActivation(
        result.metadata.skillResult as import('../../../shared/contract/agentSkill').SkillToolResult
      );
    }
  }
}
