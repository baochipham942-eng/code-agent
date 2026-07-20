// ============================================================================
// Telemetry Collector - 事件采集 + 缓冲 + TelemetryAdapter
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { getServiceRegistry } from '../services/serviceRegistry';
import { generateMessageId } from '../../shared/utils/id';
import { getTelemetryStorage } from './telemetryStorage';
import { getAuthService } from '../services/auth/authService';
import { trackNode } from '../observability/posthogNode';
import { POSTHOG_EVENTS } from '../../shared/observability/posthog-events';
import { getSystemPromptCache } from './systemPromptCache';
import { getDiagnosticVersions } from './diagnosticVersions';
import { buildDiagnosticBundle, sanitizeDiagnosticBundle } from './diagnosticBundleService';
import { classifyIntent, evaluateOutcome } from './intentClassifier';
import type { TelemetrySession, TelemetryTurn, TelemetryModelCall, TelemetryToolCall, TelemetryTimelineEvent, TelemetryAdapter, QualitySignals, TelemetryPushEvent, DiagnosticTriggerReason } from '../../shared/contract/telemetry';
import type { AgentEvent } from '../../shared/contract';
import { INCOMPLETE_TOOL_RESULT_MARKER } from '../../shared/contract/agentTrajectory';
import { redactCredentialText } from '../../shared/security/secretPatterns';
import { sanitizeBrowserComputerToolResult } from '../../shared/utils/browserComputerRedaction';
import {
  classifyError,
  isRecord,
  asString,
  asNumber,
  extractComputerSurfaceFields,
  sanitizeToolArgsForTelemetry,
  parseSerializedArguments,
  summarizeEvent,
  extractEventData,
  type SessionConfig,
  type PendingToolCall,
  type DetachedToolCallInput,
  type DetachedTimelineEventInput,
  type DetachedTurnInput,
  type DetachedTurnBuffer,
} from './telemetryCollectorInternal';

// classifyError 被 telemetryQueryService 等外部模块从本文件导入，保持 re-export。
export { classifyError } from './telemetryCollectorInternal';


const logger = createLogger('TelemetryCollector');

function redactTelemetryString(value: string | undefined): string | undefined {
  return typeof value === 'string' ? redactCredentialText(value) : value;
}

function redactTelemetryModelCall(call: TelemetryModelCall): TelemetryModelCall {
  return {
    ...call,
    prompt: redactTelemetryString(call.prompt),
    completion: redactTelemetryString(call.completion),
    error: redactTelemetryString(call.error),
  };
}

function redactTelemetryToolCall<T extends TelemetryToolCall>(call: T): T {
  return {
    ...call,
    arguments: redactCredentialText(call.arguments),
    actualArguments: redactTelemetryString(call.actualArguments),
    resultSummary: redactCredentialText(call.resultSummary),
    error: redactTelemetryString(call.error),
  };
}


export class TelemetryCollector {
  private static instance: TelemetryCollector | null = null;

  private activeSession: TelemetrySession | null = null;
  private activeTurn: Partial<TelemetryTurn> | null = null;
  private turnModelCalls: Array<TelemetryModelCall & { turnId: string; sessionId: string }> = [];
  private turnToolCalls: Array<TelemetryToolCall & { turnId: string; sessionId: string }> = [];
  private turnEvents: Array<TelemetryTimelineEvent & { turnId: string; sessionId: string }> = [];
  private pendingToolCalls = new Map<string, PendingToolCall>();
  private detachedTurnBuffers = new Map<string, DetachedTurnBuffer>();

  // Counters for signals
  private turnRetryCount = 0;
  private turnErrorCount = 0;
  private turnErrorRecovered = 0;
  private turnNudgesInjected = 0;
  private compactionOccurred = false;
  private circuitBreakerTripped = false;

  // Buffer + flush
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  // Event listener for real-time push
  private eventListeners: Array<(event: TelemetryPushEvent) => void> = [];

  static getInstance(): TelemetryCollector {
    if (!this.instance) {
      this.instance = new TelemetryCollector();
      getServiceRegistry().register('TelemetryCollector', this.instance);
    }
    return this.instance;
  }

  // --------------------------------------------------------------------------
  // Event Subscription (for IPC push)
  // --------------------------------------------------------------------------

  addEventListener(listener: (event: TelemetryPushEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  private pushEvent(event: TelemetryPushEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        /* ignore */
      }
    }
  }

  // --------------------------------------------------------------------------
  // Session Lifecycle
  // --------------------------------------------------------------------------

