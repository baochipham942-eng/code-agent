// ============================================================================
// Tool Deny Rules — 全局工具黑名单
//
// 原属 toolRegistry.ts（legacy 聚合入口），P0-6.2 抽出为独立模块。
// Registry 不应承担跨服务过滤职责：deny rules 的来源是 config/policy 层，
// registry 的责任只是列 schema + 解析 handler。
//
// 用途：cloud config 或 policy 层注入黑名单模式，contextAssembly 生成
// LLM tools 列表时调 filterToolsByDenyRules() 剔除被禁用的工具。
// 模式支持精确名或前缀通配（如 "mcp__slack__*"）。
// ============================================================================

import type { ToolDefinition } from '../../shared/contract';

export interface DenyRule {
  /** Tool name pattern (exact or prefix with *) */
  pattern: string;
  /** Reason for denial */
  reason?: string;
}

/** Global deny rules (populated from config or policy) */
const denyRules: DenyRule[] = [];

/**
 * Add a deny rule. Tools matching the pattern will be excluded.
 * Pattern supports exact match or prefix glob: "mcp__slack__*"
 */
export function addDenyRule(rule: DenyRule): void {
  denyRules.push(rule);
}

/**
 * Clear all deny rules.
 */
export function clearDenyRules(): void {
  denyRules.length = 0;
}

/**
 * Check if a tool name is denied by any rule.
 */
export function isToolDenied(toolName: string): boolean {
  return denyRules.some((rule) => matchesDenyPattern(rule.pattern, toolName));
}

/**
 * Filter tool definitions by deny rules.
 * Removes tools matching any deny pattern before sending to the model.
 */
export function filterToolsByDenyRules(tools: ToolDefinition[]): ToolDefinition[] {
  if (denyRules.length === 0) return tools;
  return tools.filter((t) => !isToolDenied(t.name));
}

function matchesDenyPattern(pattern: string, toolName: string): boolean {
  if (pattern.endsWith('*')) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return pattern === toolName;
}
