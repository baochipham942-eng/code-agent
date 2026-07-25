// ============================================================================
// Agent 自发挂起-续跑（self-wake）契约
// ============================================================================
// 角色主动性（roleProactivity）解决的是「外部按时把某个角色叫醒」；这里解决的是
// 另一半：agent 在本轮里主动把自己停下，等条件满足再续跑，等待期间零 idle 成本。
//
// 三种醒来条件：
//   time  —— 到点醒（sleep_until）
//   job   —— 某个自动化任务跑完就醒（wake_on）
//   event —— 某个具名事件发生就醒（wake_on_event）
// ============================================================================

export type AgentWakeKind = 'time' | 'job' | 'event';

/** pending=还没醒；fired=已投递续跑；cancelled=被取消（会话删除/用户撤销） */
export type AgentWakeStatus = 'pending' | 'fired' | 'cancelled';

export interface AgentWakeRecord {
  id: string;
  sessionId: string;
  kind: AgentWakeKind;
  /** kind=time：到点的绝对时间戳（ms） */
  dueAt: number | null;
  /** kind=job：等这个自动化任务跑完 */
  jobId: string | null;
  /** kind=event：等这个具名事件 */
  eventName: string | null;
  /** 给人和模型看的一句话：为什么挂起、醒来要干什么 */
  reason: string;
  status: AgentWakeStatus;
  createdAt: number;
  firedAt: number | null;
}

export interface CreateAgentWakeInput {
  id: string;
  sessionId: string;
  kind: AgentWakeKind;
  dueAt?: number | null;
  jobId?: string | null;
  eventName?: string | null;
  reason: string;
  createdAt: number;
}

/** 醒来时投递给会话的续跑提示词。醒来原因原样带回，模型才知道自己当初挂起想干什么。 */
export function buildWakeResumePrompt(record: Pick<AgentWakeRecord, 'kind' | 'reason'>): string {
  const trigger = record.kind === 'time'
    ? '你之前设定的时间到了'
    : record.kind === 'job'
      ? '你之前等的那个自动化任务跑完了'
      : '你之前等的事件发生了';
  return `${trigger}。当初挂起的理由是：${record.reason}\n\n现在继续把这件事做完。`;
}
