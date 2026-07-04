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
