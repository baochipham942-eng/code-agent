import type { MessageAttachment, MessageMetadata } from '../../shared/contract';
import type {
  ConversationEnvelope,
  ConversationEnvelopeContext,
  WorkbenchMessageMetadata,
} from '../../shared/contract/conversationEnvelope';
import { generateMessageId } from '../../shared/utils/id';
import { SteerRejectedError } from '../agent/runtime/conversationRuntime';
import { SteerUnsupportedError } from './runContext';

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
  sessionId: string;
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

export type SteerOrQueueOutcome =
  | { outcome: 'steered' }
  | { outcome: 'queued'; queuedInputId: string };

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
  repository: SteerQueueFenceRepository,
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

    const queued = buildQueuedSteerEnvelope(input, options);
    repository.enqueue({
      id: queued.id,
      sessionId: input.sessionId,
      envelope: queued.envelope,
      now: options?.now?.(),
    });
    return { outcome: 'queued', queuedInputId: queued.id };
  }
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
