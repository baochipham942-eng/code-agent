import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addMessageToSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessageToSession: mocks.addMessageToSession,
    updateSession: mocks.updateSession,
  }),
}));

import { bindExternalEngineAbort } from '../../../src/host/services/agentEngine/agentEngineAbort';
import { getAgentEngineSessionSink } from '../../../src/host/services/agentEngine/agentEngineSessionSink';

describe('external subagent runtime isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not persist subagent messages or status into the parent session', async () => {
    const sink = getAgentEngineSessionSink('subagent');

    await sink.addMessageToSession('parent-session', { role: 'assistant' } as never);
    await sink.updateSession('parent-session', { status: 'running' });

    expect(mocks.addMessageToSession).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it('keeps the session-level sink unchanged when no subagent origin is present', async () => {
    const sink = getAgentEngineSessionSink(undefined);

    await sink.addMessageToSession('desktop-session', { role: 'assistant' } as never);

    expect(mocks.addMessageToSession).toHaveBeenCalledTimes(1);
  });

  it('turns abort into one termination request and detaches after completion', () => {
    const controller = new AbortController();
    const terminate = vi.fn();
    const unbind = bindExternalEngineAbort(controller.signal, terminate);

    controller.abort('parent-cancel');
    expect(terminate).toHaveBeenCalledTimes(1);
    unbind();
  });
});
