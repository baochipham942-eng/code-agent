import { IPC_DOMAINS } from '@shared/ipc';
import type { TeamRecipe } from '@shared/contract/teamRecipe';
import ipcService from './ipcService';

export interface LaunchRecipeResult {
  ok: boolean;
  error?: string;
  runId?: string;
}

/** 已保存的团队配方目录（输入框「团队」面板和成员条预览共用一份） */
export function listRecipes(): Promise<TeamRecipe[]> {
  return ipcService.invokeDomain<TeamRecipe[]>(IPC_DOMAINS.TEAM, 'recipeList', {});
}

export function launchRecipe(sessionId: string, recipeId: string, topic: string): Promise<LaunchRecipeResult> {
  return ipcService.invokeDomain<LaunchRecipeResult>(IPC_DOMAINS.TEAM, 'launchRecipe', {
    sessionId,
    recipeId,
    topic,
  });
}
