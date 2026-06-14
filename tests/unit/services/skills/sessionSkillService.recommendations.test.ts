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

  it('recommends OpenCLI for complex social/search tasks', async () => {
    skills.push(skill({
      name: 'opencli-search',
      description: 'OpenCLI 复杂搜索 — 用本机 opencli 处理登录态网站、社交平台、反爬页面和站点专用 adapter 抓取。',
      aliases: ['opencli', '复杂搜索', '小红书搜索', '登录态抓取', '反爬抓取'],
      bins: ['opencli'],
      source: 'builtin',
    }));

    const { getSessionSkillService } = await import('../../../../src/main/services/skills/sessionSkillService');
    const recommendations = getSessionSkillService().recommendSkills(
      'session-1',
      '帮我做一个小红书和知乎的复杂搜索，最好复用登录态抓取帖子'
    );

    expect(recommendations[0]).toMatchObject({
      skillName: 'opencli-search',
      libraryId: 'builtin',
    });
  });

  it('recommends builtin task-routing skills for research, implementation, and delivery intents', async () => {
    skills.push(
      skill({
        name: 'research-brief-and-split',
        description: '研究拆题：用于产品、竞品、版本、能力、模型、语音、工具链等对标研究。',
        aliases: ['研究拆题', '竞品对标', '版本对比'],
        source: 'builtin',
      }),
      skill({
        name: 'implementation-closure',
        description: '实现闭环：用于已进入代码实现、修 bug、迁移、收尾、测试补齐或回归验证的任务。',
        aliases: ['实现闭环', '修复并验证', '最小改动'],
        source: 'builtin',
      }),
      skill({
        name: 'reviewer-facing-delivery',
        description: '面向 reviewer 的交付材料：用于 Excel 审批表、PR 摘要、handoff、发布说明。',
        aliases: ['交付材料', '审批表', 'PR 摘要'],
        source: 'builtin',
      }),
    );

    const { getSessionSkillService } = await import('../../../../src/main/services/skills/sessionSkillService');
    const service = getSessionSkillService();

    expect(service.recommendSkills('session-1', '帮我做一下竞品对标研究')[0]).toMatchObject({
      skillName: 'research-brief-and-split',
      libraryId: 'builtin',
    });
    expect(service.recommendSkills('session-2', '这个 bug 帮我修复并验证')[0]).toMatchObject({
      skillName: 'implementation-closure',
      libraryId: 'builtin',
    });
    expect(service.recommendSkills('session-3', '把这个审批表改得更可读')[0]).toMatchObject({
      skillName: 'reviewer-facing-delivery',
      libraryId: 'builtin',
    });
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