  startSession(sessionId: string, config: SessionConfig): void {
    if (this.activeSession?.id === sessionId) return; // already tracking

    // 版本指纹：调用方未显式传则用当前运行时版本兜底，保证每条会话都带齐
    const versions = getDiagnosticVersions();

    const session: TelemetrySession = {
      id: sessionId,
      userId: config.userId ?? getAuthService().getCurrentUser()?.id ?? null,
      title: config.title || 'Untitled',
      modelProvider: config.modelProvider,
      modelName: config.modelName,
      workingDirectory: config.workingDirectory,
      startTime: Date.now(),
      turnCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      totalToolCalls: 0,
      toolSuccessRate: 0,
      totalErrors: 0,
      status: 'recording',
      agentVersion: config.agentVersion ?? versions.agentVersion,
      promptVersion: config.promptVersion ?? versions.promptVersion,
      toolSchemaVersion: config.toolSchemaVersion ?? versions.toolSchemaVersion
    };

    this.activeSession = session;
    getTelemetryStorage().insertSession(session);

    // PostHog: session 开始事件（metadata-only，不含 workingDirectory 等可能含 PII 的字段）
    trackNode(POSTHOG_EVENTS.SESSION_STARTED, {
      sessionId,
      provider: config.modelProvider,
      model: config.modelName,
    });

    // Ensure system prompt cache table exists
    try {
      getSystemPromptCache().ensureTable();
    } catch {
      /* non-critical */
    }

    this.pushEvent({ type: 'session_start', sessionId, data: session });
    logger.info(`Telemetry session started: ${sessionId}`);
  }

  endSession(sessionId: string): void {
    if (this.activeSession?.id !== sessionId) return;

    this.finalizeOpenTurnsForSession(sessionId);

    // Flush any pending data
    this.flush();

    const now = Date.now();
    this.activeSession.endTime = now;
    this.activeSession.durationMs = now - this.activeSession.startTime;
    this.activeSession.status = 'completed';

    getTelemetryStorage().updateSession(sessionId, {
      endTime: this.activeSession.endTime,
      durationMs: this.activeSession.durationMs,
      status: 'completed',
      turnCount: this.activeSession.turnCount,
      totalInputTokens: this.activeSession.totalInputTokens,
      totalOutputTokens: this.activeSession.totalOutputTokens,
      totalTokens: this.activeSession.totalTokens,
      totalToolCalls: this.activeSession.totalToolCalls,
      toolSuccessRate: this.activeSession.toolSuccessRate,
      totalErrors: this.activeSession.totalErrors
    });

    const hadErrors = this.activeSession.totalErrors > 0;

    this.pushEvent({
      type: 'session_end',
      sessionId,
      data: this.activeSession
    });

    // 会话结束顺手做一次 raw 旁表滚动淘汰(便宜,每会话一次)
    try {
      getTelemetryStorage().pruneRawPayloads();
    } catch {
      /* non-critical */
    }

    // 失败信号 → 静默构建+脱敏+入队诊断包(dogfood 期自动,不打扰用户;上传由 uploader 走)
    if (hadErrors) {
      void this.captureDiagnosticBundle(sessionId, 'session_error');
    }

    logger.info(`Telemetry session ended: ${sessionId}`);
    this.activeSession = null;
  }

  /**
   * 构建+脱敏+入队一条诊断包(失败 session 触发)。fire-and-forget,失败不影响主流程。
   * 数据此时已 flush 到 storage,buildDiagnosticBundle 从持久层读取。
   */
  private async captureDiagnosticBundle(sessionId: string, reason: DiagnosticTriggerReason): Promise<void> {
    try {
      const bundle = await buildDiagnosticBundle(sessionId);
      if (!bundle) return;
      const sanitized = sanitizeDiagnosticBundle(bundle);
      const now = Date.now();
      getTelemetryStorage().insertDiagnosticBundle({
        id: generateMessageId(),
        sessionId,
        agentVersion: sanitized.versions.agentVersion ?? null,
        promptVersion: sanitized.versions.promptVersion ?? null,
        toolSchemaVersion: sanitized.versions.toolSchemaVersion ?? null,
        triggerReason: reason,
        bundleVersion: sanitized.bundleVersion,
        builtAt: sanitized.builtAt,
        bundle: JSON.stringify(sanitized),
        createdAt: now,
        syncedAt: null,
      });
      logger.info(`Diagnostic bundle queued for ${sessionId} (${reason})`);
    } catch (error) {
      logger.warn('captureDiagnosticBundle failed:', error);
    }
  }

  /**
   * 获取活跃会话的累计数据（用于在 endSession 之前读取 token 统计）
   */
  getSessionData(sessionId: string): TelemetrySession | null {
    if (this.activeSession?.id === sessionId) {
      return { ...this.activeSession };
    }
    return null;
  }

  updateSessionTitle(sessionId: string, title: string): void {
    if (this.activeSession?.id === sessionId) {
      this.activeSession.title = title;
    }
    getTelemetryStorage().updateSession(sessionId, { title });
  }

  // --------------------------------------------------------------------------
  // Turn Lifecycle
  // --------------------------------------------------------------------------

