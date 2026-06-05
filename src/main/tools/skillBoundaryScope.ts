// ============================================================================
// skillBoundaryScope — 严格 skill 工具集可见性过滤（opt-in strict toolset）
//
// GAP-001 的 toolBoundary 是「软执行边界」：边界外工具仍对模型可见，只是调用时
// 强制用户审批。对「对话式建/改角色」这类 meta skill 不够——弱模型（mimo）看见 core
// 的 Edit/Write 就会绕过 skill 设计的 propose_role 流程直接改文件（验收实证）。
//
// 当 skill 声明 strict-toolset 时，本过滤器把模型可见工具集**硬收缩**到 skill 的
// allowedTools，模型物理上选不到边界外工具，只能走 skill 设计的工具。仅对 opt-in 的
// skill 生效（edit-role / create-role），不改全局 GAP-001 语义。
// ============================================================================

import type { SkillToolBoundary } from '../../shared/contract/agentSkill';
import { resolveToolAlias } from '../services/toolSearch/deferredTools';

/** 取 allowed-tools 条目的基础工具名（去掉 Bash(git:*) 这种模式前缀），并归一别名 */
function canonicalToolName(entry: string): string | undefined {
  const base = entry.split('(')[0]?.trim();
  if (!base) return undefined;
  return resolveToolAlias(base);
}

/**
 * strict-toolset skill 激活时，把可见工具集收缩到其 allowedTools。
 * 非 strict / 无边界 / 边界为空时原样返回（保持 GAP-001 软边界行为不变）。
 */
export function filterToolDefinitionsByStrictSkillBoundary<T extends { name: string }>(
  tools: T[],
  boundary: SkillToolBoundary | undefined,
): T[] {
  if (!boundary?.strict || boundary.allowedTools.length === 0) {
    return tools;
  }
  const allowed = new Set<string>();
  for (const entry of boundary.allowedTools) {
    const canonical = canonicalToolName(entry);
    if (canonical) allowed.add(canonical);
  }
  return tools.filter((tool) => allowed.has(resolveToolAlias(tool.name)));
}
