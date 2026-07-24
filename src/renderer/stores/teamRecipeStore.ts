// ============================================================================
// Team Recipe Store - 已保存团队配方的渲染端目录缓存
// ============================================================================
// 三个消费方共用一份：输入框「＋ → 团队」二级面板（列表）、成员条（预选团队的
// 成员名单）、发送时启动配方（要拿配方名当会话标题）。
// 只读目录，选中态不在这里——那是 composerStore 的 selectedTeamRecipeId。
// ============================================================================

import { create } from 'zustand';
import type { TeamRecipe } from '@shared/contract/teamRecipe';
import { listRecipes } from '../services/teamClient';

interface TeamRecipeState {
  recipes: TeamRecipe[];
  isLoaded: boolean;
  refresh: () => Promise<void>;
}

export const useTeamRecipeStore = create<TeamRecipeState>()((set) => ({
  recipes: [],
  isLoaded: false,
  refresh: async () => {
    try {
      set({ recipes: (await listRecipes()) ?? [], isLoaded: true });
    } catch {
      // 目录取不到不该拖垮输入框：留空列表，面板显示空态
      set({ isLoaded: true });
    }
  },
}));
