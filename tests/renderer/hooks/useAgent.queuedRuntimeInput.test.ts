import { describe, expect, it } from 'vitest';
import type { QueuedRuntimeInput } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { requeueAtFront } from '../../../src/renderer/hooks/useAgent';

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
