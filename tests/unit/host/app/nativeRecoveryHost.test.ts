import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
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
      interruptCause: 'crash_or_quit',
      interrupt_cause: 'crash_or_quit',
      autoResumeCount: 0,
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

function approvalInput(): NativeRecoveryOperationInput {
  const input = recoveryInput();
  const operation: PendingOperation = {
    ...input.operation,
    operationId: 'approval:approval-1',
    kind: 'approval',
    status: 'waiting',
    providerOperationId: 'approval:approval-1',
    requiresHumanConfirmation: true,
  };
  const descriptor: NativeRecoveryDescriptor = {
    ...input.descriptor,
    logicalOperationId: 'call-write',
    operationId: operation.operationId,
    phase: 'approval_waiting',
    approvalId: 'approval-1',
  };
  return {
    operation,
    descriptor,
    plan: {
      ...input.plan,
      envelope: { ...input.plan.envelope, pendingOperations: [operation] },
      checkpoint: input.plan.checkpoint
        ? { ...input.plan.checkpoint, state: descriptor }
        : null,
      pendingOperations: [operation],
    },
  };
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
  it('passes the durable goal snapshot into the adopted live loop', async () => {
    const input = recoveryInput();
    const goalState = {
      contract: { goal: 'resume goal', verifyCommand: 'npm test', tokenBudget: 800, maxTurns: 4 },
      status: 'pending' as const,
      inactiveTurns: 0,
      completionRequested: false,
      swarmTokensUsed: 12,
      gateFailureCounts: { 1: 1, 2: 0 },
      verificationDegraded: false,
      turnsCompleted: 2,
      tokensUsed: 77,
      inputTokensUsed: 50,
      outputTokensUsed: 27,
      wallClockElapsedMs: 120,
    };
    input.descriptor.goalState = goalState;
    let messages: Message[] = [sourceMessage()];
    const resumeExistingDurableRun = vi.fn(async (
      _sessionId: string,
      _runId: string,
      _history: Message[],
      options?: { mode: 'normal'; goalRecoverySnapshot?: typeof goalState },
    ) => {
      expect(options?.goalRecoverySnapshot).toEqual(goalState);
      messages = [...messages, { id: 'assistant-goal', role: 'assistant', content: '继续', timestamp: 3 }];
    });
    const ports = createApplicationNativeRecoveryPorts(
      { checkpointDurable: vi.fn(async () => undefined) } as never,
      {
        sessions: {
          getMessages: vi.fn(async () => messages),
          updateMessage: vi.fn(async (messageId: string, updates: Partial<Message>) => {
            messages = messages.map((message) => message.id === messageId ? { ...message, ...updates } : message);
          }),
        },
        tasks: { resumeExistingDurableRun },
      },
    );

    await expect(ports.model.dispatchPrepared(input)).resolves.toMatchObject({ loopResumed: true });
    expect(resumeExistingDurableRun).toHaveBeenCalledOnce();
  });

  it('re-enters the production task path with full history and fences before dispatch', async () => {
    const input = recoveryInput();
    let messages = [
      { id: 'older', role: 'user', content: 'older', timestamp: 0 } as Message,
      sourceMessage(),
      {
        id: 'assistant-partial',
        role: 'assistant',
        content: '半截回答\n\n[连接中断 — 部分回答已保留]',
        timestamp: 2,
      } as Message,
    ];
    const checkpointDurable = vi.fn(async () => undefined);
    const updateMessage = vi.fn(async (_messageId: string, updates: Partial<Message>) => {
      messages = messages.map((message) => message.id === 'user-source'
        ? { ...message, ...updates }
        : message);
    });
    const resumeExistingDurableRun = vi.fn(async (_sessionId: string, _runId: string, history: Message[]) => {
      expect(history.map((message) => message.id)).toEqual(['older', 'user-source']);
      messages = [...messages, {
        id: 'assistant-result',
        role: 'assistant',
        content: '恢复后的结果',
        timestamp: 3,
      }];
    });
    const ports = createApplicationNativeRecoveryPorts(
      { checkpointDurable } as never,
      {
        sessions: {
          getMessages: vi.fn(async () => messages),
          updateMessage,
        },
        tasks: { resumeExistingDurableRun },
        now: () => 20,
      },
    );

    await expect(ports.model.dispatchPrepared(input)).resolves.toEqual({
      resultRef: 'message-ledger:assistant-result',
      loopResumed: true,
    });
    expect(checkpointDurable).toHaveBeenCalledWith('run-recovery', expect.objectContaining({
      status: 'running',
      interruptCause: 'crash_or_quit',
      autoResumeCount: 1,
      pendingOperations: [expect.objectContaining({
        status: 'abandoned',
        resultRef: 'model-recovery:superseded-by-live-loop:model:turn-original',
        updatedAt: 20,
      })],
    }));
    expect(checkpointDurable.mock.invocationCallOrder[0])
      .toBeLessThan(resumeExistingDurableRun.mock.invocationCallOrder[0]);
    expect(resumeExistingDurableRun).toHaveBeenCalledWith(
      'session-recovery',
      'run-recovery',
      [
        expect.objectContaining({ id: 'older' }),
        expect.objectContaining({ id: 'user-source' }),
      ],
      expect.objectContaining({
        mode: 'normal',
        disableAutoAgent: true,
        modelSpec: { provider: 'openai', model: 'gpt-test' },
      }),
      expect.objectContaining({ correlation: { turnId: 'turn-original' } }),
      'user-source',
    );
  });

  it('replays a dispatched model turn once and records the crashed usage as unknown', async () => {
    const prepared = recoveryInput();
    const input: NativeRecoveryOperationInput = {
      ...prepared,
      operation: {
        ...prepared.operation,
        status: 'dispatched',
        providerOperationId: 'provider-original',
      },
      descriptor: { ...prepared.descriptor, phase: 'after_model_dispatch' },
    };
    let messages: Message[] = [sourceMessage()];
    const recordModelRecoveryUsage = vi.fn();
    const resumeExistingDurableRun = vi.fn(async (_sessionId: string, _runId: string, history: Message[]) => {
      expect(history.map((message) => message.id)).toEqual(['user-source']);
      messages = [...messages, {
        id: 'assistant-recovered',
        role: 'assistant',
        content: '重新生成后的结果',
        timestamp: 3,
      }];
    });
    const ports = createApplicationNativeRecoveryPorts(
      { checkpointDurable: vi.fn(async () => undefined) } as never,
      {
        sessions: {
          getMessages: vi.fn(async () => messages),
          updateMessage: vi.fn(async (messageId: string, updates: Partial<Message>) => {
            messages = messages.map((message) => message.id === messageId
              ? { ...message, ...updates }
              : message);
          }),
        },
        tasks: { resumeExistingDurableRun },
        recordModelRecoveryUsage,
        now: () => 20,
      },
    );

    await expect(ports.model.dispatchPrepared(input)).resolves.toEqual({
      resultRef: 'message-ledger:assistant-recovered',
      loopResumed: true,
    });
    expect(recordModelRecoveryUsage).toHaveBeenCalledOnce();
    expect(recordModelRecoveryUsage).toHaveBeenCalledWith({
      sessionId: 'session-recovery',
      provider: 'openai',
      modelId: 'gpt-test',
      inputTokens: 0,
      outputTokens: 0,
      usd: null,
      source: 'unknown',
      createdAt: 20,
    });
  });

  it('keeps recovery copy from claiming both model attempts were billed', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../src/host/app/nativeRecoveryHost.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('两次都入账');
  });

  it('does not dispatch a second model call when the message ledger already has the result', async () => {
    const input = recoveryInput();
    const checkpointDurable = vi.fn(async () => undefined);
    const updateMessage = vi.fn(async () => undefined);
    const resumeExistingDurableRun = vi.fn(async () => undefined);
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
        tasks: { resumeExistingDurableRun },
      },
    );

    await expect(ports.model.dispatchPrepared(input)).resolves.toEqual({
      resultRef: 'message-ledger:assistant-existing',
    });
    expect(resumeExistingDurableRun).toHaveBeenCalledTimes(0);
    expect(checkpointDurable).toHaveBeenCalledTimes(0);
    expect(updateMessage).toHaveBeenCalledTimes(0);
  });

  it('does not mistake a later turn response for the recovered model result', async () => {
    const input = recoveryInput();
    let resumedHistory: Message[] = [];
    const resumeExistingDurableRun = vi.fn(async (_sessionId: string, _runId: string, history: Message[]) => {
      resumedHistory = history;
    });
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
        tasks: { resumeExistingDurableRun },
      },
    );

    await expect(ports.model.dispatchPrepared(input)).rejects.toThrow(
      'native model continuation source message is not the latest user turn',
    );
    expect(resumeExistingDurableRun).not.toHaveBeenCalled();
    expect(resumedHistory).toEqual([]);
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
        tasks: { resumeExistingDurableRun: vi.fn(async () => undefined) },
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
    expect(checkpointDurable).toHaveBeenCalledWith('run-recovery', expect.objectContaining({
      interruptCause: 'crash_or_quit',
      autoResumeCount: 1,
    }));
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
        tasks: { resumeExistingDurableRun: vi.fn(async () => undefined) },
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
        tasks: { resumeExistingDurableRun: vi.fn(async () => undefined) },
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

