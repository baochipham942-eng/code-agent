// ============================================================================
// Hybrid Agent Types - Shared type definitions
// ============================================================================
// Extracted to break circular dependency between agentMdLoader ↔ coreAgents.

import type { RoleProactivityConfig } from '../../../shared/contract/roleAssets';

/**
 * 核心角色 ID
 */
export type CoreAgentId = 'coder' | 'reviewer' | 'explore' | 'plan' | 'awaiter' | 'dream';

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
  /** GAP-011：预装 skill 列表（SKILL.md 全文注入子代理 system prompt） */
  skills?: string[];
  model: ModelTier;
  maxIterations: number;
  readonly: boolean;
  /** 角色主动性配置（frontmatter proactivity-level / proactivity-cadence，docs/designs/role-proactivity.md §4） */
  proactivity?: RoleProactivityConfig;
}
