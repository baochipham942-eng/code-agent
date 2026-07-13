// ============================================================================
// MessageProcessor — Message building, parsing, and telemetry recording
// Extracted from ConversationRuntime
// ============================================================================

import type {
  AgentEvent,
  Message,
  MessageAttachment,
  MessageMetadata,
  ToolCall,
  ToolResult,
} from '../../../shared/contract';
import type { ModelResponse } from '../../agent/loopTypes';
import {
  sanitizeToolCallsForHistory,
  sanitizeToolResultsForHistoryWithCalls,
} from '../../agent/messageHandling/converter';
import { classifyExecutionPhase } from '../../tools/executionPhase';
import { createLogger } from '../../services/infra/logger';
import { logCollector } from '../../mcp/logCollector.js';
import { DELIVERY_CRITIC, MODEL_MAX_TOKENS, STOP_HOOK, getModelMaxOutputTokens } from '../../../shared/constants';
import { runDeliveryCritic } from '../deliveryCritic';
import type { RuntimeContext } from './runtimeContext';
import type { ContextAssembly } from './contextAssembly';
import type { RunFinalizer } from './runFinalizer';
import type { ToolExecutionEngine } from './toolExecutionEngine';
import { generateMessageId } from '../../../shared/utils/id';
import { getSessionManager } from '../../services';
import { extractArtifacts } from '../artifactExtractor';
import { handleDeclareDeliverablesGate } from './declareDeliverablesGate';
import { handleGoalCompletionGate } from './goalCompletionGate';
import {
  fingerprintToolCall,
  pushAndDetectStagnation,
  buildStagnationHint,
  buildStagnationStopMessage,
  pushAndDetectToolSpam,
  buildToolSpamHint,
  TOOL_SPAM_WINDOW,
} from './stagnationDetector';
import { getArtifactRepairToolPolicy } from './artifactRepairGuard';
import {
  maybeClearCompletedArtifactRepairGuardBeforeAdmission,
  ARTIFACT_REPAIR_STOP_PREFIXES,
} from './artifactRepairAdmission';
import { ANTI_SCRAPING_HINT_MARKER } from '../../tools/modules/network/antiScrapingDetector';
import { applyGroundTruthGate } from './groundTruthGate';
import { applyDesktopActionClaimGate } from './desktopActionClaimGate';
import { isLikelyIncompleteStopText } from './incompleteStopDetector';
import { extractArtifactFilePathFromMessages } from './artifactPathExtractor';
import { getHandoffProposalService } from '../../handoff/handoffProposalService';
import { extractHandoffProposalTail } from '../../handoff/handoffTail';
import {
  buildForcedFinalAssistantContent,
  isArtifactDirectoryBootstrapOnly,
  isArtifactRepairTargetFileRead,
  sanitizeToolArgumentsForObservation,
  sanitizeToolResultForObservation,
  shouldDeferForcedFinalToInference,
} from './messageProcessorHelpers';
import { handleUnavailableToolCalls } from './messageProcessorUnavailableTools';
import { recordMessageProcessorModelCallTelemetry } from './messageProcessorTelemetry';
import { generateTruncationWarning } from './truncationPrompts';
import { isToolDeniedForRun } from './toolRunPolicy';
import { attachTurnQualityMetadata } from './turnQuality';

