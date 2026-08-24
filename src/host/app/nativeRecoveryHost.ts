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

interface NativeModelContinuationSessions {
  getMessages(sessionId: string, limit?: number): Promise<Message[]>;
  updateMessage(messageId: string, updates: Partial<Message>): Promise<void>;
}

interface NativeModelContinuationTasks {
  setSessionContext(sessionId: string, messages: Message[]): void;
  startTask(
    sessionId: string,
    message: string,
    attachments?: unknown[],
    options?: { modelSpec?: { provider: string; model: string }; disableAutoAgent?: boolean },
    messageMetadata?: Message['metadata'],
    clientMessageId?: string,
  ): Promise<void>;
}

interface ApplicationNativeRecoveryDependencies {
  sessions: NativeModelContinuationSessions;
  tasks: NativeModelContinuationTasks;
  now(): number;
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
    async resolveWorkspaceScopeVersion(projectId) {
      try {
        return getProjectService().getWorkspaceScope(projectId)?.version ?? null;
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

        tasks.setSessionContext(input.plan.envelope.sessionId, messages.slice(0, sourceIndex));
        await tasks.startTask(
          input.plan.envelope.sessionId,
          source.content,
          source.attachments,
          {
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
            && (event.status === 'success' || event.status === 'recovered'));
        return completed ? { resultRef: `tool-ledger:${providerOperationId}` } : null;
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
