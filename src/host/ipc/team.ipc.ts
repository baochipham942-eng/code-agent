import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { launchTeamRecipe } from '../services/team/teamRecipeLaunchService';
import { getTeamRecipeService, type TeamRecipeWrite } from '../services/team/teamRecipeService';
import { confirmTeamRecipeDraft, listTeamRecipeDrafts, rejectTeamRecipeDraft } from '../services/team/teamRecipeDraftQueue';

interface LaunchRecipePayload {
  sessionId?: string;
  recipeId?: string;
  topic?: string;
}

interface RecipeIdPayload {
  recipeId?: string;
}

interface RecipeWritePayload {
  recipe?: TeamRecipeWrite;
}

interface RecipeUpdatePayload extends RecipeIdPayload, RecipeWritePayload {}
interface DraftIdPayload { draftId?: string; }

function invalid(message: string): IPCResponse {
  return { success: false, error: { code: 'INVALID_ARGS', message } };
}

export function registerTeamHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.TEAM, async (_event, request: IPCRequest): Promise<IPCResponse> => {
    try {
      switch (request.action) {
        case 'knownRoles':
          return { success: true, data: await getTeamRecipeService().knownRoles() };
        case 'confirmDraft': {
          const { draftId } = (request.payload ?? {}) as DraftIdPayload;
          if (!draftId) return invalid('draftId is required');
          return { success: true, data: await confirmTeamRecipeDraft(draftId) };
        }
        case 'listDrafts':
          return { success: true, data: await listTeamRecipeDrafts() };
        case 'recipeCreate': {
          const { recipe } = (request.payload ?? {}) as RecipeWritePayload;
          if (!recipe) return invalid('recipe is required');
          return { success: true, data: await getTeamRecipeService().create(recipe) };
        }
        case 'recipeDelete': {
          const { recipeId } = (request.payload ?? {}) as RecipeIdPayload;
          if (!recipeId) return invalid('recipeId is required');
          return getTeamRecipeService().delete(recipeId)
            ? { success: true }
            : { success: false, error: { code: 'NOT_FOUND', message: 'team recipe not found' } };
        }
        case 'recipeList':
          return { success: true, data: getTeamRecipeService().list() };
        case 'recipeUpdate': {
          const { recipeId, recipe } = (request.payload ?? {}) as RecipeUpdatePayload;
          if (!recipeId || !recipe) return invalid('recipeId and recipe are required');
          const updated = await getTeamRecipeService().update(recipeId, recipe);
          return updated
            ? { success: true, data: updated }
            : { success: false, error: { code: 'NOT_FOUND', message: 'team recipe not found' } };
        }
        case 'rejectDraft': {
          const { draftId } = (request.payload ?? {}) as DraftIdPayload;
          if (!draftId) return invalid('draftId is required');
          return { success: true, data: await rejectTeamRecipeDraft(draftId) };
        }
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
