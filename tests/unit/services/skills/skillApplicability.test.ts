import { describe, expect, it } from 'vitest';
import type { ParsedSkill } from '../../../../src/shared/contract/agentSkill';
import {
  filterSkillsByApplicability,
  hasSkillApplicabilityBoundary,
  type SkillApplicabilityContext,
} from '../../../../src/host/services/skills/skillApplicability';

function skill(overrides: Partial<ParsedSkill> = {}): ParsedSkill {
  return {
    name: 'applicable-skill',
    description: 'Applicability test skill',
    promptContent: '',
    basePath: '/tmp/applicable-skill',
    allowedTools: [],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'user',
    ...overrides,
  };
}

function context(overrides: Partial<SkillApplicabilityContext> = {}): SkillApplicabilityContext {
  return {
    availableToolNames: ['Read'],
    platform: 'darwin',
    env: {},
    workingDirectory: '/repo',
    pathExists: () => true,
    ...overrides,
  };
}

// 一律走生产入口 filterSkillsByApplicability / hasSkillApplicabilityBoundary 断言，
// 不按名 import 内部求值函数（knip 生产档不留 test-only export）。
describe('skillApplicability', () => {
  it('hides skills when required env or workdir paths are missing', () => {
    const missingEnv = filterSkillsByApplicability(
      [skill({ requiredEnv: ['NEO_TOKEN'] })],
      context(),
    );
    expect(missingEnv.skills).toHaveLength(0);
    expect(missingEnv.report.hidden[0]?.reason).toBe('missing_required_env');

    const missingPaths = filterSkillsByApplicability(
      [skill({ requiresPaths: ['package.json'] })],
      context({ pathExists: () => false }),
    );
    expect(missingPaths.skills).toHaveLength(0);
    expect(missingPaths.report.hidden[0]).toMatchObject({
      reason: 'missing_required_paths',
      actual: ['package.json'],
    });
  });

  it('accepts machine conditions only when every declared requirement is satisfied', () => {
    const { skills: visible, report } = filterSkillsByApplicability(
      [skill({
        requiresTools: ['Read'],
        fallbackForTools: ['ExternalSearch'],
        platforms: ['darwin'],
        requiredEnv: ['NEO_TOKEN'],
        requiresPaths: ['package.json'],
      })],
      context({ env: { NEO_TOKEN: 'configured' } }),
    );
    expect(visible).toHaveLength(1);
    expect(report.hidden).toHaveLength(0);
  });

  it('requires an actual condition inside semantic [IF] markers', () => {
    expect(hasSkillApplicabilityBoundary(skill({ promptContent: '[IF]' }))).toBe(false);
    expect(hasSkillApplicabilityBoundary(skill({ promptContent: '[IF 当前目录是 Node 项目] 适用。' }))).toBe(true);
  });
});
