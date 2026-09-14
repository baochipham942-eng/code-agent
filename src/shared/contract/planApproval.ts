import type { SessionTask } from './planning';

export const PLAN_APPROVAL_CONFIRMATION_TYPE = 'plan_approval';

type PlanApprovalStatus =
  | 'pending'
  | 'starting' // 已认领（决定已落库、启动轮次已派发），启动确认前不可再次决定
  | 'approved'
  | 'failed' // 启动轮次失败：卡片须带原因重现，pending/failed 都允许再次决定
  | 'cancelled'
  | 'revision_requested';
type PlanApprovalDecision = 'approve' | 'cancel' | 'revise';

/** A card in these states accepts a new decision (first attempt or retry after failure). */
export function isRetryablePlanApprovalStatus(status: PlanApprovalRecord['status']): boolean {
  return status === 'pending' || status === 'failed';
}

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
  /** 启动轮次失败的原因，仅 status === 'failed' 时出现。重试认领（starting）不清除。 */
  failureReason?: string;
  /** 最近一次启动失败的落定时刻。重试再败必换新值，是卡片投影 digest 的稳定判据。 */
  failedAt?: number;
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
function planApprovalStepsFromText(plan: string): PlanApprovalStep[] {
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
