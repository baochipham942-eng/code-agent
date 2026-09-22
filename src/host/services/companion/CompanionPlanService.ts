import { createHash } from 'node:crypto';
import type { CompanionCommand, CompanionDecisionOutcome, CompanionPlanAnswer, CompanionSubmitResult } from '../../../shared/contract/companion';
import { COMPANION_LIMITS } from '../../../shared/constants/companion';
import type { CompanionGateway } from './CompanionGateway';
import type { PlanSubmission } from '../../agent/planApproval';

export type CompanionPlanInspection = {
  outcome: CompanionDecisionOutcome;
  answer?: CompanionPlanAnswer;
};

/**
 * 已决 PlanApprovalGate plan → 手机卡片的结算判定。
 * 机器产生的终止（run 取消 / 审批超时 / 重启孤儿 hydrate）不是用户裁决：归
 * cancelled/expired，feedback 一律不透给手机——那些串是宿主内部文案
 * （Orphaned by process restart / Cancelled: … / Auto-rejected after timeout…），
 * 只有 resolutionOrigin 为用户裁决时 feedback 才是真人写的修改意见。
 * pending 返回 null，由调用方走自己的结算来源。
 */
export function inspectionFromGatePlan(plan: PlanSubmission): CompanionPlanInspection | null {
  if (plan.status === 'pending') return null;
  if (plan.status === 'approved') {
    return { outcome: 'answered', answer: { decision: 'approved', ...(plan.feedback ? { feedback: plan.feedback } : {}) } };
  }
  if (plan.resolutionOrigin === 'cancelled' || plan.resolutionOrigin === 'orphaned') return { outcome: 'cancelled' };
  if (plan.resolutionOrigin === 'timeout') return { outcome: 'expired' };
  return { outcome: 'answered', answer: { decision: 'rejected', ...(plan.feedback ? { feedback: plan.feedback } : {}) } };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

export interface CompanionPlanRequest {
  id: string;
  sessionId: string;
  plan: string;
  agentName?: string;
  risk?: { level: string; reasons: string[] };
  /** 启动失败的原因与落定时刻：failed（及其重试 starting 期）才带，变化会改变 operationDigest 触发卡片重发布。 */
  failureReason?: string;
  failedAt?: number;
}

/**
 * Phone plan cards are a projection of PlanApprovalGate pending submissions.
 * Desktop ChatView's swarm TaskPanel reads the same getPendingPlans() list.
 */
export function companionRequestId(sourceId: string): string {
  return sourceId.length <= COMPANION_LIMITS.idLength
    ? sourceId
    : createHash('sha256').update(sourceId).digest('hex');
}

export class CompanionPlanService {
  private readonly publishedEpoch = new Map<string, number>();
  private readonly sourceIds = new Map<string, string>();

  constructor(
    private readonly gateway: CompanionGateway,
    private readonly pending: () => CompanionPlanRequest[],
    private readonly deliver: (planId: string, approved: boolean, feedback: string | undefined, sessionId: string) => Promise<{ success: boolean; data?: { closed?: boolean } }> | { success: boolean; data?: { closed?: boolean } },
    private readonly inspect?: (requestId: string) => CompanionPlanInspection | null,
  ) {}

  /**
   * The card a phone would actually see, or null when it cannot be shown truthfully.
   * Never truncate: a person approving a clipped plan is approving what they did not read.
   */
  private card(request: CompanionPlanRequest): { preview: string; sessionId: string } | null {
    if (!request.sessionId) return null;
    const preview = JSON.stringify({
      plan: request.plan,
      ...(request.agentName ? { agentName: request.agentName } : {}),
      ...(request.risk ? { risk: request.risk } : {}),
      ...(request.failureReason ? { failureReason: request.failureReason } : {}),
    }, null, 2);
    return preview.length > COMPANION_LIMITS.approvalPreviewLength ? null : { preview, sessionId: request.sessionId };
  }

  refresh(): void {
    if (!this.gateway.hasLiveDevices()) return;
    const live = this.pending();
    const displayable = new Set<string>();
    for (const request of live) {
      if (!this.gateway.hasLiveDeviceForSession(request.sessionId)) continue;
      const card = this.card(request);
      if (!card) continue;
      const { preview, sessionId } = card;
      const requestId = companionRequestId(request.id);
      this.sourceIds.set(requestId, request.id);
      displayable.add(requestId);
      const operationDigest = createHash('sha256').update(canonical(request)).digest('hex');
      const old = this.gateway.getDecision(requestId);
      const unchanged = old?.operationDigest === operationDigest;
      if (unchanged && (old.status !== 'pending' || this.publishedEpoch.get(requestId) === this.gateway.epoch)) continue;
      const decision = unchanged
        ? old
        : { requestId, sessionId, revision: (old?.revision ?? 0) + 1,
          operationDigest, status: 'pending' as const, resolvedBy: null, kind: 'plan' as const };
      if (!unchanged) this.gateway.registerDecision(decision);
      this.publishedEpoch.set(requestId, this.gateway.publish(sessionId, 'plan', { ...decision, preview }).epoch);
    }
    for (const decision of this.gateway.pendingDecisions('plan')) {
      if (!displayable.has(decision.requestId)) {
        const inspection = this.inspect?.(this.sourceIds.get(decision.requestId) ?? decision.requestId)
          ?? { outcome: 'cancelled' as const };
        this.finish(decision, inspection);
      }
    }
  }

  settleFromHost(requestId: string, inspection: CompanionPlanInspection): void {
    const current = this.gateway.getDecision(requestId);
    if (current?.status !== 'pending') return;
    this.finish(current, inspection);
  }

  private finish(current: { requestId: string; sessionId: string; revision: number; status: 'pending' | 'approved' | 'rejected' | 'closed'; resolvedBy: string | null; operationDigest: string | null }, inspection: CompanionPlanInspection): void {
    const status = inspection.outcome === 'answered'
      ? (inspection.answer?.decision === 'rejected' ? 'rejected' as const : 'approved' as const)
      : 'closed' as const;
    const resolved = {
      ...current,
      status,
      kind: 'plan' as const,
      outcome: inspection.outcome,
      ...(inspection.answer ? { answer: inspection.answer } : {}),
    };
    this.gateway.registerDecision(resolved);
    this.gateway.publish(current.sessionId, 'plan', { ...resolved });
    this.publishedEpoch.delete(current.requestId);
    this.sourceIds.delete(current.requestId);
  }

  async respond(command: Extract<CompanionCommand, { action: 'plan.respond' }>): Promise<CompanionSubmitResult> {
    this.refresh();
    const current = this.gateway.getDecision(command.payload.requestId);
    if (current?.sessionId !== command.sessionId) return { kind: 'rejected', reason: 'scope_denied' };
    if (current.status !== 'pending' || current.revision !== command.expectedRevision || current.operationDigest !== command.payload.operationDigest) {
      return { kind: 'approval_conflict', current };
    }
    const outcome = await this.deliver(
      this.sourceIds.get(current.requestId) ?? current.requestId,
      command.payload.decision === 'approved',
      command.payload.feedback,
      current.sessionId,
    );
    if (!outcome.success || outcome.data?.closed) {
      this.refresh();
      return { kind: 'approval_conflict', current: this.gateway.getDecision(current.requestId) ?? current };
    }
    const answer: CompanionPlanAnswer = {
      decision: command.payload.decision,
      ...(command.payload.feedback ? { feedback: command.payload.feedback } : {}),
    };
    const resolved = {
      ...current,
      status: command.payload.decision,
      resolvedBy: command.deviceId,
      kind: 'plan' as const,
      outcome: 'answered' as const,
      answer,
    };
    this.gateway.registerDecision(resolved);
    this.gateway.publish(current.sessionId, 'plan', { ...resolved });
    this.publishedEpoch.delete(current.requestId);
    this.sourceIds.delete(current.requestId);
    return { kind: 'accepted', command: { deviceId: command.deviceId, commandId: command.commandId, action: command.action,
      sessionId: command.sessionId, payloadHash: '', state: 'resolved', createdAt: Date.now(), result: { decision: resolved.status, requestId: current.requestId } } };
  }
}
