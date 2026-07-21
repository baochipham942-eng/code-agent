import { describe, expect, it } from 'vitest';
import { SurfaceContinuationService } from '../../../../src/host/services/surfaceExecution/SurfaceContinuationService';

describe('SurfaceContinuationService', () => {
  it('binds a single-use continuation to conversation and agent ownership', () => {
    const service = new SurfaceContinuationService({
      now: () => 100,
      createId: () => 'continuation-1',
    });
    service.prepare({
      conversationId: 'conversation-1',
      parentSessionId: 'surface-parent',
      agentId: 'agent-a',
    });

    expect(service.consume({
      conversationId: 'conversation-1',
      runId: 'run-foreign',
      agentId: 'agent-b',
    })).toBeNull();
    expect(service.consume({
      conversationId: 'conversation-1',
      runId: 'run-next',
      agentId: 'agent-a',
    })).toMatchObject({
      requestId: 'continuation-1',
      parentSessionId: 'surface-parent',
    });
    expect(service.consume({
      conversationId: 'conversation-1',
      runId: 'run-next',
      agentId: 'agent-a',
    })).toBeNull();
  });

  it('expires an unconsumed continuation instead of reviving old authority', () => {
    let now = 100;
    const service = new SurfaceContinuationService({ now: () => now, ttlMs: 50 });
    service.prepare({
      conversationId: 'conversation-1',
      parentSessionId: 'surface-parent',
      agentId: 'agent-a',
    });
    now = 151;

    expect(service.peek('conversation-1', 'agent-a')).toBeNull();
  });
});
