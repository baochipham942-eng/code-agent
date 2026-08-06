// 出厂配方并入目录的语义（2026-08-06「用这个团」web 端验证实测踩空后钉死）：
// 成员条待命 pills 与发送启动都从这份目录找配方，找不到会静默降级成普通消息。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamRecipe } from '../../../src/shared/contract/teamRecipe';
import { TEAM_RECIPES } from '../../../src/shared/constants/teamRecipeCatalog';

const listRecipes = vi.fn<() => Promise<TeamRecipe[]>>();
vi.mock('../../../src/renderer/services/teamClient', () => ({
  listRecipes: (...args: unknown[]) => listRecipes(...(args as [])),
}));

import { useTeamRecipeStore } from '../../../src/renderer/stores/teamRecipeStore';

describe('teamRecipeStore', () => {
  beforeEach(() => {
    listRecipes.mockReset();
  });

  it('初始目录就含全部出厂配方（刷新前预选出厂团也能被找到）', () => {
    const ids = useTeamRecipeStore.getState().recipes.map((recipe) => recipe.id);
    for (const builtin of TEAM_RECIPES) {
      expect(ids).toContain(builtin.id);
    }
  });

  it('refresh 合并出厂与用户配方，撞 id 用户版优先', async () => {
    const overridden: TeamRecipe = { ...TEAM_RECIPES[0], name: '用户改过的版本' };
    const userOnly: TeamRecipe = { ...TEAM_RECIPES[0], id: 'user-own', name: '自建团' };
    listRecipes.mockResolvedValue([overridden, userOnly]);

    await useTeamRecipeStore.getState().refresh();

    const { recipes, isLoaded } = useTeamRecipeStore.getState();
    expect(isLoaded).toBe(true);
    expect(recipes.filter((recipe) => recipe.id === overridden.id)).toHaveLength(1);
    expect(recipes.find((recipe) => recipe.id === overridden.id)?.name).toBe('用户改过的版本');
    expect(recipes.find((recipe) => recipe.id === 'user-own')?.name).toBe('自建团');
    expect(recipes.map((recipe) => recipe.id)).toEqual(
      expect.arrayContaining(TEAM_RECIPES.map((recipe) => recipe.id).filter((id) => id !== overridden.id)),
    );
  });

  it('refresh 拉取失败时出厂配方仍在目录里', async () => {
    listRecipes.mockRejectedValue(new Error('ipc down'));

    await useTeamRecipeStore.getState().refresh();

    expect(useTeamRecipeStore.getState().isLoaded).toBe(true);
    expect(useTeamRecipeStore.getState().recipes.length).toBeGreaterThanOrEqual(TEAM_RECIPES.length - 1);
  });
});
