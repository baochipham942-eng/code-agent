// ============================================================================
// Unified Evidence / Provenance Contract (ADR-029)
// ============================================================================

export type EvidenceKind =
  | 'read'
  | 'file'
  | 'diff'
  | 'patch'
  | 'tool'
  | 'test'
  | 'typecheck'
  | 'build'
  | 'ci'
  | 'browser_dom'
  | 'browser_a11y'
  | 'screenshot'
  | 'computer_ax'
  | 'artifact'
  | 'trace';

export type EvidenceState =
  | 'fresh'
  | 'candidate'
  | 'read'
  | 'stale'
  | 'needs_re_read'
  | 'not_run';

export type RedactionStatus = 'clean' | 'redacted' | 'contains_secret_blocked';

export interface EvidenceRef {
  id: string;
  kind: EvidenceKind;
  ref: string;
  source: string;
  freshness: {
    capturedAtMs: number;
    digest?: string;
    state: EvidenceState;
  };
  redactionStatus: RedactionStatus;
}

export type VerificationStatus = 'passed' | 'failed' | 'not_run' | 'skipped';

export interface MakeEvidenceRefInput {
  id?: string;
  kind: EvidenceKind;
  ref: string;
  source: string;
  capturedAtMs?: number;
  digest?: string;
  state?: EvidenceState;
  redactionStatus?: RedactionStatus;
}

export interface ConclusionEligibilityOptions {
  verificationStatus?: VerificationStatus;
  verificationPassed?: boolean;
}

export interface StalenessCheck {
  digest?: string;
  nowMs?: number;
  maxAgeMs?: number;
}

function stableEvidenceId(input: MakeEvidenceRefInput): string {
  const parts = [
    input.kind,
    input.source,
    input.ref,
    input.digest ?? '',
    input.state ?? 'fresh',
  ];
  let hash = 0x811c9dc5;
  for (const char of parts.join('\u0000')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `evidence_${hash.toString(16).padStart(8, '0')}`;
}

export function makeEvidenceRef(input: MakeEvidenceRefInput): EvidenceRef {
  return {
    id: input.id ?? stableEvidenceId(input),
    kind: input.kind,
    ref: input.ref,
    source: input.source,
    freshness: {
      capturedAtMs: input.capturedAtMs ?? Date.now(),
      ...(input.digest ? { digest: input.digest } : {}),
      state: input.state ?? 'fresh',
    },
    redactionStatus: input.redactionStatus ?? 'clean',
  };
}

export function isConclusionEligible(
  evidence: EvidenceRef,
  options: ConclusionEligibilityOptions = {},
): boolean {
  return evidence.freshness.state === 'read'
    || options.verificationStatus === 'passed'
    || options.verificationPassed === true;
}

export function isExportSafe(evidence: EvidenceRef): boolean {
  return evidence.redactionStatus !== 'contains_secret_blocked';
}

export function isStale(evidence: EvidenceRef, check: StalenessCheck = {}): boolean {
  if (evidence.freshness.state === 'stale') {
    return true;
  }
  if (
    evidence.freshness.digest
    && check.digest
    && evidence.freshness.digest !== check.digest
  ) {
    return true;
  }
  if (typeof check.maxAgeMs === 'number' && typeof check.nowMs === 'number') {
    return check.nowMs - evidence.freshness.capturedAtMs > check.maxAgeMs;
  }
  return false;
}
