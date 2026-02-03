// ============================================================================
// Hybrid Agent Architecture - 混合式多 Agent 架构
// ============================================================================
//
// 三层架构：
// 1. Layer 1: 核心角色（4 个，覆盖 80% 场景）
// 2. Layer 2: 动态扩展（按需生成专用 Agent）
// 3. Layer 3: 智能路由（自动决策）
//
// 设计原则：
// - 简单任务用核心角色（快速、可预测）
// - 复杂任务用动态扩展（灵活、专业化）
// - 超复杂任务用 Agent Swarm（并行、高效）
//
// ============================================================================

// Core Agents (Layer 1)
export {
  type CoreAgentId,
  type CoreAgentConfig,
  type ModelTier,
  CORE_AGENTS,
  CORE_AGENT_IDS,
  MODEL_CONFIG,
  getCoreAgent,
  getAgent,
  listCoreAgents,
  getModelConfig,
  getAgentModelConfig,
  isReadonlyAgent,
  isCoreAgent,
  validateAgentId,
  recommendCoreAgent,
} from './coreAgents';

// Dynamic Factory (Layer 2)
export {
  type DynamicAgentSpec,
  type DynamicAgentConfig,
  type GenerationContext,
  type GenerationResult,
  DynamicAgentFactory,
  getDynamicAgentFactory,
  generateAnalysisPrompt,
} from './dynamicFactory';

// Task Router (Layer 3)
export {
  type TaskComplexity,
  type RoutingDecisionType,
  type CoreRoutingDecision,
  type DynamicRoutingDecision,
  type SwarmRoutingDecision,
  type RoutingDecision,
  type SwarmConfig,
  type TaskAnalysis,
  type RoutingContext,
  TaskRouter,
  getTaskRouter,
  analyzeTask,
} from './taskRouter';

// Agent Swarm
export {
  type AgentStatus,
  type ReportType,
  type AgentReport,
  type AgentRuntime,
  type SwarmResult,
  type AgentExecutor,
  AgentSwarm,
  getAgentSwarm,
} from './agentSwarm';

// ============================================================================
// Convenience Functions
// ============================================================================

import { getTaskRouter, type RoutingContext, type RoutingDecision } from './taskRouter';
import { getAgentSwarm, type AgentExecutor, type SwarmResult } from './agentSwarm';
import { getDynamicAgentFactory } from './dynamicFactory';

/**
 * 快速路由任务
 *
 * @example
 * const decision = await routeTask({ task: 'Fix the bug in login.ts' });
 * if (decision.type === 'core') {
 *   // 使用核心角色执行
 * }
 */
export async function routeTask(context: RoutingContext): Promise<RoutingDecision> {
  const router = getTaskRouter();
  return router.route(context);
}

/**
 * 执行 Agent Swarm
 *
 * @example
 * const result = await executeSwarm(agents, config, executor);
 * console.log(result.aggregatedOutput);
 */
export async function executeSwarm(
  decision: { agents: import('./dynamicFactory').DynamicAgentConfig[]; config: import('./taskRouter').SwarmConfig },
  executor: AgentExecutor
): Promise<SwarmResult> {
  const swarm = getAgentSwarm();
  return swarm.execute(decision.agents, decision.config, executor);
}

/**
 * 清理任务相关的动态 Agent
 */
export function cleanupTaskAgents(parentTaskId: string): void {
  const factory = getDynamicAgentFactory();
  factory.destroyTaskAgents(parentTaskId);
}

// ============================================================================
// Usage Example
// ============================================================================

/*
// 1. 路由任务
const decision = await routeTask({
  task: 'Refactor the authentication module to use JWT tokens',
  workingDirectory: '/path/to/project',
});

// 2. 根据决策类型执行
switch (decision.type) {
  case 'core':
    // 使用核心角色
    await executeWithCoreAgent(decision.agent, task);
    break;

  case 'dynamic':
    // 使用动态 Agent（顺序或简单并行）
    for (const agent of decision.agents) {
      await executeAgent(agent);
    }
    break;

  case 'swarm':
    // 使用 Agent Swarm（复杂并行）
    const result = await executeSwarm(decision, myExecutor);
    console.log(result.aggregatedOutput);
    break;
}

// 3. 清理
cleanupTaskAgents(sessionId);
*/
