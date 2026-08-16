import { describe, expect, it } from 'vitest';
import type { ParsedSkill } from '../../../../src/shared/contract/agentSkill';
import {
  evaluateSkillApplicability,
  hasSemanticApplicabilityBoundary,
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

describe('skillApplicability', () => {
  it('hides skills when required env or workdir paths are missing', () => {
    expect(evaluateSkillApplicability(
      skill({ requiredEnv: ['NEO_TOKEN'] }),
      context(),
    )?.reason).toBe('missing_required_env');

    expect(evaluateSkillApplicability(
      skill({ requiresPaths: ['package.json'] }),
      context({ pathExists: () => false }),
    )).toMatchObject({
      reason: 'missing_required_paths',
      actual: ['package.json'],
    });
  });

  it('accepts machine conditions only when every declared requirement is satisfied', () => {
    expect(evaluateSkillApplicability(
      skill({
        requiresTools: ['Read'],
        fallbackForTools: ['ExternalSearch'],
        platforms: ['darwin'],
        requiredEnv: ['NEO_TOKEN'],
        requiresPaths: ['package.json'],
      }),
      context({ env: { NEO_TOKEN: 'configured' } }),
    )).toBeNull();
  });

  it('requires an actual condition inside semantic [IF] markers', () => {
    expect(hasSemanticApplicabilityBoundary('[IF]')).toBe(false);
    expect(hasSemanticApplicabilityBoundary('[IF 当前目录是 Node 项目] 适用。')).toBe(true);
  });
});
