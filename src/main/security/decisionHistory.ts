// ============================================================================
// Decision History - Circular buffer of permission decisions
// ============================================================================

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
