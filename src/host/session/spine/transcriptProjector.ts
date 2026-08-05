import type BetterSqlite3 from 'better-sqlite3';
import type { Message, MessageMetadata } from '../../../shared/contract/message';
import type { ToolCall, ToolResult } from '../../../shared/contract/tool';
import { SessionRepository } from '../../services/core/repositories/SessionRepository';
import { sanitizePackageValue, type SessionPackagePrivacyLevel } from './packageSanitizer';

export type TranscriptLine =
  | { v: 1; type: 'session_meta'; ts: number; sessionId: string; title?: string; model?: string; appVersion?: string }
  | { v: 1; type: 'message'; ts: number; sessionId: string; messageId: string; role: string; turnId?: string; traceId?: string; visibility?: string; content: string }
  | { v: 1; type: 'tool_call'; ts: number; sessionId: string; turnId?: string; toolCallId: string; name: string; status: string; durationMs?: number; resultSummary?: string; error?: string }
  | { v: 1; type: 'permission'; ts: number; sessionId: string; toolCallId?: string; outcome: string; reason: string; decisionId?: string };

export interface TranscriptProjectionResult {
  lines: TranscriptLine[];
  messages: Message[];
  session: {
    id: string;
    title: string;
    model: string;
    workingDirectory?: string;
    createdAt: number;
    updatedAt: number;
  };
  messageCount: number;
  toolCallCount: number;
  errorCount: number;
}

function correlation(metadata?: MessageMetadata): { turnId?: string; traceId?: string } {
  const value = metadata?.correlation;
  return value ? { turnId: value.turnId, traceId: value.traceId } : {};
}

export function projectSessionTranscript(
  db: BetterSqlite3.Database,
  sessionId: string,
  options: { privacyLevel: SessionPackagePrivacyLevel; homeDir?: string; appVersion?: string },
): TranscriptProjectionResult {
  const repository = new SessionRepository(db);
  const session = repository.getSession(sessionId, { includeDeleted: true });
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const messages = repository.getMessages(sessionId, undefined, undefined, { includeRewound: true });
  const lines: TranscriptLine[] = [{
    v: 1,
    type: 'session_meta',
    ts: session.createdAt,
    sessionId,
    title: session.title || undefined,
    model: session.modelConfig.model,
    appVersion: options.appVersion,
  }];
  let toolCallCount = 0;
  let errorCount = 0;
  const resultsByCallId = new Map<string, ToolResult>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) resultsByCallId.set(result.toolCallId, result);
    for (const call of message.toolCalls ?? []) {
      if (call.result) resultsByCallId.set(call.id, call.result);
    }
  }

  for (const message of messages) {
    const ids = correlation(message.metadata);
    lines.push({
      v: 1,
      type: 'message',
      ts: message.timestamp,
      sessionId,
      messageId: message.id,
      role: message.role,
      ...ids,
      visibility: message.visibility,
      content: message.content,
    });
    for (const call of message.toolCalls ?? []) {
      const result = resultsByCallId.get(call.id);
      const error = result && !result.success ? String(result.error || result.output || 'Tool failed') : undefined;
      if (error) errorCount += 1;
      toolCallCount += 1;
      lines.push({
        v: 1,
        type: 'tool_call',
        ts: message.timestamp,
        sessionId,
        turnId: ids.turnId,
        toolCallId: call.id,
        name: call.name,
        status: result ? (result.success ? 'success' : 'error') : 'requested',
        durationMs: result?.duration,
        resultSummary: result?.output,
        error,
      });
    }
  }

  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='permission_decisions'").get()) {
    const decisions = db.prepare(`
      SELECT id, final_outcome, reason, recorded_at, trace_json
      FROM permission_decisions WHERE session_id = ? ORDER BY recorded_at ASC, id ASC
    `).all(sessionId) as Array<Record<string, unknown>>;
    for (const decision of decisions) {
      let toolCallId: string | undefined;
      try {
        const trace = JSON.parse(String(decision.trace_json || '{}')) as Record<string, unknown>;
        if (typeof trace.toolCallId === 'string') toolCallId = trace.toolCallId;
      } catch { /* malformed trace remains uncorrelated */ }
      lines.push({
        v: 1,
        type: 'permission',
        ts: Number(decision.recorded_at),
        sessionId,
        toolCallId,
        outcome: String(decision.final_outcome),
        reason: String(decision.reason),
        decisionId: String(decision.id),
      });
    }
  }

  const safeLines = sanitizePackageValue(lines, options.privacyLevel, options.homeDir);
  return {
    lines: safeLines,
    messages,
    session: {
      id: session.id,
      title: session.title,
      model: session.modelConfig.model,
      workingDirectory: session.workingDirectory,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
    messageCount: messages.length,
    toolCallCount,
    errorCount,
  };
}

export function transcriptToJsonl(lines: TranscriptLine[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}
