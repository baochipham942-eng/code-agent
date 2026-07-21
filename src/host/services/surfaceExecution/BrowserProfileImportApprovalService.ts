import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export interface BrowserProfileImportApprovalSubjectV1 {
  conversationId: string;
  runId: string;
  agentId: string;
}

export interface BrowserProfileImportApprovalScopeV1 {
  source: string;
  profileId: string;
  domainAllowlist?: string[];
}

interface SignedApprovalPayloadV1 {
  version: 1;
  nonce: string;
  subject: BrowserProfileImportApprovalSubjectV1;
  scopeHash: string;
  issuedAt: number;
  expiresAt: number;
}

interface ApprovalRecord {
  expiresAt: number;
  consumed: boolean;
}

function normalizedScope(scope: BrowserProfileImportApprovalScopeV1): Record<string, unknown> {
  return {
    source: scope.source.trim().toLowerCase(),
    profileId: scope.profileId.trim(),
    domainAllowlist: Array.from(new Set((scope.domainAllowlist || [])
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean))).sort(),
  };
}

function scopeHash(scope: BrowserProfileImportApprovalScopeV1): string {
  return createHash('sha256').update(JSON.stringify(normalizedScope(scope))).digest('hex');
}

export class BrowserProfileImportApprovalService {
  private readonly secret = randomBytes(32);
  private readonly approvals = new Map<string, ApprovalRecord>();

  issue(input: {
    subject: BrowserProfileImportApprovalSubjectV1;
    scope: BrowserProfileImportApprovalScopeV1;
    ttlMs?: number;
    now?: number;
  }): { token: string; scopeHash: string; expiresAt: number } {
    const now = input.now ?? Date.now();
    const ttlMs = Math.min(Math.max(Math.floor(input.ttlMs || 60_000), 1_000), 5 * 60_000);
    const payload: SignedApprovalPayloadV1 = {
      version: 1,
      nonce: randomUUID(),
      subject: { ...input.subject },
      scopeHash: scopeHash(input.scope),
      issuedAt: now,
      expiresAt: now + ttlMs,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = this.sign(encoded);
    this.approvals.set(payload.nonce, { expiresAt: payload.expiresAt, consumed: false });
    return { token: `v1.${encoded}.${signature}`, scopeHash: payload.scopeHash, expiresAt: payload.expiresAt };
  }

  consume(input: {
    token: string;
    subject: BrowserProfileImportApprovalSubjectV1;
    scope: BrowserProfileImportApprovalScopeV1;
    now?: number;
  }): boolean {
    const [version, encoded, signature] = input.token.split('.');
    if (version !== 'v1' || !encoded || !signature || !this.validSignature(encoded, signature)) return false;
    let payload: SignedApprovalPayloadV1;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedApprovalPayloadV1;
    } catch {
      return false;
    }
    const record = this.approvals.get(payload.nonce);
    const now = input.now ?? Date.now();
    if (payload.version !== 1 || !record || record.consumed
      || record.expiresAt !== payload.expiresAt || payload.expiresAt <= now
      || payload.scopeHash !== scopeHash(input.scope)
      || payload.subject.conversationId !== input.subject.conversationId
      || payload.subject.runId !== input.subject.runId
      || payload.subject.agentId !== input.subject.agentId) return false;
    record.consumed = true;
    return true;
  }

  private sign(encoded: string): string {
    return createHmac('sha256', this.secret).update(encoded).digest('base64url');
  }

  private validSignature(encoded: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(encoded));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

let browserProfileImportApprovalService: BrowserProfileImportApprovalService | null = null;

export function getBrowserProfileImportApprovalService(): BrowserProfileImportApprovalService {
  browserProfileImportApprovalService ??= new BrowserProfileImportApprovalService();
  return browserProfileImportApprovalService;
}

export function resetBrowserProfileImportApprovalServiceForTests(): void {
  browserProfileImportApprovalService = null;
}
