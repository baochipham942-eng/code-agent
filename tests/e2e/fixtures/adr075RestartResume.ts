import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Message, ToolResult } from '../../../src/shared/contract';
import type { PendingOperation, RunOwnerLease } from '../../../src/shared/contract/durableRun';
import type { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import {
  NativeRecoveryHost,
  type NativeRecoveryDescriptor,
  type NativeRecoveryHostPorts,
  type NativeRecoveryOperationInput,
} from '../../../src/host/runtime/nativeRecoveryHost';
import type { DurableEngineRecoveryHandler } from '../../../src/host/runtime/durableRecoveryDispatcher';
import type { DurableRunKillRestartScenario } from '../../fixtures/durableRunKillRestart';
import type { RunRegistry } from '../../../src/host/runtime/runRegistry';

export type Adr075Mutation = 'regenerate' | 'descriptor-only' | 'replay-bash';

export const ADR075_INTERRUPTED_TOOL_ERROR =
  'interrupted: process crashed before a result was recorded; do not assume it ran or succeeded';
export const ADR075_PARTIAL_ASSISTANT = 'Visible delta before crash\n\n[连接中断 — 部分回答已保留]';
export const ADR075_FINAL_ANSWERS = {
  'adr075-model-streaming': 'Restart resume completed the interrupted turn.',
  'adr075-bash-executing': 'Bash was interrupted; I will not replay the write.',
  'adr075-readonly-tool': 'Read result is in history; the turn is done.',
  'adr075-parallel-readonly': 'Both parallel reads have tool messages; the turn is done.',
} as const;

interface Adr075PersistedState {
  schemaVersion: 1;
  scenarioId: string;
  runId: string;
  sessionId: string;
  sourceMessageId: string;
  workspace: { root: string; cwd: string; fingerprint: string };
  oldOwner: RunOwnerLease;
  idempotencyKeys: string[];
}

interface Adr075Counters {
  modelDispatches: number;
  providerQueries: number;
  toolInterrupts: number;
  toolReplays: number;
  loopAttached: number;
  startTaskCount: number;
  resumeCount: number;
  bashExecutions: number;
  sideEffectWrites: number;
}

export function isAdr075Scenario(scenario: DurableRunKillRestartScenario): boolean {
  return scenario.liveLoop === true;
}

export function parseAdr075Mutation(value: string | undefined): Adr075Mutation | undefined {
  if (!value) return undefined;
  if (value === 'regenerate' || value === 'descriptor-only' || value === 'replay-bash') return value;
  throw new Error(`unknown adr075 mutation: ${value}`);
}

export function messagesPath(dataDir: string): string {
  return path.join(dataDir, 'adr075-messages.json');
}

export function usageLedgerPath(dataDir: string): string {
  return path.join(dataDir, 'adr075-usage.json');
}

export function statePath(dataDir: string): string {
  return path.join(dataDir, 'adr075-state.json');
}

export function countersPath(dataDir: string): string {
  return path.join(dataDir, 'adr075-counters.json');
}

export async function prepareAdr075(
  selected: DurableRunKillRestartScenario,
  dataDir: string,
  kernel: DurableRunKernel,
): Promise<{ runId: string; oldOwnerEpoch: number }> {
  const now = Date.now();
  const runId = `acceptance-${selected.id}`;
  const sessionId = `session-${selected.coreId}`;
  const sourceMessageId = `user-${selected.coreId}`;
  const workspaceRoot = await realpath(dataDir);
  const fingerprint = createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex');
  const workspace = { root: workspaceRoot, cwd: workspaceRoot, fingerprint };
  const { operations, descriptor, messages, idempotencyKeys } = buildKillPoint(
    selected,
    { runId, sessionId, sourceMessageId, workspace, now },
  );
  const created = await kernel.createRun({
    runId,
    sessionId,
    engine: { kind: 'native' },
    now,
    initialStatus: 'running',
    initialPendingOperations: operations,
    initialEngineCursor: { schemaVersion: 1, runtime: 'native', operationId: descriptor.operationId, phase: descriptor.phase },
  });
  await kernel.checkpoint({
    runId,
    attempt: 1,
    owner: created.owner,
    now,
    status: 'running',
    state: descriptor,
    engineCursor: { schemaVersion: 1, runtime: 'native', operationId: descriptor.operationId, phase: descriptor.phase },
    pendingOperations: operations,
    childRuns: [],
    events: [{ type: 'fault_point_ready', payload: { scenarioId: selected.id }, recordedAt: now }],
  });
  const state: Adr075PersistedState = {
    schemaVersion: 1,
    scenarioId: selected.id,
    runId,
    sessionId,
    sourceMessageId,
    workspace,
    oldOwner: created.owner,
    idempotencyKeys,
  };
  await writeFile(statePath(dataDir), JSON.stringify(state));
  await writeFile(messagesPath(dataDir), JSON.stringify(messages, null, 2));
  await writeFile(usageLedgerPath(dataDir), JSON.stringify({ entries: [] }));
  await writeFile(countersPath(dataDir), JSON.stringify(emptyCounters()));
  return { runId, oldOwnerEpoch: created.owner.epoch };
}

export async function createAdr075RecoveryPorts(input: {
  selected: DurableRunKillRestartScenario;
  dataDir: string;
  registry: RunRegistry;
  mutation: Adr075Mutation | undefined;
}): Promise<{
  ports: NativeRecoveryHostPorts;
  handlerOverride?: DurableEngineRecoveryHandler;
  counters: () => Promise<Adr075Counters>;
}> {
  const state = JSON.parse(await readFile(statePath(input.dataDir), 'utf8')) as Adr075PersistedState;
  const loadMessages = async (): Promise<Message[]> =>
    JSON.parse(await readFile(messagesPath(input.dataDir), 'utf8')) as Message[];
  const saveMessages = async (messages: Message[]): Promise<void> => {
    await writeFile(messagesPath(input.dataDir), JSON.stringify(messages, null, 2));
  };
  const bump = async (patch: Partial<Adr075Counters>): Promise<Adr075Counters> => {
    const current = JSON.parse(await readFile(countersPath(input.dataDir), 'utf8')) as Adr075Counters;
    const next: Adr075Counters = { ...current };
    for (const [key, value] of Object.entries(patch) as Array<[keyof Adr075Counters, number | undefined]>) {
      next[key] = current[key] + (value ?? 0);
    }
    await writeFile(countersPath(input.dataDir), JSON.stringify(next));
    return next;
  };
  const persistTool = async (toolCallId: string, result: ToolResult, kind: 'replayed' | 'interrupted'): Promise<string> => {
    const messages = await loadMessages();
    const assistant = messages.find((message) => message.toolCalls?.some((call) => call.id === toolCallId));
    if (!assistant) throw new Error(`adr075 tool call ${toolCallId} is missing from history`);
    const existing = messages.find((message) => message.role === 'tool' && message.toolResults?.some((item) => item.toolCallId === toolCallId));
    if (existing) return `message-ledger:${existing.id}`;
    const message: Message = {
      id: `${assistant.id}:${kind}-tool-result:${toolCallId}`,
      role: 'tool',
      content: JSON.stringify([result]),
      timestamp: Date.now(),
      toolResults: [result],
    };
    await saveMessages([...messages, message]);
    return `message-ledger:${message.id}`;
  };
  const resumeLiveLoop = async (history: Message[], sliced: boolean): Promise<NativeRecoveryResultEvidence> => {
    if (sliced || input.mutation === 'regenerate') {
      await bump({ startTaskCount: 1 });
      return { resultRef: 'regenerate:startTask', loopResumed: true };
    }
    await bump({ resumeCount: 1, loopAttached: 1 });
    const messages = await loadMessages();
    const answer = ADR075_FINAL_ANSWERS[input.selected.coreId as keyof typeof ADR075_FINAL_ANSWERS];
    if (!answer) throw new Error(`no scripted final answer for ${input.selected.id}`);
    if (!messages.some((message) => message.role === 'assistant' && message.content === answer)) {
      await saveMessages([...messages, {
        id: `assistant-final-${input.selected.coreId}`,
        role: 'assistant',
        content: answer,
        timestamp: Date.now(),
      }]);
    }
    void history;
    return { resultRef: `message-ledger:assistant-final-${input.selected.coreId}`, loopResumed: true };
  };

  const ports: NativeRecoveryHostPorts = {
    resolveWorkspace: async (descriptor) => (
      descriptor.workspace.root === state.workspace.root
        && descriptor.workspace.cwd === state.workspace.cwd
        && descriptor.workspace.fingerprint === state.workspace.fingerprint
        ? { ok: true, ...state.workspace }
        : { ok: false, reason: 'native_workspace_drift' }
    ),
    model: {
      dispatchPrepared: async (operationInput) => {
        await bump({ modelDispatches: 1 });
        const ledger = JSON.parse(await readFile(usageLedgerPath(input.dataDir), 'utf8')) as { entries: unknown[] };
        ledger.entries.push({
          sessionId: operationInput.plan.envelope.sessionId,
          source: 'unknown',
          inputTokens: 0,
          outputTokens: 0,
          recordedAt: Date.now(),
        });
        await writeFile(usageLedgerPath(input.dataDir), JSON.stringify(ledger));
        const messages = await loadMessages();
        const sourceIndex = messages.findIndex((message) => message.id === state.sourceMessageId);
        const sliced = input.mutation === 'regenerate';
        const history = sliced ? messages.slice(0, sourceIndex + 1) : messages.filter((message) => (
          message.role !== 'assistant' || !String(message.content).includes('部分回答已保留')
        ));
        const evidence = await resumeLiveLoop(history, sliced);
        if (!sliced) await completeAdoptedRun(input.registry, operationInput);
        return evidence;
      },
      queryResult: async () => null,
      canRetrySafely: async () => input.selected.coreId === 'adr075-model-streaming',
      retrySafe: async (operationInput) => ports.model.dispatchPrepared(operationInput),
    },
    tool: {
      queryResult: async () => null,
      classifyReplaySafety: async (operationInput) => {
        const toolName = operationInput.descriptor.model;
        const automatic = toolName === 'Read' || toolName === 'Glob';
        return {
          stored: automatic ? 'automatic' : 'unknown',
          current: automatic ? 'automatic' : 'unknown',
        };
      },
      dispatchPrepared: async (operationInput) => {
        const toolName = operationInput.descriptor.model;
        const toolCallId = operationInput.descriptor.logicalOperationId;
        if (toolName === 'Bash') {
          await bump({ bashExecutions: 1, sideEffectWrites: 1, toolReplays: 1 });
          await writeFile(path.join(input.dataDir, 'bash-side-effect.txt'), 'replayed\n');
        } else {
          await bump({ toolReplays: 1 });
        }
        return {
          resultRef: await persistTool(toolCallId, {
            toolCallId,
            success: true,
            output: toolName === 'Bash' ? 'replayed bash' : `replayed ${toolName} ${toolCallId}`,
            duration: 0,
          }, 'replayed'),
        };
      },
      interrupt: async (operationInput) => {
        const toolCallId = operationInput.descriptor.logicalOperationId;
        if (input.mutation === 'replay-bash' && operationInput.descriptor.model === 'Bash') {
          await bump({ bashExecutions: 1, sideEffectWrites: 1, toolReplays: 1, toolInterrupts: 1 });
          await writeFile(path.join(input.dataDir, 'bash-side-effect.txt'), 'replayed\n');
          return {
            resultRef: await persistTool(toolCallId, {
              toolCallId,
              success: true,
              output: 'mutated replay of bash',
              duration: 0,
            }, 'replayed'),
          };
        }
        await bump({ toolInterrupts: 1 });
        return {
          resultRef: await persistTool(toolCallId, {
            toolCallId,
            success: false,
            error: ADR075_INTERRUPTED_TOOL_ERROR,
            duration: 0,
          }, 'interrupted'),
        };
      },
    },
    continueLoop: async (operationInput) => {
      const messages = await loadMessages();
      const sourceIndex = messages.findIndex((message) => message.id === state.sourceMessageId);
      const sliced = input.mutation === 'regenerate';
      const history = sliced ? messages.slice(0, sourceIndex + 1) : messages;
      await resumeLiveLoop(history, sliced);
      if (sliced) return;
      await completeAdoptedRun(input.registry, operationInput);
    },
    approval: { read: async () => 'missing' },
  };

  let handlerOverride: DurableEngineRecoveryHandler | undefined;
  if (input.mutation === 'descriptor-only') {
    const inner = new NativeRecoveryHost(input.registry, ports).createHandler();
    handlerOverride = {
      name: inner.name,
      engineKind: inner.engineKind,
      serialAutoResume: inner.serialAutoResume,
      recover: async (plan, now, onAutoResumeStart) => {
        const descriptor = plan.checkpoint?.state as NativeRecoveryDescriptor;
        const only = plan.pendingOperations.filter((operation) => operation.operationId === descriptor.operationId);
        return inner.recover({
          ...plan,
          envelope: { ...plan.envelope, pendingOperations: only },
          pendingOperations: only,
        }, now, onAutoResumeStart);
      },
    };
  }

  return {
    ports,
    handlerOverride,
    counters: async () => JSON.parse(await readFile(countersPath(input.dataDir), 'utf8')) as Adr075Counters,
  };
}

export async function completeAdoptedRun(
  registry: RunRegistry,
  input: NativeRecoveryOperationInput,
): Promise<void> {
  const pending = (input.plan.envelope.pendingOperations ?? []).map((operation) => (
    ['succeeded', 'failed', 'abandoned'].includes(operation.status)
      ? operation
      : { ...operation, status: 'succeeded' as const, updatedAt: Date.now() }
  ));
  const unresolved = pending.filter((operation) => !['succeeded', 'failed', 'abandoned'].includes(operation.status));
  if (unresolved.length > 0) return;
  try {
    await registry.checkpointDurable(input.plan.envelope.runId, {
      now: Date.now(),
      status: 'running',
      state: input.descriptor,
      pendingOperations: pending,
      childRuns: input.plan.childRuns,
      events: [{ type: 'adr075_scripted_loop_attached', payload: { runId: input.plan.envelope.runId }, recordedAt: Date.now() }],
    });
    await registry.terminalDurable(input.plan.envelope.runId, {
      now: Date.now(),
      status: 'completed',
      reason: 'adr075_scripted_loop_completed',
      event: { type: 'run_completed', payload: { reason: 'adr075_scripted_loop_completed' }, recordedAt: Date.now() },
    });
  } catch {
    // Mutation paths (descriptor-only, regenerate) may leave unresolved ops or drop ownership.
  }
}

export async function loadAdr075Evidence(dataDir: string): Promise<{
  messages: Message[];
  usageEntries: number;
  honestPartialKept: boolean;
  toolMessageCount: number;
  toolCallIds: string[];
  finalAnswer: string | null;
  bashSideEffectReplayed: boolean;
}> {
  const messages = JSON.parse(await readFile(messagesPath(dataDir), 'utf8')) as Message[];
  const usage = JSON.parse(await readFile(usageLedgerPath(dataDir), 'utf8')) as { entries: unknown[] };
  const toolCallIds = messages.flatMap((message) => message.toolCalls?.map((call) => call.id) ?? []);
  const toolMessageCount = messages.filter((message) => message.role === 'tool').length;
  const final = [...messages].reverse().find((message) => (
    message.role === 'assistant' && !String(message.content).includes('部分回答已保留')
  ));
  return {
    messages,
    usageEntries: usage.entries.length,
    honestPartialKept: messages.some((message) => String(message.content).includes('部分回答已保留')),
    toolMessageCount,
    toolCallIds,
    finalAnswer: final?.content ?? null,
    bashSideEffectReplayed: existsSync(path.join(dataDir, 'bash-side-effect.txt')),
  };
}

function emptyCounters(): Adr075Counters {
  return {
    modelDispatches: 0,
    providerQueries: 0,
    toolInterrupts: 0,
    toolReplays: 0,
    loopAttached: 0,
    startTaskCount: 0,
    resumeCount: 0,
    bashExecutions: 0,
    sideEffectWrites: 0,
  };
}

function buildKillPoint(
  selected: DurableRunKillRestartScenario,
  input: {
    runId: string;
    sessionId: string;
    sourceMessageId: string;
    workspace: { root: string; cwd: string; fingerprint: string };
    now: number;
  },
): {
  operations: PendingOperation[];
  descriptor: NativeRecoveryDescriptor;
  messages: Message[];
  idempotencyKeys: string[];
} {
  const user: Message = {
    id: input.sourceMessageId,
    role: 'user',
    content: `adr075 ${selected.id}`,
    timestamp: input.now,
    metadata: { correlation: { turnId: selected.coreId } },
  };
  if (selected.coreId === 'adr075-model-streaming') {
    const operation = nativeOperation(input.runId, 'model:turn-1', 'model_call', false, input.now);
    const descriptor = nativeDescriptor({
      sourceMessageId: input.sourceMessageId,
      provider: 'scripted',
      model: 'scripted-model',
      workspace: input.workspace,
      logicalOperationId: 'turn-1',
      operationId: operation.operationId,
      phase: 'after_model_dispatch',
    });
    return {
      operations: [operation],
      descriptor,
      messages: [user, {
        id: 'assistant-partial',
        role: 'assistant',
        content: ADR075_PARTIAL_ASSISTANT,
        timestamp: input.now + 1,
        metadata: { streamInterruptionReason: 'app-restart' },
      }],
      idempotencyKeys: [operation.idempotencyKey],
    };
  }
  if (selected.coreId === 'adr075-bash-executing') {
    const operation = nativeOperation(input.runId, 'tool:call-bash', 'tool_call', true, input.now, 'exec-bash');
    const descriptor = nativeDescriptor({
      sourceMessageId: input.sourceMessageId,
      provider: 'tool',
      model: 'Bash',
      workspace: input.workspace,
      logicalOperationId: 'call-bash',
      operationId: operation.operationId,
      phase: 'tool_dispatched',
    });
    return {
      operations: [operation],
      descriptor,
      messages: [user, assistantWithTools(input.now + 1, [{ id: 'call-bash', name: 'Bash', arguments: { command: 'echo side-effect' } }])],
      idempotencyKeys: [operation.idempotencyKey],
    };
  }
  if (selected.coreId === 'adr075-readonly-tool') {
    const operation = nativeOperation(input.runId, 'tool:call-read', 'tool_call', false, input.now, 'exec-read');
    const descriptor = nativeDescriptor({
      sourceMessageId: input.sourceMessageId,
      provider: 'tool',
      model: 'Read',
      workspace: input.workspace,
      logicalOperationId: 'call-read',
      operationId: operation.operationId,
      phase: 'tool_dispatched',
    });
    return {
      operations: [operation],
      descriptor,
      messages: [user, assistantWithTools(input.now + 1, [{ id: 'call-read', name: 'Read', arguments: { file_path: 'README.md' } }])],
      idempotencyKeys: [operation.idempotencyKey],
    };
  }
  const first = nativeOperation(input.runId, 'tool:call-read-a', 'tool_call', false, input.now, 'exec-read-a');
  const second = nativeOperation(input.runId, 'tool:call-read-b', 'tool_call', false, input.now, 'exec-read-b');
  const descriptor = nativeDescriptor({
    sourceMessageId: input.sourceMessageId,
    provider: 'tool',
    model: 'Read',
    workspace: input.workspace,
    logicalOperationId: 'call-read-b',
    operationId: second.operationId,
    phase: 'tool_dispatched',
  });
  return {
    operations: [first, second],
    descriptor,
    messages: [user, assistantWithTools(input.now + 1, [
      { id: 'call-read-a', name: 'Read', arguments: { file_path: 'a.md' } },
      { id: 'call-read-b', name: 'Read', arguments: { file_path: 'b.md' } },
    ])],
    idempotencyKeys: [first.idempotencyKey, second.idempotencyKey],
  };
}

function nativeOperation(
  runId: string,
  operationId: string,
  kind: PendingOperation['kind'],
  sideEffect: boolean,
  now: number,
  providerOperationId?: string,
): PendingOperation {
  return {
    runId,
    operationId,
    attempt: 1,
    kind,
    status: 'dispatched',
    idempotencyKey: `idem-${operationId}`,
    sideEffect,
    ...(providerOperationId ? { providerOperationId } : {}),
    preparedAt: now,
    updatedAt: now,
  };
}

function nativeDescriptor(input: {
  sourceMessageId: string;
  provider: string;
  model: string;
  workspace: NativeRecoveryDescriptor['workspace'];
  logicalOperationId: string;
  operationId: string;
  phase: NativeRecoveryDescriptor['phase'];
}): NativeRecoveryDescriptor {
  return {
    schemaVersion: 1,
    kind: 'native',
    sourceMessageId: input.sourceMessageId,
    provider: input.provider,
    model: input.model,
    workspace: input.workspace,
    logicalOperationId: input.logicalOperationId,
    operationId: input.operationId,
    phase: input.phase,
    checkpointSequence: 1,
  };
}

function assistantWithTools(
  timestamp: number,
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): Message {
  return {
    id: 'assistant-tools',
    role: 'assistant',
    content: '',
    timestamp,
    toolCalls,
  };
}
