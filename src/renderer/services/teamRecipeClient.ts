import { IPC_DOMAINS } from '@shared/ipc';
import type { TeamRecipe } from '@shared/contract/teamRecipe';
import ipcService from './ipcService';

export type TeamRecipeWrite = Omit<TeamRecipe, 'id'>;

export function listTeamRecipes(): Promise<TeamRecipe[]> {
  return ipcService.invokeDomain<TeamRecipe[]>(IPC_DOMAINS.TEAM, 'recipeList');
}

export function createTeamRecipe(recipe: TeamRecipeWrite): Promise<TeamRecipe> {
  return ipcService.invokeDomain<TeamRecipe>(IPC_DOMAINS.TEAM, 'recipeCreate', { recipe });
}

export function updateTeamRecipe(recipeId: string, recipe: TeamRecipeWrite): Promise<TeamRecipe> {
  return ipcService.invokeDomain<TeamRecipe>(IPC_DOMAINS.TEAM, 'recipeUpdate', { recipeId, recipe });
}

export function deleteTeamRecipe(recipeId: string): Promise<void> {
  return ipcService.invokeDomain<void>(IPC_DOMAINS.TEAM, 'recipeDelete', { recipeId });
}
