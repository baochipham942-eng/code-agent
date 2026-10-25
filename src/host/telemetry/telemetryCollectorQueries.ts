// ============================================================================
// Telemetry Collector 脱敏 helper + 只读查询 —— 从 telemetryCollector.ts 抽出的
// 纯函数（无 `this`），以保持该模块在 eslint max-lines 预算内。行为零变化，仅做
// 机械搬移；class 侧保留同名薄委托，公共 API 不变。不并入
// telemetryCollectorInternal.ts：那处放采集侧纯函数，这里放脱敏 helper 与查询。
// ============================================================================

import type { TelemetryModelCall, TelemetryToolCall } from '../../shared/contract/telemetry';
import { redactCredentialText } from '../../shared/security/secretPatterns';
import type { TelemetryStorage } from './telemetryStorage';

function redactTelemetryString(value: string | undefined): string | undefined {
  return typeof value === 'string' ? redactCredentialText(value) : value;
}

export function redactTelemetryModelCall(call: TelemetryModelCall): TelemetryModelCall {
  return {
    ...call,
    prompt: redactTelemetryString(call.prompt),
    completion: redactTelemetryString(call.completion),
    error: redactTelemetryString(call.error),
  };
}

export function redactTelemetryToolCall<T extends TelemetryToolCall>(call: T): T {
  return {
    ...call,
    arguments: redactCredentialText(call.arguments),
    actualArguments: redactTelemetryString(call.actualArguments),
    resultSummary: redactCredentialText(call.resultSummary),
    error: redactTelemetryString(call.error),
  };
}

// ----------------------------------------------------------------------------
// Observability Queries (Harness Engineering P2a)
// ----------------------------------------------------------------------------

export function getToolPerformance(storage: TelemetryStorage, sessionId: string): Array<{
  name: string;
  total: number;
  success: number;
  avgDurationMs: number;
  successRate: number;
}> {
  try {
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

export function getErrorSummary(storage: TelemetryStorage, sessionId: string): {
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
