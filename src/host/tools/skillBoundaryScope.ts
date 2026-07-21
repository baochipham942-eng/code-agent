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
import { EXIT_ROLE_FLOW_TOOL_NAME } from './modules/roleAuthoring/exitRoleFlow.schema';

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

/**
 * strict 边界激活时注入给模型的说明：为什么工具变少了、超出流程范围时怎么退出。
 * 没有它，模型只会对用户编一个"当前环境受限"的泛化解释（2026-07-21 真实故障）。
 */
export function buildStrictToolsetNotice(boundary: SkillToolBoundary): string {
  const hasExitTool = boundary.allowedTools.some(
    (entry) => canonicalToolName(entry) === EXIT_ROLE_FLOW_TOOL_NAME,
  );
  const exitHint = hasExitTool
    ? `若用户此轮请求与该流程无关：先调用 ${EXIT_ROLE_FLOW_TOOL_NAME} 退出流程（未确认的草稿会保留在确认卡上），随后即可在本轮用完整工具继续处理用户请求。不要拒绝用户，也不要说"环境受限"。`
    : '若用户此轮请求与该流程无关：向用户说明你正处于该流程、工具暂时收窄，建议完成当前流程或新开会话后再处理；不要笼统地说"环境受限"。';
  return [
    '<strict-skill-toolset>',
    `当前处于「${boundary.skillName}」严格流程，本轮可见工具已收窄为：${boundary.allowedTools.join(', ')}。这是流程设计，不是权限问题或环境故障。`,
    exitHint,
    '</strict-skill-toolset>',
  ].join('\n');
}
