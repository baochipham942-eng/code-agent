// ============================================================================
// Agent Definition - 混合架构适配层
// ============================================================================
//
// 本文件是 hybrid/ 模块的适配层。
// 核心逻辑在 hybrid/ 模块：
// - coreAgents.ts: 4 个核心角色定义
// - dynamicFactory.ts: 动态 Agent 生成
// - taskRouter.ts: 智能路由
// - agentSwarm.ts: 并行执行引擎
// ============================================================================

// 重新导出分层类型（从 shared/types/agentTypes.ts）
export type {
  ModelTier,
  AgentCore,
  AgentRuntime,
  AgentSecurity,
  AgentLayer,
  ParallelCapability,
  AgentCoordination,
  FullAgentConfig,
  DynamicAgentConfig,
  AgentDefinition,
} from '../../shared/types/agentTypes';

export {
  MODEL_TIER_CONFIG,
  DEFAULT_RUNTIME,
  DEFAULT_SECURITY,
  DEFAULT_COORDINATION,
  resolveModelTier,
  getEffectiveRuntime,
  getEffectiveSecurity,
  getEffectiveCoordination,
  isFullAgentConfig,
  isReadonlyAgent,
  canRunInParallel,
} from '../../shared/types/agentTypes';

// 重新导出上下文级别配置
export {
  type ContextLevel,
  AGENT_CONTEXT_LEVELS,
  getAgentContextLevel,
} from './subagentContextBuilder';

// 导入混合架构模块
import {
  type CoreAgentId,
  type CoreAgentConfig,
  CORE_AGENTS,
  CORE_AGENT_IDS,
  isCoreAgent,
  recommendCoreAgent,
  getModelConfig,
  MODEL_CONFIG,
} from './hybrid';

import type { FullAgentConfig } from '../../shared/types/agentTypes';
import type { PermissionPreset } from '../services/core/permissionPresets';
import type { ModelProvider } from '../../shared/types/model';

// ============================================================================
// 核心角色到完整配置的适配
// ============================================================================

/**
 * 将 CoreAgentConfig 转换为 FullAgentConfig
 */
function toFullAgentConfig(core: CoreAgentConfig): FullAgentConfig {
  return {
    id: core.id,
    name: core.name,
    description: core.description,
    prompt: core.prompt,
    tools: core.tools,
    model: core.model === 'fast' ? 'fast' : core.model === 'powerful' ? 'powerful' : 'balanced',
    runtime: {
      maxIterations: core.maxIterations,
    },
    security: {
      permissionPreset: 'development',
    },
    coordination: {
      layer: core.readonly ? 'exploration' : 'execution',
      canDelegate: false,
      canParallelWith: core.readonly ? 'all' : 'readonly',
      readonly: core.readonly,
    },
    tags: core.readonly ? ['readonly'] : [],
  };
}

// ============================================================================
// 预定义 Agents（4 个核心角色）
// ============================================================================

/**
 * 预定义 Agents
 *
 * 混合架构只有 4 个核心角色：coder, reviewer, explore, plan
 * 复杂任务通过 TaskRouter 路由到动态 Agent 或 Agent Swarm
 */
export const PREDEFINED_AGENTS: Record<string, FullAgentConfig> = Object.fromEntries(
  CORE_AGENT_IDS.map(id => [id, toFullAgentConfig(CORE_AGENTS[id])])
);

// ============================================================================
// API 函数
// ============================================================================

/**
 * 获取预定义 Agent
 *
 * @throws 如果 ID 无效则抛出错误
 */
export function getPredefinedAgent(id: string): FullAgentConfig {
  if (!isCoreAgent(id)) {
    throw new Error(`Invalid agent ID: "${id}". Valid IDs: ${CORE_AGENT_IDS.join(', ')}`);
  }
  return PREDEFINED_AGENTS[id];
}

/**
 * 列出所有预定义 Agent ID
 */
export function listPredefinedAgentIds(): string[] {
  return [...CORE_AGENT_IDS];
}

/**
 * 列出所有预定义 Agent
 */
export function listPredefinedAgents(): Array<{ id: string; name: string; description: string }> {
  return CORE_AGENT_IDS.map(id => ({
    id,
    name: CORE_AGENTS[id].name,
    description: CORE_AGENTS[id].description,
  }));
}

/**
 * 检查是否为预定义 Agent
 */
export function isPredefinedAgent(id: string): boolean {
  return isCoreAgent(id);
}

/**
 * 按标签获取 Agents
 */
export function getAgentsByTag(tag: string): FullAgentConfig[] {
  return Object.values(PREDEFINED_AGENTS).filter(agent => agent.tags?.includes(tag));
}

/**
 * 按层级获取 Agents
 */
export function getAgentsByLayer(layer: 'exploration' | 'planning' | 'execution'): FullAgentConfig[] {
  return Object.values(PREDEFINED_AGENTS).filter(
    agent => agent.coordination?.layer === layer
  );
}