  startTurn(sessionId: string, turnId: string, turnNumber: number, userPrompt: string, agentId?: string, parentTurnId?: string): void {
    if (this.activeSession?.id !== sessionId) return;

    // 如果上一 turn 还没 endTurn 就开了新 turn（messageProcessor 多个 return
    // 'continue' 路径不调 onTurnEnd，原本会让那一 turn 永不落库 → telemetry
    // turn_number 跳号）。这里自动 finalize，避免数据丢失。
    if (this.activeTurn && this.activeTurn.id !== turnId) {
      logger.warn('[TelemetryCollector] startTurn: previous turn not ended, auto-finalizing', {
        previousTurnId: this.activeTurn.id,
        previousTurnNumber: this.activeTurn.turnNumber,
        newTurnNumber: turnNumber
      });
      // 用空 assistantResponse 走正常 endTurn，分类为 unknown outcome（continue 路径
      // 通常没生成最终回复，留 telemetry 痕迹比丢数据好）
      this.endTurn(sessionId, this.activeTurn.id!, '', undefined, undefined);
    }

    this.activeTurn = {
      id: turnId,
      sessionId,
      turnNumber,
      startTime: Date.now(),
      userPrompt,
      agentId: agentId || 'main',
      userPromptTokens: Math.ceil(userPrompt.length / 3.5), // rough estimate
      hasAttachments: false,
      attachmentCount: 0,
      agentMode: 'normal',
      effortLevel: 'high',
      modelCalls: [],
      toolCalls: [],
      events: [],
      assistantResponse: '',
      assistantResponseTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      iterationCount: 1,
      turnType: parentTurnId ? 'iteration' : 'user',
      parentTurnId: parentTurnId ?? undefined
    };

    // Reset per-turn counters
    this.turnModelCalls = [];
    this.turnToolCalls = [];
    this.turnEvents = [];
    this.pendingToolCalls.clear();
    this.turnRetryCount = 0;
    this.turnErrorCount = 0;
    this.turnErrorRecovered = 0;
    this.turnNudgesInjected = 0;
    this.compactionOccurred = false;
    this.circuitBreakerTripped = false;

    this.pushEvent({
      type: 'turn_start',
      sessionId,
      data: { turnId, turnNumber }
    });
  }

  private detachedTurnKey(sessionId: string, turnId: string): string {
    return `${sessionId}:${turnId}`;
  }

  private nextDetachedTurnNumber(sessionId: string): number {
    const activeTurnCount = this.activeSession?.id === sessionId ? this.activeSession.turnCount : 0;
    let pendingForSession = 0;
    for (const buffer of this.detachedTurnBuffers.values()) {
      if (buffer.sessionId === sessionId) pendingForSession++;
    }
    return activeTurnCount + pendingForSession + 1;
  }

  private ensureDetachedTurnBuffer(
    sessionId: string,
    turnId: string,
    options: {
      turnNumber?: number;
      userPrompt?: string;
      agentId?: string;
      parentTurnId?: string;
      startTime?: number;
    } = {}
  ): DetachedTurnBuffer {
    const key = this.detachedTurnKey(sessionId, turnId);
    let buffer = this.detachedTurnBuffers.get(key);
    if (!buffer) {
      buffer = {
        sessionId,
        turnId,
        turnNumber: options.turnNumber ?? this.nextDetachedTurnNumber(sessionId),
        userPrompt: options.userPrompt ?? '',
        agentId: options.agentId,
        parentTurnId: options.parentTurnId,
        startTime: options.startTime ?? Date.now(),
        modelCalls: [],
        toolCalls: [],
        events: [],
        pendingToolCalls: new Map()
      };
      this.detachedTurnBuffers.set(key, buffer);
      return buffer;
    }

    if (options.turnNumber !== undefined) buffer.turnNumber = options.turnNumber;
    if (options.userPrompt !== undefined) buffer.userPrompt = options.userPrompt;
    if (options.agentId !== undefined) buffer.agentId = options.agentId;
    if (options.parentTurnId !== undefined) buffer.parentTurnId = options.parentTurnId;
    if (options.startTime !== undefined) buffer.startTime = Math.min(buffer.startTime, options.startTime);
    return buffer;
  }

  private incompleteToolResultMessage(toolName: string): string {
    return `${INCOMPLETE_TOOL_RESULT_MARKER} Tool call "${toolName}" ended without a matching tool result before turn closeout.`;
  }

  private closePendingToolCallsForActiveTurn(endTime: number): void {
    if (!this.activeTurn?.id || !this.activeTurn.sessionId || this.pendingToolCalls.size === 0) {
      return;
    }

    for (const pending of this.pendingToolCalls.values()) {
      const error = this.incompleteToolResultMessage(pending.name);
      const record: TelemetryToolCall & { turnId: string; sessionId: string } = {
        id: pending.id,
        turnId: this.activeTurn.id,
        sessionId: this.activeTurn.sessionId,
        toolCallId: pending.toolCallId,
        name: pending.name,
        arguments: pending.arguments,
        actualArguments: pending.actualArguments,
        resultSummary: error,
        success: false,
        error,
        errorCategory: 'unknown',
        durationMs: Math.max(0, endTime - pending.timestamp),
        timestamp: pending.timestamp,
        index: pending.index,
        parallel: pending.parallel,
      };
      this.turnToolCalls.push(record);
      this.turnErrorCount++;
      this.pushEvent({
        type: 'tool_call',
        sessionId: this.activeTurn.sessionId,
        data: record,
      });
    }

    this.pendingToolCalls.clear();
  }

