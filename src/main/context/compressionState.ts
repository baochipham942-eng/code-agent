// ============================================================================
// CompressionState — Immutable compression tracking via commit log + snapshot
// ============================================================================
// Design principle: "projection over mutation"
// - Original transcript is NEVER modified
// - CompressionState tracks operations as an append-only commit log
// - Snapshot is derived by replaying commits
// - ProjectionEngine uses the snapshot to generate the API view at query time
// ============================================================================

export interface CompressionCommit {
  layer: 'tool-result-budget' | 'snip' | 'microcompact' | 'contextCollapse' | 'autocompact' | 'overflow-recovery' | 'system';
  operation: 'truncate' | 'snip' | 'compact' | 'collapse' | 'drain' | 'reset';
  targetMessageIds: string[];
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface CollapsedSpan {
  messageIds: string[];
  summary: string;
  originalTokens?: number;
}

export interface CompressionSnapshot {
  snippedIds: Set<string>;
  budgetedResults: Map<string, { originalTokens: number; truncatedTokens: number }>;
  collapsedSpans: CollapsedSpan[];
  microcompactedIds: Set<string>;
}

// Serializable form of the snapshot (JSON-safe)
interface SerializedState {
  commitLog: CompressionCommit[];
}

export class CompressionState {
  private commitLog: CompressionCommit[] = [];
  private snapshot: CompressionSnapshot = CompressionState.emptySnapshot();

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  applyCommit(commit: CompressionCommit): void {
    this.commitLog.push(commit);
    this.updateSnapshot(commit);
  }

  getCommitLog(): readonly CompressionCommit[] {
    return this.commitLog;
  }

  getSnapshot(): Readonly<CompressionSnapshot> {
    return this.snapshot;
  }

  getCommitsByLayer(layer: CompressionCommit['layer']): CompressionCommit[] {
    return this.commitLog.filter((c) => c.layer === layer);
  }

  reset(): void {
    const resetCommit: CompressionCommit = {
      layer: 'system',
      operation: 'reset',
      targetMessageIds: [],
      timestamp: Date.now(),
    };
    this.commitLog.push(resetCommit);
    this.snapshot = CompressionState.emptySnapshot();
  }

  serialize(): string {
    const data: SerializedState = {
      commitLog: this.commitLog,
    };
    return JSON.stringify(data);
  }

  static deserialize(json: string): CompressionState {
    const data: SerializedState = JSON.parse(json);
    const state = new CompressionState();
    for (const commit of data.commitLog) {
      // replay — applyCommit handles both log append and snapshot update
      // but reset commits should use reset() to clear snapshot
      if (commit.operation === 'reset') {
        // Manually push the historical reset commit and clear snapshot
        state.commitLog.push(commit);
        state.snapshot = CompressionState.emptySnapshot();
      } else {
        state.applyCommit(commit);
      }
    }
    return state;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private updateSnapshot(commit: CompressionCommit): void {
    switch (commit.operation) {
      case 'snip': {
        for (const id of commit.targetMessageIds) {
          this.snapshot.snippedIds.add(id);
        }
        break;
      }

      case 'truncate': {
        const originalTokens = (commit.metadata?.originalTokens as number) ?? 0;
        const truncatedTokens = (commit.metadata?.truncatedTokens as number) ?? 0;
        for (const id of commit.targetMessageIds) {
          this.snapshot.budgetedResults.set(id, { originalTokens, truncatedTokens });
        }
        break;
      }

      case 'collapse': {
        const summary = (commit.metadata?.summary as string) ?? '';
        const originalTokens = commit.metadata?.originalTokens as number | undefined;
        const span: CollapsedSpan = {
          messageIds: [...commit.targetMessageIds],
          summary,
          ...(originalTokens !== undefined ? { originalTokens } : {}),
        };
        this.snapshot.collapsedSpans.push(span);
        break;
      }

      case 'compact': {
        for (const id of commit.targetMessageIds) {
          this.snapshot.microcompactedIds.add(id);
        }
        break;
      }

      case 'reset': {
        // reset() method handles this by replacing snapshot entirely;
        // this branch is here for completeness but should not be reached
        // via applyCommit in normal usage.
        this.snapshot = CompressionState.emptySnapshot();
        break;
      }

      // drain and other future operations: no snapshot update yet
      default:
        break;
    }
  }

  private static emptySnapshot(): CompressionSnapshot {
    return {
      snippedIds: new Set(),
      budgetedResults: new Map(),
      collapsedSpans: [],
      microcompactedIds: new Set(),
    };
  }
}
