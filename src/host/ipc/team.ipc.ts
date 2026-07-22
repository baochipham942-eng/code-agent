import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { launchTeamRecipe } from '../services/team/teamRecipeLaunchService';

interface LaunchRecipePayload {
  sessionId?: string;
  recipeId?: string;
  topic?: string;
}

function invalid(message: string): IPCResponse {
  return { success: false, error: { code: 'INVALID_ARGS', message } };
}

export function registerTeamHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.TEAM, async (_event, request: IPCRequest): Promise<IPCResponse> => {
    try {
      switch (request.action) {
        case 'launchRecipe': {
          const { sessionId, recipeId, topic } = (request.payload ?? {}) as LaunchRecipePayload;
          if (!sessionId || !recipeId || typeof topic !== 'string') {
            return invalid('sessionId, recipeId and topic are required');
          }
          return {
            success: true,
            data: await launchTeamRecipe({ sessionId, recipeId, topic }),
          };
        }
        default:
          return {
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `Unknown team action: ${request.action}` },
          };
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'TEAM_RECIPE_LAUNCH_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}
