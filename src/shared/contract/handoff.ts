// ============================================================================
// Handoff Proposal Types
// ============================================================================

export type HandoffProposalStatus = 'pending' | 'accepted' | 'dismissed';

export type HandoffProposalSource = 'assistant_tail';

export interface HandoffProposal {
  id: string;
  sessionId: string;
  sourceMessageId: string;
  source: HandoffProposalSource;
  status: HandoffProposalStatus;
  title: string;
  prompt: string;
  reason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface HandoffProposalDraft {
  title: string;
  prompt: string;
  reason?: string;
}

export interface CreateHandoffProposalInput extends HandoffProposalDraft {
  sessionId: string;
  sourceMessageId: string;
  createdAt?: number;
}

export interface ListHandoffProposalsInput {
  sessionId?: string;
  status?: HandoffProposalStatus | 'all';
  limit?: number;
}

export interface UpdateHandoffProposalStatusInput {
  id: string;
  status: HandoffProposalStatus;
  updatedAt?: number;
}

function sanitizeHandoffIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 160);
}

export function buildHandoffProposalId(sessionId: string, sourceMessageId: string): string {
  return `handoff:${sanitizeHandoffIdPart(sessionId)}:${sanitizeHandoffIdPart(sourceMessageId)}`;
}

export function isHandoffProposalStatus(status: unknown): status is HandoffProposalStatus {
  return status === 'pending' || status === 'accepted' || status === 'dismissed';
}

export function getHandoffProposalStatusLabel(status: HandoffProposalStatus): string {
  switch (status) {
    case 'accepted':
      return '已继续';
    case 'dismissed':
      return '已忽略';
    case 'pending':
    default:
      return '待处理';
  }
}
