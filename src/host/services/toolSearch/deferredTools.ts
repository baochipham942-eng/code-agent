// ============================================================================
// Deferred Tools Configuration - 延迟工具配置（数据表见 deferredToolsData.ts）
// ============================================================================
// 三张数据表按 builtinSkillsData.ts 先例纯结构性拆至 deferredToolsData.ts；
// 本文件保留 accessor 逻辑并按原路径 re-export，消费方 import 路径不变。

import type { DeferredToolMeta } from '../../../shared/contract/toolSearch';
import { CORE_TOOLS, DEFERRED_TOOLS_META, TOOL_ALIASES } from './deferredToolsData';

export { CORE_TOOLS, DEFERRED_TOOLS_META, TOOL_ALIASES };

/**
 * Resolve a tool name through alias mapping.
 * Returns the canonical name if aliased, or the original name.
 */
export function resolveToolAlias(name: string): string {
  return TOOL_ALIASES[name] ?? TOOL_ALIASES[name.toLowerCase()] ?? name;
}

/**
 * 构建延迟工具索引（name → meta）
 */
export function buildDeferredToolIndex(): Map<string, DeferredToolMeta> {
  return new Map(DEFERRED_TOOLS_META.map((meta) => [meta.name, meta]));
}

/**
 * 判断工具是否为核心工具
 */
export function isCoreToolName(name: string): boolean {
  return CORE_TOOLS.includes(name);
}
