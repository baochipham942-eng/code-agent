import { TEAM_RECIPES } from '@shared/constants/teamRecipeCatalog';
import { validateTeamRecipe, type TeamRecipe } from '@shared/contract/teamRecipe';
import { listAllAgents } from '../../agent/agentRegistry';
import type { MultiagentExecutionResult } from '../../agent/multiagentExecutionTypes';
import { launchAgentTeam } from '../../agent/multiagentTools/spawnAgent';
import type { SubagentExecutionContext } from '../../agent/subagentExecutorTypes';
import { getToolResolver } from '../../tools/dispatch/toolResolver';
import {
  getApplicationRunRegistry,
  getConfiguredApplicationRunRegistry,
} from '../../app/applicationRunRegistry';
import { getSessionManager } from '../infra/sessionManager';
import { getLibraryService } from '../library/libraryService';
import type { Message } from '@shared/contract/message';
import { generateMessageId } from '../../../shared/utils/id';

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

/** 团队完成后归档聚合产物到项目资料库。失败不抛（fire-and-forget 尾部调用）。 */
export function archiveTeamResult(
  result: MultiagentExecutionResult,
  meta: { projectId: string | null; title: string; sourceSessionId: string },
): void {
  if (!result.success) return;

  const text = typeof result.output === 'string' ? result.output.trim() : '';
  if (!text) return;

  try {
    getLibraryService().archiveText({
      projectId: meta.projectId,
      title: meta.title,
      text,
      tags: ['定稿'],
      sourceSessionId: meta.sourceSessionId,
    });
  } catch (error) {
    console.warn('[TeamRecipe] 聚合产物归档失败（团队本身已完成）', error);
  }
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

  const registry = getConfiguredApplicationRunRegistry();
  if (!registry) {
    return { ok: false, error: '组队功能需要 Durable 运行时' };
  }

  // 落一条 user 请求消息：既是会话可见的组队起点（否则团队会话是空欢迎页），
  // 也是 Native Durable 工具 checkpoint 的 sourceMessageId 锚点
  // （prepareNativeToolCheckpoint 取会话最后一条 user 消息，缺则每个工具调用都抛）。
  const requestMessage: Message = {
    id: generateMessageId(),
    role: 'user',
    content: `【组队 · ${recipe.name}】${args.topic}`,
    timestamp: Date.now(),
  };
  await getSessionManager().addMessageToSession(args.sessionId, requestMessage);

  const agents = compileRecipeToAgents(recipe, args.topic);
  // 纯对话会话可能没有 workingDirectory；parent Durable Run 的 workspace 断言非空，
  // 与 cwd 一样回退到 process.cwd()（对话型配方 agent 不落文件，中性 cwd 即可）。
  const workspace = session.workingDirectory ?? process.cwd();
  const requestedRunId = `team_recipe_${crypto.randomUUID()}`;
  const parentRun = await getApplicationRunRegistry().startDurable({
    sessionId: args.sessionId,
    runId: requestedRunId,
    workspace,
    cwd: workspace,
  });
  const parentRunId = parentRun.context.runId;
  const context: SubagentExecutionContext = {
    runId: parentRunId,
    sessionId: args.sessionId,
    workspace,
    cwd: workspace,
    modelConfig: session.modelConfig,
    resolver: getToolResolver(),
    permission: { request: async () => true },
    events: { emit: () => undefined },
    abortSignal: new AbortController().signal,
    currentToolCallId: `${parentRunId}-team-recipe`,
  };

  const title = `${recipe.name}·${args.topic}`.slice(0, 120);
  const terminalParent = async (status: 'completed' | 'failed', reason?: string) => {
    try {
      await registry.terminalDurable(parentRunId, {
        now: Date.now(),
        status,
        reason,
        event: {
          type: status === 'completed' ? 'team_recipe_completed' : 'team_recipe_failed',
          payload: { recipeId: recipe.id, sessionId: args.sessionId, reason },
          recordedAt: Date.now(),
        },
      }, parentRun);
    } catch (error) {
      console.warn('[TeamRecipe] parent Durable Run 清理失败', error);
    }
  };
  void launchAgentTeam(agents, context)
    .then(async (result) => {
      if (!result.success) console.warn('[TeamRecipe] 团队未成功启动/完成', result.error);
      archiveTeamResult(result, {
        projectId: session.projectId ?? null,
        title,
        sourceSessionId: args.sessionId,
      });
      await terminalParent(result.success ? 'completed' : 'failed', result.error);
    })
    .catch(async (error) => {
      console.warn('[TeamRecipe] 团队运行失败', error);
      await terminalParent('failed', error instanceof Error ? error.message : String(error));
    });

  return { ok: true, runId: parentRunId };
}
