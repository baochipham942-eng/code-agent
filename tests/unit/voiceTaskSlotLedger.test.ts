import { describe, expect, it } from 'vitest';
import {
  VoiceTaskConcurrencyPool,
  VoiceTaskSlotLedger,
} from '../../src/host/services/voice/voiceTaskSlotLedger';

function input(index: number, sessionId: string, laneKey = `lane-${index}`) {
  return {
    workItemId: `${sessionId}-task-${index}`,
    sessionId,
    laneKey,
    submissionKey: `${sessionId}-submission-${index}`,
  };
}

describe('VoiceTaskSlotLedger', () => {
  it('enforces global=4 and perSession=2 with explicit overflow choice', () => {
    const pool = new VoiceTaskConcurrencyPool();
    const left = new VoiceTaskSlotLedger('left', pool);
    const right = new VoiceTaskSlotLedger('right', pool);

    expect(left.admit(input(1, 'left')).outcome).toBe('started');
    expect(left.admit(input(2, 'left')).outcome).toBe('started');
    expect(left.admit(input(3, 'left')).outcome).toBe('requires_choice');
    expect(right.admit(input(1, 'right')).outcome).toBe('started');
    expect(right.admit(input(2, 'right')).outcome).toBe('started');
    expect(pool.runningCount()).toBe(4);

    const third = new VoiceTaskSlotLedger('third', pool);
    expect(third.admit(input(1, 'third')).outcome).toBe('requires_choice');
  });

  it('serializes the same lane and starts it after the predecessor settles', () => {
    const pool = new VoiceTaskConcurrencyPool();
    const ledger = new VoiceTaskSlotLedger('session', pool);
    const first = input(1, 'session', 'report');
    const second = input(2, 'session', 'report');

    expect(ledger.admit(first).outcome).toBe('started');
    expect(ledger.admit(second)).toMatchObject({ outcome: 'queued', reason: 'lane_busy' });
    expect(ledger.settle(first.workItemId)).toEqual([
      expect.objectContaining({ workItemId: second.workItemId, status: 'running' }),
    ]);
  });

  it('reuses duplicate submission keys instead of dispatching twice', () => {
    const pool = new VoiceTaskConcurrencyPool();
    const ledger = new VoiceTaskSlotLedger('session', pool);
    const first = input(1, 'session');

    expect(ledger.admit(first).outcome).toBe('started');
    expect(ledger.admit({ ...input(2, 'session'), submissionKey: first.submissionKey }))
      .toMatchObject({ outcome: 'reused', slot: { workItemId: first.workItemId } });
    expect(ledger.running()).toHaveLength(1);
  });

  it('can queue on capacity only after the user chose queue', () => {
    const pool = new VoiceTaskConcurrencyPool();
    const ledger = new VoiceTaskSlotLedger('session', pool);
    ledger.admit(input(1, 'session'));
    ledger.admit(input(2, 'session'));

    const queued = ledger.admit(input(3, 'session'), { queueWhenFull: true });
    expect(queued).toMatchObject({ outcome: 'queued', reason: 'capacity' });
    expect(ledger.settle(input(1, 'session').workItemId)).toEqual([
      expect.objectContaining({ workItemId: input(3, 'session').workItemId, status: 'running' }),
    ]);
  });
});
