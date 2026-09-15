import type { IpcMain } from '../platform';
import type { IPCResponse } from '../../shared/ipc';
import type { RawDomainRouteHandlers } from '../../shared/ipc/domainRoutes';
import { TeamSchemas, type TeamDomainRequest } from '../../shared/ipc/schemas/team';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { launchTeamRecipe } from '../services/team/teamRecipeLaunchService';
import { getTeamRecipeService, type TeamRecipeWrite } from '../services/team/teamRecipeService';
import { confirmTeamRecipeDraft, listTeamRecipeDrafts, rejectTeamRecipeDraft } from '../services/team/teamRecipeDraftQueue';

interface LaunchRecipePayload {
  sessionId?: string;
  recipeId?: string;
  topic?: string;
  excludeMemberKeys?: string[];
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

/**
 * team 域单源路由表（RQ-183 续作·TEAM 刀）：原 domain switch 9 个 case 逐 case 平移为 handler（rawResponse：case 体原样，含
 * INVALID_ARGS / NOT_FOUND 直返与 recipeDelete 成功无 data 键）。未知 action → UNKNOWN_ACTION + `Unknown team action:`
 * （unknownActionCode / unknownActionMessage 保持原契约）；抛错 code 固定 TEAM_RECIPE_LAUNCH_ERROR（resolveErrorCode），message 由
 * 装配器取 Error.message / String(error)，与原 catch 一致。请求体为 null / 非对象时原实现在 try 内读 request.action 抛错落
 * TEAM_RECIPE_LAUNCH_ERROR，现返回 UNKNOWN_ACTION。
 */
const teamHandlers: RawDomainRouteHandlers<TeamDomainRequest, void> = {
  knownRoles: async (_ctx, _payload) => {
    return { success: true, data: await getTeamRecipeService().knownRoles() };
  },
  confirmDraft: async (_ctx, payload) => {
    const { draftId } = (payload ?? {}) as DraftIdPayload;
    if (!draftId) return invalid('draftId is required');
    return { success: true, data: await confirmTeamRecipeDraft(draftId) };
  },
  listDrafts: async (_ctx, _payload) => {
    return { success: true, data: await listTeamRecipeDrafts() };
  },
  recipeCreate: async (_ctx, payload) => {
    const { recipe } = (payload ?? {}) as RecipeWritePayload;
    if (!recipe) return invalid('recipe is required');
    return { success: true, data: await getTeamRecipeService().create(recipe) };
  },
  recipeDelete: async (_ctx, payload) => {
    const { recipeId } = (payload ?? {}) as RecipeIdPayload;
    if (!recipeId) return invalid('recipeId is required');
    return getTeamRecipeService().delete(recipeId)
      ? { success: true }
      : { success: false, error: { code: 'NOT_FOUND', message: 'team recipe not found' } };
  },
  recipeList: async (_ctx, _payload) => {
    return { success: true, data: getTeamRecipeService().list() };
  },
  recipeUpdate: async (_ctx, payload) => {
    const { recipeId, recipe } = (payload ?? {}) as RecipeUpdatePayload;
    if (!recipeId || !recipe) return invalid('recipeId and recipe are required');
    const updated = await getTeamRecipeService().update(recipeId, recipe);
    return updated
      ? { success: true, data: updated }
      : { success: false, error: { code: 'NOT_FOUND', message: 'team recipe not found' } };
  },
  rejectDraft: async (_ctx, payload) => {
    const { draftId } = (payload ?? {}) as DraftIdPayload;
    if (!draftId) return invalid('draftId is required');
    return { success: true, data: await rejectTeamRecipeDraft(draftId) };
  },
  launchRecipe: async (_ctx, payload) => {
    const { sessionId, recipeId, topic, excludeMemberKeys } = (payload ?? {}) as LaunchRecipePayload;
    if (!sessionId || !recipeId || typeof topic !== 'string') {
      return invalid('sessionId, recipeId and topic are required');
    }
    return {
      success: true,
      data: await launchTeamRecipe({
        sessionId,
        recipeId,
        topic,
        excludeMemberKeys: Array.isArray(excludeMemberKeys)
          ? excludeMemberKeys.filter((key): key is string => typeof key === 'string')
          : undefined,
      }),
    };
  },
};

const teamRoutes = defineDomainRoutes<TeamDomainRequest, void>(TeamSchemas.REQUEST, teamHandlers, {
  rawResponse: true,
  unknownActionCode: 'UNKNOWN_ACTION',
  unknownActionMessage: (action) => `Unknown team action: ${String(action)}`,
  resolveErrorCode: () => 'TEAM_RECIPE_LAUNCH_ERROR',
});

export function registerTeamHandlers(ipcMain: IpcMain): void {
  installDomainRoutes(ipcMain, teamRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerLoopHandlers.routes 先例）
registerTeamHandlers.routes = teamRoutes;
