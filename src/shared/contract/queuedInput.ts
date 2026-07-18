import type { ConversationEnvelope } from './conversationEnvelope';

export type QueuedInputStatus =
  | 'queued'
  | 'sending'
  | 'consumed'
  | 'retracted'
  | 'failed';

export interface QueuedInput {
  id: string;
  sessionId: string;
  envelope: ConversationEnvelope;
  status: QueuedInputStatus;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface RetractQueuedInputResult {
  retracted: boolean;
}

export interface MarkQueuedInputSendingResult {
  marked: boolean;
}

export interface QueuedInputSendOutcomeResult {
  status: QueuedInputStatus;
  retryCount: number;
}
