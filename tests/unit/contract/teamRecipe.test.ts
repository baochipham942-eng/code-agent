import { describe, expect, it } from 'vitest';
import {
  teamRecipeMemberKey,
  validateTeamRecipe,
  type TeamRecipe,
} from '../../../src/shared/contract/teamRecipe';
import { TEAM_RECIPES } from '../../../src/shared/constants/teamRecipeCatalog';

const KNOWN = ['牧之', '溯真', '青禾', '明镜', '数据分析师'];

function makeRecipe(members: TeamRecipe['members']): TeamRecipe {
  return {
    id: 'test-recipe',
    name: '测试配方',
    description: '测试',
    category: 'research',
    members,
  };
}

function makeRecipeWithLead(lead: NonNullable<TeamRecipe['lead']>, members: TeamRecipe['members']): TeamRecipe {
  return { ...makeRecipe(members), lead };
}

describe('TeamRecipe', () => {
  it('首发目录全部通过上架校验，含主理人与溯真双实例并行证据分工', () => {
    for (const recipe of TEAM_RECIPES) {
      const errors = validateTeamRecipe(recipe, KNOWN);
      expect(errors, `${recipe.id}: ${errors.map((error) => error.reason).join('; ')}`).toEqual([]);
    }

    const deepResearch = TEAM_RECIPES.find((recipe) => recipe.id === 'deep-research');
    expect(deepResearch?.members).toMatchObject([
      { id: 'evidence-a', roleId: '溯真' },
      { id: 'evidence-b', roleId: '溯真' },
    ]);
    expect(deepResearch?.members.every((member) => member.dependsOn === undefined)).toBe(true);
    expect(deepResearch?.members[0].taskTemplate).not.toBe(deepResearch?.members[1].taskTemplate);
  });

  it('无 id 时 member key 回退到 roleId', () => {
    expect(teamRecipeMemberKey({ roleId: '溯真', taskTemplate: 'x' })).toBe('溯真');
  });

  it('有 id 时 member key 使用 id', () => {
    expect(teamRecipeMemberKey({ id: 'evidence', roleId: '溯真', taskTemplate: 'x' })).toBe('evidence');
  });

  it('成员 roleId 不可解析时带有结构化 code', () => {
    expect(validateTeamRecipe(makeRecipe([{ roleId: '不存在', taskTemplate: 'x' }]), KNOWN)).toContainEqual(expect.objectContaining({
      code: 'unresolvable-role',
      reason: 'member roleId 不可解析：不存在',
    }));
  });

  it.each([
    ['roleId 不在册', makeRecipe([{ roleId: '不存在', taskTemplate: 'x' }])],
    ['members 为空', makeRecipe([])],
    ['taskTemplate 为空', makeRecipe([{ roleId: '溯真', taskTemplate: '' }])],
    [
      'lead roleId 不在册',
      makeRecipeWithLead({ roleId: '不存在', briefTemplate: '围绕「{topic}」定稿。' }, [{ roleId: '溯真', taskTemplate: 'x' }]),
    ],
    [
      'lead briefTemplate 为空',
      makeRecipeWithLead({ roleId: '牧之', briefTemplate: '  ' }, [{ roleId: '溯真', taskTemplate: 'x' }]),
    ],
    [
      'lead roleId 与 member 键重复',
      makeRecipeWithLead({ roleId: '牧之', briefTemplate: '围绕「{topic}」定稿。' }, [{ id: '牧之', roleId: '溯真', taskTemplate: 'x' }]),
    ],
    [
      '依赖不存在的 member',
      makeRecipe([{ id: 'synthesis', roleId: '溯真', taskTemplate: 'x', dependsOn: ['evidence'] }]),
    ],
    [
      '同角色无 id 导致 member 键重复',
      makeRecipe([
        { roleId: '溯真', taskTemplate: 'x' },
        { roleId: '溯真', taskTemplate: 'y' },
      ]),
    ],
    [
      'dependsOn 存在环',
      makeRecipe([
        { id: 'A', roleId: '溯真', taskTemplate: 'x', dependsOn: ['B'] },
        { id: 'B', roleId: '青禾', taskTemplate: 'y', dependsOn: ['A'] },
      ]),
    ],
  ])('拒绝坏输入：%s', (_caseName, recipe) => {
    expect(validateTeamRecipe(recipe, KNOWN)).not.toEqual([]);
  });
});