// ============================================================================
// Agent 配置访问函数
// ============================================================================

/**
 * 获取 Agent 的系统提示词
 */
export function getAgentPrompt(agent: FullAgentConfig): string {
  return agent.prompt;
}

/**
 * 获取 Agent 的工具列表
 */
export function getAgentTools(agent: FullAgentConfig, _includeToolSearch = true): string[] {
  if (!agent.tools || agent.tools.length === 0) {
    console.warn(`[AgentDefinition] Agent "${agent.name || agent.id}" has no tools defined`);
  }
  return agent.tools || [];
}

/**
 * 获取 Agent 的最大迭代次数
 */
export function getAgentMaxIterations(agent: FullAgentConfig): number {
  return agent.runtime?.maxIterations ?? 20;
}

/**
 * 获取 Agent 的权限预设
 */
export function getAgentPermissionPreset(agent: FullAgentConfig): PermissionPreset {
  return agent.security?.permissionPreset ?? 'development';
}

/**
 * 获取 Agent 的最大预算
 */
export function getAgentMaxBudget(agent: FullAgentConfig): number | undefined {
  return agent.runtime?.maxBudget;
}

// ============================================================================
// 任务复杂度和迭代次数
// ============================================================================

/**
 * 任务复杂度类型
 */
export type TaskComplexity = 'simple' | 'moderate' | 'complex';

/**
 * 估算任务复杂度
 */
export function estimateTaskComplexity(prompt: string): TaskComplexity {
  const lower = prompt.toLowerCase();

  const simpleIndicators = ['find', 'list', 'read', 'get', 'show', 'what is', '查找', '读取', '列出'];
  const complexIndicators = ['analyze', 'refactor', 'design', 'comprehensive', 'detailed', '分析', '重构', '设计', '全面'];

  const hasComplex = complexIndicators.some(i => lower.includes(i));
  const hasMultipleTasks = (prompt.match(/\d+\./g) || []).length >= 3;
  const isLong = prompt.length > 500;

  if (hasComplex || hasMultipleTasks || isLong) {
    return 'complex';
  }

  const hasSimple = simpleIndicators.some(i => lower.includes(i));
  const isShort = prompt.length < 100;

  if (hasSimple && isShort) {
    return 'simple';
  }

  return 'moderate';
}

/**
 * 计算最大迭代次数
 */
export function calculateMaxIterations(agentId: string, prompt: string): number {
  if (!isCoreAgent(agentId)) {
    throw new Error(`Invalid agent ID: "${agentId}"`);
  }

  const baseIterations = CORE_AGENTS[agentId].maxIterations;
  const complexity = estimateTaskComplexity(prompt);

  const factor = { simple: 0.6, moderate: 1.0, complex: 1.3 }[complexity];
  const calculated = Math.round(baseIterations * factor);

  return Math.max(3, Math.min(calculated, 30));
}

/**
 * 获取 Agent 的动态最大迭代次数
 */
export function getAgentDynamicMaxIterations(agent: FullAgentConfig, prompt?: string): number {
  if (prompt && isCoreAgent(agent.id)) {
    return calculateMaxIterations(agent.id, prompt);
  }
  return getAgentMaxIterations(agent);
}

// ============================================================================
// 子代理模型配置
// ============================================================================

/**
 * 获取子代理模型配置
 *
 * 使用混合架构的模型层级：
 * - explore → fast (GLM-4-Flash)
 * - reviewer, plan → balanced (GLM-4.7)
 * - coder → powerful (Kimi K2.5)
 */
export function getSubagentModelConfig(agentId: string): { provider: ModelProvider; model: string } {
  if (!isCoreAgent(agentId)) {
    throw new Error(`Invalid agent ID: "${agentId}". Valid IDs: ${CORE_AGENT_IDS.join(', ')}`);
  }

  const tier = CORE_AGENTS[agentId].model;
  return MODEL_CONFIG[tier];
}

/**
 * 获取子代理完整模型配置
 */
export function getSubagentFullModelConfig(
  agentId: string,
  baseConfig: { apiKey?: string; baseUrl?: string }
): { provider: ModelProvider; model: string; apiKey?: string; baseUrl?: string } {
  const modelConfig = getSubagentModelConfig(agentId);
  return {
    ...modelConfig,
    apiKey: baseConfig.apiKey,
    baseUrl: baseConfig.baseUrl,
  };
}

// ============================================================================
// 重新导出混合架构模块
// ============================================================================

export {
  // 核心类型
  type CoreAgentId,
  type CoreAgentConfig,

  // 核心常量
  CORE_AGENTS,
  CORE_AGENT_IDS,
  MODEL_CONFIG,

  // 核心函数
  isCoreAgent,
  recommendCoreAgent,
  getModelConfig,
} from './hybrid';

// 导出路由和 Swarm（高级用法）
export {
  type RoutingDecision,
  type RoutingContext,
  routeTask,

  type SwarmResult,
  executeSwarm,
  cleanupTaskAgents,
} from './hybrid';
