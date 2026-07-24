// ============================================================================
// routingToolPolicy — 显式 /agent 路由的工具约束
// ----------------------------------------------------------------------------
// /agent 选中 readonly agent（explore/plan）后，主对话 AgentLoop 通过
// deniedToolNames 真正收窄文件写入能力（此前 agent.tools 是 dead field，
// 只换 prompt 不换工具）。denylist 与 spawnGuard 只读子代理语义保持单一来源。
// 注：只收文件写入（与子代理 READONLY 语义对齐），不做完整 tools 白名单——
// 核心 agent 的 tools 是策展小清单，主链路按白名单执行会滤掉
// attempt_completion / 记忆 / 技能等系统工具。
// ============================================================================

import { isCoreAgent } from './hybrid/coreAgents';

/** 只读 agent 在主对话链路里被拒的文件写入工具（两种命名变体都收） */
export const READONLY_TOOL_DENYLIST: readonly string[] = [
  'write_file',
  'Write',
  'append_file',
  'Append',
  'edit_file',
  'Edit',
];

/** 按显式路由到的 agent 构造工具 denylist；非 readonly 不加约束 */
export function buildRoutingToolDenylist(
  agent: { readonly?: boolean } | null | undefined,
): string[] {
  if (!agent?.readonly) return [];
  return [...READONLY_TOOL_DENYLIST];
}

/**
 * 内置角色里「工具写只读」的策展集——注意这**不等于** coordination.readonly：
 * - reviewer：coordination.readonly=false（execution 层要跑测试），但审查员不该改文件 → 在此。
 * - plan：coordination.readonly=true，但要写计划文档 → **不在**此。
 * 两个轴（协调层 vs 工具写权限）对 reviewer/plan 恰好相反，故内置侧只能人工策展。
 */
export const BUILTIN_TOOL_READONLY_ROLES: readonly string[] = ['explore', 'explorer', 'reviewer'];

/**
 * 判定某个 spawn 出来的角色是否「工具写只读」（禁 Write/Edit/Append）。单一真源，
 * spawnAgent 的单发与并行两处共用，取代此前各自硬编码的三名字清单。
 *
 * 规则：
 * - 内置核心角色：只认策展集 BUILTIN_TOOL_READONLY_ROLES（保住 plan 写计划文档的例外，
 *   不因 coordination.readonly=true 被误禁）。
 * - 自定义角色：认它 agent.md frontmatter 声明的 readonly——这正是旧硬编码清单漏掉的：
 *   自定义角色名不在清单里，写了 readonly:true 也形同虚设。
 */
export function isToolWriteReadonlyRole(
  role: string | undefined,
  agentConfig: { coordination?: { readonly?: boolean } } | undefined,
): boolean {
  const name = role?.toLowerCase() ?? '';
  if (BUILTIN_TOOL_READONLY_ROLES.includes(name)) return true;
  return !isCoreAgent(role ?? '') && agentConfig?.coordination?.readonly === true;
}