const logger = createLogger('MessageProcessor');
type LangfuseSpanFacade = { endSpan(spanId: string, output?: unknown, level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR', statusMessage?: string): void };
function toAgentEventFromNudge(event: { type: string; data: unknown }): AgentEvent | null {
  const data = event.data as { message?: unknown; parentToolUseId?: unknown } | null;
  if (event.type !== 'notification' || typeof data?.message !== 'string') return null;
  return {
    type: 'notification',
    data: {
      message: data.message,
      parentToolUseId: typeof data.parentToolUseId === 'string' ? data.parentToolUseId : undefined,
    },
  };
}

export class MessageProcessor {
  /** 2a: 防呆/重试计数自持状态（原 RuntimeContext 字段，ADR-038 批2a 下沉） */
  private readonly guardState = {
    recentToolFingerprints: [] as string[],
    recentToolNames: [] as string[],
    stagnationWarningEmitted: false,
    searchSpamWarningEmitted: false,
    antiScrapingHitsInRun: 0,
    stopHookRetryCount: 0,
    userStopHookBlockCount: 0,
    toolCallRetryCount: 0,
    deliveryCriticBlockCount: 0,
    _consecutiveTruncations: 0,
  };

  /** @internal 测试专用入口，生产代码禁止调用 */
  get guardStateForTest() { return this.guardState; }

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
        } else if (this.guardState.toolCallRetryCount < this.ctx.maxToolCallRetries) {
          this.guardState.toolCallRetryCount++;
          logger.warn(`[AgentLoop] Detected text description of tool call: "${failedToolCallMatch.toolName}"`);
          logCollector.agent('WARN', `Model described tool call as text: ${failedToolCallMatch.toolName}`);
          this.contextAssembly.injectSystemMessage(
            this.ctx.antiPatternDetector.generateToolCallFormatError(failedToolCallMatch.toolName, response.content)
          );
          logger.debug(`[AgentLoop] Tool call retry ${this.guardState.toolCallRetryCount}/${this.ctx.maxToolCallRetries}`);
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

  // Route A: surface an artifact-repair force-stop to the UI as an error event so
  // the user sees why the turn ended. Handles both stop kinds (unavailable-tool
  // spam and attempt-limit exhaustion).
  private maybeEmitArtifactRepairStopError(stopReason: string): void {
    const targetFile = this.ctx.artifactRepairGuard?.targetFile ?? '目标文件';
    const unavailablePrefix = ARTIFACT_REPAIR_STOP_PREFIXES['unavailable-tool'];
    const attemptsPrefix = ARTIFACT_REPAIR_STOP_PREFIXES['attempts-exhausted'];
    if (stopReason.startsWith(unavailablePrefix)) {
      const detail = stopReason.slice(unavailablePrefix.length).trim();
      this.ctx.onEvent({
        type: 'error',
        data: {
          message: `产物修复终止:模型反复请求不可用工具 ${detail},已停止本轮尝试`,
          code: 'artifact_repair_admission_stop',
          suggestion: `目标文件 ${targetFile} 仍需要应用修复变更。建议重新发起任务,或检查目标文件当前状态后再继续。`,
          details: { targetFile, blockedTool: detail },
        },
      });
    } else if (stopReason.startsWith(attemptsPrefix)) {
      const detail = stopReason.slice(attemptsPrefix.length).trim();
      this.ctx.onEvent({
        type: 'error',
        data: {
          message: `产物修复终止:修复尝试达到上限(${detail}),已停止本轮尝试`,
          code: 'artifact_repair_admission_stop',
          suggestion: `目标文件 ${targetFile} 仍未通过校验。建议重新发起任务,或检查目标文件当前状态后再继续。`,
          details: { targetFile, attempts: detail },
        },
      });
    }
  }

  private buildAssistantMessageFromResponse(response: ModelResponse, content: string): Message {
    return {
      id: this.contextAssembly.generateId(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      thinking: response.thinking,
      effortLevel: this.ctx.turn.effortLevel,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      modelDecision: response.runtimeDiagnostics?.modelDecision,
      metadata: attachTurnQualityMetadata(this.ctx, undefined, response),
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
    langfuse: LangfuseSpanFacade,
  ): Promise<'break' | 'continue'> {
    if (this.ctx.control.isCancelled) {
      logger.info('[AgentLoop] Skipping final text persistence after cancellation', {
        sessionId: this.ctx.sessionId,
        contentLength: response.content?.length ?? 0,
      });
      return 'break';
    }

    const isForcedFinalTextPass = Boolean(this.ctx.control.forceFinalResponseReason);

    // Research mode: indicate report generation phase
    if (this.ctx.turn.researchModeActive) {
      this.runFinalizer.emitTaskProgress('generating', '正在生成报告...');
    } else {
      this.runFinalizer.emitTaskProgress('generating', '生成回复中...');
    }

    // User-configurable Stop hook (GAP-006: 完成闸 + 重试安全阀)
    if (!isForcedFinalTextPass && this.ctx.hookManager && !isSimpleTask) {
      try {
        const userStopResult = await this.ctx.hookManager.triggerStop(
          response.content,
          this.ctx.sessionId,
          this.guardState.userStopHookBlockCount > 0,
        );
        if (!userStopResult.shouldProceed) {
          this.guardState.userStopHookBlockCount++;
          if (this.guardState.userStopHookBlockCount <= STOP_HOOK.USER_MAX_RETRIES) {
            logger.info('[AgentLoop] Stop prevented by user hook', {
              message: userStopResult.message,
              retry: this.guardState.userStopHookBlockCount,
            });
            if (userStopResult.message) {
              this.contextAssembly.injectSystemMessage(`<stop-hook>\n${userStopResult.message}\n</stop-hook>`);
            }
            return 'continue';
          }
          // 安全阀：用户 stop hook 持续 block 达到上限，放行停止防死循环
          logger.warn('[AgentLoop] User stop hook block limit reached, allowing stop', {
            blockCount: this.guardState.userStopHookBlockCount,
            limit: STOP_HOOK.USER_MAX_RETRIES,
          });
          logCollector.agent('WARN', `User stop hook max retries (${STOP_HOOK.USER_MAX_RETRIES}) reached, allowing stop`);
          this.ctx.onEvent({
            type: 'notification',
            data: { message: 'Stop hook 持续拦截已达重试上限，本次按完成处理' },
          });
        } else if (userStopResult.message) {
          this.contextAssembly.injectSystemMessage(`<stop-hook>\n${userStopResult.message}\n</stop-hook>`);
        }
      } catch (error) {
        logger.error('[AgentLoop] User stop hook error:', error);
      }
    }

    // GAP-013 / #7: Generator-Critic 交付前自动验证（证据驱动 + 有界打回）
    // 修改文件数达到阈值的 run，在交付前派 code-review 子代理审查；发现 Critical
    // 问题 → 阻塞交付 + 注入审查意见让模型修复。证据驱动：把"本次验证命令是否运行/
    // 通过"喂给 critic，验证失败时即使 critic 出错/解析失败也按客观证据阻塞。
    // 有界打回：最多打回 DELIVERY_CRITIC.MAX_BLOCKS 次（模型修复后可重审），满则放行防死循环。
    if (
      !isForcedFinalTextPass &&
      !isSimpleTask &&
      this.ctx.enableDeliveryCritic &&
      this.guardState.deliveryCriticBlockCount < DELIVERY_CRITIC.MAX_BLOCKS
    ) {
      const modifiedFiles = Array.from(this.ctx.nudgeManager.getModifiedFiles());
      if (modifiedFiles.length >= DELIVERY_CRITIC.FILE_THRESHOLD) {
        try {
          this.runFinalizer.emitTaskProgress('generating', '交付前自动审查中...');
          const userFirstMessage = this.ctx.messages.find((m) => m.role === 'user')?.content;
          const verificationOutcome = this.ctx.nudgeManager.getVerificationOutcome();
          const criticResult = await runDeliveryCritic(
            modifiedFiles,
            typeof userFirstMessage === 'string' ? userFirstMessage : '',
            {
              workingDirectory: this.ctx.workingDirectory,
              sessionId: this.ctx.sessionId,
              abortSignal: this.ctx.control.runAbortController?.signal,
              hookManager: this.ctx.hookManager,
              // 可用性降级链：powerful tier 没配 key 时，critic 降级用主 run 的模型
              parentModelConfig: this.ctx.modelConfig,
            },
            verificationOutcome,
          );
          if (!criticResult.pass) {
            this.guardState.deliveryCriticBlockCount++;
            logger.info('[AgentLoop] Delivery blocked by critic', {
              reason: criticResult.reason.slice(0, 200),
              fileCount: modifiedFiles.length,
              verification: verificationOutcome,
              blockCount: this.guardState.deliveryCriticBlockCount,
            });
            logCollector.agent('WARN', 'Delivery critic found critical issues, blocking delivery');
            const verifyHint = verificationOutcome === 'none'
              ? '\n建议：修复后运行测试/类型检查（如 npm run typecheck / npm test）验证，再交付。'
              : verificationOutcome === 'failed'
                ? '\n注意：本次验证命令运行失败，请先让验证通过再交付。'
                : '';
            this.contextAssembly.injectSystemMessage(
              [
                '<delivery-critic>',
                `交付前自动审查发现 Critical 问题（第 ${this.guardState.deliveryCriticBlockCount}/${DELIVERY_CRITIC.MAX_BLOCKS} 次打回），请先修复再交付：`,
                criticResult.reason,
                verifyHint,
                '</delivery-critic>',
              ].join('\n'),
            );
            this.ctx.onEvent({
              type: 'notification',
              data: { message: '交付前审查发现 Critical 问题，正在修复' },
            });
            return 'continue';
          }
        } catch (error) {
          logger.error('[AgentLoop] Delivery critic error:', error);
        }
      }
    } else if (
      !isForcedFinalTextPass &&
      !isSimpleTask &&
      this.ctx.enableDeliveryCritic &&
      this.guardState.deliveryCriticBlockCount >= DELIVERY_CRITIC.MAX_BLOCKS
    ) {
      // 已打回满 MAX_BLOCKS 次仍未过 critic —— 强制放行避免无限循环（有界打回）
      logger.warn('[AgentLoop] Delivery critic block limit reached, force-passing delivery', {
        blockCount: this.guardState.deliveryCriticBlockCount,
      });
    }

    // Planning stop hook
    if (!isForcedFinalTextPass && shouldRunHooks && this.ctx.planningService) {
      try {
        const stopResult = await this.ctx.planningService.hooks.onStop();

        if (!stopResult.shouldContinue && stopResult.injectContext) {
          this.guardState.stopHookRetryCount++;

          if (this.guardState.stopHookRetryCount <= this.ctx.maxStopHookRetries) {
            this.contextAssembly.injectSystemMessage(stopResult.injectContext);
            if (stopResult.notification) {
              this.ctx.onEvent({
                type: 'notification',
                data: { message: stopResult.notification },
              });
            }
            logger.debug(` Stop hook retry ${this.guardState.stopHookRetryCount}/${this.ctx.maxStopHookRetries}`);
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

    const stopLooksIncomplete = isLikelyIncompleteStopText(response);
    const textWasTruncated =
      response.truncated ||
      response.finishReason === 'length' ||
      response.finishReason === 'max_tokens' ||
      stopLooksIncomplete;

    if (textWasTruncated && response.content) {
      if (stopLooksIncomplete) {
        logger.warn('[AgentLoop] Provider reported stop but text ended mid-sentence; continuing generation');
        logCollector.agent('WARN', 'Text response ended mid-sentence despite stop finish reason');
      }
      this.guardState._consecutiveTruncations++;

      const strippedPartialContent = this.contextAssembly.stripInternalFormatMimicry(response.content);
      const partialAssistantMessage = this.buildAssistantMessageFromResponse(response, strippedPartialContent);

      await this.contextAssembly.addAndPersistMessage(partialAssistantMessage);
      this.ctx.onEvent({ type: 'message', data: partialAssistantMessage });

      const currentMaxTokens = this.ctx.modelConfig.maxTokens || MODEL_MAX_TOKENS.DEFAULT;
      const recoveryMaxTokens = this.getTruncationRecoveryMaxTokens();
      if (!stopLooksIncomplete && recoveryMaxTokens > currentMaxTokens) {
        this.ctx.modelConfig.maxTokens = recoveryMaxTokens;
        logger.info(`[AgentLoop] Text truncation recovery: maxTokens ${currentMaxTokens} → ${recoveryMaxTokens}`);
        logCollector.agent('INFO', `Text truncation recovery: maxTokens ${currentMaxTokens} → ${recoveryMaxTokens}`);
      }

      if (this.guardState._consecutiveTruncations >= this.ctx.MAX_CONSECUTIVE_TRUNCATIONS) {
        logger.warn(`[AgentLoop] Consecutive truncation circuit breaker: ${this.guardState._consecutiveTruncations} consecutive truncations`);
        logCollector.agent('WARN', `Consecutive truncation breaker triggered (${this.guardState._consecutiveTruncations}x)`);
        this.guardState._consecutiveTruncations = 0;
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

      this.runFinalizer.emitTaskProgress(
        'generating',
        stopLooksIncomplete ? '回复疑似未完，继续生成剩余内容...' : '输出过长，继续生成剩余内容...',
      );
      return 'continue';
    }

    this.guardState._consecutiveTruncations = 0;

    // P1-P5 Nudge checks (delegated to NudgeManager)
    const artifactRepairPolicy = getArtifactRepairToolPolicy(this.ctx.artifactRepairGuard);
    if (!isForcedFinalTextPass) {
      const nudgeTriggered = this.ctx.nudgeManager.runNudgeChecks({
        toolsUsedInTurn: this.ctx.turn.toolsUsedInTurn,
        isSimpleTaskMode: this.ctx.turn.isSimpleTaskMode,
        sessionId: this.ctx.sessionId,
        iterations,
        workingDirectory: this.ctx.workingDirectory,
        mutationToolPrompt: artifactRepairPolicy?.mutationToolPromptZh,
        injectSystemMessage: (msg: string) => this.contextAssembly.injectSystemMessage(msg),
        onEvent: (event: { type: string; data: unknown }) => {
          const agentEvent = toAgentEventFromNudge(event);
          if (agentEvent) {
            this.ctx.onEvent(agentEvent);
          }
        },
        goalTracker: this.ctx.goalTracker,
      });
      if (nudgeTriggered) {
        return 'continue';
      }
    }
    // P7 + P0 Output validation (delegated to NudgeManager)
    if (!isForcedFinalTextPass) {
      const validationTriggered = this.ctx.nudgeManager.runOutputValidation(
        (msg: string) => this.contextAssembly.injectSystemMessage(msg),
      );
      if (validationTriggered) {
        return 'continue';
      }
    }

    const strippedRawContent = this.contextAssembly.stripInternalFormatMimicry(response.content || '');
    const handoffTail = extractHandoffProposalTail(strippedRawContent);
    const strippedContent = handoffTail.cleanedContent;
    const latestUserMessage = [...this.ctx.messages].reverse()
      .find((message) => message.role === 'user' && message.visibility !== 'rewound');
    const latestUserContent = latestUserMessage?.content;
    const hasAppshotEvidence =
      (typeof latestUserContent === 'string' && latestUserContent.includes('<appshot')) ||
      latestUserMessage?.attachments?.some((attachment) => attachment.id.startsWith('appshot-')) ||
      false;
    const desktopClaimGate = applyDesktopActionClaimGate({
      latestUserMessage: typeof latestUserContent === 'string' ? latestUserContent : undefined,
      assistantContent: strippedContent,
      toolCallCount: this.ctx.totalToolCallCount,
      iterations,
      hasDesktopEvidence: hasAppshotEvidence,
    });
    if (desktopClaimGate.action === 'retry') {
      logger.warn('[DesktopActionClaimGate] retrying text response without desktop tool evidence', {
        reason: desktopClaimGate.reason,
        sessionId: this.ctx.sessionId,
      });
      this.contextAssembly.injectSystemMessage(desktopClaimGate.repairPrompt);
      return 'continue';
    }

    // === Ground-truth gate ===
    // 如果用户首条消息含 URL 且本 run 命中反爬阈值，给"成功输出"加 disclaimer。
    // 不替换内容，只 prefix 提示——让用户看到"反爬限制下未必准确"。
    const userFirstMessage = this.ctx.messages.find((m) => m.role === 'user')?.content;
    const gated = applyGroundTruthGate(
      typeof userFirstMessage === 'string' ? userFirstMessage : undefined,
      this.guardState.antiScrapingHitsInRun,
      desktopClaimGate.content,
    );
    if (gated.applied) {
      logger.warn(
        `[GroundTruthGate] disclaimer prepended (anti-scraping hits=${this.guardState.antiScrapingHitsInRun}) — flagging potential fabrication`,
      );
      logCollector.agent('WARN', 'Ground-truth gate prepended disclaimer to assistant response', {
        antiScrapingHits: this.guardState.antiScrapingHitsInRun,
      });
    }

    const finalContent = gated.content;
    if (desktopClaimGate.action === 'warn') {
      logger.warn('[DesktopActionClaimGate] warning prepended to text response without desktop tool evidence', {
        reason: desktopClaimGate.reason,
        sessionId: this.ctx.sessionId,
      });
    }
    const assistantMessage = this.buildAssistantMessageFromResponse(response, finalContent);
    if (handoffTail.found && assistantMessage.contentParts?.length) {
      assistantMessage.contentParts = [{ type: 'text', text: finalContent }];
    }

    // Artifact extraction
    const artifacts = extractArtifacts(finalContent);
    if (artifacts.length > 0) {
      assistantMessage.artifacts = artifacts;
    }

    if (this.ctx.control.isCancelled) {
      logger.info('[AgentLoop] Skipping final text persistence after late cancellation', {
        sessionId: this.ctx.sessionId,
        contentLength: assistantMessage.content.length,
      });
      return 'break';
    }

    await this.contextAssembly.addAndPersistMessage(assistantMessage);

    if (handoffTail.draft) {
      try {
        getHandoffProposalService().create({
          sessionId: this.ctx.sessionId,
          sourceMessageId: assistantMessage.id,
          ...handoffTail.draft,
        });
      } catch (error) {
        logger.warn('[Handoff] Failed to create proposal from assistant tail', {
          error,
          sessionId: this.ctx.sessionId,
          sourceMessageId: assistantMessage.id,
        });
      }
    }

    this.ctx.onEvent({ type: 'message', data: assistantMessage });
    if (isForcedFinalTextPass) {
      this.ctx.control.clearForceFinalResponse();
    }

    // === 自动解析任务列表（替代 TodoWrite 工具） ===
    this.runFinalizer.tryParseTodosFromResponse(response);

    langfuse.endSpan(this.ctx.turn.currentIterationSpanId, { type: 'text_response' });

    this.runFinalizer.emitTaskProgress('completed', '回复完成');
    this.runFinalizer.emitTaskComplete();

    // Telemetry: record turn end (text response)
    this.ctx.telemetryAdapter?.onTurnEnd(this.ctx.turn.currentTurnId, response.content || '', response.thinking, this.ctx.contextHealth.currentSystemPromptHash);

    this.ctx.onEvent({
      type: 'turn_end',
      data: { turnId: this.ctx.turn.currentTurnId },
    });

    this.contextAssembly.updateContextHealth();

    // PostExecution hook: trigger async health checks (GC, codebase scans)
    if (this.ctx.hookManager) {
      this.ctx.hookManager.triggerPostExecution?.(
        this.ctx.sessionId,
        iterations,
        this.ctx.turn.toolsUsedInTurn,
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
    langfuse: LangfuseSpanFacade,
  ): Promise<'continue' | 'break'> {
    const toolCalls = response.toolCalls ?? [];
    const requestedToolNames = toolCalls.map((toolCall) => toolCall.name).join(', ');

    const deniedToolCalls = toolCalls.filter((toolCall) => isToolDeniedForRun(this.ctx, toolCall.name));
    if (deniedToolCalls.length > 0) {
      this.guardState.toolCallRetryCount++;
      const deniedNames = Array.from(new Set(deniedToolCalls.map((toolCall) => toolCall.name))).join(', ');
      this.contextAssembly.injectSystemMessage(
        [
          '<tool-run-policy>',
          `The previous tool call requested disabled tools for this run: ${deniedNames}.`,
          'Continue without those tools. If you need user input, state the blocker in your final text instead of calling an interactive tool.',
          '</tool-run-policy>',
        ].join('\n'),
      );
      if (this.guardState.toolCallRetryCount > this.ctx.maxToolCallRetries) {
        const finalMessage: Message = {
          id: this.contextAssembly.generateId(),
          role: 'assistant',
          content: `本轮请求了后台运行禁用的交互工具（${deniedNames}），已停止继续调用工具。`,
          timestamp: Date.now(),
          effortLevel: this.ctx.turn.effortLevel,
          metadata: attachTurnQualityMetadata(this.ctx, undefined, response),
          ...(this.ctx.historyVisibility === 'meta' ? { isMeta: true } : {}),
        };
        await this.contextAssembly.addAndPersistMessage(finalMessage);
        this.ctx.onEvent({ type: 'message', data: finalMessage });
        this.ctx.telemetryAdapter?.onTurnEnd(this.ctx.turn.currentTurnId, '', response.thinking, this.ctx.contextHealth.currentSystemPromptHash);
        this.ctx.onEvent({
          type: 'turn_end',
          data: { turnId: this.ctx.turn.currentTurnId },
        });
        return 'break';
      }
      return 'continue';
    }

    // Artifact contract：拦截 declare_deliverables → 写入本轮最终产物路径声明。
    const declareDeliverablesResult = handleDeclareDeliverablesGate(this.ctx, this.contextAssembly, toolCalls);
    if (declareDeliverablesResult) return declareDeliverablesResult;

    // Goal mode：拦截 attempt_completion → 双闸验证（闸1 确定性 verifyCommand + 闸2 软评审 reviewCondition）。
    // 完成判定权在代码层，模型无法靠"自称完成"绕过（拒绝 Ralph）。详见 goalCompletionGate。
    const goalGateResult = await handleGoalCompletionGate(this.ctx, this.contextAssembly, toolCalls, iterations);
    if (goalGateResult) return goalGateResult;

    const activeRepairGuard = this.ctx.artifactRepairGuard;
    if (activeRepairGuard && await maybeClearCompletedArtifactRepairGuardBeforeAdmission(
      this.ctx,
      this.contextAssembly,
      activeRepairGuard,
      requestedToolNames,
    )) {
      return 'continue';
    }

    const visibleToolNames = new Set(response.runtimeDiagnostics?.visibleToolNames || []);
    const unavailableToolCalls = visibleToolNames.size > 0
      ? toolCalls.filter((toolCall) => !visibleToolNames.has(toolCall.name))
      : [];

    if (unavailableToolCalls.length > 0) {
      return handleUnavailableToolCalls(
        {
          ctx: this.ctx,
          contextAssembly: this.contextAssembly,
          emitArtifactRepairStopError: (reason) => this.maybeEmitArtifactRepairStopError(reason),
        },
        response,
        toolCalls,
        unavailableToolCalls,
        visibleToolNames,
      );
    }

    logger.debug(` Tool calls received: ${toolCalls.length} calls`);

    // Route A: the model picked available tools this turn, so it is no longer
    // stuck on the unavailable-tool loop — clear the no-progress counter.
    if (this.ctx.artifactRepairGuard) {
      this.ctx.artifactRepairGuard.repairTurnsWithoutProgress = 0;
    }

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
          this.contextAssembly.injectSystemMessage(generateTruncationWarning());
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
            effortLevel: this.ctx.turn.effortLevel,
            inputTokens: response.usage?.inputTokens,
            outputTokens: response.usage?.outputTokens,
            metadata: attachTurnQualityMetadata(this.ctx, undefined, response),
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
      effortLevel: this.ctx.turn.effortLevel,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      modelDecision: response.runtimeDiagnostics?.modelDecision,
      metadata: attachTurnQualityMetadata(this.ctx, undefined, response),
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

    if (this.ctx.control.isCancelled || this.ctx.control.isInterrupted || this.ctx.control.runAbortController?.signal.aborted) {
      logger.info('[AgentLoop] Run stop detected after tool execution; suppressing tool results');
      return 'break';
    }

    // h2A 实时转向
    if (this.ctx.turn.needsReinference) {
      this.ctx.turn.clearReinference();
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

    // 工具结果原样落库：新鲜 observation 是模型下一轮推理的直接依据，
    // 不得在零上下文压力时预先截断（此前 compressToolResult 300→200 token 的
    // eager 压缩会把 image_analyze 等大结果砍成 "[truncated]" 存根且无落盘引用，
    // 模型看不到完整结果 → 重复调用 + 自述"被截断"）。
    // 超大文本结果统一由管线 L1 toolResultBudget（2000 token + GAP-009 落盘提示）
    // 在 API view 投影时处理；bash/MCP 在工具层已有 30K/50K 字符上限。
    const toolMessage: Message = {
      id: this.contextAssembly.generateId(),
      role: 'tool',
      content: JSON.stringify(artifactRepairResults),
      timestamp: Date.now(),
      toolResults: artifactRepairResults,
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

    if (this.ctx.control.forceFinalResponseReason) {
      if (shouldDeferForcedFinalToInference(this.ctx)) {
        logger.warn('[AgentLoop] Read-loop hard limit reached; deferring final answer to no-tool inference', {
          reason: this.ctx.control.forceFinalResponseReason,
        });
        this.contextAssembly.flushHookMessageBuffer();
        langfuse.endSpan(this.ctx.turn.currentIterationSpanId, {
          type: 'tool_calls',
          toolCount: toolCalls.length,
          successCount: toolResults.filter((r: ToolResult) => r.success).length,
          forcedFinalResponseDeferred: true,
        });
        // Close this tool turn before the deferred no-tool inference starts a fresh turn.
        this.ctx.telemetryAdapter?.onTurnEnd(this.ctx.turn.currentTurnId, '', response.thinking, this.ctx.contextHealth.currentSystemPromptHash);
        this.ctx.onEvent({
          type: 'turn_end',
          data: { turnId: this.ctx.turn.currentTurnId },
        });
        return 'continue';
      }

      const finalMessage: Message = {
        id: this.contextAssembly.generateId(),
        role: 'assistant',
        content: buildForcedFinalAssistantContent(this.ctx.control.forceFinalResponseReason),
        timestamp: Date.now(),
        effortLevel: this.ctx.turn.effortLevel,
        metadata: attachTurnQualityMetadata(this.ctx, undefined, response),
      };
      await this.contextAssembly.addAndPersistMessage(finalMessage);
      this.ctx.onEvent({ type: 'message', data: finalMessage });

      // admission_stop:在 final assistant message push 后 emit error,
      // useSessionLifecycleEffects 会把 errorContent 合并到 lastMessage(此时 = finalMessage assistant)上显示。
      this.maybeEmitArtifactRepairStopError(this.ctx.control.forceFinalResponseReason);

      this.ctx.control.clearForceFinalResponse();
      this.contextAssembly.flushHookMessageBuffer();
      langfuse.endSpan(this.ctx.turn.currentIterationSpanId, {
        type: 'tool_calls',
        toolCount: toolCalls.length,
        successCount: toolResults.filter((r: ToolResult) => r.success).length,
        forcedFinalResponse: true,
      });
      this.ctx.telemetryAdapter?.onTurnEnd(this.ctx.turn.currentTurnId, '', response.thinking, this.ctx.contextHealth.currentSystemPromptHash);
      this.ctx.onEvent({
        type: 'turn_end',
        data: { turnId: this.ctx.turn.currentTurnId },
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
      const detection = pushAndDetectStagnation(this.guardState.recentToolFingerprints, fingerprints);
      if (detection.detected && !this.guardState.stagnationWarningEmitted) {
        logger.warn(
          `[Stagnation] detected ${detection.matchCount}× repeat of fingerprint ${detection.sameFingerprint} — injecting hint to model`,
        );
        logCollector.agent('WARN', `Stagnation detected: ${detection.matchCount}× same tool+args+result`, {
          fingerprint: detection.sameFingerprint,
          matchCount: detection.matchCount,
        });
        this.contextAssembly.injectSystemMessage(buildStagnationHint(detection.matchCount));
        this.guardState.stagnationWarningEmitted = true;
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

    // === Search spam detection（语义重复搜索软提示）===
    // fingerprint stagnation 抓不到"换词重搜同一意图"（args 变 → fingerprint 变）。
    // 这里按"同一检索类工具在窗口内高频出现"检测，命中只软提示一次（不 break），
    // 引导模型用现有结果作答或如实说明限制，避免弱模型反复重搜转圈。
    if (toolCalls.length > 0) {
      const toolNames = toolCalls.map((tc: ToolCall) => tc.name);
      const spam = pushAndDetectToolSpam(this.guardState.recentToolNames, toolNames);
      if (spam.detected && !this.guardState.searchSpamWarningEmitted) {
        logger.warn(
          `[ToolSpam] ${spam.toolName} called ${spam.count}× within last ${TOOL_SPAM_WINDOW} tool calls — injecting hint to model`,
        );
        logCollector.agent('WARN', `Search spam: ${spam.toolName} ${spam.count}× in window`, {
          toolName: spam.toolName,
          count: spam.count,
        });
        this.contextAssembly.injectSystemMessage(buildToolSpamHint(spam.toolName!, spam.count));
        this.guardState.searchSpamWarningEmitted = true;
      }
    }

    // === Ground-truth gate (counter increment) ===
    // 扫描 toolResults，命中反爬 marker 就累加计数。最终 assistant message 落地前
    // 用此计数判断是否要加 disclaimer（在 handleTextResponse 里调用 applyGroundTruthGate）
    for (const r of toolResults) {
      const text = typeof r.output === 'string' ? r.output : (typeof r.error === 'string' ? r.error : '');
      if (text.includes(ANTI_SCRAPING_HINT_MARKER)) {
        this.guardState.antiScrapingHitsInRun++;
      }
    }

    // === 先解析模型输出的任务列表（模型显式标记优先） ===
    this.runFinalizer.tryParseTodosFromResponse(response);

    // === 再根据工具执行情况自动推进（仅对修改类操作生效） ===
    this.runFinalizer.autoAdvanceTodos(toolCalls, toolResults);

    // Flush hook message buffer at end of iteration
    this.contextAssembly.flushHookMessageBuffer();

    langfuse.endSpan(this.ctx.turn.currentIterationSpanId, {
      type: 'tool_calls',
      toolCount: toolCalls.length,
      successCount: toolResults.filter((r: ToolResult) => r.success).length,
    });

    // Telemetry: record turn end (tool execution)
    this.ctx.telemetryAdapter?.onTurnEnd(this.ctx.turn.currentTurnId, '', response.thinking, this.ctx.contextHealth.currentSystemPromptHash);

    this.ctx.onEvent({
      type: 'turn_end',
      data: { turnId: this.ctx.turn.currentTurnId },
    });

    this.contextAssembly.updateContextHealth();

    // 检查并执行自动压缩（在每轮工具调用后）
    await this.contextAssembly.checkAndAutoCompress();

    // Adaptive Thinking
    await this.contextAssembly.maybeInjectThinking(toolCalls, toolResults);

    // P2 Checkpoint
    const artifactRepairPolicy = getArtifactRepairToolPolicy(this.ctx.artifactRepairGuard);
    this.ctx.nudgeManager.checkProgressState(
      this.ctx.turn.toolsUsedInTurn,
      (msg: string) => this.contextAssembly.injectSystemMessage(msg),
      { mutationToolPrompt: artifactRepairPolicy?.mutationToolPromptZh },
    );

    // P5 after force-execute
    if (wasForceExecuted) {
      this.ctx.nudgeManager.checkPostForceExecute(
        this.ctx.workingDirectory,
        (msg: string) => this.contextAssembly.injectSystemMessage(msg),
      );
    }

    if (this.ctx.goalMode?.getStatus() === 'met') {
      logger.debug('[AgentLoop] Goal mode met during tool processing; ending iteration');
      return 'break';
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
    recordMessageProcessorModelCallTelemetry(this.ctx, response, iterations, inferenceDuration);
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
