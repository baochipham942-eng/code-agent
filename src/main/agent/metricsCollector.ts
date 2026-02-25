// ============================================================================
// Metrics Collector - 会话级指标采集器
//
// 轻量 TelemetryAdapter 实现，用于 eval/CLI 场景：
// - 采集 token 用量、工具调用、截断/压缩、耗时等指标
// - 会话结束后 finalize() 返回结构化 JSON
// - 可独立使用，也可与 TelemetryCollector 组合（compose）
// ============================================================================

import type { TelemetryAdapter, TelemetryModelCall } from '../../shared/types/telemetry';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface SessionMetrics {
  sessionId: string;
  startTime: number;
  endTime: number;
  elapsedMs: number;
  // Token usage
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  // Tool calls
  toolCallCount: number;
  toolCallsByName: Record<string, number>;
  toolSuccessCount: number;
  toolFailureCount: number;
  // Model calls
  modelCallCount: number;
  totalModelLatencyMs: number;
  // Context events
  truncationCount: number;
  compactionCount: number;
  // Turn tracking
  turnCount: number;
  // Errors
  errorCount: number;
  errors: Array<{ type: string; message: string; timestamp: number }>;
}

// ----------------------------------------------------------------------------
// MetricsCollector
// ----------------------------------------------------------------------------

export class MetricsCollector implements TelemetryAdapter {
  private metrics: SessionMetrics;
  private pendingToolCalls = new Map<string, { name: string; startTime: number }>();

  constructor(sessionId: string) {
    this.metrics = {
      sessionId,
      startTime: Date.now(),
      endTime: 0,
      elapsedMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCallCount: 0,
      toolCallsByName: {},
      toolSuccessCount: 0,
      toolFailureCount: 0,
      modelCallCount: 0,
      totalModelLatencyMs: 0,
      truncationCount: 0,
      compactionCount: 0,
      turnCount: 0,
      errorCount: 0,
      errors: [],
    };
  }

  // --------------------------------------------------------------------------
  // TelemetryAdapter interface
  // --------------------------------------------------------------------------

  onTurnStart(_turnId: string, _turnNumber: number, _userPrompt: string): void {
    this.metrics.turnCount++;
  }

  onModelCall(_turnId: string, call: TelemetryModelCall): void {
    this.metrics.modelCallCount++;
    this.metrics.inputTokens += call.inputTokens;
    this.metrics.outputTokens += call.outputTokens;
    this.metrics.totalTokens += call.inputTokens + call.outputTokens;
    this.metrics.totalModelLatencyMs += call.latencyMs;
    if (call.truncated) {
      this.metrics.truncationCount++;
    }
  }

  onToolCallStart(_turnId: string, toolCallId: string, name: string, _args: unknown, _index: number, _parallel: boolean): void {
    this.pendingToolCalls.set(toolCallId, { name, startTime: Date.now() });
    this.metrics.toolCallCount++;
    this.metrics.toolCallsByName[name] = (this.metrics.toolCallsByName[name] || 0) + 1;
  }

  onToolCallEnd(_turnId: string, toolCallId: string, success: boolean, error: string | undefined, _durationMs: number, _output: string | undefined): void {
    this.pendingToolCalls.delete(toolCallId);
    if (success) {
      this.metrics.toolSuccessCount++;
    } else {
      this.metrics.toolFailureCount++;
      if (error) {
        this.metrics.errorCount++;
        this.metrics.errors.push({
          type: 'tool_error',
          message: error.substring(0, 200),
          timestamp: Date.now(),
        });
      }
    }
  }

  onTurnEnd(_turnId: string, _assistantResponse: string, _thinking?: string, _systemPromptHash?: string): void {
    // Turn end is tracked via turnCount increment in onTurnStart
  }

  // --------------------------------------------------------------------------
  // Additional recording methods (called from event handler)
  // --------------------------------------------------------------------------

  recordCompaction(): void {
    this.metrics.compactionCount++;
  }

  recordError(type: string, message: string): void {
    this.metrics.errorCount++;
    this.metrics.errors.push({
      type,
      message: message.substring(0, 200),
      timestamp: Date.now(),
    });
  }

  // --------------------------------------------------------------------------
  // Finalize & Export
  // --------------------------------------------------------------------------

  finalize(): SessionMetrics {
    this.metrics.endTime = Date.now();
    this.metrics.elapsedMs = this.metrics.endTime - this.metrics.startTime;
    return { ...this.metrics };
  }

  getMetrics(): SessionMetrics {
    return { ...this.metrics };
  }

  toJSON(): string {
    return JSON.stringify(this.finalize(), null, 2);
  }
}

// ----------------------------------------------------------------------------
// Compose helper: wrap an existing TelemetryAdapter with MetricsCollector
// ----------------------------------------------------------------------------

/**
 * 组合两个 TelemetryAdapter，事件同时分发给两者。
 * 用于同时启用 TelemetryCollector（持久化）和 MetricsCollector（轻量 eval 指标）。
 */
export function composeTelemetryAdapters(
  primary: TelemetryAdapter,
  secondary: TelemetryAdapter
): TelemetryAdapter {
  return {
    onTurnStart(turnId, turnNumber, userPrompt) {
      primary.onTurnStart(turnId, turnNumber, userPrompt);
      secondary.onTurnStart(turnId, turnNumber, userPrompt);
    },
    onModelCall(turnId, call) {
      primary.onModelCall(turnId, call);
      secondary.onModelCall(turnId, call);
    },
    onToolCallStart(turnId, toolCallId, name, args, index, parallel) {
      primary.onToolCallStart(turnId, toolCallId, name, args, index, parallel);
      secondary.onToolCallStart(turnId, toolCallId, name, args, index, parallel);
    },
    onToolCallEnd(turnId, toolCallId, success, error, durationMs, output) {
      primary.onToolCallEnd(turnId, toolCallId, success, error, durationMs, output);
      secondary.onToolCallEnd(turnId, toolCallId, success, error, durationMs, output);
    },
    onTurnEnd(turnId, assistantResponse, thinking, systemPromptHash) {
      primary.onTurnEnd(turnId, assistantResponse, thinking, systemPromptHash);
      secondary.onTurnEnd(turnId, assistantResponse, thinking, systemPromptHash);
    },
  };
}
