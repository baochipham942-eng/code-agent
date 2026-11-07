// ============================================================================
// Shared Jev browser risk definition (N-JEV-BROWSER-ARMED-REST2-FU1)
// One risky-target predicate for the Jev inner loop and the main-model Browser tool gate,
// plus the in-memory registry of sessions whose Jev run handed back.
// ============================================================================

import { createLogger } from '../../../services/infra/logger';

const logger = createLogger('JevBrowserRisk', { lane: 'browser' });

/** Single definition of "risky browser target" shared by the Jev inner loop and this gate. */
export const BROWSER_RISK_KEYWORD = /pay|payment|checkout|购买|支付|delete|删除|authorize|oauth|授权|grant access|confirm purchase|unsubscribe/i;

const MAX_MARKED_SESSIONS = 256;
const handbackSessions = new Set<string>();

/** Called when a Jev run for this session ended with anything except done_verified. */
export function markBrowserJevHandback(sessionId: string | undefined): void {
  if (!sessionId) {
    logger.warn('jev handback not marked: context has no sessionId, main-model continuation stays ungated');
    return;
  }
  handbackSessions.delete(sessionId);
  handbackSessions.add(sessionId);
  if (handbackSessions.size > MAX_MARKED_SESSIONS) {
    const oldest = handbackSessions.values().next().value;
    if (oldest !== undefined) handbackSessions.delete(oldest);
  }
}

export function isBrowserJevHandbackSession(sessionId: string): boolean {
  return handbackSessions.has(sessionId);
}
