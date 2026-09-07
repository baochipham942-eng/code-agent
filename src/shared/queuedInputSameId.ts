import type { ConversationEnvelope } from './contract/conversationEnvelope';
import type { QueuedInput, QueuedInputStatus } from './contract/queuedInput';

export type SameIdQueueAction =
  | 'keep'
  | 'update'
  | 'requeue'
  | 'fork';

export function queuedRecordMatchesEnvelope(
  record: Pick<QueuedInput, 'envelope'>,
  envelope: Pick<ConversationEnvelope, 'content' | 'attachments'>,
): boolean {
  return (record.envelope.content ?? '') === (envelope.content ?? '')
    && JSON.stringify(record.envelope.attachments ?? []) === JSON.stringify(envelope.attachments ?? []);
}

/**
 * 同 id 入队回执状态机。payload 相同 = 正文相同且附件相同。
 * sending/consumed + 不同 payload → fork（有意不覆盖已推进的行）。
 * failed/retracted → 一律 requeue，即使 payload 相同（终态不会被 INSERT OR IGNORE 救活）。
 */
export function decideSameIdQueueAction(
  status: QueuedInputStatus,
  samePayload: boolean,
): SameIdQueueAction {
  if (status === 'queued') return samePayload ? 'keep' : 'update';
  if (status === 'sending' || status === 'consumed') return samePayload ? 'keep' : 'fork';
  if (status === 'failed' || status === 'retracted') return 'requeue';
  return samePayload ? 'keep' : 'fork';
}
