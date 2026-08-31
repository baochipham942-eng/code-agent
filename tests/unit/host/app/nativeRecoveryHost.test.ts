import { describe, expect, it, vi } from 'vitest';
import { createApplicationNativeRecoveryPorts } from '../../../../src/host/app/nativeRecoveryHost';
import type {
  NativeRecoveryDescriptor,
  NativeRecoveryOperationInput,
} from '../../../../src/host/runtime/nativeRecoveryHost';
import type { RunRehydrationPlan } from '../../../../src/host/runtime/durableRunStores';
import type { PendingOperation } from '../../../../src/shared/contract/durableRun';
import type { Message, ToolDefinition } from '../../../../src/shared/contract';

function recoveryInput(): NativeRecoveryOperationInput {
  const operation: PendingOperation = {
    runId: 'run-recovery',
    operationId: 'model:turn-original',
    attempt: 2,
    kind: 'model_call',
    status: 'prepared',
    idempotencyKey: 'model-idempotency-key',
    sideEffect: false,
    preparedAt: 1,
    updatedAt: 2,
  };
  const descriptor: NativeRecoveryDescriptor = {
    schemaVersion: 1,
    kind: 'native',
    sourceMessageId: 'user-source',
    provider: 'openai',
    model: 'gpt-test',
    workspace: { root: '/repo', cwd: '/repo', fingerprint: 'fingerprint' },
    logicalOperationId: 'turn-original',
    operationId: operation.operationId,
    phase: 'before_model_dispatch',
    checkpointSequence: 1,
  };
  const plan: RunRehydrationPlan = {
    envelope: {
      schemaVersion: 1,
      runId: operation.runId,
      sessionId: 'session-recovery',
      engine: { kind: 'native' },
      status: 'recovering',
      attempt: 2,
      cursor: { nextEventSeq: 2, checkpointSeq: 1 },
      owner: {
        ownerId: 'owner', processInstanceId: 'process', epoch: 2, leaseExpiresAt: 10_000,
      },
      pendingOperations: [operation],
      childRuns: [],
      createdAt: 1,
      updatedAt: 2,
    },
    previousAttempt: {
      runId: operation.runId,
      attempt: 1,
      processInstanceId: 'old-process',
      ownerId: 'owner',
      ownerEpoch: 1,
      status: 'lost',
      startedAt: 1,
    },
    checkpoint: {
      runId: operation.runId,
      checkpointSeq: 1,
      attempt: 1,
      eventSeq: 1,
      status: 'running',
      cursor: { nextEventSeq: 2, checkpointSeq: 1 },
      state: descriptor,
      checksum: 'checksum',
      createdAt: 1,
    },
    pendingOperations: [operation],
    childRuns: [],
    requiresHumanConfirmation: [],
  };
  return { plan, descriptor, operation };
}

function sourceMessage(metadata?: Message['metadata']): Message {
  return {
    id: 'user-source',
    role: 'user',
    content: '继续原来的模型调用',
    timestamp: 1,
    metadata,
  };
}

