import { beforeEach, describe, expect, it, vi } from 'vitest';

const platformState = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  return {
    handlers,
    reset() {
      handlers.clear();
    },
  };
});

const sessionManagerState = vi.hoisted(() => ({
  addMessageToSession: vi.fn(),
}));

const teammateState = vi.hoisted(() => ({
  onUserMessage: vi.fn(),
}));

const swarmEmitterState = vi.hoisted(() => ({
  userMessage: vi.fn(),
}));

const eventBusState = vi.hoisted(() => ({
  subscribe: vi.fn(),
}));

vi.mock('../../../src/main/platform', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
      platformState.handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      platformState.handlers.delete(channel);
    },
  },
}));

vi.mock('../../../src/main/services', () => ({
  getSessionManager: () => sessionManagerState,
}));

vi.mock('../../../src/main/agent/swarmServices', () => ({
  getSwarmServices: () => ({
    teammateService: teammateState,
  }),
}));

vi.mock('../../../src/main/agent/swarmEventPublisher', () => ({
  getSwarmEventEmitter: () => swarmEmitterState,
}));

vi.mock('../../../src/main/protocol/events/bus', () => ({
  getEventBus: () => eventBusState,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { registerSwarmHandlers } from '../../../src/main/ipc/swarm.ipc';

describe('swarm.ipc send-user-message', () => {
  beforeEach(() => {
    platformState.reset();
    sessionManagerState.addMessageToSession.mockReset();
    teammateState.onUserMessage.mockReset();
    swarmEmitterState.userMessage.mockReset();
    eventBusState.subscribe.mockReset();

    registerSwarmHandlers(() => null);
  });

  it('persists the direct-routed user message into the current session before delivery', async () => {
    sessionManagerState.addMessageToSession.mockResolvedValue(undefined);

    const handler = platformState.handlers.get('swarm:send-user-message');
    expect(handler).toBeTypeOf('function');

    const metadata = {
      workbench: {
        routingMode: 'direct' as const,
        targetAgentIds: ['agent-reviewer'],
        targetAgentNames: ['reviewer'],
        directRoutingDelivery: {
          deliveredTargetIds: ['agent-reviewer'],
          deliveredTargetNames: ['reviewer'],
          missingTargetIds: ['agent-missing'],
        },
      },
    };

    const result = await handler?.({}, {
      agentId: 'agent-reviewer',
      message: '只发给 reviewer',
      sessionId: 'session-1',
      messageId: 'msg-direct-1',
      timestamp: 123456,
      metadata,
    });

    expect(result).toEqual({
      delivered: true,
      persisted: true,
    });
    expect(sessionManagerState.addMessageToSession).toHaveBeenCalledWith('session-1', {
      id: 'msg-direct-1',
      role: 'user',
      content: '只发给 reviewer',
      timestamp: 123456,
      metadata,
    });
    expect(teammateState.onUserMessage).toHaveBeenCalledWith('agent-reviewer', '只发给 reviewer');
    expect(swarmEmitterState.userMessage).toHaveBeenCalledWith('agent-reviewer', '只发给 reviewer');
  });

  it('treats duplicate message persistence as already persisted so fanout can stay idempotent', async () => {
    sessionManagerState.addMessageToSession.mockRejectedValue(new Error('UNIQUE constraint failed: messages.id'));

    const handler = platformState.handlers.get('swarm:send-user-message');
    const result = await handler?.({}, {
      agentId: 'agent-reviewer',
      message: '重复投递也只保留一条',
      sessionId: 'session-1',
      messageId: 'msg-direct-duplicate',
    });

    expect(result).toEqual({
      delivered: true,
      persisted: true,
    });
    expect(teammateState.onUserMessage).toHaveBeenCalledWith('agent-reviewer', '重复投递也只保留一条');
    expect(swarmEmitterState.userMessage).toHaveBeenCalledWith('agent-reviewer', '重复投递也只保留一条');
  });

  it('fails the send when the session persistence step fails for a non-duplicate error', async () => {
    sessionManagerState.addMessageToSession.mockRejectedValue(new Error('disk unavailable'));

    const handler = platformState.handlers.get('swarm:send-user-message');
    const result = await handler?.({}, {
      agentId: 'agent-reviewer',
      message: '这条消息不能假装成功',
      sessionId: 'session-1',
      messageId: 'msg-direct-error',
    });

    expect(result).toEqual({
      delivered: false,
      persisted: false,
    });
    expect(teammateState.onUserMessage).not.toHaveBeenCalled();
    expect(swarmEmitterState.userMessage).not.toHaveBeenCalled();
  });
});
