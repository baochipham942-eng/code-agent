// ============================================================================
// Team Recipe Store - 团队配方的渲染端目录缓存（出厂 + 用户自建）
// ============================================================================
// 三个消费方共用一份：输入框「＋ → 团队」二级面板（列表）、成员条（预选团队的
// 成员名单）、发送时启动配方（要拿配方名当会话标题）。
// 只读目录，选中态不在这里——那是 composerStore 的 selectedTeamRecipeId。
//
// 出厂配方（TEAM_RECIPES）必须并进目录：host 发起服务与能力中心都认它们，
// 此前目录只装 host recipeList（用户自建），出厂团在 + 菜单/待命 pills/发送
// 启动三处全体失联（2026-08-06「用这个团」web 端验证实测）。撞 id 用户版优先。
// ============================================================================

import { create } from 'zustand';
import type { TeamRecipe } from '@shared/contract/teamRecipe';
import { TEAM_RECIPES } from '@shared/constants/teamRecipeCatalog';
import { listRecipes } from '../services/teamClient';

interface TeamRecipeState {
  recipes: TeamRecipe[];
  isLoaded: boolean;
  refresh: () => Promise<void>;
}

function mergeWithBuiltin(userRecipes: TeamRecipe[]): TeamRecipe[] {
  const userIds = new Set(userRecipes.map((recipe) => recipe.id));
  return [...TEAM_RECIPES.filter((recipe) => !userIds.has(recipe.id)), ...userRecipes];
}

export const useTeamRecipeStore = create<TeamRecipeState>()((set) => ({
  recipes: mergeWithBuiltin([]),
  isLoaded: false,
  refresh: async () => {
    try {
      set({ recipes: mergeWithBuiltin((await listRecipes()) ?? []), isLoaded: true });
    } catch {
      // 目录取不到不该拖垮输入框：出厂配方仍在，用户配方留待下次刷新
      set({ isLoaded: true });
    }
  },
}));
