import { IPC_DOMAINS } from '@shared/ipc';
import type { TeamRecipe } from '@shared/contract/teamRecipe';
import ipcService from './ipcService';
import { useSessionStore } from '../stores/sessionStore';

export interface LaunchRecipeResult {
  ok: boolean;
  error?: string;
  runId?: string;
}

/** 已保存的团队配方目录（输入框「团队」面板和成员条预览共用一份） */
export function listRecipes(): Promise<TeamRecipe[]> {
  return ipcService.invokeDomain<TeamRecipe[]>(IPC_DOMAINS.TEAM, 'recipeList', {});
}

export async function launchRecipe(sessionId: string, recipeId: string, topic: string, excludeMemberKeys?: string[]): Promise<LaunchRecipeResult> {
  const result = await ipcService.invokeDomain<LaunchRecipeResult>(IPC_DOMAINS.TEAM, 'launchRecipe', {
    sessionId,
    recipeId,
    topic,
    ...(excludeMemberKeys && excludeMemberKeys.length > 0 ? { excludeMemberKeys } : {}),
  });
  if (result.ok) {
    // teamLead 由 host 写入标准 session metadata；复用现有 session list 读回，
    // 让成员条在本次发起后立即拿到标记，不新增 team 专用 IPC 状态。
    await useSessionStore.getState().loadSessions({ silent: true });
  }
  return result;
}
