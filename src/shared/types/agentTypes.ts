// ============================================================================
// Agent Types - 分层 Agent 类型定义
// ============================================================================
//
// 4 层架构：
// 1. AgentCore - 核心行为定义（对齐 SDK）
// 2. AgentRuntime - 运行时约束
// 3. AgentSecurity - 安全控制
// 4. AgentCoordination - 多 Agent 协调
// ============================================================================

import type { PermissionPreset } from '../../main/services/core/permissionPresets';

// ============================================================================
// 第 1 层：核心行为定义
// ============================================================================

/**
 * 模型层级
 * - fast: 快速任务，使用高效模型 (haiku)
 * - balanced: 标准任务 (sonnet)
 * - powerful: 复杂推理任务 (opus)
 * - inherit: 继承父级模型配置
 */
export type ModelTier = 'fast' | 'balanced' | 'powerful' | 'inherit';

/**
 * 核心 Agent 定义 - 对齐官方 SDK
 *
 * 定义 Agent 的基本行为，只包含必要字段
 */
export interface AgentCore {
  /** Agent 的用途和能力描述 */
  description: string;

  /** 系统提示词，定义 Agent 行为 */
  prompt: string;

  /** 可用工具列表 */
  tools?: string[];

  /** 模型层级 */
  model?: ModelTier;

  /** 输出格式约束（可选，用于需要结构化输出的 Agent） */
  outputSchema?: Record<string, unknown>;
}

// ============================================================================
// 第 2 层：运行时约束
// ============================================================================

/**
 * 运行时配置 - 执行约束
 *
 * 控制 Agent 执行的资源限制，可在运行时覆盖
 */
export interface AgentRuntime {
  /** 最大迭代次数（默认: 20） */
  maxIterations?: number;

  /** 超时时间（毫秒） */
  timeout?: number;

  /** 最大预算（美元） */
  maxBudget?: number;

  /** 重试策略 */
  retryPolicy?: {
    maxRetries: number;
    backoffMs: number;
  };
}

// ============================================================================
// 第 3 层：安全控制
// ============================================================================

/**
 * 安全配置 - 权限和访问控制
 */
export interface AgentSecurity {
  /** 权限预设 */
  permissionPreset: PermissionPreset;

  /** 允许访问的路径（可选） */
  allowedPaths?: string[];

  /** 禁止的命令模式（可选） */
  blockedCommands?: string[];
}

// ============================================================================
// 第 4 层：多 Agent 协调
// ============================================================================

/**
 * Agent 执行层级
 * - exploration: 探索层（只读，可高度并行）
 * - planning: 规划层（只读 + 输出计划）
 * - execution: 执行层（读写，需权限）
 */
export type AgentLayer = 'exploration' | 'planning' | 'execution';

/**
 * 并行能力类型
 * - all: 可与任何 Agent 并行
 * - readonly: 只能与只读 Agent 并行
 * - none: 不能并行，必须串行
 */
export type ParallelCapability = 'all' | 'readonly' | 'none';

/**
 * 协调配置 - 多 Agent 系统协调
 */
export interface AgentCoordination {
  /** 执行层级 */
  layer?: AgentLayer;

  /** 是否可以创建子 Agent */
  canDelegate?: boolean;

  /** 允许创建的子 Agent 类型 */
  allowedSubagents?: string[];

  /** 并行能力 */
  canParallelWith?: ParallelCapability;

  /** 最大实例数 */
  maxInstances?: number;

  /** 是否只读（不修改文件） */
  readonly?: boolean;
}

// ============================================================================
// 完整 Agent 配置
// ============================================================================

/**
 * 完整 Agent 配置
 *
 * 组合 4 层配置，用于完整的 Agent 定义
 */
export interface FullAgentConfig extends AgentCore {
  /** 唯一标识 */
  id: string;

  /** 显示名称 */
  name: string;

  /** 运行时配置 */
  runtime?: AgentRuntime;

  /** 安全配置 */
  security?: AgentSecurity;

  /** 协调配置 */
  coordination?: AgentCoordination;

  /** 分类标签 */
  tags?: string[];
}

/**
 * AgentDefinition - FullAgentConfig 的兼容性别名
 * @deprecated 使用 FullAgentConfig 代替
 */
export type AgentDefinition = FullAgentConfig;

// ============================================================================
// 动态 Agent 配置（运行时创建）
// ============================================================================

/**
 * 动态 Agent 配置
 *
 * 用于运行时创建的自定义 Agent
 * 支持分层配置和扁平化配置（向后兼容）
 */
export interface DynamicAgentConfig {
  /** 可选名称 */
  name?: string;

  /** 系统提示词（分层结构） */
  prompt?: string;

  /** 系统提示词（向后兼容，等同于 prompt） */
  systemPrompt?: string;

  /** 工具列表 */
  tools: string[];

  /** 运行时配置（分层结构） */
  runtime?: AgentRuntime;

  /** 安全配置（分层结构，默认使用 'development'） */
  security?: Partial<AgentSecurity>;

