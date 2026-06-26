// ============================================================================
// P2-2：内置 skill 按产物分类二次分组 — 确定性单测
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { ParsedSkill } from '../../../src/shared/contract/agentSkill';
import type { SkillCategory } from '../../../src/shared/contract/skillRepository';
import { SKILL_CATEGORIES } from '../../../src/shared/constants/skillCatalog';
import { groupBuiltinSkillsByCategory } from '../../../src/renderer/components/features/settings/tabs/SkillsInstalledTab';
import { getBuiltinSkills } from '../../../src/host/services/skills/builtinSkills';

function makeSkill(name: string, category?: SkillCategory): ParsedSkill {
  return {
    name,
    description: `${name} desc`,
    promptContent: '',
    basePath: '',
    allowedTools: [],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    metadata: category ? { category } : undefined,
  };
}

describe('groupBuiltinSkillsByCategory', () => {
  it('按 SKILL_CATEGORIES 顺序分组，空分类不出现', () => {
    const skills = [
      makeSkill('xlsx', 'docs-office'),
      makeSkill('literature-review', 'research'),
      makeSkill('data-cleaning', 'data-analysis'),
    ];
    const groups = groupBuiltinSkillsByCategory(skills);
    // SKILL_CATEGORIES 顺序：docs-office < data-analysis < ... < research
    expect(groups.map((g) => g.key)).toEqual(['docs-office', 'data-analysis', 'research']);
    expect(groups.every((g) => g.skills.length === 1)).toBe(true);
  });

  it('无 category 的 skill 归入末尾"其他"组', () => {
    const groups = groupBuiltinSkillsByCategory([
      makeSkill('mystery'),
      makeSkill('xlsx', 'docs-office'),
    ]);
    expect(groups[0].key).toBe('docs-office');
    const last = groups[groups.length - 1];
    expect(last.key).toBe('__uncategorized__');
    expect(last.label).toBe('其他');
    expect(last.skills.map((s) => s.name)).toEqual(['mystery']);
  });

  it('未知 category 字符串当作未分类，落入"其他"', () => {
    const skills = [{ ...makeSkill('weird'), metadata: { category: 'not-a-real-cat' } }];
    const groups = groupBuiltinSkillsByCategory(skills);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('__uncategorized__');
  });

  it('组内 skill 按名排序', () => {
    const groups = groupBuiltinSkillsByCategory([
      makeSkill('refactor', 'development'),
      makeSkill('commit', 'development'),
      makeSkill('docker', 'development'),
    ]);
    expect(groups[0].skills.map((s) => s.name)).toEqual(['commit', 'docker', 'refactor']);
  });

  it('空输入返回空数组', () => {
    expect(groupBuiltinSkillsByCategory([])).toEqual([]);
  });
});

describe('内置 skill 分类回填（builtinSkills.ts SSoT）', () => {
  const builtins = getBuiltinSkills();

  it('全部内置 skill 都有合法 category（无 SKILL_CATEGORIES 外的标签）', () => {
    const validIds = new Set(SKILL_CATEGORIES.map((c) => c.id));
    const missing = builtins.filter((s) => {
      const cat = s.metadata?.category;
      return !cat || !validIds.has(cat as SkillCategory);
    });
    expect(missing.map((s) => s.name)).toEqual([]);
  });

  it('分组后无"其他"组（全部已分类）+ 各分类数量符合预期', () => {
    const groups = groupBuiltinSkillsByCategory(builtins);
    expect(groups.find((g) => g.key === '__uncategorized__')).toBeUndefined();
    const counts = Object.fromEntries(groups.map((g) => [g.key, g.skills.length]));
    expect(counts).toMatchObject({
      'docs-office': 3, // xlsx, meeting-summary, reviewer-facing-delivery
      'data-analysis': 2, // data-cleaning, data-analysis-helper
      research: 5, // literature-review, paper-distillation, research-monitor, opencli-search, research-brief-and-split
      automation: 7, // computer-housekeeper, contract-review, image-ocr-search, photo-archive, create-role, edit-role, task-brief-builder
      development: 15, // commit, review, test, explain, refactor, docker, dream, distill + 方法论 7（brainstorm/tdd/debug/verify/merge/work-review/implementation-closure）
    });
  });
});
