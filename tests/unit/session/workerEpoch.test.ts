// ============================================================================
// WorkerEpoch Tests
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkerEpoch,
  EpochMismatchError,
  getWorkerEpoch,
  resetWorkerEpoch,
  rematerializeFromSnapshot,
  checkResumeConsistency,
  type ResumeSnapshot,
} from '../../../src/main/session/workerEpoch';
import { CompressionState } from '../../../src/main/context/compressionState';

// --------------------------------------------------------------------------
// WorkerEpoch
// --------------------------------------------------------------------------

describe('WorkerEpoch', () => {
  let epoch: WorkerEpoch;

  beforeEach(() => {
    epoch = new WorkerEpoch();
  });

  it('starts at 0', () => {
    expect(epoch.getCurrent()).toBe(0);
  });

  it('increment returns new epoch', () => {
    const next = epoch.increment();
    expect(next).toBe(1);
  });

  it('multiple increments track correctly', () => {
    epoch.increment();
    epoch.increment();
    const third = epoch.increment();
    expect(third).toBe(3);
    expect(epoch.getCurrent()).toBe(3);
  });

  it('validate passes with matching epoch', () => {
    epoch.increment();
    expect(() => epoch.validate(1)).not.toThrow();
  });

  it('validate throws EpochMismatchError on mismatch', () => {
    epoch.increment(); // epoch is now 1
    expect(() => epoch.validate(0)).toThrow(EpochMismatchError);
  });

  it('EpochMismatchError carries expected and actual', () => {
    epoch.increment(); // epoch is now 1
    try {
      epoch.validate(0);
    } catch (e) {
      expect(e).toBeInstanceOf(EpochMismatchError);
      const err = e as EpochMismatchError;
      expect(err.expected).toBe(1);
      expect(err.actual).toBe(0);
    }
  });

  it('guardedWrite succeeds with matching epoch', () => {
    epoch.increment(); // epoch is now 1
    expect(() => epoch.guardedWrite(1, () => 'ok')).not.toThrow();
  });

  it('guardedWrite throws on mismatched epoch', () => {
    epoch.increment(); // epoch is now 1
    expect(() => epoch.guardedWrite(0, () => 'ok')).toThrow(EpochMismatchError);
  });

  it('guardedWrite executes function and returns result', () => {
    epoch.increment();
    const result = epoch.guardedWrite(1, () => 42);
    expect(result).toBe(42);
  });

  it('guardedWriteAsync works with promises', async () => {
    epoch.increment();
    const result = await epoch.guardedWriteAsync(1, async () => 'async-result');
    expect(result).toBe('async-result');
  });

  it('guardedWriteAsync throws on mismatch', async () => {
    epoch.increment(); // epoch is now 1
    await expect(epoch.guardedWriteAsync(0, async () => 'x')).rejects.toThrow(EpochMismatchError);
  });

  it('reset sets epoch back to 0', () => {
    epoch.increment();
    epoch.increment();
    epoch.reset();
    expect(epoch.getCurrent()).toBe(0);
  });
});

// --------------------------------------------------------------------------
// rematerializeFromSnapshot
// --------------------------------------------------------------------------

describe('rematerializeFromSnapshot', () => {
  beforeEach(() => {
    resetWorkerEpoch();
  });

  it('returns messages from snapshot', () => {
    const snapshot: ResumeSnapshot = {
      sessionId: 'sess-1',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    };
    const ctx = rematerializeFromSnapshot(snapshot);
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0].role).toBe('user');
  });

  it('increments worker epoch', () => {
    const before = getWorkerEpoch().getCurrent();
    rematerializeFromSnapshot({ sessionId: 's', messages: [] });
    expect(getWorkerEpoch().getCurrent()).toBe(before + 1);
  });

  it('deserializes compressionState when provided', () => {
    const cs = new CompressionState();
    cs.applyCommit({
      layer: 'snip',
      operation: 'snip',
      targetMessageIds: ['msg-1'],
      timestamp: Date.now(),
    });
    const snapshot: ResumeSnapshot = {
      sessionId: 'sess-2',
      messages: [],
      compressionState: cs.serialize(),
    };
    const ctx = rematerializeFromSnapshot(snapshot);
    expect(ctx.compressionState).toBeInstanceOf(CompressionState);
    expect(ctx.compressionState!.getSnapshot().snippedIds.has('msg-1')).toBe(true);
  });

  it('handles missing compressionState gracefully', () => {
    const snapshot: ResumeSnapshot = { sessionId: 'sess-3', messages: [] };
    const ctx = rematerializeFromSnapshot(snapshot);
    expect(ctx.compressionState).toBeUndefined();
  });

  it('returns new epoch in result', () => {
    const ctx = rematerializeFromSnapshot({ sessionId: 's', messages: [] });
    expect(ctx.epoch).toBe(1);
  });

  it('returns correct sessionId', () => {
    const ctx = rematerializeFromSnapshot({ sessionId: 'my-session', messages: [] });
    expect(ctx.sessionId).toBe('my-session');
  });
});

// --------------------------------------------------------------------------
// checkResumeConsistency
// --------------------------------------------------------------------------

describe('checkResumeConsistency', () => {
  it('consistent when counts match exactly', () => {
    const result = checkResumeConsistency(10, 10);
    expect(result.consistent).toBe(true);
    expect(result.drift).toBe(0);
  });

  it('consistent when drift <= 2', () => {
    expect(checkResumeConsistency(10, 12).consistent).toBe(true);
    expect(checkResumeConsistency(10, 8).consistent).toBe(true);
    expect(checkResumeConsistency(10, 11).consistent).toBe(true);
  });

  it('inconsistent when drift > 2', () => {
    const result = checkResumeConsistency(10, 14);
    expect(result.consistent).toBe(false);
  });

  it('returns correct drift value', () => {
    expect(checkResumeConsistency(10, 15).drift).toBe(5);
    expect(checkResumeConsistency(20, 17).drift).toBe(3);
    expect(checkResumeConsistency(5, 5).drift).toBe(0);
  });
});
