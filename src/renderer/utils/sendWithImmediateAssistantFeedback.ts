/**
 * 助手侧发送占位的真实阶段。顺序只能前进；任何耗时都不能触发阶段迁移。
 */
type AssistantFeedbackPhase = 'submitting' | 'queued' | 'waiting_model';

export interface AssistantFeedbackState {
  phase: AssistantFeedbackPhase;
  startedAt: number;
  clientMessageId: string;
  sessionId: string;
}

export type AssistantFeedbackEvent =
  | { type: 'send_started'; startedAt: number; clientMessageId: string; sessionId: string }
  | { type: 'enqueue_succeeded'; clientMessageId: string; sessionId: string }
  | { type: 'durable_activated'; clientMessageId: string; sessionId: string }
  | { type: 'model_delta'; sessionId: string }
  | { type: 'send_failed'; clientMessageId?: string; sessionId?: string };

const PHASE_ORDER: Record<AssistantFeedbackPhase, number> = {
  submitting: 0,
  queued: 1,
  waiting_model: 2,
};

/**
 * 只消费已发生的发送事件。enqueue 与 durable 事件即使跨进程乱序到达，
 * 也不会让文案从“等待模型”倒退回“已排队”。
 */
export function transitionAssistantFeedback(
  current: AssistantFeedbackState | null,
  event: AssistantFeedbackEvent,
): AssistantFeedbackState | null {
  if (event.type === 'send_started') {
    return {
      phase: 'submitting',
      startedAt: event.startedAt,
      clientMessageId: event.clientMessageId,
      sessionId: event.sessionId,
    };
  }
  if (!current) return null;
  if (event.sessionId && event.sessionId !== current.sessionId) return current;
  if ('clientMessageId' in event && event.clientMessageId
    && event.clientMessageId !== current.clientMessageId) return current;
  if (event.type === 'send_failed') return null;
  if (event.type === 'model_delta') {
    return current.phase === 'waiting_model' ? null : current;
  }
  const nextPhase: AssistantFeedbackPhase = event.type === 'enqueue_succeeded'
    ? 'queued'
    : 'waiting_model';
  return PHASE_ORDER[nextPhase] > PHASE_ORDER[current.phase]
    ? { ...current, phase: nextPhase }
    : current;
}

/**
 * 发送动作与助手侧本地占位的时序不变量：占位必须在 send 真正返回之前就建立，
 * 一旦发送被拒（鉴权/模型配置不通）再撤销。放在 utils 而不是 ChatView 内，
 * 是为了让它有真实的生产消费方，测试不算消费方（knip production 档）。
 */
export async function sendWithImmediateAssistantFeedback(options: {
  showFeedback: () => void;
  clearFeedback: () => void;
  send: () => Promise<boolean>;
}): Promise<boolean> {
  options.showFeedback();
  try {
    const sent = await options.send();
    if (!sent) options.clearFeedback();
    return sent;
  } catch (error) {
    options.clearFeedback();
    throw error;
  }
}
