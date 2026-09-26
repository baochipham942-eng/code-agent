import { createHash } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { getDatabase } from '../services/core/databaseService';
import { getSessionManager } from '../services/infra/sessionManager';
import type { Message } from '../../shared/contract';
import { getTaskManager } from '../task/TaskManager';
import type { RunRegistry } from '../runtime/runRegistry';
import type {
  NativeRecoveryDescriptor,
  NativeRecoveryHostPorts,
  NativeRecoveryOperationInput,
  NativeRecoveryResultEvidence,
} from '../runtime/nativeRecoveryHost';
import { getProjectService } from '../services/project/projectService';
import {
  isLegacyBackgroundAuthorityScope,
  resolveBackgroundWorkspaceAuthority,
} from '../runtime/workspaceAuthority';
import type { WorkspaceScope } from '../../shared/contract/project';
import type { ToolDefinition, ToolReplaySafety, ToolResult } from '../../shared/contract';
import { ToolExecutor } from '../tools/toolExecutor';
import type { ToolExecutionResult } from '../tools/types';
import { getToolDefinitionWithCloudMeta } from '../tools/dispatch/toolDefinitions';
import { classifyToolReplaySafety } from '../tools/toolReplaySafety';

interface NativeModelContinuationSessions {
  getMessages(sessionId: string, limit?: number): Promise<Message[]>;
  updateMessage(messageId: string, updates: Partial<Message>): Promise<void>;
}

interface NativeModelContinuationTasks {
  resumeExistingDurableRun(
    sessionId: string,
    runId: string,
    messages: Message[],
    options?: { mode: 'normal'; modelSpec?: { provider: string; model: string }; disableAutoAgent?: boolean },
    messageMetadata?: Message['metadata'],
    clientMessageId?: string,
  ): Promise<void>;
}

interface ApplicationNativeRecoveryDependencies {
  sessions: NativeModelContinuationSessions;
  tasks: NativeModelContinuationTasks;
  now(): number;
  resolveToolDefinition(name: string): ToolDefinition | undefined;
  executeTool(input: {
    name: string;
    arguments: Record<string, unknown>;
    sessionId: string;
    sourceMessageId: string;
    toolCallId: string;
    workingDirectory: string;
  }): Promise<ToolExecutionResult>;
  persistToolMessage(sessionId: string, message: Message): Promise<void>;
  storedToolReplaySafety(sessionId: string, executionId?: string): ToolReplaySafety | null;
  acknowledgeToolRecovery(sessionId: string, executionId: string | undefined, toolName: string): void;
}

const MODEL_RECOVERY_MESSAGE_LIMIT = 500;

function preparedModelEvidence(
  messages: Message[],
  descriptor: NativeRecoveryDescriptor,
): NativeRecoveryResultEvidence | null {
  const sourceIndex = messages.findIndex((message) => message.id === descriptor.sourceMessageId);
  if (sourceIndex < 0) return null;
  const source = messages[sourceIndex];
  if (source.role !== 'user' || source.metadata?.correlation?.turnId !== descriptor.logicalOperationId) {
    return null;
  }
  const nextTurnOffset = messages.slice(sourceIndex + 1)
    .findIndex((message) => message.role === 'user');
  const turnEnd = nextTurnOffset < 0 ? messages.length : sourceIndex + 1 + nextTurnOffset;
  const result = messages.slice(sourceIndex + 1, turnEnd).find((message) => (
    message.role === 'assistant' && message.visibility !== 'rewound'
  ));
  return result ? { resultRef: `message-ledger:${result.id}` } : null;
}

function toolResultEvidence(
  messages: Message[],
  toolCallId: string,
): NativeRecoveryResultEvidence | null {
  const message = messages.find((candidate) => (
    candidate.role === 'tool'
    && candidate.toolResults?.some((result) => result.toolCallId === toolCallId)
  ));
  return message ? { resultRef: `message-ledger:${message.id}` } : null;
}

function persistedToolCall(messages: Message[], toolCallId: string) {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const toolCall = message.toolCalls?.find((candidate) => candidate.id === toolCallId);
    if (toolCall) return { assistantMessage: message, toolCall };
  }
  return null;
}

