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
  position: number;
  pausedReason: string | null;
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

/**
 * 排队消息已经拿到自己的 durable run 身份。这个事件只允许在首个
 * durable_run_attempts 记录创建成功后发送，renderer 据此结束“排队启动中”。
 */
export interface QueuedInputActivatedEvent {
  sessionId: string;
  id: string;
  runId: string;
  activatedAt: number;
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

export interface UpdateQueuedInputResult {
  updated: boolean;
}

export interface ReorderQueuedInputsResult {
  reordered: boolean;
}
