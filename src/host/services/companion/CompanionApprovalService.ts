import { createHash } from 'node:crypto';
import type { PermissionRequest, PermissionResponse } from '../../../shared/contract/permission';
import type { CompanionCommand, CompanionSubmitResult } from '../../../shared/contract/companion';
import { COMPANION_LIMITS } from '../../../shared/constants/companion';
import type { CompanionGateway } from './CompanionGateway';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

/** Mobile cards are a projection. The desktop's pending resolver remains the authority. */
export class CompanionApprovalService {
  /**
   * Epoch of the last publish per request.
   * ponytail: in-memory, so a host restart republishes every live card once — harmless,
   * and cheaper than a JSON query over companion_events. Move it into the events table
   * if cards ever need to survive a restart without that extra publish.
   */
  private readonly publishedEpoch = new Map<string, number>();

  constructor(private readonly gateway: CompanionGateway,
    private readonly pending: () => PermissionRequest[],
    private readonly deliver: (requestId: string, response: PermissionResponse, sessionId: string) => { success: boolean; data?: { closed?: boolean } }) {}

  /**
   * The card a phone would actually see, or null when it cannot be shown truthfully.
   * Never truncate: a person approving a clipped diff is approving what they did not read.
   */
  private card(request: PermissionRequest): { preview: string; sessionId: string } | null {
    if (!request.sessionId || request.resolved) return null;
    const preview = JSON.stringify({ type: request.type, tool: request.tool, details: request.details, boundary: request.boundary }, null, 2);
    return preview.length > COMPANION_LIMITS.approvalPreviewLength ? null : { preview, sessionId: request.sessionId };
  }

  /**
   * Whether this specific request would reach a phone as an actionable card.
   * The permission island asks before it decides to drop its fail-closed timeout, so
   * answering "a phone is online" instead of "this card gets delivered" is what turned
   * an oversized preview into a run parked forever with nothing on screen.
   */
  canDisplay(request: PermissionRequest): boolean {
    return this.card(request) !== null;
  }

  refresh(): void {
    const live = this.pending();
    const displayable = new Set<string>();
    for (const request of live) {
      const card = this.card(request);
      if (!card) continue;
      const { preview, sessionId } = card;
      displayable.add(request.id);
      const operationDigest = createHash('sha256').update(canonical(request)).digest('hex');
      const old = this.gateway.getDecision(request.id);
      const unchanged = old?.operationDigest === operationDigest;
      // An unchanged card still has to be republished after an epoch bump (a revoke does
      // that): every other phone re-snapshots and drops its events, so a card that is
      // never re-emitted into the new epoch simply disappears while the run keeps waiting.
      if (unchanged && (old.status !== 'pending' || this.publishedEpoch.get(request.id) === this.gateway.epoch)) continue;
      // Republishing is not a new decision: reusing the row keeps the revision the phone
      // already holds valid, so an in-flight approval.respond is not invalidated.
      const decision = unchanged
        ? old
        : { requestId: request.id, sessionId, revision: (old?.revision ?? 0) + 1,
          operationDigest, status: 'pending' as const, resolvedBy: null };
      if (!unchanged) this.gateway.registerDecision(decision);
      this.publishedEpoch.set(request.id, this.gateway.publish(sessionId, 'approval', { ...decision, preview }).epoch);
    }
    for (const decision of this.gateway.pendingDecisions()) {
      if (!displayable.has(decision.requestId)) {
        const closed = { ...decision, status: 'closed' as const };
        this.gateway.registerDecision(closed);
        this.gateway.publish(decision.sessionId, 'approval', { ...closed });
        this.publishedEpoch.delete(decision.requestId);
      }
    }
  }

  respond(command: Extract<CompanionCommand, { action: 'approval.respond' }>): CompanionSubmitResult {
    this.refresh();
    const current = this.gateway.getDecision(command.payload.requestId);
    if (current?.sessionId !== command.sessionId) return { kind: 'rejected', reason: 'scope_denied' };
    if (current.status !== 'pending' || current.revision !== command.expectedRevision || current.operationDigest !== command.payload.operationDigest) {
      return { kind: 'approval_conflict', current };
    }
    const outcome = this.deliver(current.requestId, command.payload.decision === 'approved' ? 'allow' : 'deny', current.sessionId);
    if (!outcome.success || outcome.data?.closed) {
      this.refresh();
      return { kind: 'approval_conflict', current: this.gateway.getDecision(current.requestId) ?? current };
    }
    const resolved = { ...current, status: command.payload.decision, resolvedBy: command.deviceId };
    this.gateway.registerDecision(resolved);
    this.gateway.publish(current.sessionId, 'approval', { ...resolved });
    return { kind: 'accepted', command: { deviceId: command.deviceId, commandId: command.commandId, action: command.action,
      sessionId: command.sessionId, payloadHash: '', state: 'resolved', createdAt: Date.now(), result: { decision: resolved.status, requestId: current.requestId } } };
  }
}
