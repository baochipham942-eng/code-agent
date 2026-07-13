// ============================================================================
// Swarm Goal（P4）集成胶水 — goal 循环与 workflow 扇出之间的预算双向打通 + 编排引导
// 设计见 内部文档 §4.1
//
// 独立成模块的原因：
// 1. toolExecutionEngine / conversationRuntime 都贴着 max-lines 上限，胶水逻辑不进主文件
// 2. clamp / 记账是纯逻辑，独立模块便于确定性单测（E2E AC3）
// ============================================================================

import type { ToolCall, ToolResult } from '../../../shared/contract';
import type { GoalModeController } from '../goalModeController';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('SwarmGoal');

/** workflow 工具名（dynamic-workflow 命令层入口，见 docs/architecture/dynamic-workflow.md） */
const WORKFLOW_TOOL_NAME = 'workflow';

/** 本模块只依赖 RuntimeContext 的这三个字段，窄化类型便于单测构造 */
export interface SwarmGoalRuntimeView {
  goalMode?: GoalModeController;
  stats: Pick<import('./runStatsState').RunStatsState, 'totalInputTokens' | 'totalOutputTokens'>;
}

/**
 * 预算下行 clamp：tool dispatch 前把 workflow 调用的 budgetTokens 压到
 * 「goal 剩余预算 × MAX_BUDGET_FRACTION」以内——budgetTokens 不可信模型自报。
 * 非 goal mode / 不允许 swarm / 无 workflow 调用时为 no-op。
 */
export function applySwarmBudgetClamp(ctx: SwarmGoalRuntimeView, toolCalls: ToolCall[]): void {
  const goalMode = ctx.goalMode;
  if (!goalMode?.isPending() || !goalMode.allowsSwarm()) {
    return;
  }
  const mainTokensUsed = ctx.stats.totalInputTokens + ctx.stats.totalOutputTokens;
  for (const call of toolCalls) {
    if (call.name !== WORKFLOW_TOOL_NAME) {
      continue;
    }
    const rawBudget = call.arguments?.budgetTokens;
    const requested = typeof rawBudget === 'number' ? rawBudget : undefined;
    const clamped = goalMode.clampSwarmBudget(requested, mainTokensUsed);
    call.arguments = { ...(call.arguments ?? {}), budgetTokens: clamped };
    logger.debug('[SwarmGoal] workflow budget clamped', { requested, clamped });
  }
}

/**
 * 预算上行记账：workflow 工具结果的 metadata.tokensSpent → goal 消耗，
 * 闸3 evaluateFallback 由此看见 swarm 子 agent 的真实消耗。
 * 无论结果成功失败都记账（失败路径 meta 也带 tokensSpent，token 已真实花掉）。
 */
export function recordSwarmSpend(
  goalMode: GoalModeController | undefined,
  toolCalls: ToolCall[],
  toolResults: Array<ToolResult | undefined>,
): void {
  if (!goalMode) {
    return;
  }
  for (const call of toolCalls) {
    if (call.name !== WORKFLOW_TOOL_NAME) {
      continue;
    }
    const result = toolResults.find((r) => r?.toolCallId === call.id);
    goalMode.recordSwarmTokens(result?.metadata?.tokensSpent);
  }
}

/**
 * goal 首轮注入 swarm 编排引导（仅 allowSwarm 时一次）：
 * 告知模型可用 workflow 工具扇出并行子 agent + 使用边界。
 */
export function maybeInjectSwarmGuidance(
  ctx: Pick<SwarmGoalRuntimeView, 'goalMode'>,
  inject: (message: string) => void,
  iteration: number,
): void {
  const goalMode = ctx.goalMode;
  if (iteration !== 1 || !goalMode?.isPending() || !goalMode.allowsSwarm()) {
    return;
  }
  inject(goalMode.buildSwarmGuidance());
  logger.debug('[SwarmGoal] swarm guidance injected');
}

/** goal 观测事件展示用：主 agent 消耗 + swarm 记账消耗（闸3 内部自己加总，这里只服务展示） */
export function goalTokensUsedWithSwarm(ctx: SwarmGoalRuntimeView): number {
  return ctx.stats.totalInputTokens + ctx.stats.totalOutputTokens + (ctx.goalMode?.getSwarmTokensUsed() ?? 0);
}
