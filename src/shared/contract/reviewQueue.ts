// ============================================================================
// Review Queue Types - 仅保留 trace identity，评测中心 UI 已下线
// ============================================================================

export type UnifiedTraceSource = 'session_replay';

export interface UnifiedTraceIdentity {
  traceId: string;
  traceSource: UnifiedTraceSource;
  /** @deprecated Use traceSource. */
  source: UnifiedTraceSource;
  sessionId: string;
  replayKey: string;
}

export function buildSessionTraceIdentity(sessionId: string): UnifiedTraceIdentity {
  return {
    traceId: `session:${sessionId}`,
    traceSource: 'session_replay',
    source: 'session_replay',
    sessionId,
    replayKey: sessionId
  };
}
