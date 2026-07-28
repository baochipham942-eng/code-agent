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

/**
 * 宿主自动抽干排队消息后广播的载荷（通道 = IPC_CHANNELS.QUEUED_INPUT_SETTLED）。
 * 前端据此清掉本地排队卡片——卡片只有「立即发送」那条路会自己清，
 * 宿主抽干那条路必须靠这条广播。
 */
export interface QueuedInputSettledEvent {
  sessionId: string;
  id: string;
  status: 'consumed' | 'failed';
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
