import type { MessageAttachment, MessageMetadata } from '../../shared/contract';
import type {
  ConversationEnvelope,
  ConversationEnvelopeContext,
  WorkbenchMessageMetadata,
} from '../../shared/contract/conversationEnvelope';
import type { SteerOrQueueOutcome } from '../../shared/contract/appService';
import { generateMessageId } from '../../shared/utils/id';
import { SteerRejectedError } from '../agent/runtime/conversationRuntime';
import { SteerUnsupportedError } from './runContext';
import { getDatabase } from '../services/core/databaseService';
import { QueuedInputRepository } from '../services/core/repositories/QueuedInputRepository';

export function workbenchMetadataToEnvelopeContext(
  workbench?: WorkbenchMessageMetadata,
): ConversationEnvelopeContext | undefined {
  if (!workbench) return undefined;

  const context: ConversationEnvelopeContext = {};

  if (workbench.workingDirectory !== undefined) {
    context.workingDirectory = workbench.workingDirectory;
  }
  if (workbench.preferredAgentId !== undefined) {
    context.preferredAgentId = workbench.preferredAgentId;
  }
  if (workbench.preferredAgentName !== undefined) {
    context.preferredAgentName = workbench.preferredAgentName;
  }
  if (workbench.selectedAgent) {
    context.selectedAgent = { ...workbench.selectedAgent };
  }
  if (workbench.selectedPromptCommand) {
    context.selectedPromptCommand = {
      ...workbench.selectedPromptCommand,
      hints: workbench.selectedPromptCommand.hints
        ? [...workbench.selectedPromptCommand.hints]
        : undefined,
    };
  }
  if (workbench.routingMode) {
    context.routing = {
      mode: workbench.routingMode,
      targetAgentIds: workbench.targetAgentIds?.length
        ? [...workbench.targetAgentIds]
        : undefined,
    };
  }
  if (workbench.selectedSkillIds?.length) {
    context.selectedSkillIds = [...workbench.selectedSkillIds];
  }
  if (workbench.selectedConnectorIds?.length) {
    context.selectedConnectorIds = [...workbench.selectedConnectorIds];
  }
  if (workbench.selectedMcpServerIds?.length) {
    context.selectedMcpServerIds = [...workbench.selectedMcpServerIds];
  }
  if (workbench.turnCapabilityScopeMode) {
    context.turnCapabilityScopeMode = workbench.turnCapabilityScopeMode;
  }
  if (workbench.designBrief) {
    context.designBrief = workbench.designBrief;
  }
  if (workbench.executionIntent) {
    context.executionIntent = { ...workbench.executionIntent };
  }
  if (workbench.runtimeInputMode) {
    context.runtimeInput = {
      mode: workbench.runtimeInputMode,
      delivery: workbench.runtimeInputDelivery,
    };
  }
  if (workbench.voiceInput) {
    context.voiceInput = { ...workbench.voiceInput };
  }

  return Object.keys(context).length > 0 ? context : undefined;
}

export interface SteerAttemptTarget {
  steer(
    newMessage: string,
    clientMessageId?: string,
    attachments?: MessageAttachment[],
    metadata?: MessageMetadata,
  ): void | Promise<void>;
}

export interface SteerQueueFenceRepository {
  enqueue(input: { id: string; sessionId: string; envelope: unknown; now?: number }): void;
}

export interface SteerOrQueueInput {
  sessionId: string | null;
  content: string;
  clientMessageId?: string;
  attachments?: MessageAttachment[];
  metadata?: MessageMetadata;
  /**
   * Caller's raw envelope context, when available (web has it; desktop doesn't
   * and falls back to workbenchMetadataToEnvelopeContext(metadata?.workbench)).
   */
  context?: ConversationEnvelopeContext;
}

export type { SteerOrQueueOutcome } from '../../shared/contract/appService';

