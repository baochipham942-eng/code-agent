import { describe, expect, it } from 'vitest';
import { TEAM_RECIPES } from '../../../../src/shared/constants/teamRecipeCatalog';
import type { TeamRecipe } from '../../../../src/shared/contract/teamRecipe';
import { compileRecipeToAgents, applyExcludedMembers } from '../../../../src/host/services/team/teamRecipeLaunchService';

function getRecipe(id: string): TeamRecipe {
  const recipe = TEAM_RECIPES.find((candidate) => candidate.id === id);
  if (!recipe) throw new Error(`Missing test recipe: ${id}`);
  return recipe;
}

describe('compileRecipeToAgents', () => {
  it('编译产品规格配方并替换主题', () => {
    const agents = compileRecipeToAgents(getRecipe('product-spec'), '会员增长');

    expect(agents).toHaveLength(2);
    expect(agents.map((agent) => agent.role)).toEqual(['溯真', '青禾']);
    for (const agent of agents) {
      expect(agent.task).toContain('会员增长');
      expect(agent.task).not.toContain('{topic}');
      expect(agent.dependsOn).toBeUndefined();
    }
  });

  it('把同角色的并行证据成员编译成独立 role-index', () => {
    const agents = compileRecipeToAgents(getRecipe('deep-research'), '智能体协作');

    expect(agents).toHaveLength(2);
    expect(agents.map((agent) => agent.role)).toEqual(['溯真', '溯真']);
    expect(agents[0].dependsOn).toBeUndefined();
    expect(agents[1].dependsOn).toBeUndefined();
  });

  it('替换 taskTemplate 中的全部主题占位', () => {
    const recipe: TeamRecipe = {
      id: 'multi-placeholder',
      name: '多占位',
      description: '测试多个主题占位',
      category: 'product',
      members: [
        { roleId: '牧之', taskTemplate: '{topic}：分析 {topic}，再复核 {topic}。' },
      ],
    };

    const [agent] = compileRecipeToAgents(recipe, 'A/B $1');

    expect(agent.task).toBe('A/B $1：分析 A/B $1，再复核 A/B $1。');
  });

  it('真实首发配方均可编译', () => {
    for (const recipe of TEAM_RECIPES) {
      expect(() => compileRecipeToAgents(recipe, '真实主题')).not.toThrow();
    }
  });
});

describe('applyExcludedMembers（待命成员 × 排除）', () => {
  const recipe: TeamRecipe = {
    id: 'standby-exclude',
    name: '待命排除',
    description: '成员条 × 掉的人启动时不该再出现',
    category: 'product',
    lead: { roleId: '牧之', briefTemplate: '统筹 {topic}' },
    members: [
      { roleId: '溯真', taskTemplate: '调研 {topic}' },
      { id: 'writer-a', roleId: '青禾', taskTemplate: '写作 {topic}', dependsOn: ['溯真'] },
    ],
  };

  it('按成员键剔除成员，并摘掉指向被剔除成员的 dependsOn', () => {
    const effective = applyExcludedMembers(recipe, ['溯真']);

    expect(effective.members.map((member) => member.roleId)).toEqual(['青禾']);
    expect(effective.members[0].dependsOn).toEqual([]);
    expect(effective.lead?.roleId).toBe('牧之');
    // 剔除后的配方照常可编译（dependsOn 不再悬空）
    expect(() => compileRecipeToAgents(effective, '主题')).not.toThrow();
  });

  it('lead 被排除时 lead 置空（启动自然降级到确定性路径）', () => {
    const effective = applyExcludedMembers(recipe, ['牧之']);

    expect(effective.lead).toBeUndefined();
    expect(effective.members).toHaveLength(2);
  });

  it('member.id 存在时按 id 匹配，不误伤同角色的其它实例', () => {
    const effective = applyExcludedMembers(recipe, ['writer-a']);

    expect(effective.members.map((member) => member.roleId)).toEqual(['溯真']);
  });

  it('空排除名单原样返回（同一引用）', () => {
    expect(applyExcludedMembers(recipe, [])).toBe(recipe);
    expect(applyExcludedMembers(recipe, undefined)).toBe(recipe);
  });
});
