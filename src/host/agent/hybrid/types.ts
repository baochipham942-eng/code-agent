// ============================================================================
// Hybrid Agent Types - Shared type definitions
// ============================================================================
// Extracted to break circular dependency between agentMdLoader ↔ coreAgents.

import type { RoleProactivityConfig, RoleVisual } from '../../../shared/contract/roleAssets';

/**
 * 核心角色 ID
 */
export type CoreAgentId = 'coder' | 'reviewer' | 'explore' | 'plan' | 'awaiter' | 'dream' | 'distill';

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
  /** 声明式输入说明，仅用于模型可见提示和 UI/metadata 透传，不做 schema 校验。 */
  inputs?: string[];
  /** 声明式输出说明，仅用于模型可见提示和产物 metadata 透传，不做输出解析。 */
  outputs?: string[];
  model: ModelTier;
  /**
   * 指定具体模型（frontmatter `model-override: <provider>/<model>`）。
   * 留空走 model 档位；填了且该 provider 用户确实配了 key 才生效，否则回落档位。
   */
  modelOverride?: { provider: string; model: string };
  maxIterations: number;
  readonly: boolean;
  /** 角色主动性配置（frontmatter proactivity-level / proactivity-cadence，内部文档 §4） */
  proactivity?: RoleProactivityConfig;
  /** 展示层字段，写在 agent.md 的扁平 frontmatter，不参与 prompt 解释。 */
  visual?: RoleVisual;
}
