// ============================================================================
// Subagent Skill Injection Tests (GAP-011)
// 测试子代理 skills 全文预注入块的构建（课程"方向 A"）
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ParsedSkill } from '../../../../src/shared/contract/agentSkill';

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const discoveryMocks = vi.hoisted(() => ({
  getSkill: vi.fn<(name: string) => unknown>(),
}));

vi.mock('../../../../src/host/services/skills/skillDiscoveryService', () => ({
  getSkillDiscoveryService: () => ({
    getSkill: discoveryMocks.getSkill,
  }),
}));

const loaderMocks = vi.hoisted(() => ({
  loadSkillContent: vi.fn(async () => undefined),
}));

vi.mock('../../../../src/host/services/skills/skillLoader', () => ({
  loadSkillContent: loaderMocks.loadSkillContent,
}));

import { buildSubagentSkillsBlock } from '../../../../src/host/services/skills/subagentSkillInjection';

function makeSkill(overrides: Partial<ParsedSkill> = {}): Partial<ParsedSkill> {
  return {
    name: 'pdf-processing',
    description: 'PDF 解析与蒸馏方法论',
    promptContent: '先 pdftotext 提取，再按章节切块分析。',
    allowedTools: ['Bash', 'Read'],
    loaded: true,
    basePath: '/skills/pdf-processing',
    ...overrides,
  };
}

describe('buildSubagentSkillsBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should build a <preloaded_skills> block with full SKILL.md content', async () => {
    discoveryMocks.getSkill.mockReturnValue(makeSkill());

    const result = await buildSubagentSkillsBlock(['pdf-processing']);

    expect(result.block).not.toBeNull();
    expect(result.block).toContain('<preloaded_skills>');
    expect(result.block).toContain('<skill name="pdf-processing">');
    expect(result.block).toContain('先 pdftotext 提取，再按章节切块分析。');
    expect(result.loaded).toEqual(['pdf-processing']);
    expect(result.missing).toEqual([]);
  });

  it('should load content on demand for lazily-loaded skills', async () => {
    const skill = makeSkill({ loaded: false });
    discoveryMocks.getSkill.mockReturnValue(skill);

    await buildSubagentSkillsBlock(['pdf-processing']);

    expect(loaderMocks.loadSkillContent).toHaveBeenCalledWith(skill);
  });

  it('should report missing skills without failing', async () => {
    discoveryMocks.getSkill.mockImplementation((name: string) =>
      name === 'exists' ? makeSkill({ name: 'exists' }) : undefined,
    );

    const result = await buildSubagentSkillsBlock(['exists', 'not-found']);

    expect(result.loaded).toEqual(['exists']);
    expect(result.missing).toEqual(['not-found']);
    expect(result.block).toContain('<skill name="exists">');
    expect(result.block).not.toContain('not-found');
  });

  it('should return null block when no skills can be loaded', async () => {
    discoveryMocks.getSkill.mockReturnValue(undefined);

    const result = await buildSubagentSkillsBlock(['ghost-skill']);

    expect(result.block).toBeNull();
    expect(result.missing).toEqual(['ghost-skill']);
  });

  it('should treat content load failure as missing', async () => {
    discoveryMocks.getSkill.mockReturnValue(makeSkill({ loaded: false }));
    loaderMocks.loadSkillContent.mockRejectedValueOnce(new Error('disk error'));

    const result = await buildSubagentSkillsBlock(['pdf-processing']);

    expect(result.block).toBeNull();
    expect(result.missing).toEqual(['pdf-processing']);
  });

  it('should include multiple skills in one block', async () => {
    discoveryMocks.getSkill.mockImplementation((name: string) =>
      makeSkill({ name, promptContent: `${name} 的方法论` }),
    );

    const result = await buildSubagentSkillsBlock(['skill-a', 'skill-b']);

    expect(result.loaded).toEqual(['skill-a', 'skill-b']);
    expect(result.block).toContain('<skill name="skill-a">');
    expect(result.block).toContain('<skill name="skill-b">');
  });
});
