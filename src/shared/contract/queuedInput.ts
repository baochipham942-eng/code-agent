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
 * 排队条目离开「可见队列」或回到可见队列时广播的载荷
 * （通道 = IPC_CHANNELS.QUEUED_INPUT_SETTLED）。
 * 前端卡片只有「立即发送」那条路会自己清；宿主抽干必须靠这条广播。
 * sending = 出队那一刻（queued→sending），计数必须在这一刻掉，不能等整轮回答结束。
 * queued = 发送失败后重新入队，卡片要再出现。
 * consumed / failed = 终态。
 */
export interface QueuedInputSettledEvent {
  sessionId: string;
  id: string;
  status: 'consumed' | 'failed' | 'sending' | 'queued';
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
