import type { ToolDefinition } from '../../shared/contract';
import { getConfiguredApplicationRunRegistry } from '../app/applicationRunRegistry';
import { getDatabase } from '../services/core/databaseService';

export interface NativeToolCheckpoint {
  complete(success: boolean): Promise<void>;
}

export async function prepareNativeToolCheckpoint(input: {
  runId?: string;
  sessionId?: string;
  toolName: string;
  toolDefinition: ToolDefinition;
  toolCallId?: string;
  executionId: string;
  startedAt: number;
}): Promise<NativeToolCheckpoint> {
  const registry = input.runId ? getConfiguredApplicationRunRegistry() : null;
  const active = Boolean(input.runId && registry?.hasDurableOwner(input.runId));
  if (!input.runId || !registry || !active) {
    return { complete: async () => {} };
  }

  const sourceMessageId = input.sessionId
    ? [...getDatabase().getMessages(input.sessionId)]
      .reverse()
      .find((message) => message.role === 'user')?.id
    : undefined;
  if (!sourceMessageId) {
    throw new Error('Native Durable tool checkpoint requires a stable source message id');
  }

  const sideEffect = input.toolDefinition.permissionLevel !== 'read'
    && !(input.toolDefinition.permissionLevel === 'network' && input.toolDefinition.readOnly === true);
  const operation = {
    runId: input.runId,
    sourceMessageId,
    toolName: input.toolName,
    logicalOperationId: input.toolCallId ?? input.executionId,
    providerOperationId: input.executionId,
    sideEffect,
  };

  await registry.checkpointNativeToolOperation({
    ...operation,
    status: 'dispatched',
    now: input.startedAt,
  });

  return {
    complete: async (success) => {
      await registry.checkpointNativeToolOperation({
        ...operation,
        status: success ? 'succeeded' : 'failed',
        resultRef: `tool-ledger:${input.executionId}`,
      });
    },
  };
}