  private closePendingDetachedToolCalls(buffer: DetachedTurnBuffer, endTime: number): void {
    if (buffer.pendingToolCalls.size === 0) return;
    for (const pending of buffer.pendingToolCalls.values()) {
      const error = this.incompleteToolResultMessage(pending.name);
      buffer.toolCalls.push({
        toolCallId: pending.toolCallId,
        name: pending.name,
        arguments: pending.rawArguments ?? parseSerializedArguments(pending.arguments),
        resultSummary: error,
        success: false,
        error,
        durationMs: Math.max(0, endTime - pending.timestamp),
        timestamp: pending.timestamp,
        index: pending.index,
        parallel: pending.parallel,
        metadata: {
          closeoutReason: 'pending_tool_result',
        },
      });
    }
    buffer.pendingToolCalls.clear();
  }

  private finalizeOpenTurnsForSession(sessionId: string): void {
    if (this.activeTurn?.sessionId === sessionId && this.activeTurn.id) {
      this.endTurn(
        sessionId,
        this.activeTurn.id,
        this.activeTurn.assistantResponse ?? '',
        this.activeTurn.thinkingContent,
        this.activeTurn.systemPromptHash,
      );
    }

    for (const buffer of [...this.detachedTurnBuffers.values()]) {
      if (buffer.sessionId === sessionId) {
        this.endDetachedTurn(sessionId, buffer.turnId, '', undefined, undefined, buffer.agentId);
      }
    }
  }

  private hasActiveTurn(sessionId: string, turnId: string): boolean {
    return this.activeTurn?.id === turnId && this.activeTurn.sessionId === sessionId;
  }

  private hasDifferentActiveTurnInSession(sessionId: string, turnId: string): boolean {
    return !!this.activeTurn && this.activeTurn.sessionId === sessionId && this.activeTurn.id !== turnId;
  }

  private recordDetachedModelCall(sessionId: string, turnId: string, call: TelemetryModelCall, agentId?: string): void {
    const safeCall = redactTelemetryModelCall(call);
    const buffer = this.ensureDetachedTurnBuffer(sessionId, turnId, { agentId });
    buffer.modelCalls.push(safeCall);
    this.pushEvent({
      type: 'model_call',
      sessionId,
      data: safeCall
    });
  }

  private recordDetachedToolCallStart(
    sessionId: string,
    turnId: string,
    toolCallId: string,
    name: string,
    args: unknown,
    index: number,
    parallel: boolean,
    agentId?: string
  ): void {
    const buffer = this.ensureDetachedTurnBuffer(sessionId, turnId, { agentId });
    const safeArgs = sanitizeToolArgsForTelemetry(name, args);
    buffer.pendingToolCalls.set(toolCallId, {
      id: generateMessageId(),
      toolCallId,
      name,
      arguments: safeArgs.serialized,
      actualArguments: safeArgs.actualArguments,
      rawArguments: safeArgs.rawArguments,
      timestamp: Date.now(),
      index,
      parallel
    });
  }

  private recordDetachedToolCallEnd(
    sessionId: string,
    turnId: string,
    toolCallId: string,
    success: boolean,
    error: string | undefined,
    durationMs: number,
    output: string | undefined,
    metadata?: Record<string, unknown>,
    agentId?: string
  ): void {
    const buffer = this.ensureDetachedTurnBuffer(sessionId, turnId, { agentId });
    const pending = buffer.pendingToolCalls.get(toolCallId);
    if (!pending) return;
    buffer.pendingToolCalls.delete(toolCallId);
    buffer.toolCalls.push({
      toolCallId,
      name: pending.name,
      arguments: pending.rawArguments ?? parseSerializedArguments(pending.arguments),
      resultSummary: output,
      success,
      error,
      durationMs,
      timestamp: pending.timestamp,
      index: pending.index,
      parallel: pending.parallel,
      metadata
    });
  }

  private endDetachedTurn(
    sessionId: string,
    turnId: string,
    assistantResponse: string,
    thinking?: string,
    systemPromptHash?: string,
    agentId?: string
  ): boolean {
    const key = this.detachedTurnKey(sessionId, turnId);
    const buffer = this.ensureDetachedTurnBuffer(sessionId, turnId, { agentId });
    const now = Date.now();
    this.closePendingDetachedToolCalls(buffer, now);
    const recorded = this.recordDetachedTurn({
      sessionId,
      turnId,
      turnNumber: buffer.turnNumber,
      userPrompt: buffer.userPrompt,
      assistantResponse,
      thinking,
      systemPromptHash,
      agentId: buffer.agentId ?? agentId,
      parentTurnId: buffer.parentTurnId,
      startTime: buffer.startTime,
      endTime: now,
      modelCalls: buffer.modelCalls,
      toolCalls: buffer.toolCalls,
      events: buffer.events
    });
    if (recorded) {
      this.detachedTurnBuffers.delete(key);
    }
    return recorded;
  }

