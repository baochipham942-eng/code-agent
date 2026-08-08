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
    expect(ledger.settle(first.workItemId, 'completed')).toEqual([
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

  it('creates a new attempt after failed or cancelled work, while completed work remains reusable', () => {
    const pool = new VoiceTaskConcurrencyPool();
    const ledger = new VoiceTaskSlotLedger('session', pool);
    const first = input(1, 'session');

    expect(ledger.admit(first)).toMatchObject({ outcome: 'started', slot: { attempt: 1 } });
    ledger.settle(first.workItemId, 'failed');
    const retry = ledger.admit({ ...input(2, 'session'), submissionKey: first.submissionKey });
    expect(retry).toMatchObject({ outcome: 'started', slot: { workItemId: 'session-task-2', attempt: 2 } });
    expect(ledger.get(first.workItemId)).toMatchObject({ status: 'settled', terminalStatus: 'failed' });

    ledger.settle('session-task-2', 'completed');
    expect(ledger.admit({ ...input(3, 'session'), submissionKey: first.submissionKey }))
      .toMatchObject({ outcome: 'reused', slot: { workItemId: 'session-task-2', terminalStatus: 'completed' } });

    const cancelledLedger = new VoiceTaskSlotLedger('cancelled-session', pool);
    const cancelled = input(4, 'cancelled-session');
    cancelledLedger.admit(cancelled);
    cancelledLedger.settle(cancelled.workItemId, 'cancelled');
    expect(cancelledLedger.admit({ ...input(5, 'cancelled-session'), submissionKey: cancelled.submissionKey }))
      .toMatchObject({ outcome: 'started', slot: { attempt: 2 } });
  });

  it('can queue on capacity only after the user chose queue', () => {
    const pool = new VoiceTaskConcurrencyPool();
    const ledger = new VoiceTaskSlotLedger('session', pool);
    ledger.admit(input(1, 'session'));
    ledger.admit(input(2, 'session'));

    const queued = ledger.admit(input(3, 'session'), { queueWhenFull: true });
    expect(queued).toMatchObject({ outcome: 'queued', reason: 'capacity' });
    expect(ledger.settle(input(1, 'session').workItemId, 'completed')).toEqual([
      expect.objectContaining({ workItemId: input(3, 'session').workItemId, status: 'running' }),
    ]);
  });

  // settle 的 terminalStatus 曾经默认成 'completed'，而语音协调器恰好不传它——
  // 失败的语音任务会被记成成功，既不可重试、又把失败写成了成功（「没传参数就当通过」）。
  // 参数已改成必填，这条钉住行为侧：失败落账后必须能按同一 submissionKey 再来一次。
  it('failed work must stay retryable under the same submission key', () => {
    const pool = new VoiceTaskConcurrencyPool();
    const ledger = new VoiceTaskSlotLedger('session', pool);
    const first = input(1, 'session', 'lane');

    expect(ledger.admit(first).outcome).toBe('started');
    ledger.settle(first.workItemId, 'failed');
    expect(ledger.get(first.workItemId)).toMatchObject({ terminalStatus: 'failed' });

    const retry = ledger.admit({ ...input(2, 'session', 'lane'), submissionKey: first.submissionKey });
    expect(retry).toMatchObject({ outcome: 'started', slot: { attempt: 2 } });
  });
});
