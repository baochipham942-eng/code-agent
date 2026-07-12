import { randomUUID } from 'node:crypto';
import type { ToolResult } from '../../shared/contract';
import { getDatabase } from '../services/core/databaseService';
import { getAuditLogger } from '../security';
import { sanitizeToolParams, truncateToolOutput } from './toolExecutorHelpers';
import { markToolCacheHit } from './toolExecutionTelemetry';

export function recordCachedToolReplay(input: {
  cached: ToolResult;
  params: Record<string, unknown>;
  toolName: string;
  sessionId?: string;
  toolCallId?: string;
  auditEnabled: boolean;
}): void {
  const executionId = randomUUID();
  const cachedParams = sanitizeToolParams(input.params);
  const summary = String(
    cachedParams.command
    || cachedParams.file_path
    || cachedParams.path
    || cachedParams.pattern
    || input.toolName,
  ).substring(0, 80);
  try {
    const recordedAt = Date.now();
    getDatabase().appendToolExecutionBegin({
      executionId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      summary,
      params: cachedParams,
      recordedAt,
    });
    getDatabase().appendToolExecutionComplete({
      executionId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      status: 'cached',
      recordedAt: Date.now(),
    });
  } catch {
    // Cache replay remains available when the audit DB is unavailable.
  }
  markToolCacheHit(input.toolCallId);
  if (!input.auditEnabled) return;
  try {
    getAuditLogger().logToolUsage({
      sessionId: input.sessionId || 'unknown',
      toolName: input.toolName,
      input: cachedParams,
      output: input.cached.output ? truncateToolOutput(input.cached.output) : undefined,
      duration: 0,
      success: true,
    });
  } catch {
    // Audit backend failure cannot turn a proven replay into execution.
  }
}