  // ---- 向后兼容的扁平化字段 ----

  /** 最大迭代次数（向后兼容，等同于 runtime.maxIterations） */
  maxIterations?: number;

  /** 最大预算（向后兼容，等同于 runtime.maxBudget） */
  maxBudget?: number;

  /** 权限预设（向后兼容，等同于 security.permissionPreset） */
  permissionPreset?: PermissionPreset;
}

// ============================================================================
// 默认配置
// ============================================================================

/**
 * 模型层级配置映射
 */
export const MODEL_TIER_CONFIG: Record<Exclude<ModelTier, 'inherit'>, {
  model: string;
  maxTurns: number;
  timeout: number;
}> = {
  fast: { model: 'haiku', maxTurns: 10, timeout: 30_000 },
  balanced: { model: 'sonnet', maxTurns: 20, timeout: 120_000 },
  powerful: { model: 'opus', maxTurns: 50, timeout: 600_000 },
};

/**
 * 默认运行时配置
 */
export const DEFAULT_RUNTIME: Required<Omit<AgentRuntime, 'retryPolicy'>> = {
  maxIterations: 20,
  timeout: 120_000,
  maxBudget: 1.0,
};

/**
 * 默认安全配置
 */
export const DEFAULT_SECURITY: AgentSecurity = {
  permissionPreset: 'development',
};

/**
 * 默认协调配置
 */
export const DEFAULT_COORDINATION: AgentCoordination = {
  layer: 'execution',
  canDelegate: false,
  canParallelWith: 'readonly',
  maxInstances: 5,
  readonly: false,
};

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 解析模型层级到实际模型名
 */
export function resolveModelTier(tier: ModelTier | undefined, parentModel?: string): string {
  if (!tier || tier === 'inherit') {
    return parentModel || MODEL_TIER_CONFIG.balanced.model;
  }
  return MODEL_TIER_CONFIG[tier].model;
}

/**
 * 获取有效运行时配置（应用默认值）
 */
export function getEffectiveRuntime(config?: AgentRuntime): Required<Omit<AgentRuntime, 'retryPolicy'>> & Pick<AgentRuntime, 'retryPolicy'> {
  return {
    maxIterations: config?.maxIterations ?? DEFAULT_RUNTIME.maxIterations,
    timeout: config?.timeout ?? DEFAULT_RUNTIME.timeout,
    maxBudget: config?.maxBudget ?? DEFAULT_RUNTIME.maxBudget,
    retryPolicy: config?.retryPolicy,
  };
}

/**
 * 获取有效安全配置（应用默认值）
 */
export function getEffectiveSecurity(config?: Partial<AgentSecurity>): AgentSecurity {
  return {
    permissionPreset: config?.permissionPreset ?? DEFAULT_SECURITY.permissionPreset,
    allowedPaths: config?.allowedPaths,
    blockedCommands: config?.blockedCommands,
  };
}

/**
 * 获取有效协调配置（应用默认值）
 */
export function getEffectiveCoordination(config?: AgentCoordination): Required<Omit<AgentCoordination, 'allowedSubagents'>> & Pick<AgentCoordination, 'allowedSubagents'> {
  return {
    layer: config?.layer ?? DEFAULT_COORDINATION.layer!,
    canDelegate: config?.canDelegate ?? DEFAULT_COORDINATION.canDelegate!,
    allowedSubagents: config?.allowedSubagents,
    canParallelWith: config?.canParallelWith ?? DEFAULT_COORDINATION.canParallelWith!,
    maxInstances: config?.maxInstances ?? DEFAULT_COORDINATION.maxInstances!,
    readonly: config?.readonly ?? DEFAULT_COORDINATION.readonly!,
  };
}

// ============================================================================
// 类型守卫
// ============================================================================

/**
 * 检查是否为完整 Agent 配置
 */
export function isFullAgentConfig(config: unknown): config is FullAgentConfig {
  return (
    typeof config === 'object' &&
    config !== null &&
    'id' in config &&
    'name' in config &&
    'description' in config &&
    'prompt' in config
  );
}

/**
 * 检查 Agent 是否只读
 */
export function isReadonlyAgent(config: FullAgentConfig): boolean {
  return config.coordination?.readonly === true ||
    config.coordination?.layer === 'exploration' ||
    config.coordination?.layer === 'planning';
}

/**
 * 检查两个 Agent 是否可以并行执行
 */
export function canRunInParallel(agentA: FullAgentConfig, agentB: FullAgentConfig): boolean {
  const capA = agentA.coordination?.canParallelWith ?? 'readonly';
  const capB = agentB.coordination?.canParallelWith ?? 'readonly';

  // 任一为 none，不能并行
  if (capA === 'none' || capB === 'none') {
    return false;
  }

  // 任一为 all，可以并行
  if (capA === 'all' || capB === 'all') {
    return true;
  }

  // 都是 readonly，只有双方都是只读层才能并行
  return isReadonlyAgent(agentA) || isReadonlyAgent(agentB);
}
