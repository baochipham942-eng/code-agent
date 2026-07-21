import crypto from 'node:crypto';
import type { SurfaceRuntimeIdentityV1 } from './SurfaceExecutionRuntime';

const DEFAULT_CONTINUATION_TTL_MS = 10 * 60_000;

export interface SurfaceContinuationIntentV1 {
  requestId: string;
  conversationId: string;
  parentSessionId: string;
  agentId: string;
  requestedAt: number;
  expiresAt: number;
}

interface SurfaceContinuationServiceOptions {
  now?: () => number;
  createId?: () => string;
  ttlMs?: number;
}

function ownerKey(conversationId: string, agentId: string): string {
  return JSON.stringify([conversationId, agentId]);
}

export class SurfaceContinuationService {
  private readonly pending = new Map<string, SurfaceContinuationIntentV1>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly ttlMs: number;

  constructor(options: SurfaceContinuationServiceOptions = {}) {
    this.now = options.now || Date.now;
    this.createId = options.createId || (() => `surface_continuation_${crypto.randomUUID()}`);
    this.ttlMs = options.ttlMs || DEFAULT_CONTINUATION_TTL_MS;
  }

  prepare(input: {
    conversationId: string;
    parentSessionId: string;
    agentId: string;
  }): SurfaceContinuationIntentV1 {
    const conversationId = input.conversationId.trim();
    const parentSessionId = input.parentSessionId.trim();
    const agentId = input.agentId.trim();
    if (!conversationId || !parentSessionId || !agentId) {
      throw new Error('Surface continuation requires conversation, parent session, and agent identity.');
    }
    this.prune();
    const requestedAt = this.now();
    const intent: SurfaceContinuationIntentV1 = {
      requestId: this.createId(),
      conversationId,
      parentSessionId,
      agentId,
      requestedAt,
      expiresAt: requestedAt + this.ttlMs,
    };
    this.pending.set(ownerKey(conversationId, agentId), intent);
    return structuredClone(intent);
  }

  peek(conversationId: string, agentId: string): SurfaceContinuationIntentV1 | null {
    this.prune();
    const intent = this.pending.get(ownerKey(conversationId, agentId));
    return intent ? structuredClone(intent) : null;
  }

  consume(identity: SurfaceRuntimeIdentityV1): SurfaceContinuationIntentV1 | null {
    this.prune();
    const key = ownerKey(identity.conversationId, identity.agentId);
    const intent = this.pending.get(key);
    if (!intent) return null;
    this.pending.delete(key);
    return structuredClone(intent);
  }

  clear(): void {
    this.pending.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, intent] of this.pending) {
      if (intent.expiresAt <= now) this.pending.delete(key);
    }
  }
}

let surfaceContinuationService: SurfaceContinuationService | null = null;

export function getSurfaceContinuationService(): SurfaceContinuationService {
  surfaceContinuationService ??= new SurfaceContinuationService();
  return surfaceContinuationService;
}

export function resetSurfaceContinuationServiceForTests(): void {
  surfaceContinuationService?.clear();
  surfaceContinuationService = null;
}
