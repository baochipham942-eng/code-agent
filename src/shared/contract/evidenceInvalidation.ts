import type { EvidenceKind } from './evidence';

export const EVIDENCE_INVALIDATION_RECORD_TYPE = 'turn_checkout_evidence_invalidation';

export interface EvidenceInvalidationRecord {
  schemaVersion: 1;
  recordType: typeof EVIDENCE_INVALIDATION_RECORD_TYPE;
  sessionId: string;
  createdAt: number;
  changedFilePaths: string[];
  invalidateRunEvidence: true;
}

const RUN_LEVEL_KINDS = new Set<EvidenceKind>([
  'test',
  'typecheck',
  'build',
  'browser_dom',
  'browser_a11y',
  'screenshot',
  'computer_ax',
]);
const PATH_KINDS = new Set<EvidenceKind>(['read', 'file', 'diff', 'patch', 'artifact']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isEvidenceInvalidationRecord(value: unknown): value is EvidenceInvalidationRecord {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.recordType === EVIDENCE_INVALIDATION_RECORD_TYPE
    && typeof value.sessionId === 'string'
    && typeof value.createdAt === 'number'
    && Array.isArray(value.changedFilePaths)
    && value.changedFilePaths.every((item) => typeof item === 'string')
    && value.invalidateRunEvidence === true;
}

function evidenceInvalidationFromTraceEvent(
  value: unknown,
): EvidenceInvalidationRecord | null {
  if (!isRecord(value) || value.type !== 'evidence_invalidation') return null;
  return isEvidenceInvalidationRecord(value.data) ? value.data : null;
}

function pathRefMatches(ref: string, changedFilePaths: readonly string[]): boolean {
  return changedFilePaths.some((changedPath) => (
    ref === changedPath
    || ref.includes(`${changedPath}:`)
    || ref.includes(`${changedPath}#`)
    || ref.includes(`${changedPath}?`)
    || ref.includes(`${changedPath} `)
  ));
}

/** Project an append-only invalidation record over an existing durable record. */
export function applyEvidenceInvalidation(
  value: unknown,
  record: EvidenceInvalidationRecord,
  staleIds?: Set<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => applyEvidenceInvalidation(child, record, staleIds));
  }
  if (!isRecord(value)) return value;

  const freshness = isRecord(value.freshness) ? value.freshness : null;
  const kind = value.kind as EvidenceKind | undefined;
  const evidenceRef = typeof value.id === 'string'
    && typeof kind === 'string'
    && typeof value.ref === 'string'
    && typeof value.source === 'string'
    && freshness
    && typeof freshness.capturedAtMs === 'number'
    && typeof freshness.state === 'string';
  const shouldStale = evidenceRef && (
    RUN_LEVEL_KINDS.has(kind)
    || (PATH_KINDS.has(kind) && pathRefMatches(value.ref as string, record.changedFilePaths))
  );
  if (shouldStale) {
    staleIds?.add(value.id as string);
    return {
      ...value,
      freshness: { ...freshness, state: 'stale' },
    };
  }

  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    applyEvidenceInvalidation(child, record, staleIds),
  ]));
}

export function markDurableRecordInvalidated<T>(
  value: T,
  record: EvidenceInvalidationRecord,
  staleIds?: Set<string>,
): T {
  const projected = applyEvidenceInvalidation(value, record, staleIds);
  if (!isRecord(projected)) return projected as T;
  return {
    ...projected,
    evidenceInvalidatedAt: record.createdAt,
  } as T;
}

/** Apply invalidation markers in append order; evidence created after a marker stays fresh. */
export function projectEvidenceInvalidationSequence<T>(
  values: readonly T[],
  retainMarkers = false,
): T[] {
  const projected: T[] = [];
  for (const value of values) {
    const invalidation = isEvidenceInvalidationRecord(value)
      ? value
      : evidenceInvalidationFromTraceEvent(value);
    if (!invalidation) {
      projected.push(value);
      continue;
    }
    for (let index = 0; index < projected.length; index += 1) {
      const existing = projected[index];
      if (isRecord(existing) && existing.sessionId === invalidation.sessionId) {
        projected[index] = markDurableRecordInvalidated(existing, invalidation) as T;
      }
    }
    if (retainMarkers) projected.push(value);
  }
  return projected;
}
