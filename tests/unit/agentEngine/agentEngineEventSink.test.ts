import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => ({
  webContentsSend: vi.fn(),
}));

vi.mock('../../../src/host/platform', () => ({
  AppWindow: {
    getAllWindows: () => [{ webContents: { send: mocks.webContentsSend } }],
  },
}));

import { emitExternalAgentEvent } from '../../../src/host/services/agentEngine/agentEngineEventSink';

describe('external agent engine event sink routing', () => {
  const event: AgentEvent = { type: 'turn_start', data: { turnId: 'turn-1' } };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes only to the local sink when one is present', () => {
    const localSink = vi.fn();

    emitExternalAgentEvent('subagent-session', event, localSink);

    expect(localSink).toHaveBeenCalledWith(event);
    expect(mocks.webContentsSend).not.toHaveBeenCalled();
  });

  it('keeps desktop window broadcasting when no local sink is present', () => {
    emitExternalAgentEvent('desktop-session', event);

    expect(mocks.webContentsSend).toHaveBeenCalledTimes(1);
    expect(mocks.webContentsSend).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        ...event,
        streamEpoch: expect.stringMatching(/^native:/),
        sessionId: 'desktop-session',
        seq: 1,
      }),
    );
  });
});
