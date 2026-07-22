import { describe, expect, it } from 'vitest';
import { TEAM_RECIPES } from '../../../../src/shared/constants/teamRecipeCatalog';
import type { TeamRecipe } from '../../../../src/shared/contract/teamRecipe';
import { compileRecipeToAgents } from '../../../../src/host/services/team/teamRecipeLaunchService';

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
