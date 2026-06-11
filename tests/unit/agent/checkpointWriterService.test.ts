import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  CheckpointWriterService,
  type CheckpointWriterRunner,
} from '../../../src/main/agent/checkpointWriterService';

function message(id: string): Message {
  return {
    id,
    role: 'user',
    content: `message ${id}`,
    timestamp: Date.now(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('CheckpointWriterService', () => {
  it('starts writer work in the background without awaiting completion', () => {
    const pending = deferred<Awaited<ReturnType<CheckpointWriterRunner>>>();
    const runner = vi.fn(() => pending.promise);
    const service = new CheckpointWriterService({ runner });

    const result = service.trigger({
      sessionId: 's1',
      workingDirectory: '/repo',
      messages: [message('m1')],
      reason: 'periodic',
    });

    expect(result).toEqual({
      started: true,
      queued: false,
      skipped: false,
      reason: 'started',
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('keeps only the latest pending job while a writer is running', async () => {
    const first = deferred<Awaited<ReturnType<CheckpointWriterRunner>>>();
    const runner = vi
      .fn<CheckpointWriterRunner>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({
        success: true,
        checkpointPath: '/tmp/checkpoint.md',
        memoryPath: '/tmp/MEMORY.md',
        writtenAt: 2,
      });
    const service = new CheckpointWriterService({ runner });

    service.trigger({
      sessionId: 's1',
      workingDirectory: '/repo',
      messages: [message('m1')],
      reason: 'periodic',
    });
    const queued1 = service.trigger({
      sessionId: 's1',
      workingDirectory: '/repo',
      messages: [message('m1'), message('m2')],
      reason: 'pressure',
    });
    const queued2 = service.trigger({
      sessionId: 's1',
      workingDirectory: '/repo',
      messages: [message('m1'), message('m2'), message('m3')],
      reason: 'pressure',
    });

    expect(queued1.queued).toBe(true);
    expect(queued2.queued).toBe(true);
    first.resolve({
      success: true,
      checkpointPath: '/tmp/checkpoint.md',
      memoryPath: '/tmp/MEMORY.md',
      writtenAt: 1,
    });
    await service.waitForIdle('s1', 1_000);

    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1][0].messages.map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('does not retrigger periodic writes before the message watermark advances enough', () => {
    const runner = vi.fn<CheckpointWriterRunner>().mockResolvedValue({
      success: true,
      checkpointPath: '/tmp/checkpoint.md',
      memoryPath: '/tmp/MEMORY.md',
      writtenAt: 1,
    });
    const service = new CheckpointWriterService({
      runner,
      minMessagesBetweenPeriodicWrites: 3,
    });

    const skipped = service.maybeTriggerPeriodic({
      sessionId: 's1',
      workingDirectory: '/repo',
      messages: [message('m1'), message('m2')],
    });
    const started = service.maybeTriggerPeriodic({
      sessionId: 's1',
      workingDirectory: '/repo',
      messages: [message('m1'), message('m2'), message('m3')],
    });

    expect(skipped.skipped).toBe(true);
    expect(skipped.reason).toBe('periodic-watermark-not-reached');
    expect(started.started).toBe(true);
  });
});

