// ============================================================================
// Telemetry Collector - 事件采集 + 缓冲 + TelemetryAdapter
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { generateMessageId } from '../../shared/utils/id';
import { getTelemetryStorage } from './telemetryStorage';
import { getSystemPromptCache } from './systemPromptCache';
import { classifyIntent, evaluateOutcome } from './intentClassifier';
import type {
  TelemetrySession,
  TelemetryTurn,
  TelemetryModelCall,
  TelemetryToolCall,
  TelemetryTimelineEvent,
  TelemetryAdapter,
  QualitySignals,
  TelemetryPushEvent,
} from '../../shared/types/telemetry';
import type { AgentEvent } from '../../shared/types';

const logger = createLogger('TelemetryCollector');

interface SessionConfig {
  title: string;
  generationId: string;
  modelProvider: string;
  modelName: string;
  workingDirectory: string;
}

interface PendingToolCall {
  id: string;
  toolCallId: string;
  name: string;
  arguments: string;
  timestamp: number;
  index: number;
  parallel: boolean;
}

export class TelemetryCollector {
  private static instance: TelemetryCollector | null = null;

  private activeSession: TelemetrySession | null = null;
  private activeTurn: Partial<TelemetryTurn> | null = null;
  private turnModelCalls: Array<TelemetryModelCall & { turnId: string; sessionId: string }> = [];
  private turnToolCalls: Array<TelemetryToolCall & { turnId: string; sessionId: string }> = [];
  private turnEvents: Array<TelemetryTimelineEvent & { turnId: string; sessionId: string }> = [];
  private pendingToolCalls = new Map<string, PendingToolCall>();

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
    }
    return this.instance;
  }

  // --------------------------------------------------------------------------
  // Event Subscription (for IPC push)
  // --------------------------------------------------------------------------

  addEventListener(listener: (event: TelemetryPushEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter(l => l !== listener);
    };
  }

  private pushEvent(event: TelemetryPushEvent): void {
    for (const listener of this.eventListeners) {
      try { listener(event); } catch { /* ignore */ }
    }
  }

  // --------------------------------------------------------------------------
  // Session Lifecycle
  // --------------------------------------------------------------------------

  startSession(sessionId: string, config: SessionConfig): void {
    if (this.activeSession?.id === sessionId) return; // already tracking

    const session: TelemetrySession = {
      id: sessionId,
      title: config.title || 'Untitled',
      generationId: config.generationId,
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
    };

    this.activeSession = session;
    getTelemetryStorage().insertSession(session);

    // Ensure system prompt cache table exists
    try { getSystemPromptCache().ensureTable(); } catch { /* non-critical */ }

    this.pushEvent({ type: 'session_start', sessionId, data: session });
    logger.info(`Telemetry session started: ${sessionId}`);
  }

  endSession(sessionId: string): void {
    if (this.activeSession?.id !== sessionId) return;

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
      totalErrors: this.activeSession.totalErrors,
    });

    this.pushEvent({ type: 'session_end', sessionId, data: this.activeSession });
    logger.info(`Telemetry session ended: ${sessionId}`);
    this.activeSession = null;
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

  startTurn(sessionId: string, turnId: string, turnNumber: number, userPrompt: string, agentId?: string): void {
    if (this.activeSession?.id !== sessionId) return;

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
      iterationCount: turnNumber,
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

    this.pushEvent({ type: 'turn_start', sessionId, data: { turnId, turnNumber } });
  }

  endTurn(sessionId: string, turnId: string, assistantResponse: string, thinking?: string, systemPromptHash?: string): void {
    if (!this.activeTurn || this.activeTurn.id !== turnId) {
      logger.warn('[TelemetryCollector] endTurn: turnId mismatch', {
        expected: this.activeTurn?.id,
        received: turnId,
      });
      return;
    }

    const now = Date.now();
    const startTime = this.activeTurn.startTime!;

    // Classify intent
    const toolNames = this.turnToolCalls.map(tc => tc.name);
    const intent = classifyIntent(this.activeTurn.userPrompt!, toolNames);

    // Build quality signals
    const successCount = this.turnToolCalls.filter(tc => tc.success).length;
    const totalToolCalls = this.turnToolCalls.length;
    const signals: QualitySignals = {
      toolSuccessRate: totalToolCalls > 0 ? successCount / totalToolCalls : 0,
      toolCallCount: totalToolCalls,
      retryCount: this.turnRetryCount,
      errorCount: this.turnErrorCount,
      errorRecovered: this.turnErrorRecovered,
      compactionTriggered: this.compactionOccurred,
      circuitBreakerTripped: this.circuitBreakerTripped,
      nudgesInjected: this.turnNudgesInjected,
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
      assistantResponse: assistantResponse.substring(0, 10000),
      assistantResponseTokens: Math.ceil(assistantResponse.length / 3.5),
      thinkingContent: thinking?.substring(0, 5000),
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      modelCalls: [],
      toolCalls: [],
      events: [],
      intent,
      outcome,
      compactionOccurred: this.compactionOccurred,
      iterationCount: this.activeTurn.iterationCount ?? 1,
    };

    // Persist turn
    getTelemetryStorage().insertTurn(turn);

    // Batch insert sub-records
    getTelemetryStorage().batchInsert({
      modelCalls: this.turnModelCalls,
      toolCalls: this.turnToolCalls,
      events: this.turnEvents,
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
      this.activeSession.toolSuccessRate = allToolCalls > 0
        ? (prevSuccessful + successCount) / allToolCalls
        : 0;

      // Update session in DB periodically
      getTelemetryStorage().updateSession(this.activeSession.id, {
        turnCount: this.activeSession.turnCount,
        totalInputTokens: this.activeSession.totalInputTokens,
        totalOutputTokens: this.activeSession.totalOutputTokens,
        totalTokens: this.activeSession.totalTokens,
        totalToolCalls: this.activeSession.totalToolCalls,
        toolSuccessRate: this.activeSession.toolSuccessRate,
        totalErrors: this.activeSession.totalErrors,
      });
    }

    this.pushEvent({ type: 'turn_end', sessionId, data: { turnId, intent, outcome } });

    this.activeTurn = null;
  }

  // --------------------------------------------------------------------------
  // Data Recording
  // --------------------------------------------------------------------------

  recordModelCall(turnId: string, call: TelemetryModelCall): void {
    if (!this.activeTurn || this.activeTurn.id !== turnId) {
      logger.warn('[TelemetryCollector] recordModelCall: turnId mismatch', {
        expected: this.activeTurn?.id,
        received: turnId,
        hasActiveTurn: !!this.activeTurn,
      });
      return;
    }

    const record = {
      ...call,
      turnId,
      sessionId: this.activeTurn.sessionId!,
    };
    this.turnModelCalls.push(record);
    this.pushEvent({ type: 'model_call', sessionId: this.activeTurn.sessionId!, data: call });
  }

  recordToolCallStart(
    turnId: string,
    toolCallId: string,
    name: string,
    args: unknown,
    index: number,
    parallel: boolean
  ): void {
    if (!this.activeTurn || this.activeTurn.id !== turnId) return;

    const pending: PendingToolCall = {
      id: generateMessageId(),
      toolCallId,
      name,
      arguments: JSON.stringify(args ?? {}).substring(0, 2048),
      timestamp: Date.now(),
      index,
      parallel,
    };
    this.pendingToolCalls.set(toolCallId, pending);
  }

  recordToolCallEnd(
    turnId: string,
    toolCallId: string,
    success: boolean,
    error: string | undefined,
    durationMs: number,
    output: string | undefined,
  ): void {
    if (!this.activeTurn || this.activeTurn.id !== turnId) return;

    const pending = this.pendingToolCalls.get(toolCallId);
    if (!pending) return;
    this.pendingToolCalls.delete(toolCallId);

    const record: TelemetryToolCall & { turnId: string; sessionId: string } = {
      id: pending.id,
      turnId,
      sessionId: this.activeTurn.sessionId!,
      toolCallId,
      name: pending.name,
      arguments: pending.arguments,
      resultSummary: (output ?? error ?? '').substring(0, 500),
      success,
      error,
      durationMs,
      timestamp: pending.timestamp,
      index: pending.index,
      parallel: pending.parallel,
    };
    this.turnToolCalls.push(record);

    if (!success) {
      this.turnErrorCount++;
    }

    this.pushEvent({ type: 'tool_call', sessionId: this.activeTurn.sessionId!, data: record });
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
        if ((event.data as { message?: string })?.message?.includes('nudge') ||
            (event.data as { message?: string })?.message?.includes('提示')) {
          this.turnNudgesInjected++;
        }
        break;
    }

    // Record as timeline event
    const timelineEvent: TelemetryTimelineEvent & { turnId: string; sessionId: string } = {
      id: generateMessageId(),
      turnId,
      sessionId,
      timestamp: Date.now(),
      eventType: event.type,
      summary: this.summarizeEvent(event),
      data: this.extractEventData(event),
    };
    this.turnEvents.push(timelineEvent);
  }

  // --------------------------------------------------------------------------
  // Adapter Factory
  // --------------------------------------------------------------------------

  createAdapter(sessionId: string, agentId?: string): TelemetryAdapter {
    const collector = this;
    return {
      onTurnStart(turnId: string, turnNumber: number, userPrompt: string) {
        collector.startTurn(sessionId, turnId, turnNumber, userPrompt, agentId);
      },
      onModelCall(turnId: string, call: TelemetryModelCall) {
        collector.recordModelCall(turnId, call);
      },
      onToolCallStart(turnId: string, toolCallId: string, name: string, args: unknown, index: number, parallel: boolean) {
        collector.recordToolCallStart(turnId, toolCallId, name, args, index, parallel);
      },
      onToolCallEnd(turnId: string, toolCallId: string, success: boolean, error: string | undefined, durationMs: number, output: string | undefined) {
        collector.recordToolCallEnd(turnId, toolCallId, success, error, durationMs, output);
      },
      onTurnEnd(turnId: string, assistantResponse: string, thinking?: string, systemPromptHash?: string) {
        collector.endTurn(sessionId, turnId, assistantResponse, thinking, systemPromptHash);
      },
    };
  }

  // --------------------------------------------------------------------------
  // Buffer Flush
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private summarizeEvent(event: AgentEvent): string {
    const data = event.data as Record<string, unknown> | undefined;
    switch (event.type) {
      case 'turn_start':
        return `Turn ${data?.iteration ?? '?'} started`;
      case 'turn_end':
        return `Turn ended`;
      case 'tool_call_start':
        return `Tool: ${data?.name ?? 'unknown'} started`;
      case 'tool_call_end':
        return `Tool completed: ${(data as { success?: boolean })?.success ? 'success' : 'failed'}`;
      case 'message':
        return `Message: ${((data as { content?: string })?.content ?? '').substring(0, 80)}`;
      case 'error':
        return `Error: ${(data as { message?: string })?.message?.substring(0, 100) ?? 'unknown'}`;
      case 'notification':
        return `Notification: ${(data as { message?: string })?.message?.substring(0, 100) ?? ''}`;
      case 'context_compressed':
        return `Context compaction triggered`;
      case 'stream_reasoning':
        return `Thinking...`;
      default:
        return `Event: ${event.type}`;
    }
  }

  private extractEventData(event: AgentEvent): string | undefined {
    const data = event.data as Record<string, unknown> | undefined;
    if (!data) return undefined;

    // Extract only key fields, exclude large content
    const extracted: Record<string, unknown> = {};
    const allowedKeys = ['turnId', 'iteration', 'name', 'success', 'error', 'code', 'message', 'duration'];
    for (const key of allowedKeys) {
      if (key in data) {
        const val = data[key];
        if (typeof val === 'string') {
          extracted[key] = val.substring(0, 200);
        } else {
          extracted[key] = val;
        }
      }
    }

    if (Object.keys(extracted).length === 0) return undefined;
    return JSON.stringify(extracted);
  }
}

// Singleton accessor
export function getTelemetryCollector(): TelemetryCollector {
  return TelemetryCollector.getInstance();
}
