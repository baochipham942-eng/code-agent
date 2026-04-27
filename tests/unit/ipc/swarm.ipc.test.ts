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

const planApprovalState = vi.hoisted(() => ({
  cancelAll: vi.fn(),
}));

const launchApprovalState = vi.hoisted(() => ({
  cancelAll: vi.fn(),
}));

const parallelCoordinatorState = vi.hoisted(() => ({
  canReceiveMessage: vi.fn(),
  sendMessage: vi.fn(),
  abortTask: vi.fn(),
  abortAllRunning: vi.fn(),
}));

const spawnGuardState = vi.hoisted(() => ({
  get: vi.fn(),
  sendMessage: vi.fn(),
  cancel: vi.fn(),
  cancelAll: vi.fn(),
}));

const swarmEmitterState = vi.hoisted(() => ({
  userMessage: vi.fn(),
  cancelled: vi.fn(),
  agentCancelled: vi.fn(),
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
    planApproval: planApprovalState,
    launchApproval: launchApprovalState,
    parallelCoordinator: parallelCoordinatorState,
    spawnGuard: spawnGuardState,
    teammateService: teammateState,
  }),
}));

vi.mock('../../../src/main/agent/swarmEventPublisher', () => ({
  getSwarmEventEmitter: () => swarmEmitterState,
}));

vi.mock('../../../src/main/services/eventing/bus', () => ({
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
    planApprovalState.cancelAll.mockReset();
    launchApprovalState.cancelAll.mockReset();
    parallelCoordinatorState.canReceiveMessage.mockReset();
    parallelCoordinatorState.sendMessage.mockReset();
    parallelCoordinatorState.abortTask.mockReset();
    parallelCoordinatorState.abortAllRunning.mockReset();
    spawnGuardState.get.mockReset();
    spawnGuardState.sendMessage.mockReset();
    spawnGuardState.cancel.mockReset();
    spawnGuardState.cancelAll.mockReset();
    swarmEmitterState.userMessage.mockReset();
    swarmEmitterState.cancelled.mockReset();
    swarmEmitterState.agentCancelled.mockReset();
    eventBusState.subscribe.mockReset();

    parallelCoordinatorState.canReceiveMessage.mockReturnValue(true);
    parallelCoordinatorState.sendMessage.mockReturnValue(true);
    spawnGuardState.get.mockReturnValue(undefined);
    spawnGuardState.sendMessage.mockReturnValue(false);
    parallelCoordinatorState.abortTask.mockReturnValue(false);

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
    expect(parallelCoordinatorState.sendMessage).toHaveBeenCalledWith('agent-reviewer', '只发给 reviewer');
    expect(teammateState.onUserMessage).toHaveBeenCalledWith('agent-reviewer', '只发给 reviewer');
    expect(swarmEmitterState.userMessage).toHaveBeenCalledWith('agent-reviewer', '只发给 reviewer', {
      sessionId: 'session-1',
    });
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
    expect(parallelCoordinatorState.sendMessage).toHaveBeenCalledWith('agent-reviewer', '重复投递也只保留一条');
    expect(teammateState.onUserMessage).toHaveBeenCalledWith('agent-reviewer', '重复投递也只保留一条');
    expect(swarmEmitterState.userMessage).toHaveBeenCalledWith('agent-reviewer', '重复投递也只保留一条', {
      sessionId: 'session-1',
    });
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
    expect(parallelCoordinatorState.sendMessage).not.toHaveBeenCalled();
    expect(teammateState.onUserMessage).not.toHaveBeenCalled();
    expect(swarmEmitterState.userMessage).not.toHaveBeenCalled();
  });

  it('returns delivered=false for an unknown agent without persisting a phantom direct message', async () => {
    parallelCoordinatorState.canReceiveMessage.mockReturnValue(false);
    spawnGuardState.get.mockReturnValue(undefined);

    const handler = platformState.handlers.get('swarm:send-user-message');
    const result = await handler?.({}, {
      agentId: 'agent-missing',
      message: '没有这个 agent',
      sessionId: 'session-1',
      messageId: 'msg-missing',
    });

    expect(result).toEqual({
      delivered: false,
      persisted: false,
    });
    expect(sessionManagerState.addMessageToSession).not.toHaveBeenCalled();
    expect(parallelCoordinatorState.sendMessage).not.toHaveBeenCalled();
    expect(teammateState.onUserMessage).not.toHaveBeenCalled();
    expect(swarmEmitterState.userMessage).not.toHaveBeenCalled();
  });

  it('routes stop-all through the app run-level cancellation path when available', async () => {
    const appService = {
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    registerSwarmHandlers(() => appService as never);

    const handler = platformState.handlers.get('swarm:cancel-run');
    const result = await handler?.({}, { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(appService.cancel).toHaveBeenCalledWith('session-1');
    expect(parallelCoordinatorState.abortAllRunning).not.toHaveBeenCalled();
    expect(swarmEmitterState.cancelled).not.toHaveBeenCalled();
  });

  it('falls back to direct swarm run cancellation when app service is unavailable', async () => {
    const handler = platformState.handlers.get('swarm:cancel-run');
    const result = await handler?.({}, { sessionId: 'session-1' });

    expect(result).toBe(true);
    expect(planApprovalState.cancelAll).toHaveBeenCalledWith('swarm_cancelled');
    expect(launchApprovalState.cancelAll).toHaveBeenCalledWith('swarm_cancelled');
    expect(spawnGuardState.cancelAll).toHaveBeenCalledWith('swarm_cancelled');
    expect(parallelCoordinatorState.abortAllRunning).toHaveBeenCalledWith('swarm_cancelled');
    expect(swarmEmitterState.cancelled).toHaveBeenCalledTimes(1);
  });

  it('cancels a single spawnGuard agent with terminal cancelled event semantics', async () => {
    spawnGuardState.cancel.mockReturnValueOnce(true);

    const handler = platformState.handlers.get('swarm:cancel-agent');
    const result = await handler?.({}, { agentId: 'agent-reviewer' });

    expect(result).toBe(true);
    expect(spawnGuardState.cancel).toHaveBeenCalledWith('agent-reviewer');
    expect(parallelCoordinatorState.abortTask).not.toHaveBeenCalled();
    expect(swarmEmitterState.agentCancelled).toHaveBeenCalledWith('agent-reviewer', 'Cancelled by user');
  });

  it('falls back to coordinator abort for single-agent cancellation and still emits cancelled terminal event', async () => {
    spawnGuardState.cancel.mockReturnValueOnce(false);
    parallelCoordinatorState.abortTask.mockReturnValueOnce(true);

    const handler = platformState.handlers.get('swarm:cancel-agent');
    const result = await handler?.({}, { agentId: 'agent-reviewer' });

    expect(result).toBe(true);
    expect(parallelCoordinatorState.abortTask).toHaveBeenCalledWith('agent-reviewer');
    expect(swarmEmitterState.agentCancelled).toHaveBeenCalledWith('agent-reviewer', 'Cancelled by user');
  });
});
