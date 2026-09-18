export type CardOutcome = 'answered' | 'expired' | 'cancelled';

/**
 * 同 requestId 的卡片事件按到达顺序浅合并。终态字段（outcome/answer）不跨发布继承：
 * 重发布的 pending 重试卡（启动失败后带原因重现）不带这两个键，若从旧 payload 继承，
 * pending 卡会渲染出 data-outcome="answered"。结算事件自带这两个键，照常合并进去。
 */
export function mergeCardPayload(
  previous: Record<string, unknown> | undefined,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!previous) return payload;
  const base = { ...previous };
  delete base.outcome;
  delete base.answer;
  return { ...base, ...payload };
}

export function cardOutcome(card: Record<string, unknown>): CardOutcome | undefined {
  const value = card.outcome;
  return value === 'answered' || value === 'expired' || value === 'cancelled' ? value : undefined;
}

function cardAnswer(card: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = card.answer;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function questionAnswers(card: Record<string, unknown>): Record<string, string | string[]> | undefined {
  const answers = cardAnswer(card)?.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return undefined;
  return answers as Record<string, string | string[]>;
}

export function questionDeclined(card: Record<string, unknown>): boolean {
  return cardAnswer(card)?.declined === true || card.status === 'rejected';
}

export function approvalDecision(card: Record<string, unknown>): 'approved' | 'rejected' | 'allow_session' | undefined {
  const decision = cardAnswer(card)?.decision;
  if (decision === 'approved' || decision === 'rejected' || decision === 'allow_session') return decision;
  if (card.status === 'approved') return 'approved';
  if (card.status === 'rejected') return 'rejected';
  return undefined;
}

export function planDecision(card: Record<string, unknown>): { decision: 'approved' | 'rejected'; feedback?: string } | undefined {
  const answer = cardAnswer(card);
  const decision = answer?.decision;
  const feedback = typeof answer?.feedback === 'string' ? answer.feedback : undefined;
  if (decision === 'approved' || decision === 'rejected') return { decision, feedback };
  if (card.status === 'approved') return { decision: 'approved', feedback };
  if (card.status === 'rejected') return { decision: 'rejected', feedback };
  return undefined;
}