function buildRecoveredToolMessage(input: {
  assistantMessage: Message;
  toolCallId: string;
  result: ToolResult;
  now: number;
  kind: 'replayed' | 'interrupted';
}): Message {
  return {
    id: `${input.assistantMessage.id}:${input.kind}-tool-result:${input.toolCallId}`,
    role: 'tool',
    content: JSON.stringify([input.result]),
    timestamp: input.now,
    toolResults: [input.result],
    ...(input.assistantMessage.isMeta ? { isMeta: true } : {}),
  };
}

async function checkpointToolReplayFence(
  registry: Pick<RunRegistry, 'checkpointDurable'>,
  input: NativeRecoveryOperationInput,
  now: number,
): Promise<void> {
  await registry.checkpointDurable(input.plan.envelope.runId, {
    now,
    status: 'running',
    state: input.descriptor,
    engineCursor: input.plan.checkpoint?.cursor.engineCursor,
    pendingOperations: input.plan.pendingOperations.map((operation) => (
      operation.operationId === input.operation.operationId
        ? { ...operation, status: 'unknown' as const, updatedAt: now }
        : operation
    )),
    childRuns: input.plan.childRuns,
    events: [{
      type: 'native_tool_recovery_dispatch_fenced',
      payload: { operationId: input.operation.operationId },
      recordedAt: now,
    }],
  });
}

async function checkpointModelDispatchFence(
  registry: Pick<RunRegistry, 'checkpointDurable'>,
  input: NativeRecoveryOperationInput,
  now: number,
): Promise<void> {
  const pendingOperations = input.plan.pendingOperations.map((operation) => (
    operation.operationId === input.operation.operationId
      ? {
          ...operation,
          // Crossing into the live AgentLoop makes the provider outcome unknowable if
          // this process dies. Persist unknown before dispatch so recovery reviews it
          // instead of charging for an unprovable second request.
          status: 'unknown' as const,
          updatedAt: now,
        }
      : operation
  ));
  await registry.checkpointDurable(input.plan.envelope.runId, {
    now,
    status: 'running',
    state: input.descriptor,
    engineCursor: input.plan.checkpoint?.cursor.engineCursor,
    pendingOperations,
    childRuns: input.plan.childRuns,
    events: [{
      type: 'native_model_recovery_dispatch_fenced',
      payload: { operationId: input.operation.operationId },
      recordedAt: now,
    }],
  });
}

