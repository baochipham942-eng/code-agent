export type CardOutcome = 'answered' | 'expired' | 'cancelled';

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