  endTurn(sessionId: string, turnId: string, assistantResponse: string, thinking?: string, systemPromptHash?: string): void {
    if (!this.activeTurn) return;
    if (this.activeTurn?.id !== turnId) {
      logger.warn('[TelemetryCollector] endTurn: turnId mismatch', {
        expected: this.activeTurn?.id,
        received: turnId
      });
      return;
    }

    const now = Date.now();
    const startTime = this.activeTurn.startTime!;
    this.closePendingToolCallsForActiveTurn(now);

    // Classify intent
    const toolNames = this.turnToolCalls.map((tc) => tc.name);
    const intent = classifyIntent(this.activeTurn.userPrompt!, toolNames);

    // Build quality signals
    const successCount = this.turnToolCalls.filter((tc) => tc.success).length;
    const totalToolCalls = this.turnToolCalls.length;
    const signals: QualitySignals = {
      toolSuccessRate: totalToolCalls > 0 ? successCount / totalToolCalls : 0,
      toolCallCount: totalToolCalls,
      retryCount: this.turnRetryCount,
      errorCount: this.turnErrorCount,
      errorRecovered: this.turnErrorRecovered,
      compactionTriggered: this.compactionOccurred,
      circuitBreakerTripped: this.circuitBreakerTripped,
      nudgesInjected: this.turnNudgesInjected
    };

    // Evaluate outcome
    const outcome = evaluateOutcome(signals);

    // Total tokens from model calls
    const totalInput = this.turnModelCalls.reduce((s, mc) => s + mc.inputTokens, 0);
    const totalOutput = this.turnModelCalls.reduce((s, mc) => s + mc.outputTokens, 0);

    const turn: TelemetryTurn = {
      ...(this.activeTurn as TelemetryTurn),
      endTime: now,
      durationMs: now - startTime,
      systemPromptHash: systemPromptHash || (this.activeTurn as TelemetryTurn).systemPromptHash,
      assistantResponse,
      assistantResponseTokens: Math.ceil(assistantResponse.length / 3.5),
      thinkingContent: thinking,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      modelCalls: [],
      toolCalls: [],
      events: [],
      intent,
      outcome,
      compactionOccurred: this.compactionOccurred,
      iterationCount: this.activeTurn.iterationCount ?? 1
    };

    // Persist turn
    getTelemetryStorage().insertTurn(turn);

    // Batch insert sub-records
    getTelemetryStorage().batchInsert({
      modelCalls: this.turnModelCalls,
      toolCalls: this.turnToolCalls,
      events: this.turnEvents
    });

    // Update session aggregates
    if (this.activeSession) {
      this.activeSession.turnCount++;
      this.activeSession.totalInputTokens += totalInput;
      this.activeSession.totalOutputTokens += totalOutput;
      this.activeSession.totalTokens += totalInput + totalOutput;
      this.activeSession.totalToolCalls += totalToolCalls;
      this.activeSession.totalErrors += this.turnErrorCount;

      // Recalculate session tool success rate
      const allToolCalls = this.activeSession.totalToolCalls;
      const prevSuccessful = this.activeSession.toolSuccessRate * (allToolCalls - totalToolCalls);
      this.activeSession.toolSuccessRate = allToolCalls > 0 ? (prevSuccessful + successCount) / allToolCalls : 0;

      // Update session in DB periodically
      getTelemetryStorage().updateSession(this.activeSession.id, {
        turnCount: this.activeSession.turnCount,
        totalInputTokens: this.activeSession.totalInputTokens,
        totalOutputTokens: this.activeSession.totalOutputTokens,
        totalTokens: this.activeSession.totalTokens,
        totalToolCalls: this.activeSession.totalToolCalls,
        toolSuccessRate: this.activeSession.toolSuccessRate,
        totalErrors: this.activeSession.totalErrors
      });
    }

    this.pushEvent({
      type: 'turn_end',
      sessionId,
      data: { turnId, intent, outcome }
    });

    this.activeTurn = null;
  }

