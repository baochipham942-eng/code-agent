import { createHash } from 'node:crypto';
import type { PermissionRequest, PermissionResponse } from '../../shared/contract/permission';
import type { CompanionCommand, CompanionSubmitResult } from '../../shared/contract/companion';
import { COMPANION_LIMITS } from '../../shared/constants/companion';
import type { CompanionGateway } from './CompanionGateway';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

/** Mobile cards are a projection. The desktop's pending resolver remains the authority. */
export class CompanionApprovalService {
  constructor(private readonly gateway: CompanionGateway,
    private readonly pending: () => PermissionRequest[],
    private readonly deliver: (requestId: string, response: PermissionResponse, sessionId: string) => { success: boolean; data?: { closed?: boolean } }) {}

  refresh(): void {
    const live = this.pending();
    const displayable = new Set<string>();
    for (const request of live) {
      if (!request.sessionId || request.resolved) continue;
      const preview = JSON.stringify({ type: request.type, tool: request.tool, details: request.details, boundary: request.boundary }, null, 2);
      // Never let an incomplete or truncated preview authorize an operation.
      if (preview.length > COMPANION_LIMITS.approvalPreviewLength) continue;
      displayable.add(request.id);
      const operationDigest = createHash('sha256').update(canonical(request)).digest('hex');
      const old = this.gateway.getDecision(request.id);
      if (old?.operationDigest === operationDigest) continue;
      const decision = { requestId: request.id, sessionId: request.sessionId, revision: (old?.revision ?? 0) + 1,
        operationDigest, status: 'pending' as const, resolvedBy: null };
      this.gateway.registerDecision(decision);
      this.gateway.publish(request.sessionId, 'approval', { ...decision, preview });
    }
    for (const decision of this.gateway.pendingDecisions()) {
      if (!displayable.has(decision.requestId)) {
        const closed = { ...decision, status: 'closed' as const };
        this.gateway.registerDecision(closed);
        this.gateway.publish(decision.sessionId, 'approval', { ...closed });
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
