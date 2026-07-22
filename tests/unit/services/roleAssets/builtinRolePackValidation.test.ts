// ============================================================================
// E1 Role Pack 校验门：预设包必须绑真 skill，禁纯 prompt 空壳（rollout-plan §5 验收 4）
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  BUILTIN_ROLES,
  BUILTIN_ROLE_IDS,
  RETIRED_BUILTIN_ROLE_VISUALS,
  getBuiltinRoleVisual,
  validateBuiltinRolePack,
  type BuiltinRoleDefinition,
} from '../../../../src/host/services/roleAssets/builtinRoles';
import { BUILTIN_SKILLS } from '../../../../src/host/services/skills/builtinSkillsData';

const knownSkillNames = new Set(BUILTIN_SKILLS.map((s) => s.name));

const makeRole = (agentMd: string): BuiltinRoleDefinition => ({
  id: '测试角色',
  agentMd,
  visual: {
    icon: 'UserCircle',
    category: 'research',
    displayName: '测试角色',
    profession: '测试',
    tags: ['t1'],
    quickPrompts: ['q1'],
  },
});

describe('validateBuiltinRolePack', () => {
  // 门的盲区自检：内置 skill 全集必须非空且含已知锚点，
  // 否则「全部解析失败」会被误判成数据问题而非导入断裂
  it('内置 skill 全集非空且含锚点 skill', () => {
    expect(knownSkillNames.size).toBeGreaterThan(10);
    expect(knownSkillNames.has('literature-review')).toBe(true);
  });

  it('所有预设 Role Pack 通过校验（上架硬门）', () => {
    expect(BUILTIN_ROLES.length).toBeGreaterThan(0);
    for (const role of BUILTIN_ROLES) {
      const issues = validateBuiltinRolePack(role, knownSkillNames);
      expect(issues, `${role.id}: ${issues.map((i) => i.issue).join('; ')}`).toEqual([]);
    }
  });
});

// 退役预设角色（Batch 3 收敛）：研究员停止分发但存量安装保留"预设"身份
describe('退役预设角色（研究员）', () => {
  it('研究员不在装名册（新安装不再分发，避免与溯真定位重叠）', () => {
    expect(BUILTIN_ROLES.some((r) => r.id === '研究员')).toBe(false);
    expect(RETIRED_BUILTIN_ROLE_VISUALS['研究员']).toBeDefined();
  });

  it('研究员仍被识别为预设（存量安装保留 builtin 徽标 + 视觉，不降级）', () => {
    expect(BUILTIN_ROLE_IDS).toContain('研究员');
    const visual = getBuiltinRoleVisual('研究员');
    expect(visual?.icon).toBe('Microscope');
    expect(visual?.category).toBe('research');
    expect(visual?.displayName).toBe('研究员');
  });

  it('数据分析师保留在装名册（数据能力 4 包未覆盖，不收敛）', () => {
    expect(BUILTIN_ROLES.some((r) => r.id === '数据分析师')).toBe(true);
  });

  // 喂坏输入验门真红
  it('拒绝纯 prompt 空壳包（无 skills）', () => {
    const role = makeRole('---\nname: 测试角色\ndescription: x\ntools: [Read]\n---\n\n正文');
    const issues = validateBuiltinRolePack(role, knownSkillNames);
    expect(issues.some((i) => i.issue.includes('空壳'))).toBe(true);
  });

  it('拒绝引用不可解析的 skill（外部需安装 skill）', () => {
    const role = makeRole(
      '---\nname: 测试角色\ndescription: x\ntools: [Read]\nskills: [不存在的skill]\n---\n\n正文',
    );
    const issues = validateBuiltinRolePack(role, knownSkillNames);
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'unresolvable-skill',
      issue: expect.stringContaining('不存在的skill'),
    }));
  });

  it('拒绝无 frontmatter 的定义', () => {
    const role = makeRole('没有 frontmatter 的正文');
    expect(validateBuiltinRolePack(role, knownSkillNames)).toHaveLength(1);
  });

  it('拒绝 frontmatter name 与 roleId 不一致', () => {
    const role = makeRole('---\nname: 别的名字\nskills: [literature-review]\n---\n\n正文');
    const issues = validateBuiltinRolePack(role, knownSkillNames);
    expect(issues.some((i) => i.issue.includes('不一致'))).toBe(true);
  });

  it('拒绝空 tags / quickPrompts', () => {
    const role = makeRole('---\nname: 测试角色\nskills: [literature-review]\n---\n\n正文');
    role.visual.tags = [];
    role.visual.quickPrompts = [];
    const issues = validateBuiltinRolePack(role, knownSkillNames);
    expect(issues.some((i) => i.issue.includes('tags'))).toBe(true);
    expect(issues.some((i) => i.issue.includes('quickPrompts'))).toBe(true);
  });
});
