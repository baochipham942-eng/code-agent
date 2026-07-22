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
import { generateMessageId } from '../../../shared/utils/id';

export interface LaunchTeamRecipeResult {
  ok: boolean;
  error?: string;
  sessionId?: string;
  runId?: string;
}

/** 铁律校验查 swarm run 的回溯条数：按 started_at 倒序，本轮 run 必在最近这批里。 */
const SWARM_RUN_LOOKUP_LIMIT = 100;

interface CompiledRecipeAgent {
  role: string;
  task: string;
  dependsOn?: string[];
}

interface TeamRecipeLaunchInput {
  sessionId: string;
  recipeId: string;
  topic: string;
}

interface ValidatedTeamRecipeLaunch extends TeamRecipeLaunchInput {
  recipe: TeamRecipe;
  session: NonNullable<Awaited<ReturnType<ReturnType<typeof getSessionManager>['getSession']>>>;
  workspace: string;
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

/** 主理人主会话轮的固定脚手架；保持纯函数，供单测锁定工具调用合同。 */
export function buildLeadBrief(recipe: TeamRecipe, topic: string): string {
  if (!recipe.lead) throw new Error('buildLeadBrief 需要 lead 配方');

  const members = recipe.members.map((member) => ({
    role: member.roleId,
    task: member.taskTemplate.split('{topic}').join(topic),
  }));
  const brief = recipe.lead.briefTemplate.split('{topic}').join(topic);

  return `${brief}\n\n` +
    '执行铁律：第一步必须调用 spawn_agent，parallel=true，并将下方 agents JSON 原样传入；一次调用起全部成员。' +
    '禁止你自己代写成员的专业产出。成员回报后，由你基于成员产出综述并定稿。\n\n' +
    `agents JSON：\n${JSON.stringify(members, null, 2)}`;
}

/** 团队完成后归档聚合产物到项目资料库。部分成员失败仍归档，并显式标出缺席。 */
export function archiveTeamResult(
  result: MultiagentExecutionResult,
  meta: { projectId: string | null; title: string; sourceSessionId: string },
): void {
  const output = typeof result.output === 'string' ? result.output.trim() : '';
  if (!output) return;

  const partialFailure = !result.success;
  const absentNotice = partialFailure
    ? `\n\n> 缺席成员：${result.error?.trim() || '部分成员未完成，具体原因未记录。'}`
    : '';

  try {
    getLibraryService().archiveText({
      projectId: meta.projectId,
      title: partialFailure ? `${meta.title}（部分成员缺席）` : meta.title,
      text: `${output}${absentNotice}`,
      tags: ['定稿'],
      sourceSessionId: meta.sourceSessionId,
    });
  } catch (error) {
    console.warn('[TeamRecipe] 聚合产物归档失败（团队本身已完成）', error);
  }
}

/** 原有 durable 团队路径；lead 不可用或验真失败时的唯一降级目标。 */
export async function launchTeamRecipeDeterministic(
  input: ValidatedTeamRecipeLaunch,
): Promise<LaunchTeamRecipeResult> {
  const registry = getConfiguredApplicationRunRegistry();
  if (!registry) {
    return { ok: false, error: '组队功能需要 Durable 运行时' };
  }

  // 起点消息既让会话可见组队请求，也是 Native Durable 工具 checkpoint 的 sourceMessageId 锚点
  // （prepareNativeToolCheckpoint 取会话最后一条 user 消息，缺则每个工具调用都抛）。
  // 主理人路径不需要它——sendMessage 自己会落一条 user 消息，重复落会让会话出现两条起点。
  await getSessionManager().addMessageToSession(input.sessionId, {
    id: generateMessageId(),
    role: 'user',
    content: `【组队 · ${input.recipe.name}】${input.topic}`,
    timestamp: Date.now(),
  });

  const agents = compileRecipeToAgents(input.recipe, input.topic);
  const requestedRunId = `team_recipe_${crypto.randomUUID()}`;
  // Durable kernel 是启动后异步配置的（实测冷启后约 13s 才 ready）；这期间点配方会抛，
  // 必须给出人话原因而不是让 fire-and-forget 变成未捕获拒绝。
  let parentRun;
  try {
    parentRun = await getApplicationRunRegistry().startDurable({
      sessionId: input.sessionId,
      runId: requestedRunId,
      workspace: input.workspace,
      cwd: input.workspace,
    });
  } catch (error) {
    console.warn('[TeamRecipe] 确定性组队起 Durable 父 run 失败', error);
    return { ok: false, error: '组队运行时尚未就绪，请稍后重试' };
  }
  const parentRunId = parentRun.context.runId;
  const context: SubagentExecutionContext = {
    runId: parentRunId,
    sessionId: input.sessionId,
    workspace: input.workspace,
    cwd: input.workspace,
    modelConfig: input.session.modelConfig,
    resolver: getToolResolver(),
    permission: { request: async () => true },
    events: { emit: () => undefined },
    abortSignal: new AbortController().signal,
    currentToolCallId: `${parentRunId}-team-recipe`,
  };

  const title = `${input.recipe.name}·${input.topic}`.slice(0, 120);
  const terminalParent = async (status: 'completed' | 'failed', reason?: string) => {
    try {
      await registry.terminalDurable(parentRunId, {
        now: Date.now(),
        status,
        reason,
        event: {
          type: status === 'completed' ? 'team_recipe_completed' : 'team_recipe_failed',
          payload: { recipeId: input.recipe.id, sessionId: input.sessionId, reason },
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
        projectId: input.session.projectId ?? null,
        title,
        sourceSessionId: input.sessionId,
      });
      await terminalParent(result.success ? 'completed' : 'failed', result.error);
    })
    .catch(async (error) => {
      console.warn('[TeamRecipe] 团队运行失败', error);
      await terminalParent('failed', error instanceof Error ? error.message : String(error));
    });

  return { ok: true, runId: parentRunId };
}

async function launchTeamRecipeViaLead(input: ValidatedTeamRecipeLaunch): Promise<void> {
  const lead = input.recipe.lead;
  if (!lead) return;

  const { getTaskManager } = await import('../../task');
  const orchestrator = getTaskManager().getOrCreateCurrentOrchestrator(input.sessionId);
  if (!orchestrator) {
    console.warn('[TeamRecipe] 主理人降级：拿不到当前会话 orchestrator');
    await launchTeamRecipeDeterministic(input);
    return;
  }

  const { buildRoleContextBlock } = await import('../roleAssets/roleAssetService');
  const contextBlock = await buildRoleContextBlock(lead.roleId, input.workspace);
  if (!contextBlock) {
    console.warn(`[TeamRecipe] 主理人降级：roleId=${lead.roleId} 不是可解析的持久化角色`);
    await launchTeamRecipeDeterministic(input);
    return;
  }

  const startedAt = Date.now();
  try {
    await orchestrator.sendMessage(buildLeadBrief(input.recipe, input.topic), undefined, {
      mode: 'normal',
      agentOverrideId: lead.roleId,
      turnSystemContext: [contextBlock],
    });
  } catch (error) {
    console.warn('[TeamRecipe] 主理人降级：主会话轮执行失败', error);
    await launchTeamRecipeDeterministic(input);
    return;
  }

  // 铁律校验先于取稿：成员到底跑没跑，决定了「降级重跑」是省钱补救还是二次全额付费。
  // 查询本身出错时按「跑过」处理（fail-open）——重跑一整个团队的代价远高于漏判一次。
  let membersRan = true;
  try {
    // 两条证据取并集：SpawnGuard 覆盖全部委派形态（spawn_agent 单发 / 并行 / Task 工具都在这里注册），
    // swarm_runs 是并行路径的持久化痕迹，在 SpawnGuard 的 5 分钟清理窗口之后仍然可查。
    const { getSpawnGuard } = await import('../../agent/spawnGuard');
    const spawnedMember = getSpawnGuard().list({ sessionId: input.sessionId })
      .some((agent) => agent.createdAt >= startedAt);

    const { getDatabase } = await import('../core');
    const swarmMember = getDatabase().getSwarmTraceRepo().listRuns(SWARM_RUN_LOOKUP_LIMIT)
      .some((run) => run.sessionId === input.sessionId && run.startedAt >= startedAt && run.completedCount > 0);

    membersRan = spawnedMember || swarmMember;
  } catch (error) {
    console.warn('[TeamRecipe] 成员 run 铁律校验查询失败，按已跑处理（不重跑团队）', error);
  }

  if (!membersRan) {
    // 主理人没起团就自己出稿 = WorkBuddy 铁律④「禁止主理人代写成员产出」违规。
    // 此时几乎没花钱，降级重跑是划算的补救。
    console.warn('[TeamRecipe] 主理人降级：未发现本轮已完成成员 run，丢弃主理人自写稿');
    await launchTeamRecipeDeterministic(input);
    return;
  }

  const sessionWithMessages = await getSessionManager().getSession(input.sessionId);
  const assistantMessages = (sessionWithMessages?.messages ?? []).filter(
    (message) => message.role === 'assistant' && message.content,
  );
  const finalOutput = assistantMessages.length > 0
    ? assistantMessages[assistantMessages.length - 1].content.trim()
    : '';
  if (!finalOutput) {
    // 成员已真跑过，重跑要再付一整个团队的钱，且讨论流已在会话里 —— 只报警不重跑。
    console.warn('[TeamRecipe] 主理人无可归档定稿；成员已跑过故不重跑团队，本次无定稿入库');
    return;
  }

  try {
    getLibraryService().archiveText({
      projectId: input.session.projectId ?? null,
      title: `${input.recipe.name}·${input.topic}`.slice(0, 120),
      text: finalOutput,
      tags: ['定稿'],
      sourceSessionId: input.sessionId,
    });
  } catch (error) {
    console.warn('[TeamRecipe] 主理人定稿归档失败', error);
  }
}

/** 用户点配方：lead 配方由主理人主会话轮自己起团；其余走确定性 durable 路径。 */
export async function launchTeamRecipe(args: TeamRecipeLaunchInput): Promise<LaunchTeamRecipeResult> {
  const recipe = TEAM_RECIPES.find((candidate) => candidate.id === args.recipeId);
  if (!recipe) return { ok: false, error: '配方不存在' };

  const knownRoleIds = new Set(listAllAgents().map((agent) => agent.id));
  const errors = validateTeamRecipe(recipe, knownRoleIds);
  if (errors.length > 0) return { ok: false, error: errors.map((error) => error.reason).join('; ') };

  const session = await getSessionManager().getSession(args.sessionId);
  if (!session) return { ok: false, error: '会话不存在' };

  if (!getConfiguredApplicationRunRegistry()) {
    return { ok: false, error: '组队功能需要 Durable 运行时' };
  }

  const input: ValidatedTeamRecipeLaunch = {
    ...args,
    recipe,
    session,
    workspace: session.workingDirectory ?? process.cwd(),
  };
  if (!recipe.lead) {
    console.warn('[TeamRecipe] 主理人降级：配方未配置 lead，走确定性组队路径');
    return launchTeamRecipeDeterministic(input);
  }

  void launchTeamRecipeViaLead(input).catch((error) => {
    console.warn('[TeamRecipe] 主理人流程异常退出', error);
  });
  return { ok: true, sessionId: args.sessionId };
}
