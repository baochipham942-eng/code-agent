import { createHash } from 'node:crypto';
import type { CompanionCommand, CompanionSubmitResult } from '../../../shared/contract/companion';
import { COMPANION_LIMITS } from '../../../shared/constants/companion';
import type { CompanionGateway } from './CompanionGateway';

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
}

/**
 * Phone plan cards are a projection of PlanApprovalGate pending submissions.
 * Desktop ChatView's swarm TaskPanel reads the same getPendingPlans() list.
 */
function companionRequestId(sourceId: string): string {
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
    private readonly deliver: (planId: string, approved: boolean, feedback: string | undefined, sessionId: string) => { success: boolean; data?: { closed?: boolean } },
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
        const closed = { ...decision, status: 'closed' as const, kind: 'plan' as const };
        this.gateway.registerDecision(closed);
        this.gateway.publish(decision.sessionId, 'plan', { ...closed });
        this.publishedEpoch.delete(decision.requestId);
        this.sourceIds.delete(decision.requestId);
      }
    }
  }

  respond(command: Extract<CompanionCommand, { action: 'plan.respond' }>): CompanionSubmitResult {
    this.refresh();
    const current = this.gateway.getDecision(command.payload.requestId);
    if (current?.sessionId !== command.sessionId) return { kind: 'rejected', reason: 'scope_denied' };
    if (current.status !== 'pending' || current.revision !== command.expectedRevision || current.operationDigest !== command.payload.operationDigest) {
      return { kind: 'approval_conflict', current };
    }
    const outcome = this.deliver(
      this.sourceIds.get(current.requestId) ?? current.requestId,
      command.payload.decision === 'approved',
      command.payload.feedback,
      current.sessionId,
    );
    if (!outcome.success || outcome.data?.closed) {
      this.refresh();
      return { kind: 'approval_conflict', current: this.gateway.getDecision(current.requestId) ?? current };
    }
    const resolved = { ...current, status: command.payload.decision, resolvedBy: command.deviceId, kind: 'plan' as const };
    this.gateway.registerDecision(resolved);
    this.gateway.publish(current.sessionId, 'plan', { ...resolved });
    this.publishedEpoch.delete(current.requestId);
    this.sourceIds.delete(current.requestId);
    return { kind: 'accepted', command: { deviceId: command.deviceId, commandId: command.commandId, action: command.action,
      sessionId: command.sessionId, payloadHash: '', state: 'resolved', createdAt: Date.now(), result: { decision: resolved.status, requestId: current.requestId } } };
  }
}
