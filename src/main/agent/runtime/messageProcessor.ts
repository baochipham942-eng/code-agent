// ============================================================================
// MessageProcessor — Message building, parsing, and telemetry recording
// Extracted from ConversationRuntime
// ============================================================================

import type {
  Message,
  MessageAttachment,
  MessageMetadata,
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
import { MODEL_MAX_TOKENS, getModelMaxOutputTokens } from '../../../shared/constants';
import {
  sanitizeBrowserComputerToolArguments,
  sanitizeBrowserComputerToolResult,
  sanitizeLargeTextToolArguments,
} from '../../../shared/utils/browserComputerRedaction';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';
import type { RunFinalizer } from './runFinalizer';
import type { ToolExecutionEngine } from './toolExecutionEngine';
import { generateMessageId } from '../../../shared/utils/id';
import { getSessionManager } from '../../services';
import { extractArtifacts } from '../artifactExtractor';
import {
  fingerprintToolCall,
  pushAndDetectStagnation,
  buildStagnationHint,
  buildStagnationStopMessage,
} from './stagnationDetector';
import { ANTI_SCRAPING_HINT_MARKER } from '../../tools/modules/network/antiScrapingDetector';
import { applyGroundTruthGate } from './groundTruthGate';

const logger = createLogger('MessageProcessor');

function sanitizeToolArgumentsForObservation(toolCall: Pick<ToolCall, 'name' | 'arguments'>): Record<string, unknown> | undefined {
  const browserSafeArgs = sanitizeBrowserComputerToolArguments(toolCall.name, toolCall.arguments) || toolCall.arguments;
  return sanitizeLargeTextToolArguments(toolCall.name, browserSafeArgs);
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

function shouldPreserveToolObservation(result: ToolResult): boolean {
  return result.metadata?.preserveObservation === true;
}

function isArtifactRepairTargetFileRead(result: ToolResult): boolean {
  return result.success === true
    && typeof result.output === 'string'
    && result.metadata?.evidenceKind === 'file_read'
    && typeof result.metadata?.filePath === 'string';
}

function buildForcedFinalAssistantContent(reason: string): string {
  if (reason.includes('artifact repair target already passes validation')) {
    return '目标产物已通过交互验收，修复流程已结束。';
  }
  return '任务已结束，已停止继续调用工具。执行记录和产物已保留。';
}

function buildArtifactRepairAdmissionRecoveryPrompt(
  targetFile: string,
  requestedNames: string,
  allowedNames: string,
  blockedToolCount: number,
): string {
  return [
    '<artifact-repair-admission-blocked>',
    `You are already inside artifact repair mode for ${targetFile}.`,
    `Your previous tool call requested unavailable tools: ${requestedNames}.`,
    `Only these tools are currently available: ${allowedNames}.`,
    'Do not repeat the unavailable tool call.',
    blockedToolCount >= 2
      ? 'The read/source-exploration budget is exhausted. Your next action must use Edit or Append on the target artifact.'
      : 'Your next action must patch the target artifact using the currently available file mutation tools.',
    'Use the target HTML file and validator failure summary already in context. Do not inspect validator/runtime sources.',
    '</artifact-repair-admission-blocked>',
  ].join('\n');
}

function activateArtifactRepairAdmissionStop(
  ctx: RuntimeContext,
  targetFile: string,
  requestedNames: string,
): void {
  ctx.forceFinalResponseReason = `artifact repair unavailable tool repeated: ${requestedNames}`;
  ctx.forceFinalResponsePrompt = [
    '<force-final-response reason="artifact-repair-tool-admission">',
    `Artifact repair mode is active for ${targetFile}.`,
    `The model repeatedly requested unavailable tool(s): ${requestedNames}.`,
    'Stop this attempt now instead of spending another model request on the same blocked action.',
    'Report that the target artifact still needs a mutation patch and that no target file change was applied.',
    '</force-final-response>',
  ].join('\n');
}

function isArtifactDirectoryBootstrapOnly(toolCall: ToolCall, result: ToolResult): boolean {
  if (!result.success) return false;
  if (toolCall.name !== 'Bash' && toolCall.name !== 'bash') return false;
  const command = typeof toolCall.arguments?.command === 'string' ? toolCall.arguments.command.trim() : '';
  if (!command) return false;
  return /^mkdir\s+-p\s+/.test(command);
}

function extractArtifactFilePathFromMessages(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const rawContent: unknown = message.content;
    const content = typeof rawContent === 'string'
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent.map((part: unknown) => {
          if (!part || typeof part !== 'object') return '';
          const textPart = part as { type?: unknown; text?: unknown };
          return textPart.type === 'text' && typeof textPart.text === 'string' ? textPart.text : '';
        }).join('\n')
        : '';
    const matches = extractAbsoluteFilePaths(content).filter((candidate) => /\.(html?|tsx?|jsx?|css|md)$/i.test(candidate));
    if (matches.length > 0) return matches[0];
  }
  return null;
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

  private getTruncationRecoveryMaxTokens(): number {
    const currentMaxTokens = this.ctx.modelConfig.maxTokens || MODEL_MAX_TOKENS.DEFAULT;
    const providerRecommendedMax = getModelMaxOutputTokens(this.ctx.modelConfig.model);
    return Math.max(currentMaxTokens, providerRecommendedMax);
  }

  private buildAssistantMessageFromResponse(response: ModelResponse, content: string): Message {
    return {
      id: this.contextAssembly.generateId(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      thinking: response.thinking,
      effortLevel: this.ctx.effortLevel,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      contentParts: response.contentParts?.map((part) =>
        part.type === 'text'
          ? { type: 'text' as const, text: this.contextAssembly.stripInternalFormatMimicry(part.text) }
          : part
      ),
    };
  }

  private buildTextContinuationPrompt(): string {
    return [
      'Continue from exactly where your previous response stopped.',
      'Do not repeat any earlier text, do not restart the section, and do not apologize.',
      'If you were outputting a long file or long code block, continue with the next lines only.',
    ].join(' ');
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): langfuse SDK 的 trace span 类型未导入，应 import { LangfuseTraceClient } from 'langfuse' 替换 any
    langfuse: any,
  ): Promise<'break' | 'continue'> {
    if (this.ctx.isCancelled) {
      logger.info('[AgentLoop] Skipping final text persistence after cancellation', {
        sessionId: this.ctx.sessionId,
        contentLength: response.content?.length ?? 0,
      });
      return 'break';
    }

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

    const textWasTruncated =
      response.truncated ||
      response.finishReason === 'length' ||
      response.finishReason === 'max_tokens';

    if (textWasTruncated && response.content) {
      this.ctx._consecutiveTruncations++;

      const strippedPartialContent = this.contextAssembly.stripInternalFormatMimicry(response.content);
      const partialAssistantMessage = this.buildAssistantMessageFromResponse(response, strippedPartialContent);

      await this.contextAssembly.addAndPersistMessage(partialAssistantMessage);
      this.ctx.onEvent({ type: 'message', data: partialAssistantMessage });

      const currentMaxTokens = this.ctx.modelConfig.maxTokens || MODEL_MAX_TOKENS.DEFAULT;
      const recoveryMaxTokens = this.getTruncationRecoveryMaxTokens();
      if (recoveryMaxTokens > currentMaxTokens) {
        this.ctx.modelConfig.maxTokens = recoveryMaxTokens;
        logger.info(`[AgentLoop] Text truncation recovery: maxTokens ${currentMaxTokens} → ${recoveryMaxTokens}`);
        logCollector.agent('INFO', `Text truncation recovery: maxTokens ${currentMaxTokens} → ${recoveryMaxTokens}`);
      }

      if (this.ctx._consecutiveTruncations >= this.ctx.MAX_CONSECUTIVE_TRUNCATIONS) {
        logger.warn(`[AgentLoop] Consecutive truncation circuit breaker: ${this.ctx._consecutiveTruncations} consecutive truncations`);
        logCollector.agent('WARN', `Consecutive truncation breaker triggered (${this.ctx._consecutiveTruncations}x)`);
        this.ctx._consecutiveTruncations = 0;
        this.contextAssembly.injectSystemMessage(
          [
            'Your previous responses keep hitting the output token limit.',
            'Continue from the exact end of the latest assistant message.',
            'Do not repeat earlier content.',
            'If the user asked for a long file or long code listing, keep continuing in chunks until complete.',
            'Only switch to write_file or another file-producing tool if the user explicitly wants the remaining content saved as a file.',
          ].join(' ')
        );
      } else {
        this.contextAssembly.injectSystemMessage(this.buildTextContinuationPrompt());
      }

      this.runFinalizer.emitTaskProgress('generating', '输出过长，继续生成剩余内容...');
      return 'continue';
    }

    this.ctx._consecutiveTruncations = 0;

    // P1-P5 Nudge checks (delegated to NudgeManager)
    const nudgeTriggered = this.ctx.nudgeManager.runNudgeChecks({
      toolsUsedInTurn: this.ctx.toolsUsedInTurn,
      isSimpleTaskMode: this.ctx.isSimpleTaskMode,
      sessionId: this.ctx.sessionId,
      iterations,
      workingDirectory: this.ctx.workingDirectory,
      injectSystemMessage: (msg: string) => this.contextAssembly.injectSystemMessage(msg),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): NudgeManager 的 onEvent 形参 { type: string; data: unknown } 是宽口，外层 ctx.onEvent 期望 AgentEvent 严格联合；应让 NudgeManager 直接接受 AgentEvent，或在外层定义 AnyEvent 类型
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

    const strippedContent = this.contextAssembly.stripInternalFormatMimicry(response.content || '');

    // === Ground-truth gate ===
    // 如果用户首条消息含 URL 且本 run 命中反爬阈值，给"成功输出"加 disclaimer。
    // 不替换内容，只 prefix 提示——让用户看到"反爬限制下未必准确"。
    const userFirstMessage = this.ctx.messages.find((m) => m.role === 'user')?.content;
    const gated = applyGroundTruthGate(
      typeof userFirstMessage === 'string' ? userFirstMessage : undefined,
      this.ctx.antiScrapingHitsInRun,
      strippedContent,
    );
    if (gated.applied) {
      logger.warn(
        `[GroundTruthGate] disclaimer prepended (anti-scraping hits=${this.ctx.antiScrapingHitsInRun}) — flagging potential fabrication`,
      );
      logCollector.agent('WARN', 'Ground-truth gate prepended disclaimer to assistant response', {
        antiScrapingHits: this.ctx.antiScrapingHitsInRun,
      });
    }

    const finalContent = gated.content;
    const assistantMessage = this.buildAssistantMessageFromResponse(response, finalContent);

    // Artifact extraction
    const artifacts = extractArtifacts(finalContent);
    if (artifacts.length > 0) {
      assistantMessage.artifacts = artifacts;
    }

    if (this.ctx.isCancelled) {
      logger.info('[AgentLoop] Skipping final text persistence after late cancellation', {
        sessionId: this.ctx.sessionId,
        contentLength: assistantMessage.content.length,
      });
      return 'break';
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): 同 handleTextResponse，langfuse SDK trace 类型应统一从 'langfuse' import
    langfuse: any,
  ): Promise<'continue' | 'break'> {
    const toolCalls = response.toolCalls!;
    const visibleToolNames = new Set(response.runtimeDiagnostics?.visibleToolNames || []);
    const unavailableToolCalls = visibleToolNames.size > 0
      ? toolCalls.filter((toolCall) => !visibleToolNames.has(toolCall.name))
      : [];

  if (unavailableToolCalls.length > 0) {
      const requestedNames = unavailableToolCalls.map((toolCall) => toolCall.name).join(', ');
      const allowedNames = [...visibleToolNames].join(', ') || 'none';
      const guard = this.ctx.artifactRepairGuard;
      const blockedToolCount = (guard?.blockedToolCount ?? 0) + 1;
      if (guard) {
        guard.blockedToolCount = blockedToolCount;
        guard.lastBlockedTool = requestedNames;
        if (blockedToolCount >= 2) {
          guard.noOpPatchCount = Math.max(guard.noOpPatchCount ?? 0, 1);
        }
      }
      const recoveryPrompt = guard?.targetFile
        ? buildArtifactRepairAdmissionRecoveryPrompt(
            guard.targetFile,
            requestedNames,
            allowedNames,
            blockedToolCount,
          )
        : null;
      this.contextAssembly.injectSystemMessage(
        [
          '<tool-admission-repair>',
          `The previous tool call requested unavailable tools: ${requestedNames}.`,
          `Only these tools are currently available: ${allowedNames}.`,
          'Do not repeat the unavailable tool call. Pick the next action only from the currently available tools.',
          recoveryPrompt || '',
          '</tool-admission-repair>',
        ].filter(Boolean).join('\n'),
      );
      if (recoveryPrompt) {
        this.contextAssembly.pushPersistentSystemContext(recoveryPrompt);
      }
      const assistantMsg: Message = {
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
      await this.contextAssembly.addAndPersistMessage(assistantMsg);
      this.ctx.onEvent({ type: 'message', data: assistantMsg });

      const syntheticResults: ToolResult[] = toolCalls.map((toolCall) => {
        const blocked = unavailableToolCalls.some((blockedCall) => blockedCall.id === toolCall.id);
        return {
          toolCallId: toolCall.id,
          success: false,
          error: blocked
            ? [
              `Tool ${toolCall.name} is not available in the current repair step.`,
              `Available tools: ${allowedNames}.`,
              recoveryPrompt || 'Use the currently visible tools only.',
            ].join('\n')
            : 'Skipped because the same model response included unavailable repair tools.',
          duration: 0,
          metadata: {
            artifactRepairGuard: {
              blocked: true,
              unavailableTool: blocked,
              targetFile: guard?.targetFile,
              phase: guard?.phase,
              attempts: guard?.attempts,
              blockedToolCount: guard?.blockedToolCount ?? blockedToolCount,
              lastBlockedTool: requestedNames,
              targetReadCount: guard?.targetReadCount,
              targetRangedReadCount: guard?.targetRangedReadCount,
              noOpPatchCount: guard?.noOpPatchCount,
            },
          },
        };
      });
      const toolMsg: Message = {
        id: this.contextAssembly.generateId(),
        role: 'tool',
        content: JSON.stringify(syntheticResults),
        timestamp: Date.now(),
        toolResults: syntheticResults,
      };
      await this.contextAssembly.addAndPersistMessage(toolMsg);
      const sanitizedResults = sanitizeToolResultsForHistoryWithCalls(syntheticResults, toolCalls);
      this.ctx.onEvent({ type: 'message', data: toolMsg });
      sanitizedResults.forEach((result) => {
        this.ctx.onEvent({
          type: 'tool_call_end',
          data: sanitizeToolResultForObservation(
            toolCalls.find((toolCall) => toolCall.id === result.toolCallId),
            result,
          ),
        });
      });
      return 'continue';
    }

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
      const boostedMax = Math.max(currentMax, getModelMaxOutputTokens(this.ctx.modelConfig.model));
      if (boostedMax > currentMax) {
        this.ctx.modelConfig.maxTokens = boostedMax;
        logger.info(`[AgentLoop] Tool truncation: boosted maxTokens ${currentMax} → ${boostedMax}`);
      }

      const writeFileCall = toolCalls.find((tc: ToolCall) =>
        tc.name === 'write_file' ||
        tc.name === 'Write' ||
        tc.name === 'append_file' ||
        tc.name === 'Append'
      );
      if (writeFileCall) {
        const content = writeFileCall.arguments?.content as string;
        if (content) {
          logger.warn(`${writeFileCall.name} content length: ${content.length} chars - may be truncated!`);
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

    if (this.ctx.isCancelled || this.ctx.isInterrupted || this.ctx.runAbortController?.signal.aborted) {
      logger.info('[AgentLoop] Run stop detected after tool execution; suppressing tool results');
      return 'break';
    }

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
    const artifactRepairResults = this.ctx.artifactRepairGuard
      ? sanitizedResults.map((result: ToolResult) => {
          if (!isArtifactRepairTargetFileRead(result)) {
            return result;
          }
          const output = this.contextAssembly.formatArtifactRepairToolResultContent(
            result,
            result.output || result.error || '',
          );
          if (output === result.output) {
            return result;
          }
          return {
            ...result,
            output,
            metadata: {
              ...result.metadata,
              artifactRepairPreview: true,
            },
          };
        })
      : sanitizedResults;

    // Compress tool results to save tokens
    const compressedResults = artifactRepairResults.map((result: ToolResult) => {
      if (shouldPreserveToolObservation(result)) {
        return result;
      }
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

    const artifactDirOnlyBootstrap = toolCalls.length === 1
      && toolResults.length === 1
      && isArtifactDirectoryBootstrapOnly(toolCalls[0], toolResults[0]);

    if (artifactDirOnlyBootstrap) {
      const artifactFilePath = extractArtifactFilePathFromMessages(this.ctx.messages);
      if (artifactFilePath) {
        this.contextAssembly.injectSystemMessage(
          [
            '<artifact-file-write-required>',
            `目标产物文件是 ${artifactFilePath}。目录已经存在，下一步必须直接写这个文件本身。`,
            '不要再次调用 mkdir，不要只输出计划，不要停留在目录准备。',
            '如果文件非常大：先 Write 一个最小可运行骨架到该路径，再用 Append 连续补完，并在最后一个 Append 上设置 final=true；如果完整单文件已经准备好且体量适中，可以直接一次 Write。',
            '</artifact-file-write-required>',
          ].join('\n')
        );
      }
    }

    if (this.ctx.forceFinalResponseReason) {
      const finalMessage: Message = {
        id: this.contextAssembly.generateId(),
        role: 'assistant',
        content: buildForcedFinalAssistantContent(this.ctx.forceFinalResponseReason),
        timestamp: Date.now(),
        effortLevel: this.ctx.effortLevel,
      };
      await this.contextAssembly.addAndPersistMessage(finalMessage);
      this.ctx.onEvent({ type: 'message', data: finalMessage });

      this.ctx.forceFinalResponseReason = undefined;
      this.ctx.forceFinalResponsePrompt = undefined;
      this.contextAssembly.flushHookMessageBuffer();
      langfuse.endSpan(this.ctx.currentIterationSpanId, {
        type: 'tool_calls',
        toolCount: toolCalls.length,
        successCount: toolResults.filter((r: ToolResult) => r.success).length,
        forcedFinalResponse: true,
      });
      this.ctx.telemetryAdapter?.onTurnEnd(this.ctx.currentTurnId, '', response.thinking, this.ctx.currentSystemPromptHash);
      this.ctx.onEvent({
        type: 'turn_end',
        data: { turnId: this.ctx.currentTurnId },
      });
      return 'break';
    }

    // === Stagnation detection ===
    // 计算本轮每个 tool call 的 fingerprint，push 到滑动窗口，连续 N 次相同
    // → 注入提示让模型换路径。不强制 break loop（给模型自我纠正机会），但
    // 已经发出过提示后再次命中就升级（这里用 stagnationWarningEmitted 标记 + 后续可在 finalizer break）
    const fingerprints = toolCalls.map((tc: ToolCall) => {
      const r = toolResults.find((res: ToolResult) => res.toolCallId === tc.id);
      return r ? fingerprintToolCall(tc, r) : '';
    }).filter((fp: string) => fp.length > 0);

    if (fingerprints.length > 0) {
      const detection = pushAndDetectStagnation(this.ctx.recentToolFingerprints, fingerprints);
      if (detection.detected && !this.ctx.stagnationWarningEmitted) {
        logger.warn(
          `[Stagnation] detected ${detection.matchCount}× repeat of fingerprint ${detection.sameFingerprint} — injecting hint to model`,
        );
        logCollector.agent('WARN', `Stagnation detected: ${detection.matchCount}× same tool+args+result`, {
          fingerprint: detection.sameFingerprint,
          matchCount: detection.matchCount,
        });
        this.contextAssembly.injectSystemMessage(buildStagnationHint(detection.matchCount));
        this.ctx.stagnationWarningEmitted = true;
      }
      // Hint 注入后仍重复 → 真止损,避免无谓烧 token。
      // 实战 case:龙虾 rate limit 重复 ToolSearch,日志 app-2026-05-03.log:1126。
      if (detection.shouldStop) {
        logger.warn(
          `[Stagnation] shouldStop after warning — fingerprint=${detection.sameFingerprint} matchCount=${detection.matchCount}, breaking iteration`,
        );
        logCollector.agent('ERROR', `Stagnation stop: ${detection.matchCount}× same call after warning`, {
          fingerprint: detection.sameFingerprint,
          matchCount: detection.matchCount,
        });
        this.contextAssembly.injectSystemMessage(
          buildStagnationStopMessage(detection.matchCount, detection.sameFingerprint),
        );
        this.ctx.onEvent({
          type: 'error',
          data: {
            message: `工具调用陷入死循环 (fingerprint=${detection.sameFingerprint},连续 ${detection.matchCount} 次),已停止本轮以避免烧 token`,
            code: 'STAGNATION_STOP',
            suggestion: '换工具或换参数;若任务确实无法推进,直接告知用户限制',
          },
        });
        return 'break';
      }
    }

    // === Ground-truth gate (counter increment) ===
    // 扫描 toolResults，命中反爬 marker 就累加计数。最终 assistant message 落地前
    // 用此计数判断是否要加 disclaimer（在 handleTextResponse 里调用 applyGroundTruthGate）
    for (const r of toolResults) {
      const text = typeof r.output === 'string' ? r.output : (typeof r.error === 'string' ? r.error : '');
      if (text.includes(ANTI_SCRAPING_HINT_MARKER)) {
        this.ctx.antiScrapingHitsInRun++;
      }
    }

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
      provider: response.actualProvider ?? response.fallback?.to.provider ?? this.ctx.modelConfig.provider,
      model: response.actualModel ?? response.fallback?.to.model ?? this.ctx.modelConfig.model,
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
  injectSteerMessage(
    newMessage: string,
    clientMessageId?: string,
    attachments?: MessageAttachment[],
    metadata?: MessageMetadata,
  ): void {
    const steerMessage: Message = {
      id: clientMessageId ?? generateMessageId(),
      role: 'user',
      content: newMessage,
      timestamp: Date.now(),
      attachments,
      metadata,
    };
    this.ctx.messages.push(steerMessage);

    if (process.env.CODE_AGENT_CLI_MODE !== 'true') {
      const sessionManager = getSessionManager();
      sessionManager.addMessageToSession(this.ctx.sessionId, steerMessage).catch((err: unknown) => {
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
