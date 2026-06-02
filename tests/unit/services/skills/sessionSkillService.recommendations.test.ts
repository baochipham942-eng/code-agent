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

// 推荐目录用真实内置数据（与生产兜底一致），让"未安装可获取"推荐可被测试
vi.mock('../../../../src/main/services/cloud', async () => {
  const { getBuiltinSkillCatalogPayload } = await import('../../../../src/shared/constants/skillCatalog');
  return {
    getCloudConfigService: () => ({
      getSkillCatalog: () => getBuiltinSkillCatalogPayload(),
    }),
  };
});

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

describe('SessionSkillService install recommendations (catalog 导购)', () => {
  beforeEach(async () => {
    skills.length = 0;
    const { resetSessionSkillService } = await import('../../../../src/main/services/skills/sessionSkillService');
    resetSessionSkillService();
  });

  it('recommends installable catalog skills when not installed locally', async () => {
    // 本地没有任何 skill，用户输入命中 pptx 关键词
    const { getSessionSkillService } = await import('../../../../src/main/services/skills/sessionSkillService');
    const recommendations = getSessionSkillService().recommendSkills('session-1', '帮我做个ppt汇报');

    const pptxRec = recommendations.find((rec) => rec.skillName === 'pptx');
    expect(pptxRec).toMatchObject({
      skillName: 'pptx',
      action: 'install',
      displayName: 'PPT 演示文稿',
      repoId: 'anthropic-skills',
    });
  });

  it('does not recommend installing builtin catalog entries missing locally', async () => {
    // xlsx 在目录中标记为 builtin，本地缺失说明环境异常，不应推荐安装
    const { getSessionSkillService } = await import('../../../../src/main/services/skills/sessionSkillService');
    const recommendations = getSessionSkillService().recommendSkills('session-1', '帮我处理 excel 表格数据');

    const xlsxRec = recommendations.find((rec) => rec.skillName === 'xlsx');
    expect(xlsxRec).toBeUndefined();
  });

  it('recommends mount instead of install when skill is installed locally', async () => {
    // pptx 本地已安装（来自仓库下载），应走挂载推荐而不是安装推荐
    skills.push(skill({
      name: 'pptx',
      description: 'PPT 演示文稿生成。Use when user needs PowerPoint slides.',
      aliases: ['PPT', '演示文稿'],
    }));

    const { getSessionSkillService } = await import('../../../../src/main/services/skills/sessionSkillService');
    const recommendations = getSessionSkillService().recommendSkills('session-1', '帮我做个PPT汇报');

    const pptxRecs = recommendations.filter((rec) => rec.skillName === 'pptx');
    expect(pptxRecs).toHaveLength(1);
    expect(pptxRecs[0].action).not.toBe('install');
  });

  it('caps install recommendation scores at 0.8', async () => {
    const { getSessionSkillService } = await import('../../../../src/main/services/skills/sessionSkillService');
    const recommendations = getSessionSkillService().recommendSkills(
      'session-1',
      '帮我写个营销文案做个落地页文案'
    );

    const installRecs = recommendations.filter((rec) => rec.action === 'install');
    expect(installRecs.length).toBeGreaterThan(0);
    for (const rec of installRecs) {
      expect(rec.score).toBeLessThanOrEqual(0.8);
    }
  });
});
