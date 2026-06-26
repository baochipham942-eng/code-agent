// ============================================================================
// /goal 生命周期通知消息（聊天区卡片）的编解码
//
// "开启目标 / 目标已完成 / 目标已中止" 以 role='system' + source='goal' 的消息
// 形式插入聊天流，content 编码为带 __goalNotice 标记的 JSON，由 GoalNoticeMessage
// 组件解析渲染（参考 SkillStatusMessage 的 source='skill' 模式）。
// ============================================================================

import type { Message } from '../../../../shared/contract/message';
import type { GoalGateVerificationCard } from '../../../../shared/contract/agent';
import { generateMessageId } from '../../../../shared/utils/id';

export type GoalNoticeKind = 'start' | 'met' | 'aborted';

export interface GoalNoticePayload {
  kind: GoalNoticeKind;
  /** 目标文本 */
  goal: string;
  /** 中止原因（kind=aborted） */
  reason?: string;
  /** 总轮次（met/aborted） */
  turns?: number;
  /** 已用 token（met/aborted） */
  tokensUsed?: number;
  /** 总耗时 ms（met/aborted） */
  durationMs?: number;
  /** Goal verification card summarized from goal_gate events. */
  verificationCard?: GoalGateVerificationCard;
}

interface GoalNoticeEnvelope {
  __goalNotice: GoalNoticePayload;
}

/** 把 goal 通知编码成消息 content（JSON）。 */
export function encodeGoalNotice(payload: GoalNoticePayload): string {
  return JSON.stringify({ __goalNotice: payload } satisfies GoalNoticeEnvelope);
}

/** content 是否为 goal 通知（供 MessageBubble 分支判断）。 */
export function isGoalNoticeContent(content: string): boolean {
  return typeof content === 'string' && content.includes('"__goalNotice"');
}

/** 解析 goal 通知 content；非法返回 null。 */
export function parseGoalNotice(content: string): GoalNoticePayload | null {
  try {
    const parsed = JSON.parse(content) as Partial<GoalNoticeEnvelope>;
    const notice = parsed?.__goalNotice;
    if (notice && typeof notice.goal === 'string' && typeof notice.kind === 'string') {
      return notice;
    }
  } catch {
    /* 非 JSON / 格式不符 → null */
  }
  return null;
}

/** 构造一条 goal 通知消息（role=system + source=goal，由 MessageBubble 渲染成卡片）。 */
export function buildGoalNoticeMessage(payload: GoalNoticePayload): Message {
  return {
    id: generateMessageId(),
    role: 'system',
    source: 'goal',
    content: encodeGoalNotice(payload),
    timestamp: Date.now(),
  };
}
