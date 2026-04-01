// ============================================================================
// WorkerEpoch — Concurrent-writer fence via epoch generation
// ============================================================================
// Design principle: "epoch as write gate"
// - Each resume/reconnect increments the epoch
// - Stale async writers hold an old epoch and are rejected by guardedWrite
// - Prevents torn writes when a new session supersedes an old one
// ============================================================================

import { CompressionState } from '../context/compressionState';

// --------------------------------------------------------------------------
// EpochMismatchError
// --------------------------------------------------------------------------

export class EpochMismatchError extends Error {
  constructor(
    public expected: number,
    public actual: number,
  ) {
    super(`Epoch mismatch: expected ${expected}, got ${actual}`);
    this.name = 'EpochMismatchError';
  }
}

// --------------------------------------------------------------------------
// WorkerEpoch
// --------------------------------------------------------------------------

export class WorkerEpoch {
  private currentEpoch: number = 0;

  /**
   * Increment epoch. Called on resume/reconnect.
   * Returns the new epoch value.
   */
  increment(): number {
    this.currentEpoch++;
    return this.currentEpoch;
  }

  getCurrent(): number {
    return this.currentEpoch;
  }

  /**
   * Validate that the given epoch matches current.
   * Throws EpochMismatchError if not.
   */
  validate(epoch: number): void {
    if (epoch !== this.currentEpoch) {
      throw new EpochMismatchError(this.currentEpoch, epoch);
    }
  }

  /**
   * Execute a write operation guarded by epoch validation.
   * If epoch changed between start and execution, the write is rejected.
   */
  guardedWrite<T>(epoch: number, fn: () => T): T {
    this.validate(epoch);
    return fn();
  }

  /**
   * Async version of guardedWrite.
   */
  async guardedWriteAsync<T>(epoch: number, fn: () => Promise<T>): Promise<T> {
    this.validate(epoch);
    return fn();
  }

  reset(): void {
    this.currentEpoch = 0;
  }
}

// --------------------------------------------------------------------------
// Singleton
// --------------------------------------------------------------------------

let instance: WorkerEpoch | null = null;

export function getWorkerEpoch(): WorkerEpoch {
  if (!instance) instance = new WorkerEpoch();
  return instance;
}

export function resetWorkerEpoch(): void {
  instance = null;
}

// --------------------------------------------------------------------------
// ResumeSnapshot + RematerializedContext
// --------------------------------------------------------------------------

export interface ResumeSnapshot {
  sessionId: string;
  messages: Array<{ role: string; content: string; id?: string; timestamp?: number }>;
  compressionState?: string; // serialized CompressionState
  epoch?: number;
}

export interface RematerializedContext {
  sessionId: string;
  messages: Array<{ role: string; content: string; id?: string; timestamp?: number }>;
  compressionState?: CompressionState;
  epoch: number;
}

// --------------------------------------------------------------------------
// rematerializeFromSnapshot
// --------------------------------------------------------------------------

/**
 * Rematerialize session from snapshot instead of replaying transcript.
 * Faster and more consistent than replay.
 */
export function rematerializeFromSnapshot(snapshot: ResumeSnapshot): RematerializedContext {
  const epoch = getWorkerEpoch().increment();

  let compressionState: CompressionState | undefined;
  if (snapshot.compressionState) {
    compressionState = CompressionState.deserialize(snapshot.compressionState);
  }

  return {
    sessionId: snapshot.sessionId,
    messages: snapshot.messages,
    compressionState,
    epoch,
  };
}

// --------------------------------------------------------------------------
// checkResumeConsistency
// --------------------------------------------------------------------------

/**
 * Check if resume is consistent by comparing snapshot message count
 * with actual transcript line count.
 */
export function checkResumeConsistency(
  snapshotMessageCount: number,
  actualTranscriptLines: number,
): { consistent: boolean; drift: number } {
  const drift = Math.abs(snapshotMessageCount - actualTranscriptLines);
  return { consistent: drift <= 2, drift };
}