  /**
   * Persist a complete turn without touching activeTurn state.
   * Used by subagents, which may run concurrently with the main loop and cannot
   * share the collector's single activeTurn buffer.
   */
  recordDetachedTurn(input: DetachedTurnInput): boolean {
    const modelCalls = (input.modelCalls || []).map((call) => ({
      ...call,
      turnId: input.turnId,
      sessionId: input.sessionId
    }));

    const toolCalls = (input.toolCalls || []).map((call) => {
      const safeArgs = sanitizeToolArgsForTelemetry(call.name, call.arguments);
      const safeResult = sanitizeBrowserComputerToolResult(call.name, safeArgs.rawArguments, {
        output: call.resultSummary,
        error: call.error,
        metadata: call.metadata
      });
      const errorCategory = call.error ? classifyError(call.error) : undefined;
      const computerSurfaceFields = extractComputerSurfaceFields(call.name, safeArgs.serialized, call.metadata);
      return {
        id: generateMessageId(),
        turnId: input.turnId,
        sessionId: input.sessionId,
        toolCallId: call.toolCallId,
        name: call.name,
        arguments: safeArgs.serialized,
        actualArguments: safeArgs.actualArguments,
        resultSummary: safeResult.output ?? safeResult.error ?? '',
        success: call.success,
        error: safeResult.error,
        errorCategory,
        durationMs: call.durationMs,
        timestamp: call.timestamp,
        index: call.index,
        parallel: !!call.parallel,
        ...computerSurfaceFields
      } satisfies TelemetryToolCall & { turnId: string; sessionId: string };
    });

    const events = (input.events || []).map(
      (event) =>
        ({
          id: generateMessageId(),
          turnId: input.turnId,
          sessionId: input.sessionId,
          timestamp: event.timestamp ?? Date.now(),
          eventType: event.eventType,
          summary: event.summary,
          data: typeof event.data === 'string' ? event.data : event.data ? JSON.stringify(event.data) : undefined,
          durationMs: event.durationMs
        }) satisfies TelemetryTimelineEvent & {
          turnId: string;
          sessionId: string;
        }
    );

    const successCount = toolCalls.filter((tc) => tc.success).length;
    const totalToolCalls = toolCalls.length;
    const signals: QualitySignals = {
      toolSuccessRate: totalToolCalls > 0 ? successCount / totalToolCalls : 0,
      toolCallCount: totalToolCalls,
      retryCount: 0,
      errorCount: toolCalls.length - successCount,
      errorRecovered: 0,
      compactionTriggered: events.some((event) => event.eventType === 'context_compressed'),
      circuitBreakerTripped: false,
      nudgesInjected: 0
    };
    const totalInput = modelCalls.reduce((sum, call) => sum + call.inputTokens, 0);
    const totalOutput = modelCalls.reduce((sum, call) => sum + call.outputTokens, 0);
    const effectiveAgentId = input.agentId || 'subagent';
    const isMainLoopAgent = effectiveAgentId === 'main' || effectiveAgentId === 'cli';
    const turn: TelemetryTurn = {
      id: input.turnId,
      sessionId: input.sessionId,
      turnNumber: input.turnNumber,
      startTime: input.startTime,
      endTime: input.endTime,
      durationMs: Math.max(0, input.endTime - input.startTime),
      userPrompt: input.userPrompt,
      userPromptTokens: Math.ceil(input.userPrompt.length / 3.5),
      hasAttachments: false,
      attachmentCount: 0,
      agentMode: isMainLoopAgent ? 'normal' : 'subagent',
      effortLevel: 'high',
      modelCalls: [],
      toolCalls: [],
      events: [],
      systemPromptHash: input.systemPromptHash,
      assistantResponse: input.assistantResponse,
      assistantResponseTokens: Math.ceil(input.assistantResponse.length / 3.5),
      thinkingContent: input.thinking,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      intent: classifyIntent(
        input.userPrompt,
        toolCalls.map((tc) => tc.name)
      ),
      outcome: evaluateOutcome(signals),
      compactionOccurred: signals.compactionTriggered,
      iterationCount: input.turnNumber,
      agentId: effectiveAgentId,
      turnType: isMainLoopAgent && !input.parentTurnId ? 'user' : 'iteration',
      parentTurnId: input.parentTurnId
    };

    getTelemetryStorage().insertTurn(turn);
    getTelemetryStorage().batchInsert({ modelCalls, toolCalls, events });

    if (this.activeSession?.id === input.sessionId) {
      this.activeSession.turnCount++;
      this.activeSession.totalInputTokens += totalInput;
      this.activeSession.totalOutputTokens += totalOutput;
      this.activeSession.totalTokens += totalInput + totalOutput;
      this.activeSession.totalToolCalls += totalToolCalls;
      this.activeSession.totalErrors += signals.errorCount;
      const allToolCalls = this.activeSession.totalToolCalls;
      const previousSuccessful = this.activeSession.toolSuccessRate * (allToolCalls - totalToolCalls);
      this.activeSession.toolSuccessRate = allToolCalls > 0 ? (previousSuccessful + successCount) / allToolCalls : 0;
      getTelemetryStorage().updateSession(this.activeSession.id, {
        turnCount: this.activeSession.turnCount,
        totalInputTokens: this.activeSession.totalInputTokens,
        totalOutputTokens: this.activeSession.totalOutputTokens,
        totalTokens: this.activeSession.totalTokens,
        totalToolCalls: this.activeSession.totalToolCalls,
        toolSuccessRate: this.activeSession.toolSuccessRate,
        totalErrors: this.activeSession.totalErrors
      });
    }

    this.pushEvent({
      type: 'turn_end',
      sessionId: input.sessionId,
      data: { turnId: input.turnId, detached: true }
    });
    return true;
  }

  // --------------------------------------------------------------------------
  // Data Recording
  // --------------------------------------------------------------------------

