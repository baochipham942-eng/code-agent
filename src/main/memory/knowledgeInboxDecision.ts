import type { MemoryRecord } from '../protocol/types/repositories';

export const KNOWLEDGE_INBOX_DECISION_CATEGORY = 'knowledge_inbox_decision';

export type KnowledgeInboxDecisionValue = 'approve' | 'reject';

export interface KnowledgeInboxDecisionRecord {
  candidateId: string;
  decision: KnowledgeInboxDecisionValue;
  contentHash: string;
  title: string;
  kind: string;
  source: string;
  reason: string;
  decidedAt: number;
  memoryId: string | null;
  decisionMemoryId: string;
}

export function normalizeInboxContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

export function hashInboxContent(content: string): string {
  const normalized = normalizeInboxContent(content);
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function parseKnowledgeInboxDecision(memory: MemoryRecord): KnowledgeInboxDecisionRecord | null {
  const metadata = memory.metadata?.knowledgeInbox;
  if (!metadata || typeof metadata !== 'object') return null;
  const record = metadata as Record<string, unknown>;
  const candidateId = typeof record.candidateId === 'string' ? record.candidateId : '';
  const decision = record.decision === 'approve' || record.decision === 'reject' ? record.decision : null;
  const contentHash = typeof record.contentHash === 'string' ? record.contentHash : '';
  if (!candidateId || !decision || !contentHash) return null;
  return {
    candidateId,
    decision,
    contentHash,
    title: typeof record.title === 'string' ? record.title : '',
    kind: typeof record.kind === 'string' ? record.kind : '',
    source: typeof record.source === 'string' ? record.source : '',
    reason: typeof record.reason === 'string' ? record.reason : '',
    decidedAt: typeof record.decidedAt === 'number' ? record.decidedAt : memory.updatedAt,
    memoryId: typeof record.memoryId === 'string' ? record.memoryId : null,
    decisionMemoryId: memory.id,
  };
}

export function shouldSuppressMemoryByInboxDecision(
  memory: MemoryRecord,
  decisions: KnowledgeInboxDecisionRecord[],
): boolean {
  if (decisions.length === 0) return false;

  const ownDecision = parseKnowledgeInboxDecision(memory);
  if (ownDecision?.decision === 'approve' && memory.source === 'user_defined') {
    return false;
  }

  const candidateIds = new Set<string>([
    `flush:${memory.id}`,
    `pattern:${memory.id}`,
  ]);
  const contentHash = hashInboxContent(memory.content);

  return decisions.some((decision) =>
    candidateIds.has(decision.candidateId) || decision.contentHash === contentHash,
  );
}
