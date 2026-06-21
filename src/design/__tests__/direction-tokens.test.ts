import { describe, expect, it } from 'vitest';
import {
  DESIGN_BRIEF_DIRECTION_LABELS,
  type DesignBriefDirection,
} from '../../shared/contract/designBrief';
import { directionTokens } from '../direction-tokens';

const directions = Object.keys(DESIGN_BRIEF_DIRECTION_LABELS) as DesignBriefDirection[];
const paletteKeys = ['primary', 'surface', 'accent', 'muted', 'contrast'] as const;

describe('directionTokens', () => {
  it('defines a complete token package for each direction', () => {
    expect(Object.keys(directionTokens).sort()).toEqual([...directions].sort());

    for (const direction of directions) {
      const token = directionTokens[direction];
      expect(token).toBeTruthy();
      expect(Object.keys(token.palette).sort()).toEqual([...paletteKeys].sort());
      for (const key of paletteKeys) {
        expect(token.palette[key]).toMatch(/^oklch\(.+\)$/);
      }
      expect(token.fonts.serif).toContain('serif');
      expect(token.fonts.sans).toContain('sans-serif');
      expect(token.posture.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(token.refs)).toBe(true);
      expect(token.refs.length).toBeGreaterThan(0);
      for (const ref of token.refs) {
        expect(ref.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

