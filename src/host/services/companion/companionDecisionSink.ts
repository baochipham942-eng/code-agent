import type { PermissionResponse } from '../../../shared/contract/permission';
import type { CompanionApprovalAnswer, CompanionDecisionOutcome } from '../../../shared/contract/companion';

export type CompanionApprovalHostSettlement = {
  requestId: string;
  outcome: CompanionDecisionOutcome;
  answer?: CompanionApprovalAnswer;
};

type Listener = (event: CompanionApprovalHostSettlement) => void;
let listener: Listener | null = null;

export function bindCompanionApprovalListener(next: Listener | null): void {
  listener = next;
}

export function noteCompanionApprovalSettlement(event: CompanionApprovalHostSettlement): void {
  try { listener?.(event); } catch { /* A card projection must not fail the permission island. */ }
}

export function approvalAnswerFromPermission(response: PermissionResponse): CompanionApprovalAnswer {
  if (response === 'allow_session') return { decision: 'allow_session' };
  if (response === 'allow' || response === 'allow_standing') return { decision: 'approved' };
  return { decision: 'rejected' };
}
