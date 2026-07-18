import { describe, expect, it } from 'vitest';
import type { QueuedRuntimeInput } from '../../../src/renderer/hooks/agent/useAgentIPC';
import {
  requeueAtFront,
  resolveQueuedRuntimeInputFailure,
} from '../../../src/renderer/hooks/useAgent';

function queuedInput(id: string, retryCount?: number): QueuedRuntimeInput {
  return {
    id,
    sessionId: 'session-1',
    envelope: {
      content: `message-${id}`,
      sessionId: 'session-1',
    },
    content: `message-${id}`,
    mode: 'supplement',
    attachmentsCount: 0,
    createdAt: 1,
    retryCount,
  };
}

describe('queued runtime input retry helpers', () => {
  it('increments retryCount and marks only exhausted inputs as sendFailed', () => {
    const firstFailure = resolveQueuedRuntimeInputFailure(queuedInput('A'), 3);
    expect(firstFailure.queued.retryCount).toBe(1);
    expect(firstFailure.exhausted).toBe(false);
    expect(firstFailure.queued.sendFailed).toBeUndefined();

    const lastRetry = resolveQueuedRuntimeInputFailure(queuedInput('A', 2), 3);
    expect(lastRetry.queued.retryCount).toBe(3);
    expect(lastRetry.exhausted).toBe(false);
    expect(lastRetry.queued.sendFailed).toBeUndefined();

    const exhausted = resolveQueuedRuntimeInputFailure(queuedInput('A', 3), 3);
    expect(exhausted.queued.retryCount).toBe(4);
    expect(exhausted.exhausted).toBe(true);
    expect(exhausted.queued.sendFailed).toBe(true);
  });

  it('requeues the failed oldest input ahead of newer queued input', () => {
    const oldest = queuedInput('A');
    const newer = queuedInput('B');

    expect(requeueAtFront([newer], oldest).map((item) => item.id)).toEqual(['A', 'B']);
  });

  it('moves an existing item to the front without duplicating its id', () => {
    const oldest = queuedInput('A', 1);
    const newer = queuedInput('B');

    expect(requeueAtFront([newer, queuedInput('A')], oldest)).toEqual([oldest, newer]);
  });
});
