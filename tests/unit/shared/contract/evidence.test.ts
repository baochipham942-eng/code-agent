import { describe, expect, it } from 'vitest';

import {
  isConclusionEligible,
  isExportSafe,
  isStale,
  makeEvidenceRef,
} from '../../../../src/shared/contract/evidence';

describe('EvidenceRef contract', () => {
  it('builds a stable ADR-029 evidence reference', () => {
    const evidence = makeEvidenceRef({
      kind: 'read',
      ref: 'src/host/example.ts#L1-L5',
      source: 'Read',
      capturedAtMs: 1782450000000,
      digest: 'abc123',
      state: 'read',
      redactionStatus: 'clean',
    });

    expect(evidence).toEqual({
      id: 'evidence_b2afa713',
      kind: 'read',
      ref: 'src/host/example.ts#L1-L5',
      source: 'Read',
      freshness: {
        capturedAtMs: 1782450000000,
        digest: 'abc123',
        state: 'read',
      },
      redactionStatus: 'clean',
    });
  });

  it('blocks candidate evidence from conclusions unless verification passed', () => {
    const candidate = makeEvidenceRef({
      kind: 'file',
      ref: 'src/host/example.ts',
      source: 'code_search',
      capturedAtMs: 1782450000000,
      state: 'candidate',
    });

    expect(isConclusionEligible(candidate)).toBe(false);
    expect(isConclusionEligible(candidate, { verificationStatus: 'failed' })).toBe(false);
    expect(isConclusionEligible(candidate, { verificationStatus: 'passed' })).toBe(true);
    expect(isConclusionEligible({ ...candidate, freshness: { ...candidate.freshness, state: 'read' } })).toBe(true);
  });

  it('blocks secret-bearing evidence from export', () => {
    const blocked = makeEvidenceRef({
      kind: 'trace',
      ref: 'trace:secret',
      source: 'ComputerSurface',
      capturedAtMs: 1782450000000,
      redactionStatus: 'contains_secret_blocked',
    });

    expect(isExportSafe(blocked)).toBe(false);
    expect(isExportSafe({ ...blocked, redactionStatus: 'redacted' })).toBe(true);
  });

  it('marks stale evidence by state, digest mismatch, or age', () => {
    const evidence = makeEvidenceRef({
      kind: 'read',
      ref: 'src/host/example.ts#L1-L5',
      source: 'Read',
      capturedAtMs: 1_000,
      digest: 'old',
      state: 'read',
    });

    expect(isStale(evidence, { digest: 'old', nowMs: 1_500, maxAgeMs: 1_000 })).toBe(false);
    expect(isStale(evidence, { digest: 'new' })).toBe(true);
    expect(isStale(evidence, { nowMs: 3_000, maxAgeMs: 1_000 })).toBe(true);
    expect(isStale({ ...evidence, freshness: { ...evidence.freshness, state: 'stale' } })).toBe(true);
  });
});
