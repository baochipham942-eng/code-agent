import { describe, expect, it } from 'vitest';
import { buildSelfCritiquePromptSection, SELF_CRITIQUE_CONFIG } from '../../../../src/host/prompts/selfCritique';
import { directionTokens } from '../../../../src/design/direction-tokens';
import { CRITIQUE_DIMENSIONS } from '../../../../src/design/critique/types';
import type { DesignBrief } from '../../../../src/shared/contract/designBrief';

describe('buildSelfCritiquePromptSection', () => {
  it('returns null when brief is absent', () => {
    expect(buildSelfCritiquePromptSection(undefined)).toBeNull();
    expect(buildSelfCritiquePromptSection(null)).toBeNull();
  });

  it('emits all 5 dimensions in the section', () => {
    const brief: DesignBrief = {
      direction: 'editorial',
      directionTokens: directionTokens.editorial,
      surface: 'landing_page',
    };
    const section = buildSelfCritiquePromptSection(brief);
    expect(section).not.toBeNull();
    for (const dim of CRITIQUE_DIMENSIONS) {
      expect(section).toContain(dim);
    }
  });

  it('injects directionTokens posture and palette anchors when present', () => {
    const brief: DesignBrief = {
      direction: 'editorial',
      directionTokens: directionTokens.editorial,
    };
    const section = buildSelfCritiquePromptSection(brief)!;
    expect(section).toContain(directionTokens.editorial.posture);
    expect(section).toContain(directionTokens.editorial.palette.primary);
    expect(section).toContain(directionTokens.editorial.palette.accent);
  });

  it('falls back to direction name when directionTokens absent', () => {
    const brief: DesignBrief = {
      direction: 'utilitarian',
    };
    const section = buildSelfCritiquePromptSection(brief)!;
    expect(section).toContain('utilitarian');
    expect(section).toContain('无 directionTokens');
  });

  it('mentions surface and constraints when present', () => {
    const brief: DesignBrief = {
      direction: 'technical',
      directionTokens: directionTokens.technical,
      surface: 'dashboard',
      constraints: ['必须有暗色模式', '必须支持键盘操作'],
    };
    const section = buildSelfCritiquePromptSection(brief)!;
    expect(section).toContain('dashboard');
    expect(section).toContain('硬约束');
    expect(section).toContain('2 条');
  });

  it('declares gate threshold and max passes from SELF_CRITIQUE_CONFIG', () => {
    const brief: DesignBrief = { direction: 'calm' };
    const section = buildSelfCritiquePromptSection(brief)!;
    expect(section).toContain(`< ${SELF_CRITIQUE_CONFIG.gateThreshold}`);
    expect(section).toContain(`${SELF_CRITIQUE_CONFIG.maxPasses} passes`);
  });

  it('includes silent-scoring instruction (no user-visible output)', () => {
    const brief: DesignBrief = { direction: 'playful' };
    const section = buildSelfCritiquePromptSection(brief)!;
    expect(section).toContain('silent');
    expect(section).toMatch(/不要把评分输出给用户/);
  });

  it('wraps section in <design_self_critique> tag', () => {
    const brief: DesignBrief = { direction: 'premium' };
    const section = buildSelfCritiquePromptSection(brief)!;
    expect(section.startsWith('<design_self_critique>')).toBe(true);
    expect(section.endsWith('</design_self_critique>')).toBe(true);
  });

  it('handles brief with no direction at all (degenerate but legal)', () => {
    const brief: DesignBrief = { intent: 'just intent' };
    const section = buildSelfCritiquePromptSection(brief)!;
    expect(section).not.toBeNull();
    // No direction → no posture / no palette → still emits dimensions + gate
    for (const dim of CRITIQUE_DIMENSIONS) {
      expect(section).toContain(dim);
    }
  });
});