describe('application Native model continuation ports', () => {
  it('re-enters the production task path and fences the original operation before dispatch', async () => {
    const input = recoveryInput();
    let messages = [
      { id: 'older', role: 'user', content: 'older', timestamp: 0 } as Message,
      sourceMessage(),
    ];
    const checkpointDurable = vi.fn(async () => undefined);
    const updateMessage = vi.fn(async (_messageId: string, updates: Partial<Message>) => {
      messages = messages.map((message) => message.id === 'user-source'
        ? { ...message, ...updates }
        : message);
    });
    const setSessionContext = vi.fn();
    const startTask = vi.fn(async () => {
      messages.push({
        id: 'assistant-result',
        role: 'assistant',
        content: '恢复后的结果',
        timestamp: 3,
      });
    });
    const ports = createApplicationNativeRecoveryPorts(
      { checkpointDurable } as never,
      {
        sessions: {
          getMessages: vi.fn(async () => messages),
          updateMessage,
        },
        tasks: { setSessionContext, startTask },
        now: () => 20,
      },
    );

    await expect(ports.model.dispatchPrepared(input)).resolves.toEqual({
      resultRef: 'message-ledger:assistant-result',
    });
    expect(checkpointDurable).toHaveBeenCalledWith('run-recovery', expect.objectContaining({
      status: 'running',
      pendingOperations: [expect.objectContaining({ status: 'unknown', updatedAt: 20 })],
    }));
    expect(setSessionContext).toHaveBeenCalledWith('session-recovery', [
      expect.objectContaining({ id: 'older' }),
    ]);
    expect(startTask).toHaveBeenCalledWith(
      'session-recovery',
      '继续原来的模型调用',
      undefined,
      expect.objectContaining({
        disableAutoAgent: true,
        modelSpec: { provider: 'openai', model: 'gpt-test' },
      }),
      expect.objectContaining({ correlation: { turnId: 'turn-original' } }),
      'user-source',
    );
  });

  it('does not dispatch a second model call when the message ledger already has the result', async () => {
    const input = recoveryInput();
    const checkpointDurable = vi.fn(async () => undefined);
    const updateMessage = vi.fn(async () => undefined);
    const startTask = vi.fn(async () => undefined);
    const ports = createApplicationNativeRecoveryPorts(
      { checkpointDurable } as never,
      {
        sessions: {
          getMessages: vi.fn(async (): Promise<Message[]> => [
            sourceMessage({ correlation: { turnId: 'turn-original' } }),
            {
              id: 'assistant-existing',
              role: 'assistant',
              content: '已经落账的结果',
              timestamp: 2,
            },
          ]),
          updateMessage,
        },
        tasks: { setSessionContext: vi.fn(), startTask },
      },
    );

    await expect(ports.model.dispatchPrepared(input)).resolves.toEqual({
      resultRef: 'message-ledger:assistant-existing',
    });
    expect(startTask).toHaveBeenCalledTimes(0);
    expect(checkpointDurable).toHaveBeenCalledTimes(0);
    expect(updateMessage).toHaveBeenCalledTimes(0);
  });

  it('does not mistake a later turn response for the recovered model result', async () => {
    const input = recoveryInput();
    const startTask = vi.fn(async () => undefined);
    const ports = createApplicationNativeRecoveryPorts(
      { checkpointDurable: vi.fn(async () => undefined) } as never,
      {
        sessions: {
          getMessages: vi.fn(async (): Promise<Message[]> => [
            sourceMessage({ correlation: { turnId: 'turn-original' } }),
            { id: 'later-user', role: 'user', content: 'later', timestamp: 2 },
            { id: 'later-result', role: 'assistant', content: 'later result', timestamp: 3 },
          ]),
          updateMessage: vi.fn(async () => undefined),
        },
        tasks: { setSessionContext: vi.fn(), startTask },
      },
    );

    await expect(ports.model.dispatchPrepared(input)).rejects.toThrow(
      'native model continuation completed without result evidence',
    );
    expect(startTask).toHaveBeenCalledTimes(1);
  });

  it('keeps provider result lookup and retry proof conservative', async () => {
    const ports = createApplicationNativeRecoveryPorts();
    const input = recoveryInput();

    await expect(ports.model.queryResult({
      ...input,
      providerOperationId: 'provider-unqueryable',
    })).resolves.toBeNull();
    await expect(ports.model.canRetrySafely(input)).resolves.toBe(false);
    await expect(ports.model.retrySafe(input)).rejects.toThrow(
      'native model safe retry is not proven by the current provider contract',
    );
  });
});

