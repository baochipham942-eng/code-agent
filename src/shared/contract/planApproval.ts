import type { SessionTask } from './planning';

export const PLAN_APPROVAL_CONFIRMATION_TYPE = 'plan_approval';

export type PlanApprovalStatus = 'pending' | 'approved' | 'cancelled' | 'revision_requested';
export type PlanApprovalDecision = 'approve' | 'cancel' | 'revise';

export interface PlanApprovalStep {
  id: string;
  content: string;
  originalContent: string;
  edited?: boolean;
}

export interface PlanApprovalRecord {
  status: PlanApprovalStatus;
  originalPlan: string;
  steps: PlanApprovalStep[];
  removedSteps?: PlanApprovalStep[];
  reordered?: boolean;
  decidedAt?: number;
  feedback?: string;
}

export interface PlanApprovalRequest {
  sessionId: string;
  messageId: string;
  toolCallId: string;
  decision: PlanApprovalDecision;
  steps?: PlanApprovalStep[];
  feedback?: string;
}

export interface PlanApprovalResponse {
  approval: PlanApprovalRecord;
  tasks?: SessionTask[];
}

function stripStepMarker(line: string): string | null {
  const match = line.match(/^\s*(?:(?:[-*+]\s+(?:\[[ xX-]\]\s*)?)|(?:\d+[.)]\s+))(.+?)\s*$/);
  return match?.[1]?.trim() || null;
}

/** Convert the free-form plan emitted by existing plan tools into stable editable rows. */
export function planApprovalStepsFromText(plan: string): PlanApprovalStep[] {
  const listItems = plan
    .split('\n')
    .map(stripStepMarker)
    .filter((item): item is string => Boolean(item));
  const fallbackParagraphs = plan
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/^#{1,6}\s+/, '').trim())
    .filter(Boolean);
  const contents = listItems.length > 0 ? listItems : fallbackParagraphs;
  return contents.map((content, index) => ({
    id: `step-${index + 1}`,
    content,
    originalContent: content,
  }));
}

export function createPendingPlanApproval(plan: string): PlanApprovalRecord {
  return {
    status: 'pending',
    originalPlan: plan,
    steps: planApprovalStepsFromText(plan),
  };
}

export function formatApprovedPlan(steps: readonly PlanApprovalStep[]): string {
  return steps.map((step, index) => `${index + 1}. ${step.content.trim()}`).join('\n');
}
