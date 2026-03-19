// ============================================================================
// Hybrid Agent Types - Shared type definitions
// ============================================================================
// Extracted to break circular dependency between agentMdLoader ↔ coreAgents.

/**
 * 核心角色 ID（4 个）
 */
export type CoreAgentId = 'coder' | 'reviewer' | 'explore' | 'plan' | 'awaiter';

/**
 * 模型层级（3 级）
 */
export type ModelTier = 'fast' | 'balanced' | 'powerful';

/**
 * 核心角色配置（扁平化）
 */
export interface CoreAgentConfig {
  id: CoreAgentId;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  model: ModelTier;
  maxIterations: number;
  readonly: boolean;
}
