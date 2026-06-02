import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedSkill } from '../../../../src/shared/contract/agentSkill';

const skills: ParsedSkill[] = [];

vi.mock('../../../../src/main/services/skills/skillDiscoveryService', () => ({
  getSkillDiscoveryService: () => ({
    getAllSkills: () => skills,
    getUserInvocableSkills: () => skills.filter((skill) => skill.userInvocable),
    getSkill: (name: string) => skills.find((skill) => skill.name === name),
  }),
}));

vi.mock('../../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../../src/main/context/contextHealthService', () => ({
  getContextHealthService: () => ({
    recordSourceContribution: vi.fn(),
    clearSourceContribution: vi.fn(),
  }),
}));

vi.mock('../../../../src/main/context/tokenEstimator', () => ({
  estimateTokens: () => 1,
}));

vi.mock('../../../../src/main/services/skills/skillLoader', () => ({
  loadSkillContent: vi.fn(),
}));

function skill(overrides: Partial<ParsedSkill> & Pick<ParsedSkill, 'name' | 'description'>): ParsedSkill {
  return {
    promptContent: '',
    basePath: `/tmp/${overrides.name}`,
    allowedTools: [],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'user',
    ...overrides,
  };
}

describe('SessionSkillService recommendations', () => {
  beforeEach(async () => {
    skills.length = 0;
    const { resetSessionSkillService } = await import('../../../../src/main/services/skills/sessionSkillService');
    resetSessionSkillService();
  });

  it('recommends unmounted user-invocable skills by semantic aliases', async () => {
    skills.push(skill({
      name: 'docx',
      description: 'Word 文档 AI 助手。Use when user needs DOCX or Word document work.',
      aliases: ['Word 文档', 'DOCX'],
    }));

    const { getSessionSkillService } = await import('../../../../src/main/services/skills/sessionSkillService');
    const recommendations = getSessionSkillService().recommendSkills('session-1', '帮我整理这个 Word 文档');

    expect(recommendations[0]).toMatchObject({
      skillName: 'docx',
      reason: expect.stringContaining('匹配语义'),
    });
  });

  it('does not recommend mounted skills again', async () => {
    skills.push(skill({
      name: 'docx',
      description: 'Word 文档 AI 助手。Use when user needs DOCX or Word document work.',
      aliases: ['Word 文档'],
    }));

    const { getSessionSkillService } = await import('../../../../src/main/services/skills/sessionSkillService');
    const service = getSessionSkillService();
    service.mountSkill('session-1', 'docx', 'user', 'manual');

    expect(service.recommendSkills('session-1', '帮我整理这个 Word 文档')).toEqual([]);
  });
});
