import { describe, expect, it } from 'vitest';
import {
  formatDesignBriefLabel,
  normalizeDesignBrief,
} from '../../../src/shared/contract/designBrief';

describe('normalizeDesignBrief', () => {
  it('returns undefined for empty input', () => {
    expect(normalizeDesignBrief()).toBeUndefined();
    expect(normalizeDesignBrief(null)).toBeUndefined();
    expect(normalizeDesignBrief({})).toBeUndefined();
  });

  it('trims strings and drops blank-only fields', () => {
    expect(normalizeDesignBrief({ intent: '  做一个落地页  ', audience: '   ' })).toEqual({
      intent: '做一个落地页',
    });
  });

  it('keeps valid surface and direction, drops bogus values', () => {
    expect(
      normalizeDesignBrief({
        surface: 'landing_page',
        direction: 'editorial',
      }),
    ).toEqual({
      surface: 'landing_page',
      direction: 'editorial',
    });

    expect(
      normalizeDesignBrief({
        // @ts-expect-error — forced bogus value
        surface: 'rocket_ship',
        // @ts-expect-error — forced bogus value
        direction: 'maximalist',
      }),
    ).toBeUndefined();
  });

  it('dedupes and trims constraints / references', () => {
    expect(
      normalizeDesignBrief({
        constraints: ['  WCAG AA ', 'WCAG AA', '', '   '],
        references: ['linear.app', '  linear.app  ', 'vercel.com'],
      }),
    ).toEqual({
      constraints: ['WCAG AA'],
      references: ['linear.app', 'vercel.com'],
    });
  });

  it('only keeps source when manual or inferred', () => {
    expect(normalizeDesignBrief({ intent: 'x', source: 'manual' })?.source).toBe('manual');
    expect(normalizeDesignBrief({ intent: 'x', source: 'inferred' })?.source).toBe('inferred');
    // @ts-expect-error — forced bogus source
    expect(normalizeDesignBrief({ intent: 'x', source: 'auto' })?.source).toBeUndefined();
  });
});

describe('formatDesignBriefLabel', () => {
  it('joins surface · direction · intent in that order', () => {
    expect(
      formatDesignBriefLabel({
        surface: 'landing_page',
        direction: 'editorial',
        intent: '个人作品集',
      }),
    ).toBe('Landing page · Editorial · 个人作品集');
  });

  it('skips missing parts', () => {
    expect(formatDesignBriefLabel({ surface: 'dashboard' })).toBe('Dashboard');
    expect(formatDesignBriefLabel({ intent: '只剩 intent' })).toBe('只剩 intent');
    expect(formatDesignBriefLabel({ direction: 'calm', intent: 'x' })).toBe('Calm · x');
  });

  it('falls back to a generic label when the brief is empty', () => {
    expect(formatDesignBriefLabel({})).toBe('Design brief');
  });
});
