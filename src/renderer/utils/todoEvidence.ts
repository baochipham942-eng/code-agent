export type TodoEvidence = 'probe' | 'claimed' | 'user';

export function todoEvidenceOf(metadata?: Record<string, unknown>): TodoEvidence {
  const raw = metadata?.evidence;
  if (raw === 'probe' || raw === 'user' || raw === 'claimed') return raw;
  const refs = metadata?.evidenceRefs;
  if (Array.isArray(refs) && refs.length > 0) return 'probe';
  return 'claimed';
}

export function todoEvidenceLabel(evidence: TodoEvidence): string {
  if (evidence === 'probe') return '有记录';
  if (evidence === 'user') return '你改过';
  return '模型说的';
}
