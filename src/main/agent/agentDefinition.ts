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

// 重新导出分层类型（从 shared/contract/agentTypes.ts）
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
} from '../../shared/contract/agentTypes';

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
} from '../../shared/contract/agentTypes';

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

import {
  resolveAgent as registryResolveAgent,
  listAllAgents as registryListAllAgents,
} from './agentRegistry';
import { resolveTierModelConfig, type TierResolutionSettings } from '../model/modelDecision';
import { getConfigService } from '../services/core/configService';

import type { FullAgentConfig } from '../../shared/contract/agentTypes';
import type { PermissionPreset } from '@shared/contract';
import type { ModelProvider } from '../../shared/contract/model';

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
    skills: core.skills,
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
 * 获取预定义 / 自定义 Agent。
 *
 * 路由：先查 agentRegistry（自定义优先 + builtin 兜底），找不到再回退到
 * PREDEFINED_AGENTS（防御兜底，registry 未初始化时仍可工作）。
 *
 * @throws 如果 ID 既不是 builtin、也不在 registry 中则抛错
 */
export function getPredefinedAgent(id: string): FullAgentConfig {
  // 1) 自定义优先（含 builtin 兜底）
  const resolved = registryResolveAgent(id);
  if (resolved) {
    return toFullAgentConfig(resolved);
  }
  // 2) registry 未初始化时的最终兜底
  if (isCoreAgent(id)) {
    return PREDEFINED_AGENTS[id];
  }
  const availableIds = registryListAllAgents().map((a) => a.id);
  const knownIds = availableIds.length > 0 ? availableIds : [...CORE_AGENT_IDS];
  throw new Error(`Invalid agent ID: "${id}". Valid IDs: ${knownIds.join(', ')}`);
}

/**
 * 列出所有预定义 / 自定义 Agent ID。
 */
export function listPredefinedAgentIds(): string[] {
  const fromRegistry = registryListAllAgents().map((a) => a.id);
  if (fromRegistry.length > 0) return fromRegistry;
  return [...CORE_AGENT_IDS];
}

/**
 * 列出所有预定义 / 自定义 Agent。
 *
 * 返回结构兼容旧调用：{ id, name, description }，额外多挂一个 source 字段。
 */
export function listPredefinedAgents(): Array<{
  id: string;
  name: string;
  description: string;
  source?: 'builtin' | 'user' | 'project';
}> {
  const fromRegistry = registryListAllAgents();
  if (fromRegistry.length > 0) {
    return fromRegistry.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      source: a.source,
    }));
  }
  return CORE_AGENT_IDS.map(id => ({
    id,
    name: CORE_AGENTS[id].name,
    description: CORE_AGENTS[id].description,
    source: 'builtin' as const,
  }));
}

/**
 * 检查是否为预定义 / 已注册 Agent
 */
export function isPredefinedAgent(id: string): boolean {
  return registryResolveAgent(id) !== undefined || isCoreAgent(id);
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
 * 获取 Agent 的系统提示词。
 * 核心 5 个 subagent（coder / reviewer / explore / plan / awaiter）的 prompt
 * 已通过 applyOverride 包成 Proxy，访问时自动反映用户 override —— 直接返回
 * agent.prompt 即可。自定义 agent（agentMd 加载的）没接 registry，原样返回。
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
 * 计算最大迭代次数。
 *
 * 自定义 agent 走 registry 拿到的 maxIterations，builtin 走 CORE_AGENTS。
 */
export function calculateMaxIterations(agentId: string, prompt: string): number {
  const resolved = registryResolveAgent(agentId);
  let baseIterations: number;
  if (resolved) {
    baseIterations = resolved.maxIterations;
  } else if (isCoreAgent(agentId)) {
    baseIterations = CORE_AGENTS[agentId].maxIterations;
  } else {
    throw new Error(`Invalid agent ID: "${agentId}"`);
  }

  const complexity = estimateTaskComplexity(prompt);

  const factor = { simple: 0.6, moderate: 1.0, complex: 1.3 }[complexity];
  const calculated = Math.round(baseIterations * factor);

  return Math.max(3, Math.min(calculated, 30));
}

/**
 * 获取 Agent 的动态最大迭代次数。
 *
 * builtin 和自定义 agent 都走 calculateMaxIterations 做复杂度调节。
 */
export function getAgentDynamicMaxIterations(agent: FullAgentConfig, prompt?: string): number {
  if (prompt && (isCoreAgent(agent.id) || registryResolveAgent(agent.id))) {
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
 * 使用混合架构的模型层级（档位）：
 * - explore / awaiter → fast（免费档）
 * - reviewer / plan → balanced（标准档）
 * - coder → powerful（主力档 = 用户默认模型）
 *
 * ADR-019 批 2：档位经 resolveTierModelConfig 解析为用户已配置的 provider——
 * 内置推荐（如智谱免费模型）只在用户配了对应 key 时使用，否则降级到用户
 * 默认模型。分发版不因"没配某个特定厂商的 key"而坏。
 */
export function getSubagentModelConfig(agentId: string): { provider: ModelProvider; model: string } {
  const resolved = registryResolveAgent(agentId);
  const tier = resolved
    ? resolved.model
    : isCoreAgent(agentId)
      ? CORE_AGENTS[agentId].model
      : null;

  if (tier === null) {
    const knownIds = registryListAllAgents().map((a) => a.id);
    const fallback = knownIds.length > 0 ? knownIds.join(', ') : CORE_AGENT_IDS.join(', ');
    throw new Error(`Invalid agent ID: "${agentId}". Valid IDs: ${fallback}`);
  }

  return resolveTierModelConfig(tier, MODEL_CONFIG[tier], getTierResolutionSettingsSafe());
}

/** 从 configService 取档位解析所需的 settings 切片；不可用（测试/CLI）返回 undefined → 沿用内置默认 */
function getTierResolutionSettingsSafe(): TierResolutionSettings | undefined {
  try {
    const settings = getConfigService().getSettings();
    const models = settings.models;
    if (!models) return undefined;
    const defaultProvider = models.defaultProvider ?? models.default;
    return {
      defaultProvider,
      defaultModel: models.providers?.[defaultProvider]?.model,
      providers: models.providers,
      routingFast: models.routing?.fast,
    };
  } catch {
    return undefined;
  }
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

