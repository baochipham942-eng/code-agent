import { describe, expect, it } from 'vitest';
import { verifyDigestMatch } from '../../../../src/main/services/cloud/updateService';

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
