import { TEAM_RECIPES } from '@shared/constants/teamRecipeCatalog';
import { validateTeamRecipe, type TeamRecipe } from '@shared/contract/teamRecipe';
import { listAllAgents } from '../../agent/agentRegistry';
import { launchAgentTeam } from '../../agent/multiagentTools/spawnAgent';
import type { SubagentExecutionContext } from '../../agent/subagentExecutorTypes';
import { getToolResolver } from '../../tools/dispatch/toolResolver';
import { getSessionManager } from '../infra/sessionManager';

export interface LaunchTeamRecipeResult {
  ok: boolean;
  error?: string;
  runId?: string;
}

interface CompiledRecipeAgent {
  role: string;
  task: string;
  dependsOn?: string[];
}

export function compileRecipeToAgents(
  recipe: TeamRecipe,
  topic: string,
): CompiledRecipeAgent[] {
  return recipe.members.map((member) => ({
    role: member.roleId,
    task: member.taskTemplate.split('{topic}').join(topic),
    dependsOn: member.dependsOn?.map((depKey) => {
      const depIdx = recipe.members.findIndex(
        (candidate) => (candidate.id ?? candidate.roleId) === depKey,
      );
      return `${recipe.members[depIdx].roleId}-${depIdx}`;
    }),
  }));
}

/** 用户点配方 → 确定性起 durable 团队。绕开模型。 */
export async function launchTeamRecipe(args: {
  sessionId: string;
  recipeId: string;
  topic: string;
}): Promise<LaunchTeamRecipeResult> {
  const recipe = TEAM_RECIPES.find((candidate) => candidate.id === args.recipeId);
  if (!recipe) {
    return { ok: false, error: '配方不存在' };
  }

  const knownRoleIds = new Set(listAllAgents().map((agent) => agent.id));
  const errors = validateTeamRecipe(recipe, knownRoleIds);
  if (errors.length > 0) {
    return { ok: false, error: errors.map((error) => error.reason).join('; ') };
  }

  const session = await getSessionManager().getSession(args.sessionId);
  if (!session) {
    return { ok: false, error: '会话不存在' };
  }

  const agents = compileRecipeToAgents(recipe, args.topic);
  const runId = `team_recipe_${crypto.randomUUID()}`;
  const context: SubagentExecutionContext = {
    runId,
    sessionId: args.sessionId,
    workspace: session.workingDirectory,
    cwd: session.workingDirectory ?? process.cwd(),
    modelConfig: session.modelConfig,
    resolver: getToolResolver(),
    permission: { request: async () => true },
    events: { emit: () => undefined },
    abortSignal: new AbortController().signal,
    currentToolCallId: `${runId}-team-recipe`,
  };

  const result = await launchAgentTeam(agents, context);
  return {
    ok: result.success,
    error: result.success ? undefined : result.error,
    runId: context.runId,
  };
}
