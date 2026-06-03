// ============================================================================
// P2-1：角色按产物分类分组 — 确定性单测
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { RolePanelEntry } from '../../../src/shared/contract/roleAssets';
import type { SkillCategory } from '../../../src/shared/contract/skillRepository';
import { groupRolesByCategory } from '../../../src/renderer/components/features/settings/tabs/RolesTab';

function makeRole(roleId: string, category?: SkillCategory, icon?: string): RolePanelEntry {
  return {
    roleId,
    description: '',
    source: 'builtin',
    memoryCount: 0,
    lastWork: null,
    icon,
    category,
  };
}

describe('groupRolesByCategory', () => {
  it('按 SKILL_CATEGORIES 顺序分组，空分类不出现', () => {
    const groups = groupRolesByCategory([
      makeRole('研究员', 'research', 'Microscope'),
      makeRole('数据分析师', 'data-analysis', 'BarChart3'),
    ]);
    // data-analysis 在 SKILL_CATEGORIES 中先于 research
    expect(groups.map((g) => g.key)).toEqual(['data-analysis', 'research']);
    expect(groups.map((g) => g.entries[0].roleId)).toEqual(['数据分析师', '研究员']);
  });

  it('无 category 的用户自建角色归入末尾"其他"组', () => {
    const groups = groupRolesByCategory([
      makeRole('我的助手'),
      makeRole('研究员', 'research'),
    ]);
    expect(groups[0].key).toBe('research');
    const last = groups[groups.length - 1];
    expect(last.key).toBe('__uncategorized__');
    expect(last.label).toBe('其他');
    expect(last.entries.map((e) => e.roleId)).toEqual(['我的助手']);
  });

  it('未知 category 当作未分类', () => {
    const role = { ...makeRole('x'), category: 'bogus' as SkillCategory };
    const groups = groupRolesByCategory([role]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('__uncategorized__');
  });

  it('空输入返回空数组', () => {
    expect(groupRolesByCategory([])).toEqual([]);
  });
});
