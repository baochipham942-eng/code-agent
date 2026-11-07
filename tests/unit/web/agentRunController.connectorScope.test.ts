// N-CONNECTOR-POLISH-AUDIT-FU4-SCOPE：web 发射路径对 insufficient_scope 卡事件原样透传
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Response } from 'express';

const broadcastSSE = vi.fn();
const sendSSE = vi.fn();

vi.mock('../../../src/web/helpers/sse', () => ({
  broadcastSSE: (channel: string, data: unknown) => broadcastSSE(channel, data),
  sendSSE: (res: unknown, event: string, data: unknown) => sendSSE(res, event, data),
}));

const { AgentRunController } = await import('../../../src/web/routes/agentRunController');

function createSink(closed = false): Response {
  return {
    writableEnded: closed,
    destroyed: false,
    write: () => true,
    end: () => undefined,
    once: () => undefined,
    off: () => undefined,
  } as unknown as Response;
}

function createController(mirrorToBroadcast: boolean, streamClosed = false) {
  return new AgentRunController({
    res: createSink(streamClosed),
    runId: 'run-1',
    sessionId: 'session-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tryGetSessionManager: async () => null,
    mirrorToBroadcast,
  });
}

function createFilteredController() {
  return new AgentRunController({
    res: createSink(false),
    runId: 'run-filtered',
    sessionId: 'session-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tryGetSessionManager: async () => null,
    mirrorToBroadcast: false,
    eventFilter: { include: ['permission_request'] },
  });
}


describe('AgentRunController forwards insufficient_scope connector_required (web routes/agent path sink)', () => {
  it('broadcasts the card event with requiredScope/helpUrl intact', () => {
    const event = {
      type: 'connector_required' as const,
      data: { connectors: [{ id: 'notion', source: 'selected' as const, reason: 'insufficient_scope', requiredScope: 'write', helpUrl: 'https://example.test/p' }] },
    };
    createController(true).emitAgentEvent(event);
    expect(broadcastSSE).toHaveBeenCalledWith('agent:event', expect.objectContaining({ type: 'connector_required', data: expect.objectContaining(event.data), sessionId: 'session-1' }));
  });
});