interface QueuedSteerEnvelopeInput {
  sessionId: string;
  content: string;
  clientMessageId?: string;
  attachments?: MessageAttachment[];
  metadata?: MessageMetadata;
  context?: ConversationEnvelopeContext;
}

interface QueueBuildOptions {
  generateId?: () => string;
}

function buildQueuedSteerEnvelope(
  input: QueuedSteerEnvelopeInput,
  options?: QueueBuildOptions,
): { id: string; envelope: ConversationEnvelope } {
  const id = input.clientMessageId ?? options?.generateId?.() ?? generateMessageId();
  return {
    id,
    envelope: {
      content: input.content,
      clientMessageId: id,
      sessionId: input.sessionId,
      attachments: input.attachments,
      context: input.context
        ?? workbenchMetadataToEnvelopeContext(input.metadata?.workbench),
    },
  };
}

export async function steerOrQueue(
  target: SteerAttemptTarget,
  input: SteerOrQueueInput,
  repository?: SteerQueueFenceRepository,
  options?: { generateId?: () => string; now?: () => number },
): Promise<SteerOrQueueOutcome> {
  try {
    await target.steer(
      input.content,
      input.clientMessageId,
      input.attachments,
      input.metadata,
    );
    return { outcome: 'steered' };
  } catch (error) {
    if (!(error instanceof SteerRejectedError || error instanceof SteerUnsupportedError)) {
      throw error;
    }
    const sessionId = input.sessionId;
    if (!sessionId) throw error;

    const queued = buildQueuedSteerEnvelope({ ...input, sessionId }, options);
    const queueRepository = repository ?? resolveQueuedInputRepository();
    queueRepository.enqueue({
      id: queued.id,
      sessionId,
      envelope: queued.envelope,
      now: options?.now?.(),
    });
    return { outcome: 'queued', queuedInputId: queued.id };
  }
}

function resolveQueuedInputRepository(): SteerQueueFenceRepository {
  const db = getDatabase().getDb();
  if (!db) throw new Error('Cannot queue steer input because the database is not initialized');
  return new QueuedInputRepository(db);
}

export interface PendingSteerLikeMessage {
  content: string;
  clientMessageId?: string;
  attachments?: MessageAttachment[];
  metadata?: MessageMetadata;
}

export function queuePendingSteerMessages(
  sessionId: string,
  pending: PendingSteerLikeMessage[],
  repository: SteerQueueFenceRepository,
  options?: { generateId?: () => string; now?: () => number },
): string[] {
  return pending.map((message) => {
    const queued = buildQueuedSteerEnvelope({ sessionId, ...message }, options);
    repository.enqueue({
      id: queued.id,
      sessionId,
      envelope: queued.envelope,
      now: options?.now?.(),
    });
    return queued.id;
  });
}

/**
 * Convenience wrapper for callers (desktop cancel()/interruptAndContinue()) that must never throw or
 * block: resolves its own repository (DB not initialized degrades to a logged drop, same as a missing
 * session or a failed enqueue) instead of pushing that plumbing onto every call site.
 */
export function queuePendingSteerMessagesOrWarn(
  sessionId: string | null,
  pending: PendingSteerLikeMessage[],
  logContext: string,
  log: { warn: (message: string, ...args: unknown[]) => void; error: (message: string, ...args: unknown[]) => void },
): void {
  if (pending.length === 0) return;
  if (!sessionId) {
    log.warn(`[SteerQueueFence] Dropping pending steer messages ${logContext} because no session is available`);
    return;
  }
  let repository: SteerQueueFenceRepository;
  try {
    repository = resolveQueuedInputRepository();
  } catch {
    log.warn(`[SteerQueueFence] Dropping pending steer messages ${logContext} because the database is not initialized`);
    return;
  }
  try {
    queuePendingSteerMessages(sessionId, pending, repository);
  } catch (error) {
    log.error(`[SteerQueueFence] Failed to queue pending steer messages ${logContext}`, error);
  }
}
