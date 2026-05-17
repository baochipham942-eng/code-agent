import { describe, expect, it } from 'vitest';
import {
  normalizeUpdateSha256,
  resolveExpectedUpdateSha256,
  verifyDigestMatch,
} from '../../../../src/main/services/cloud/updateService';

// ============================================================================
// M6.a — sha256 verification logic for cloud update artifacts
//
// The pure function lives at the boundary; the caller (downloadUpdate) wraps
// it with fs.unlinkSync + Error throw on mismatch. We only need to cover the
// comparison itself — no fs/network mocking.
// ============================================================================

describe('verifyDigestMatch', () => {
  it('returns ok=true when digests match exactly', () => {
    const d = 'a'.repeat(64);
    expect(verifyDigestMatch(d, d)).toEqual({ ok: true });
  });

  it('is case-insensitive — uppercase actual matches lowercase expected', () => {
    const lo = 'a'.repeat(64);
    const up = 'A'.repeat(64);
    expect(verifyDigestMatch(up, lo)).toEqual({ ok: true });
    expect(verifyDigestMatch(lo, up)).toEqual({ ok: true });
  });

  it('returns ok=false with both digests in the reason on mismatch', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const verdict = verifyDigestMatch(a, b);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain(a);
      expect(verdict.reason).toContain(b);
    }
  });

  it('treats an empty expected as a mismatch — never silent-pass', () => {
    expect(verifyDigestMatch('a'.repeat(64), '')).toEqual({
      ok: false,
      reason: expect.stringContaining('a'.repeat(64)),
    });
  });

  it('treats a single-char difference as mismatch', () => {
    const a = 'a'.repeat(64);
    const b = 'a'.repeat(63) + 'b';
    expect(verifyDigestMatch(a, b).ok).toBe(false);
  });
});

describe('update sha256 requirement', () => {
  it('normalizes valid sha256 and rejects malformed values', () => {
    expect(normalizeUpdateSha256(` ${'A'.repeat(64)} `)).toBe('a'.repeat(64));
    expect(normalizeUpdateSha256('sha256:' + 'a'.repeat(64))).toBeUndefined();
    expect(normalizeUpdateSha256('a'.repeat(63))).toBeUndefined();
    expect(normalizeUpdateSha256(null)).toBeUndefined();
  });

  it('requires sha256 for direct downloads by default', () => {
    expect(() => resolveExpectedUpdateSha256(undefined, false)).toThrow(/missing a valid sha256/);
    expect(() => resolveExpectedUpdateSha256('not-a-hash', false)).toThrow(/missing a valid sha256/);
  });

  it('allows unsigned direct downloads only with the explicit override', () => {
    expect(resolveExpectedUpdateSha256(undefined, true)).toEqual({
      required: false,
      reason: 'CODE_AGENT_ALLOW_UNSIGNED_UPDATE_DOWNLOAD is enabled.',
    });
  });

  it('returns normalized sha256 when present', () => {
    expect(resolveExpectedUpdateSha256('A'.repeat(64), false)).toEqual({
      required: true,
      sha256: 'a'.repeat(64),
    });
  });
});
