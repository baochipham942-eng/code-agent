import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from './ipcService';

export interface LaunchRecipeResult {
  ok: boolean;
  error?: string;
  runId?: string;
}

export function launchRecipe(sessionId: string, recipeId: string, topic: string): Promise<LaunchRecipeResult> {
  return ipcService.invokeDomain<LaunchRecipeResult>(IPC_DOMAINS.TEAM, 'launchRecipe', {
    sessionId,
    recipeId,
    topic,
  });
}
