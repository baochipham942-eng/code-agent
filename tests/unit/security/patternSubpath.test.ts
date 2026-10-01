import picomatch from 'picomatch';
import { describe, expect, it } from 'vitest';
import { patternIntersectsSubpath } from '../../../src/host/security/patternSubpath';

const GLOB = { bash: true, dot: true } as const;

function matchedBy(pattern: string): (candidate: string) => boolean {
  return (candidate) => picomatch.isMatch(candidate, pattern, GLOB);
}

describe('patternIntersectsSubpath', () => {
  it('intersects when a wildcard sits above the authorized directory', () => {
    const pattern = '/work/*/secrets/**';
    const root = '/work/proj';
    expect(patternIntersectsSubpath(pattern, root, matchedBy(pattern))).toBe(true);
  });

  it('intersects when a globstar above the directory covers a descendant', () => {
    const pattern = '/work/**/secrets/**';
    const root = '/work/proj';
    expect(patternIntersectsSubpath(pattern, root, matchedBy(pattern))).toBe(true);
  });

  it('does not intersect a sibling tree', () => {
    const pattern = '/work/other/**';
    const root = '/work/proj';
    expect(patternIntersectsSubpath(pattern, root, matchedBy(pattern))).toBe(false);
  });

  it('does not intersect when the wildcard names a different child', () => {
    const pattern = '/work/other/*/secrets/**';
    const root = '/work/proj';
    expect(patternIntersectsSubpath(pattern, root, matchedBy(pattern))).toBe(false);
  });

  it('still intersects a pattern that is already under the authorized directory', () => {
    const pattern = '/work/proj/secrets/**';
    const root = '/work/proj';
    expect(patternIntersectsSubpath(pattern, root, matchedBy(pattern))).toBe(true);
  });

  it('asks the matcher, so an inside witness the pattern misses is not an intersection', () => {
    expect(patternIntersectsSubpath('/work/*/secrets/**', '/work/proj', () => false)).toBe(false);
  });
});