export function createApplicationNativeRecoveryPorts(
  registry?: Pick<RunRegistry, 'checkpointDurable'>,
  overrides: Partial<ApplicationNativeRecoveryDependencies> = {},
): NativeRecoveryHostPorts {
  const dependencies = (): ApplicationNativeRecoveryDependencies => ({
    sessions: overrides.sessions ?? getSessionManager(),
    tasks: overrides.tasks ?? getTaskManager(),
    now: overrides.now ?? Date.now,
    resolveToolDefinition: overrides.resolveToolDefinition ?? getToolDefinitionWithCloudMeta,
    executeTool: overrides.executeTool ?? (async (input) => {
      const executor = new ToolExecutor({
        requestPermission: async () => true,
        workingDirectory: input.workingDirectory,
        ledgerOrigin: 'desktop',
      });
      return executor.execute(input.name, input.arguments, {
        sessionId: input.sessionId,
        sourceMessageId: input.sourceMessageId,
        currentToolCallId: input.toolCallId,
        turnId: input.toolCallId,
      });
    }),
    persistToolMessage: overrides.persistToolMessage ?? (async (sessionId, message) => {
      getDatabase().addMessage(sessionId, message, { provenanceKind: 'crash-recovery' });
    }),
    storedToolReplaySafety: overrides.storedToolReplaySafety ?? ((sessionId, executionId) => {
      if (!executionId) return null;
      return getDatabase().getToolExecutionsBySession(sessionId, 500)
        .find((event) => event.executionId === executionId && event.phase === 'begin')
        ?.replaySafety ?? null;
    }),
    acknowledgeToolRecovery: overrides.acknowledgeToolRecovery ?? ((sessionId, executionId, toolName) => {
      if (!executionId) return;
      getDatabase().appendToolExecutionComplete({
        executionId,
        sessionId,
        toolName,
        status: 'recovered',
        recordedAt: Date.now(),
      });
    }),
  });
  return {
    continuationExecutor: 'available',
    async resolveWorkspace(descriptor) {
      try {
        const [root, cwd] = await Promise.all([
          realpath(descriptor.workspace.root),
          realpath(descriptor.workspace.cwd),
        ]);
        const fingerprint = createHash('sha256').update(path.resolve(root)).digest('hex');
        return { ok: true, root: path.resolve(root), cwd: path.resolve(cwd), fingerprint };
      } catch {
        return { ok: false, reason: 'native_workspace_unavailable' };
      }
    },
    async resolveWorkspaceScopeVersion(scope: WorkspaceScope) {
      try {
        // 合成 legacy scope 不在任何项目库里（查库必得 null → 恒判 drift，把同机普通重启
        // 误伤成人工审查）。它唯一的真相来源是 primaryRoot 本身：按当前文件系统重算一遍
        // 兜底权威，根没漂移就得到同一个 version；根变得不安全（如落进 $HOME/数据目录）
        // 时重算返回 undefined → null → 照旧判 drift。
        if (isLegacyBackgroundAuthorityScope(scope)) {
          return resolveBackgroundWorkspaceAuthority({ workspace: scope.primaryRoot })?.version ?? null;
        }
        return getProjectService().getWorkspaceScope(scope.projectId)?.version ?? null;
      } catch {
        return null;
      }
    },
    model: {
      async dispatchPrepared(input) {
        if (!registry) throw new Error('native model continuation requires the application RunRegistry');
        const { sessions, tasks, now } = dependencies();
        const messages = await sessions.getMessages(
          input.plan.envelope.sessionId,
          MODEL_RECOVERY_MESSAGE_LIMIT,
        );
        const existing = preparedModelEvidence(messages, input.descriptor);
        if (existing) return existing;

        const sourceIndex = messages.findIndex((message) => (
          message.id === input.descriptor.sourceMessageId && message.role === 'user'
        ));
        const source = messages[sourceIndex];
        if (!source) throw new Error('native model continuation source message is unavailable');

        await sessions.updateMessage(source.id, {
          metadata: {
            ...source.metadata,
            correlation: {
              ...source.metadata?.correlation,
              turnId: input.descriptor.logicalOperationId,
            },
          },
        });
        await checkpointModelDispatchFence(registry, input, now());

        await tasks.resumeExistingDurableRun(
          input.plan.envelope.sessionId,
          input.plan.envelope.runId,
          messages,
          {
            mode: 'normal',
            modelSpec: {
              provider: input.descriptor.provider,
              model: input.descriptor.model,
            },
            // The crashed run was already inside the native model path. Re-entering
            // auto-agent routing would replay a larger graph instead of this operation.
            disableAutoAgent: true,
          },
          {
            ...source.metadata,
            correlation: {
              ...source.metadata?.correlation,
              turnId: input.descriptor.logicalOperationId,
            },
          },
          source.id,
        );

        const replayed = preparedModelEvidence(
          await sessions.getMessages(input.plan.envelope.sessionId, MODEL_RECOVERY_MESSAGE_LIMIT),
          input.descriptor,
        );
        if (!replayed) throw new Error('native model continuation completed without result evidence');
        return replayed;
      },
      async queryResult() {
        // Native providers currently persist no providerOperationId-correlated result.
        // Telemetry is keyed by a local turn id and is flushed only after completion,
        // so treating it as a provider receipt would create false exactly-once claims.
        return null;
      },
      async canRetrySafely() {
        // A dispatched model request can already have incurred cost even when no result
        // was persisted. No current provider contract proves idempotency or zero charge,
        // therefore automatic retry is never safe.
        return false;
      },
      async retrySafe() {
        throw new Error('native model safe retry is not proven by the current provider contract');
      },
    },
    tool: {
      async queryResult({ plan, providerOperationId }) {
        const completed = getDatabase().getToolExecutionsBySession(plan.envelope.sessionId, 500)
          .find((event) => event.executionId === providerOperationId
            && event.phase === 'complete'
            && event.status === 'success');
        return completed ? { resultRef: `tool-ledger:${providerOperationId}` } : null;
      },
      async classifyReplaySafety(input) {
        const { sessions, resolveToolDefinition, storedToolReplaySafety } = dependencies();
        const messages = await sessions.getMessages(input.plan.envelope.sessionId, MODEL_RECOVERY_MESSAGE_LIMIT);
        const persisted = persistedToolCall(messages, input.descriptor.logicalOperationId);
        const toolName = persisted?.toolCall.name ?? input.descriptor.model;
        return {
          stored: storedToolReplaySafety(
            input.plan.envelope.sessionId,
            input.operation.providerOperationId,
          ),
          current: classifyToolReplaySafety(resolveToolDefinition(toolName)),
        };
      },
      async dispatchPrepared(input) {
        if (!registry) throw new Error('native tool continuation requires the application RunRegistry');
        const deps = dependencies();
        const messages = await deps.sessions.getMessages(
          input.plan.envelope.sessionId,
          MODEL_RECOVERY_MESSAGE_LIMIT,
        );
        const existing = toolResultEvidence(messages, input.descriptor.logicalOperationId);
        if (existing) {
          deps.acknowledgeToolRecovery(
            input.plan.envelope.sessionId,
            input.operation.providerOperationId,
            input.descriptor.model,
          );
          return existing;
        }
        const persisted = persistedToolCall(messages, input.descriptor.logicalOperationId);
        if (!persisted) throw new Error('native tool continuation payload is unavailable');
        if (classifyToolReplaySafety(deps.resolveToolDefinition(persisted.toolCall.name)) !== 'automatic') {
          throw new Error('native tool replay declaration changed before dispatch');
        }
        await checkpointToolReplayFence(registry, input, deps.now());
        const result = await deps.executeTool({
          name: persisted.toolCall.name,
          arguments: persisted.toolCall.arguments,
          sessionId: input.plan.envelope.sessionId,
          sourceMessageId: input.descriptor.sourceMessageId,
          toolCallId: persisted.toolCall.id,
          workingDirectory: input.descriptor.workspace.cwd,
        });
        const toolResult: ToolResult = {
          toolCallId: persisted.toolCall.id,
          success: result.success,
          ...(result.output !== undefined ? { output: result.output } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
          duration: 0,
          ...(result.metadata ? { metadata: result.metadata } : {}),
        };
        const message = buildRecoveredToolMessage({
          assistantMessage: persisted.assistantMessage,
          toolCallId: persisted.toolCall.id,
          result: toolResult,
          now: deps.now(),
          kind: 'replayed',
        });
        await deps.persistToolMessage(input.plan.envelope.sessionId, message);
        deps.acknowledgeToolRecovery(
          input.plan.envelope.sessionId,
          input.operation.providerOperationId,
          persisted.toolCall.name,
        );
        return { resultRef: `message-ledger:${message.id}` };
      },
      async interrupt(input) {
        const deps = dependencies();
        const messages = await deps.sessions.getMessages(
          input.plan.envelope.sessionId,
          MODEL_RECOVERY_MESSAGE_LIMIT,
        );
        const existing = toolResultEvidence(messages, input.descriptor.logicalOperationId);
        if (existing) return existing;
        const persisted = persistedToolCall(messages, input.descriptor.logicalOperationId);
        if (!persisted) throw new Error('native interrupted tool payload is unavailable');
        const toolResult: ToolResult = {
          toolCallId: persisted.toolCall.id,
          success: false,
          error: 'interrupted: process crashed before a result was recorded; do not assume it ran or succeeded',
          duration: 0,
        };
        const message = buildRecoveredToolMessage({
          assistantMessage: persisted.assistantMessage,
          toolCallId: persisted.toolCall.id,
          result: toolResult,
          now: deps.now(),
          kind: 'interrupted',
        });
        await deps.persistToolMessage(input.plan.envelope.sessionId, message);
        deps.acknowledgeToolRecovery(
          input.plan.envelope.sessionId,
          input.operation.providerOperationId,
          persisted.toolCall.name,
        );
        return { resultRef: `message-ledger:${message.id}` };
      },
    },
    approval: {
      async read(approvalId) {
        const approval = getDatabase().getPendingApprovalRepo().getById(approvalId);
        if (!approval) return 'missing';
        if (approval.status === 'pending') return 'pending';
        if (approval.status === 'approved') return 'approved';
        if (approval.status === 'rejected') return 'rejected';
        return 'conflict';
      },
    },
  };
}