describe('application Native tool continuation ports', () => {
  function toolInput(): NativeRecoveryOperationInput {
    const input = recoveryInput();
    const toolOperation: PendingOperation = {
      ...input.operation,
      operationId: 'tool:call-read',
      kind: 'tool_call',
      status: 'dispatched',
      providerOperationId: 'execution-read',
      sideEffect: false,
    };
    const descriptor: NativeRecoveryDescriptor = {
      ...input.descriptor,
      provider: 'tool',
      model: 'Read',
      logicalOperationId: 'call-read',
      operationId: toolOperation.operationId,
      phase: 'tool_dispatched',
    };
    return {
      operation: toolOperation,
      descriptor,
      plan: {
        ...input.plan,
        envelope: {
          ...input.plan.envelope,
          pendingOperations: [toolOperation],
        },
        checkpoint: input.plan.checkpoint
          ? { ...input.plan.checkpoint, state: descriptor }
          : null,
        pendingOperations: [toolOperation],
      },
    };
  }

  function toolMessages(): Message[] {
    return [
      sourceMessage(),
      {
        id: 'assistant-tool-call',
        role: 'assistant',
        content: '',
        timestamp: 2,
        toolCalls: [{
          id: 'call-read',
          name: 'Read',
          arguments: { file_path: 'README.md' },
        }],
      },
    ];
  }

  const readDefinition: ToolDefinition = {
    name: 'Read',
    description: 'read',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'string' },
    requiresPermission: false,
    permissionLevel: 'read' as const,
    readOnly: true,
  };

  it('replays persisted read-only arguments and records the real result', async () => {
    const input = toolInput();
    const persisted: Message[] = [];
    const checkpointDurable = vi.fn(async () => undefined);
    const executeTool = vi.fn(async () => ({ success: true, output: 'file contents' }));
    const acknowledgeToolRecovery = vi.fn();
    const ports = createApplicationNativeRecoveryPorts(
      { checkpointDurable } as never,
      {
        sessions: {
          getMessages: vi.fn(async () => [...toolMessages(), ...persisted]),
          updateMessage: vi.fn(async () => undefined),
        },
        tasks: { setSessionContext: vi.fn(), startTask: vi.fn(async () => undefined) },
        resolveToolDefinition: vi.fn(() => readDefinition),
        storedToolReplaySafety: vi.fn(() => 'automatic' as const),
        executeTool,
        persistToolMessage: vi.fn(async (_sessionId, message) => { persisted.push(message); }),
        acknowledgeToolRecovery,
        now: () => 20,
      },
    );

    await expect(ports.tool.classifyReplaySafety(input)).resolves.toEqual({
      stored: 'automatic',
      current: 'automatic',
    });
    await expect(ports.tool.dispatchPrepared(input)).resolves.toEqual({
      resultRef: 'message-ledger:assistant-tool-call:replayed-tool-result:call-read',
    });
    expect(checkpointDurable).toHaveBeenCalledOnce();
    expect(checkpointDurable.mock.invocationCallOrder[0])
      .toBeLessThan(executeTool.mock.invocationCallOrder[0]);
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Read',
      arguments: { file_path: 'README.md' },
      toolCallId: 'call-read',
    }));
    expect(persisted[0]).toMatchObject({
      role: 'tool',
      toolResults: [{ toolCallId: 'call-read', success: true, output: 'file contents' }],
    });
    expect(acknowledgeToolRecovery).toHaveBeenCalledWith(
      'session-recovery',
      'execution-read',
      'Read',
    );
  });

  it('rejects dispatch when the current replay declaration degrades after classification', async () => {
    const input = toolInput();
    const checkpointDurable = vi.fn(async () => undefined);
    const executeTool = vi.fn(async () => ({ success: true, output: 'must not run' }));
    const resolveToolDefinition = vi.fn()
      .mockReturnValueOnce(readDefinition)
      .mockReturnValue({
        ...readDefinition,
        permissionLevel: 'write' as const,
        readOnly: false,
      });
    const ports = createApplicationNativeRecoveryPorts(
      { checkpointDurable } as never,
      {
        sessions: {
          getMessages: vi.fn(async () => toolMessages()),
          updateMessage: vi.fn(async () => undefined),
        },
        tasks: { setSessionContext: vi.fn(), startTask: vi.fn(async () => undefined) },
        resolveToolDefinition,
        storedToolReplaySafety: vi.fn(() => 'automatic' as const),
        executeTool,
        persistToolMessage: vi.fn(async () => undefined),
        acknowledgeToolRecovery: vi.fn(),
      },
    );

    await expect(ports.tool.classifyReplaySafety(input)).resolves.toEqual({
      stored: 'automatic',
      current: 'automatic',
    });
    await expect(ports.tool.dispatchPrepared(input)).rejects.toThrow(
      'native tool replay declaration changed before dispatch',
    );
    expect(checkpointDurable).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('writes interrupted for a write tool and never invokes execution', async () => {
    const input = toolInput();
    input.operation.sideEffect = true;
    const persisted: Message[] = [];
    const checkpointDurable = vi.fn(async () => undefined);
    const executeTool = vi.fn(async () => ({ success: true, output: 'must not run' }));
    const ports = createApplicationNativeRecoveryPorts(
      { checkpointDurable } as never,
      {
        sessions: {
          getMessages: vi.fn(async () => [...toolMessages(), ...persisted]),
          updateMessage: vi.fn(async () => undefined),
        },
        tasks: { setSessionContext: vi.fn(), startTask: vi.fn(async () => undefined) },
        resolveToolDefinition: vi.fn(() => ({
          ...readDefinition,
          permissionLevel: 'write' as const,
          readOnly: false,
        })),
        storedToolReplaySafety: vi.fn(() => 'unknown' as const),
        executeTool,
        persistToolMessage: vi.fn(async (_sessionId, message) => { persisted.push(message); }),
        acknowledgeToolRecovery: vi.fn(),
        now: () => 20,
      },
    );

    await expect(ports.tool.classifyReplaySafety(input)).resolves.toEqual({
      stored: 'unknown',
      current: 'unknown',
    });
    await ports.tool.interrupt(input);
    expect(checkpointDurable).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
    expect(persisted[0]).toMatchObject({
      role: 'tool',
      toolResults: [{
        toolCallId: 'call-read',
        success: false,
        error: expect.stringContaining('interrupted'),
      }],
    });
  });
});
