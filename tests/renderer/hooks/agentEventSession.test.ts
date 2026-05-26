import { describe, expect, it } from 'vitest';
import {
  getAgentEventSessionId,
  isAgentEventForCurrentSession,
} from '../../../src/renderer/hooks/agent/agentEventSession';

describe('agentEventSession', () => {
  it('uses explicit event session ids instead of assuming the active session', () => {
    expect(isAgentEventForCurrentSession(
      { data: { content: 'old turn' } },
      'current-session',
    )).toBe(false);

    expect(isAgentEventForCurrentSession(
      { sessionId: 'other-session', data: { content: 'old turn' } },
      'current-session',
    )).toBe(false);

    expect(isAgentEventForCurrentSession(
      { data: { sessionId: 'current-session', content: 'current turn' } },
      'current-session',
    )).toBe(true);
  });

  it('reads session id from top-level envelope before data fallback', () => {
    expect(getAgentEventSessionId({
      sessionId: 'envelope-session',
      data: { sessionId: 'payload-session' },
    })).toBe('envelope-session');
  });
});