describe('application Native approval recovery ports', () => {
  function approvalMessages(): Message[] {
    return [
      sourceMessage(),
      {
        id: 'assistant-approval-call',
        role: 'assistant',
        content: '',
        timestamp: 2,
        toolCalls: [{ id: 'call-write', name: 'Write', arguments: { file_path: 'out.txt', content: 'ok' } }],
      },
    ];
  }

  it('executes an approved tool once and materializes its result', async () => {
    const input = approvalInput();
    const persisted: Message[] = [];
    const executeTool = vi.fn(async () => ({ success: true, output: 'written' }));
    const ports = createApplicationNativeRecoveryPorts(undefined, {
      sessions: {
        getMessages: vi.fn(async () => [...approvalMessages(), ...persisted]),
        updateMessage: vi.fn(async () => undefined),
      },
      tasks: { resumeExistingDurableRun: vi.fn(async () => undefined) },
      executeTool,
      persistToolMessage: vi.fn(async (_sessionId, message) => { persisted.push(message); }),
      now: () => 20,
    });

    await expect(ports.approval.dispatchPrepared!(input)).resolves.toEqual({
      resultRef: 'message-ledger:assistant-approval-call:approved-tool-result:call-write',
    });
    await expect(ports.approval.dispatchPrepared!(input)).resolves.toEqual({
      resultRef: 'message-ledger:assistant-approval-call:approved-tool-result:call-write',
    });
    expect(executeTool).toHaveBeenCalledOnce();
    expect(persisted[0]).toMatchObject({
      role: 'tool',
      toolResults: [{ toolCallId: 'call-write', success: true, output: 'written' }],
    });
  });

  it('materializes rejection feedback as a failed tool result', async () => {
    const input = approvalInput();
    const persisted: Message[] = [];
    const ports = createApplicationNativeRecoveryPorts(undefined, {
      sessions: {
        getMessages: vi.fn(async () => [...approvalMessages(), ...persisted]),
        updateMessage: vi.fn(async () => undefined),
      },
      tasks: { resumeExistingDurableRun: vi.fn(async () => undefined) },
      persistToolMessage: vi.fn(async (_sessionId, message) => { persisted.push(message); }),
      now: () => 20,
    });

    await expect(ports.approval.reject!(input, '范围不清晰')).resolves.toEqual({
      resultRef: 'message-ledger:assistant-approval-call:denied-tool-result:call-write',
    });
    expect(persisted[0]).toMatchObject({
      role: 'tool',
      toolResults: [{
        toolCallId: 'call-write',
        success: false,
        error: 'approval rejected: 范围不清晰',
      }],
    });
  });
});