  recordModelCall(turnId: string, call: TelemetryModelCall): void {
    if (!this.activeTurn) return;
    if (this.activeTurn?.id !== turnId) {
      logger.warn('[TelemetryCollector] recordModelCall: turnId mismatch', {
        expected: this.activeTurn?.id,
        received: turnId,
        hasActiveTurn: !!this.activeTurn
      });
      return;
    }

    const record = {
      ...call,
      turnId,
      sessionId: this.activeTurn.sessionId!
    };
    const safeRecord = redactTelemetryModelCall(record);
    this.turnModelCalls.push({
      ...safeRecord,
      turnId,
      sessionId: this.activeTurn.sessionId!
    });
    this.pushEvent({
      type: 'model_call',
      sessionId: record.sessionId,
      data: redactTelemetryModelCall(call)
    });
  }

  recordToolCallStart(turnId: string, toolCallId: string, name: string, args: unknown, index: number, parallel: boolean): void {
    if (this.activeTurn?.id !== turnId) return;

    const safeArgs = sanitizeToolArgsForTelemetry(name, args);
    const pending: PendingToolCall = {
      id: generateMessageId(),
      toolCallId,
      name,
      arguments: safeArgs.serialized,
      actualArguments: safeArgs.actualArguments,
      rawArguments: safeArgs.rawArguments,
      timestamp: Date.now(),
      index,
      parallel
    };
    this.pendingToolCalls.set(toolCallId, pending);
  }

  recordToolCallEnd(turnId: string, toolCallId: string, success: boolean, error: string | undefined, durationMs: number, output: string | undefined, metadata?: Record<string, unknown>): void {
    if (this.activeTurn?.id !== turnId) return;

    const pending = this.pendingToolCalls.get(toolCallId);
    if (!pending) return;
    this.pendingToolCalls.delete(toolCallId);

    const safeResult = sanitizeBrowserComputerToolResult(pending.name, pending.rawArguments, {
      output,
      error,
      metadata
    });
    const safeError = safeResult.error;
    const safeOutput = safeResult.output;
    const errorCategory = error ? classifyError(error) : undefined;
    const computerSurfaceFields = extractComputerSurfaceFields(pending.name, pending.arguments, metadata);
    const record: TelemetryToolCall & { turnId: string; sessionId: string } = {
      id: pending.id,
      turnId,
      sessionId: this.activeTurn.sessionId!,
      toolCallId,
      name: pending.name,
      arguments: pending.arguments,
      actualArguments: pending.actualArguments,
      resultSummary: safeOutput ?? safeError ?? '',
      success,
      error: safeError,
      errorCategory,
      durationMs,
      timestamp: pending.timestamp,
      index: pending.index,
      parallel: pending.parallel,
      ...computerSurfaceFields
    };
    const safeRecord = redactTelemetryToolCall(record);
    this.turnToolCalls.push(safeRecord);

    if (!success) {
      this.turnErrorCount++;
      const validationIssues = Array.isArray(metadata?.validationIssues)
        ? metadata.validationIssues
        : undefined;
      trackNode(POSTHOG_EVENTS.TOOL_CALL_FAILED, {
        sessionId: this.activeTurn.sessionId!,
        tool: pending.name,
        toolCallId,
        errorCategory: errorCategory ?? 'unknown',
        validationFailed: metadata?.validationFailed === true,
        validationIssueCount: validationIssues?.length ?? 0,
      });
    }

    this.pushEvent({
      type: 'tool_call',
      sessionId: this.activeTurn.sessionId!,
      data: safeRecord
    });
  }

  // --------------------------------------------------------------------------
  // AgentEvent Handler
  // --------------------------------------------------------------------------

  handleEvent(sessionId: string, event: AgentEvent): void {
    if (this.activeSession?.id !== sessionId) return;

    const turnId = this.activeTurn?.id;
    if (!turnId) return;

    // Track specific event types
    switch (event.type) {
      case 'context_compressed':
        this.compactionOccurred = true;
        break;
      case 'error':
        if ((event.data as { code?: string })?.code === 'CIRCUIT_BREAKER_TRIPPED') {
          this.circuitBreakerTripped = true;
        }
        break;
      case 'notification':
        if ((event.data as { message?: string })?.message?.includes('nudge') || (event.data as { message?: string })?.message?.includes('提示')) {
          this.turnNudgesInjected++;
        }
        break;
    }

    if (event.type === 'model_decision') {
      const data = event.data as unknown as Record<string, unknown> | undefined;
      trackNode(POSTHOG_EVENTS.MODEL_DECISION, {
        sessionId,
        requestedProvider: data?.requestedProvider,
        requestedModel: data?.requestedModel,
        resolvedProvider: data?.resolvedProvider,
        resolvedModel: data?.resolvedModel,
        reason: data?.reason,
        billingMode: data?.billingMode,
      });
    }

    // Record as timeline event
    const timelineEvent: TelemetryTimelineEvent & {
      turnId: string;
      sessionId: string;
    } = {
      id: generateMessageId(),
      turnId,
      sessionId,
      timestamp: Date.now(),
      eventType: event.type,
      summary: summarizeEvent(event),
      data: extractEventData(event)
    };
    this.turnEvents.push(timelineEvent);
  }

  // --------------------------------------------------------------------------
  // Adapter Factory
  // --------------------------------------------------------------------------

