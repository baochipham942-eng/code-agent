// ============================================================================
// Decision History - Circular buffer of permission decisions
// ============================================================================

import type { DecisionTrace } from '../../shared/contract/decisionTrace';

/**
 * Outcome of a permission decision
 */
export type DecisionOutcome =
  | 'auto-approve'
  | 'ask-approved'
  | 'ask-denied'
  | 'policy-allow'
  | 'policy-deny'
  | 'classifier-deny'
  | 'hook-blocked'
  | 'monitor-blocked';

/**
 * A single permission decision entry
 */
export interface DecisionHistoryEntry {
  timestamp: number;
  toolName: string;
  /** Command or file path, truncated to 80 chars */
  summary: string;
  outcome: DecisionOutcome;
  reason: string;
  durationMs: number;
  /** Reviewable trace for auto allow/deny/ask decisions. */
  decisionTrace?: DecisionTrace;
  /** 产生这条决策的会话。缺省时不计入任何会话的限流计数。 */
  sessionId?: string;
}

/**
 * 自动拦截。人拒的 ask-denied、放行类（auto-approve / ask-approved / policy-allow）都不在此列：
 * 它们打断「连续」计数，且不计入窗口累计。
 */
const AUTO_DENY_OUTCOMES = new Set<DecisionOutcome>([
  'policy-deny',
  'classifier-deny',
  'hook-blocked',
  'monitor-blocked',
]);

export function isAutoDenyOutcome(outcome: DecisionOutcome): boolean {
  return AUTO_DENY_OUTCOMES.has(outcome);
}

const MAX_HISTORY = 50;

/**
 * In-memory circular buffer of permission decisions.
 * Same pattern as HookManager.triggerHistory.
 */
class DecisionHistory {
  private entries: DecisionHistoryEntry[] = [];

  record(entry: DecisionHistoryEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_HISTORY) {
      this.entries.shift();
    }
  }

  getRecent(count = 10): readonly DecisionHistoryEntry[] {
    return this.entries.slice(-count);
  }

  getAll(): readonly DecisionHistoryEntry[] {
    return this.entries;
  }

  /**
   * 该会话从最近一条往回数，连续自动拦截的次数。
   * 其它会话的记录跳过；本会话任何非自动拦截（ask-denied / auto-approve 等）打断连续。
   */
  countConsecutiveAutoDenies(sessionId: string): number {
    let count = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.sessionId !== sessionId) continue;
      if (!isAutoDenyOutcome(entry.outcome)) break;
      count++;
    }
    return count;
  }

  /**
   * 该会话在 [now - windowMs, now] 内的自动拦截累计次数。
   * 非自动拦截不计入；其它会话不计入。连续与否不影响本计数。
   */
  countWindowAutoDenies(sessionId: string, windowMs: number, now = Date.now()): number {
    const cutoff = now - windowMs;
    let count = 0;
    for (const entry of this.entries) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.timestamp < cutoff) continue;
      if (isAutoDenyOutcome(entry.outcome)) count++;
    }
    return count;
  }

  clear(): void {
    this.entries = [];
  }
}

// Singleton
let instance: DecisionHistory | null = null;

export function getDecisionHistory(): DecisionHistory {
  if (!instance) {
    instance = new DecisionHistory();
  }
  return instance;
}

export function resetDecisionHistory(): void {
  instance = null;
}
