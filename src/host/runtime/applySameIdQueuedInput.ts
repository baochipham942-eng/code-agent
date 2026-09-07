import type { ConversationEnvelope } from '../../shared/contract/conversationEnvelope';
import type { QueuedInputStatus } from '../../shared/contract/queuedInput';
import {
  decideSameIdQueueAction,
  queuedRecordMatchesEnvelope,
  type SameIdQueueAction,
} from '../../shared/queuedInputSameId';
import { generateMessageId } from '../../shared/utils/id';

interface SameIdQueuedRecord {
  id: string;
  envelopeJson: string;
  status: QueuedInputStatus;
}

export interface SameIdQueuedRepository {
  enqueue(input: { id: string; sessionId: string; envelope: unknown; now?: number }): void;
  getById?(id: string): SameIdQueuedRecord | null;
  updateEnvelope?(id: string, envelopeJson: string, now?: number): boolean;
  requeue?(id: string, envelopeJson: string, now?: number): boolean;
}

export interface ApplySameIdQueuedInput {
  id: string;
  sessionId: string;
  envelope: unknown;
  now?: number;
  generateId?: () => string;
}

export interface ApplySameIdQueuedResult {
  id: string;
  envelope: unknown;
  action: SameIdQueueAction | 'insert';
}

function parseEnvelope(envelopeJson: string): ConversationEnvelope {
  try {
    return JSON.parse(envelopeJson) as ConversationEnvelope;
  } catch {
    return { content: '' };
  }
}

function submittedEnvelope(envelope: unknown): ConversationEnvelope {
  if (!envelope || typeof envelope !== 'object') return { content: '' };
  return envelope as ConversationEnvelope;
}

function forkNewRow(
  repo: SameIdQueuedRepository,
  input: ApplySameIdQueuedInput,
): ApplySameIdQueuedResult {
  const freshId = input.generateId?.() ?? generateMessageId();
  const envelope = {
    ...submittedEnvelope(input.envelope),
    clientMessageId: freshId,
    sessionId: input.sessionId,
  };
  repo.enqueue({
    id: freshId,
    sessionId: input.sessionId,
    envelope,
    now: input.now,
  });
  return { id: freshId, envelope, action: 'fork' };
}

/**
 * 同 id 入队：与 renderer 入队回执同一张真值表（decideSameIdQueueAction）。
 * 没有 getById 的测试替身退回单纯 enqueue，生产仓储走完整状态机。
 */
export function applySameIdQueuedInput(
  repo: SameIdQueuedRepository,
  input: ApplySameIdQueuedInput,
): ApplySameIdQueuedResult {
  const existing = ((): SameIdQueuedRecord | null => {
    try {
      return repo.getById?.(input.id) ?? null;
    } catch {
      return null;
    }
  })();
  if (!existing) {
    repo.enqueue({
      id: input.id,
      sessionId: input.sessionId,
      envelope: input.envelope,
      now: input.now,
    });
    return { id: input.id, envelope: input.envelope, action: 'insert' };
  }

  const currentEnvelope = parseEnvelope(existing.envelopeJson);
  const submitted = submittedEnvelope(input.envelope);
  const samePayload = queuedRecordMatchesEnvelope(
    { envelope: currentEnvelope },
    submitted,
  );
  const action = decideSameIdQueueAction(existing.status, samePayload);
  const envelopeJson = JSON.stringify(input.envelope);

  if (action === 'keep') {
    return { id: input.id, envelope: currentEnvelope, action };
  }
  if (action === 'update') {
    if (repo.updateEnvelope?.(input.id, envelopeJson, input.now)) {
      return { id: input.id, envelope: input.envelope, action };
    }
    const again = repo.getById?.(input.id);
    if (again && queuedRecordMatchesEnvelope({ envelope: parseEnvelope(again.envelopeJson) }, submitted)) {
      return { id: input.id, envelope: parseEnvelope(again.envelopeJson), action: 'keep' };
    }
    return forkNewRow(repo, input);
  }
  if (action === 'requeue') {
    if (repo.requeue?.(input.id, envelopeJson, input.now)) {
      return { id: input.id, envelope: input.envelope, action };
    }
    const again = repo.getById?.(input.id);
    if (again?.status === 'queued'
      && queuedRecordMatchesEnvelope({ envelope: parseEnvelope(again.envelopeJson) }, submitted)) {
      return { id: input.id, envelope: parseEnvelope(again.envelopeJson), action: 'keep' };
    }
    return forkNewRow(repo, input);
  }
  return forkNewRow(repo, input);
}