  createAdapter(sessionId: string, agentId?: string): TelemetryAdapter {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const collector = this;
    return {
      onTurnStart(turnId: string, turnNumber: number, userPrompt: string, parentTurnId?: string) {
        collector.startTurn(sessionId, turnId, turnNumber, userPrompt, agentId, parentTurnId);
        if (!collector.hasActiveTurn(sessionId, turnId)) {
          collector.ensureDetachedTurnBuffer(sessionId, turnId, {
            turnNumber,
            userPrompt,
            agentId,
            parentTurnId,
            startTime: Date.now()
          });
        }
      },
      onModelCall(turnId: string, call: TelemetryModelCall) {
        if (collector.hasActiveTurn(sessionId, turnId) || collector.hasDifferentActiveTurnInSession(sessionId, turnId)) {
          collector.recordModelCall(turnId, call);
          return;
        }
        collector.recordDetachedModelCall(sessionId, turnId, call, agentId);
      },
      onToolCallStart(turnId: string, toolCallId: string, name: string, args: unknown, index: number, parallel: boolean) {
        if (collector.hasActiveTurn(sessionId, turnId) || collector.hasDifferentActiveTurnInSession(sessionId, turnId)) {
          collector.recordToolCallStart(turnId, toolCallId, name, args, index, parallel);
        } else {
          collector.recordDetachedToolCallStart(sessionId, turnId, toolCallId, name, args, index, parallel, agentId);
        }
        // PostHog: 工具使用事件（在 start hook 埋点最干净——单点覆盖 6 个 onToolCallEnd 分支）
        trackNode(POSTHOG_EVENTS.TOOL_USED, { tool: name, toolCallId });
      },
      onToolCallEnd(turnId: string, toolCallId: string, success: boolean, error: string | undefined, durationMs: number, output: string | undefined, metadata?: Record<string, unknown>) {
        if (collector.hasActiveTurn(sessionId, turnId) || collector.hasDifferentActiveTurnInSession(sessionId, turnId)) {
          collector.recordToolCallEnd(turnId, toolCallId, success, error, durationMs, output, metadata);
          return;
        }
        collector.recordDetachedToolCallEnd(sessionId, turnId, toolCallId, success, error, durationMs, output, metadata, agentId);
      },
      onTurnEnd(turnId: string, assistantResponse: string, thinking?: string, systemPromptHash?: string) {
        if (collector.hasActiveTurn(sessionId, turnId) || collector.hasDifferentActiveTurnInSession(sessionId, turnId)) {
          collector.endTurn(sessionId, turnId, assistantResponse, thinking, systemPromptHash);
          return;
        }
        collector.endDetachedTurn(sessionId, turnId, assistantResponse, thinking, systemPromptHash, agentId);
      }
    };
  }

  // --------------------------------------------------------------------------
  // Observability Queries (Harness Engineering P2a)
  // --------------------------------------------------------------------------

  /**
   * 获取当前会话的工具性能统计
   */
  getToolPerformance(sessionId: string): Array<{
    name: string;
    total: number;
    success: number;
    avgDurationMs: number;
    successRate: number;
  }> {
    try {
      const storage = getTelemetryStorage();
      const stats = storage.getToolUsageStats(sessionId);
      return stats.map((s: { name: string; callCount: number; successCount: number; avgDurationMs: number; successRate: number }) => ({
        name: s.name,
        total: s.callCount,
        success: s.successCount,
        avgDurationMs: s.avgDurationMs,
        successRate: s.successRate
      }));
    } catch {
      return [];
    }
  }

  /**
   * 获取当前会话的错误摘要
   */
  getErrorSummary(sessionId: string): {
    totalErrors: number;
    errorsByTool: Record<string, number>;
    topErrors: Array<{ error: string; count: number }>;
  } {
    const result = {
      totalErrors: 0,
      errorsByTool: {} as Record<string, number>,
      topErrors: [] as Array<{ error: string; count: number }>
    };

    try {
      const storage = getTelemetryStorage();
      const toolCalls = storage.getToolCallsBySession(sessionId);

      const failedCalls = toolCalls.filter((tc: { success: boolean }) => !tc.success);
      result.totalErrors = failedCalls.length;

      const errorCounts = new Map<string, number>();
      for (const tc of failedCalls) {
        const name = (tc as { name: string }).name;
        result.errorsByTool[name] = (result.errorsByTool[name] || 0) + 1;

        const errorKey = ((tc as { error?: string }).error || 'unknown').substring(0, 100);
        errorCounts.set(errorKey, (errorCounts.get(errorKey) || 0) + 1);
      }

      result.topErrors = [...errorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([error, count]) => ({ error, count }));
    } catch {
      // Storage not available
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // Buffer Flush
  // --------------------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
    this.activeSession = null;
    this.activeTurn = null;
    this.detachedTurnBuffers.clear();
    this.eventListeners = [];
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flush();
      this.flushTimer = null;
    }, 1000);
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // All data is flushed in endTurn, this is a safety net
  }

}

// Singleton accessor
export function getTelemetryCollector(): TelemetryCollector {
  return TelemetryCollector.getInstance();
}
