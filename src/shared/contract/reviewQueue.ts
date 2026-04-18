// ============================================================================
// Review Queue Types - Phase 6.1 + 6.2 plus minimal 6.3 failure follow-up sink
// ============================================================================

export type UnifiedTraceSource = 'session_replay';

export interface UnifiedTraceIdentity {
  traceId: string;
  source: UnifiedTraceSource;
  sessionId: string;
  replayKey: string;
}

export type ReviewQueueReason =
  | 'manual_review'
  | 'failure_followup'
  | 'interesting_case'
  | 'regression_candidate';

export type ReviewQueueSource =
  | 'current_session_bar'
  | 'session_list'
  | 'replay_failure';

export interface ReviewQueueItem {
  id: string;
  trace: UnifiedTraceIdentity;
  sessionId: string;
  sessionTitle: string;
  reason: ReviewQueueReason;
  source: ReviewQueueSource;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueReviewItemInput {
  sessionId: string;
  sessionTitle?: string;
  reason?: ReviewQueueReason;
  source?: ReviewQueueSource;
}

export function buildSessionTraceIdentity(sessionId: string): UnifiedTraceIdentity {
  return {
    traceId: `session:${sessionId}`,
    source: 'session_replay',
    sessionId,
    replayKey: sessionId,
  };
}

export function buildReviewQueueItemId(trace: UnifiedTraceIdentity): string {
  return `review:${trace.traceId}`;
}

export function getReviewQueueReasonLabel(reason: ReviewQueueReason): string {
  switch (reason) {
    case 'failure_followup':
      return '失败回看';
    case 'interesting_case':
      return '值得沉淀';
    case 'regression_candidate':
      return '回归候选';
    case 'manual_review':
    default:
      return '手动加入';
  }
}
