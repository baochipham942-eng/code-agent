import { createHash } from 'node:crypto';
import type { UserQuestionRequest, UserQuestionResponse } from '../../../shared/contract';
import type { CompanionCommand, CompanionSubmitResult } from '../../../shared/contract/companion';
import { COMPANION_LIMITS } from '../../../shared/constants/companion';
import type { UserQuestionRoute } from '../capabilities/hostCapabilityPorts';
import type { CompanionGateway } from './CompanionGateway';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

interface OfferedQuestion {
  request: UserQuestionRequest;
  sessionId: string;
  respond: (response: UserQuestionResponse) => void;
}

/** Phone question cards are a projection of promptUserInChat's pending map. */
export class CompanionQuestionService implements UserQuestionRoute {
  private readonly publishedEpoch = new Map<string, number>();
  private readonly offered = new Map<string, OfferedQuestion>();

  constructor(private readonly gateway: CompanionGateway) {}

  canOffer(sessionId: string | undefined): boolean {
    return Boolean(sessionId && this.gateway.hasLiveDevices());
  }

  offer(request: UserQuestionRequest, respond: (response: UserQuestionResponse) => void): boolean {
    if (!request.sessionId || !this.gateway.hasLiveDevices()) return false;
    if (!this.card(request)) return false;
    this.offered.set(request.id, { request, sessionId: request.sessionId, respond });
    this.refresh();
    return this.gateway.getDecision(request.id)?.status === 'pending';
  }

  cancel(requestId: string): void {
    if (!this.offered.has(requestId)) return;
    this.offered.delete(requestId);
    this.refresh();
  }

  /**
   * The card a phone would actually see, or null when it cannot be shown truthfully.
   * Never truncate: a person answering a clipped question is answering what they did not read.
   */
  private card(request: UserQuestionRequest): { preview: string; sessionId: string } | null {
    if (!request.sessionId) return null;
    const preview = JSON.stringify({ questions: request.questions }, null, 2);
    return preview.length > COMPANION_LIMITS.approvalPreviewLength ? null : { preview, sessionId: request.sessionId };
  }

  refresh(): void {
    if (!this.gateway.hasLiveDevices() && this.offered.size === 0 && this.publishedEpoch.size === 0) return;
    const displayable = new Set<string>();
    for (const { request } of this.offered.values()) {
      const card = this.card(request);
      if (!card) continue;
      const { preview, sessionId } = card;
      displayable.add(request.id);
      const operationDigest = createHash('sha256').update(canonical(request)).digest('hex');
      const old = this.gateway.getDecision(request.id);
      const unchanged = old?.operationDigest === operationDigest;
      if (unchanged && (old.status !== 'pending' || this.publishedEpoch.get(request.id) === this.gateway.epoch)) continue;
      const decision = unchanged
        ? old
        : { requestId: request.id, sessionId, revision: (old?.revision ?? 0) + 1,
          operationDigest, status: 'pending' as const, resolvedBy: null, kind: 'question' as const };
      if (!unchanged) this.gateway.registerDecision(decision);
      this.publishedEpoch.set(request.id, this.gateway.publish(sessionId, 'question', { ...decision, preview }).epoch);
    }
    for (const decision of this.gateway.pendingDecisions('question')) {
      if (!displayable.has(decision.requestId)) {
        const closed = { ...decision, status: 'closed' as const, kind: 'question' as const };
        this.gateway.registerDecision(closed);
        this.gateway.publish(decision.sessionId, 'question', { ...closed });
        this.publishedEpoch.delete(decision.requestId);
      }
    }
  }

  respond(command: Extract<CompanionCommand, { action: 'question.respond' }>): CompanionSubmitResult {
    this.refresh();
    const current = this.gateway.getDecision(command.payload.requestId);
    if (current?.sessionId !== command.sessionId) return { kind: 'rejected', reason: 'scope_denied' };
    if (current.status !== 'pending' || current.revision !== command.expectedRevision || current.operationDigest !== command.payload.operationDigest) {
      return { kind: 'approval_conflict', current };
    }
    const offered = this.offered.get(current.requestId);
    if (!offered) {
      this.refresh();
      return { kind: 'approval_conflict', current: this.gateway.getDecision(current.requestId) ?? current };
    }
    this.offered.delete(current.requestId);
    const resolved = {
      ...current,
      status: command.payload.declined === true ? 'rejected' as const : 'approved' as const,
      resolvedBy: command.deviceId,
      kind: 'question' as const,
    };
    this.gateway.registerDecision(resolved);
    this.gateway.publish(current.sessionId, 'question', { ...resolved });
    this.publishedEpoch.delete(current.requestId);
    const response: UserQuestionResponse = command.payload.declined === true
      ? { requestId: current.requestId, declined: true, ...(command.payload.reason ? { reason: command.payload.reason } : {}) }
      : { requestId: current.requestId, answers: command.payload.answers ?? {} };
    offered.respond(response);
    return { kind: 'accepted', command: { deviceId: command.deviceId, commandId: command.commandId, action: command.action,
      sessionId: command.sessionId, payloadHash: '', state: 'resolved', createdAt: Date.now(), result: { decision: resolved.status, requestId: current.requestId } } };
  }
}
