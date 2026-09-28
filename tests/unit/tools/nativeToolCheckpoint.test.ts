import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registry: {
    hasDurableOwner: vi.fn(() => true),
    checkpointNativeToolOperation: vi.fn().mockResolvedValue(undefined),
  },
  getMessages: vi.fn(() => {
    throw new Error('host database must not be read');
  }),
}));

vi.mock('../../../src/host/app/applicationRunRegistry', () => ({
  getConfiguredApplicationRunRegistry: () => mocks.registry,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getMessages: mocks.getMessages }),
}));

import { prepareNativeToolCheckpoint } from '../../../src/host/tools/nativeToolCheckpoint';

describe('prepareNativeToolCheckpoint', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the runtime source message without reading the host database', async () => {
    const checkpoint = await prepareNativeToolCheckpoint({
      runId: 'run-1',
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      toolName: 'spawn_agent',
      toolDefinition: {
        name: 'spawn_agent',
        description: 'Spawn agents',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', properties: {} },
        requiresPermission: false,
        permissionLevel: 'read',
      },
      toolCallId: 'call-1',
      executionId: 'execution-1',
      startedAt: 100,
    });

    await checkpoint.complete(true);

    expect(mocks.getMessages).not.toHaveBeenCalled();
    expect(mocks.registry.checkpointNativeToolOperation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sourceMessageId: 'message-1',
      status: 'dispatched',
    }));
    expect(mocks.registry.checkpointNativeToolOperation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sourceMessageId: 'message-1',
      status: 'succeeded',
    }));
  });

  it('forwards the live goal snapshot into both tool fences', async () => {
    const goalRecoverySnapshot = {
      contract: { goal: 'finish', verifyCommand: 'true', tokenBudget: 100, maxTurns: 2 },
      status: 'pending' as const,
      inactiveTurns: 0,
      completionRequested: false,
      swarmTokensUsed: 0,
      gateFailureCounts: { 1: 0, 2: 0 },
      verificationDegraded: false,
      turnsCompleted: 1,
      tokensUsed: 12,
    };
    const checkpoint = await prepareNativeToolCheckpoint({
      runId: 'run-1',
      sessionId: 'session-1',
      sourceMessageId: 'message-1',
      toolName: 'Read',
      toolDefinition: {
        name: 'Read',
        description: 'Read',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', properties: {} },
        requiresPermission: false,
        permissionLevel: 'read',
      },
      toolCallId: 'call-1',
      executionId: 'execution-1',
      startedAt: 100,
      goalRecoverySnapshot,
    });

    await checkpoint.complete(true);

    expect(mocks.registry.checkpointNativeToolOperation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      isGoalRun: true,
      goalState: goalRecoverySnapshot,
    }));
    expect(mocks.registry.checkpointNativeToolOperation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      isGoalRun: true,
      goalState: goalRecoverySnapshot,
    }));
  });
});
