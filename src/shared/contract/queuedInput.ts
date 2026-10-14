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
  /** ADR-072 K1C：该行由跨会话委托提交（host 判定，不由 renderer 声明）。 */
  origin?: 'delegation';
}

/**
 * ADR-072 D5.1 委托来源标记（带外）：写在 envelope_json.context.delegationOrigin，
 * 但从 buildQueuedAgentRunBody 与 /run 入口一律剥掉；只有经委托行校验
 * （session_delegations 反查 + 指纹比对）的投递才把标记经 runAgentTurn 的
 * transport 字段送进 run。该轮铸 orchestrator 起源、遥测记 turn_source。
 */
export interface DelegationOriginMarker {
  delegationId: string;
  actionFingerprint: string;
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
  input?: QueuedInput;
}

export interface ReorderQueuedInputsResult {
  reordered: boolean;
}
