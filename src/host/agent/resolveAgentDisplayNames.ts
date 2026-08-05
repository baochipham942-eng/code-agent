// ============================================================================
// resolveAgentDisplayNames - 并行成员实例显示名（施工单二 A4）
// ============================================================================
// 模型给的 name 优先；未给时用 role；同批 role 重复才加 -1/-2 序号。
// ============================================================================

export interface AgentDisplayNameInput {
  role: string;
  /** 模型可选实例显示名 */
  name?: string;
}

/**
 * 为一批并行 agent 解析互不撞车的显示名。
 * - 提供非空 name → 原样使用（trim 后）
 * - 未提供且同批 role 不重复 → role
 * - 未提供且同批 role 重复 → role-1 / role-2 …
 */
export function resolveAgentDisplayNames(agents: AgentDisplayNameInput[]): string[] {
  const roleCounts = new Map<string, number>();
  for (const agent of agents) {
    roleCounts.set(agent.role, (roleCounts.get(agent.role) ?? 0) + 1);
  }

  const roleOrdinals = new Map<string, number>();
  return agents.map((agent) => {
    const provided = typeof agent.name === 'string' ? agent.name.trim() : '';
    if (provided) return provided;

    const duplicates = (roleCounts.get(agent.role) ?? 1) > 1;
    if (!duplicates) return agent.role;

    const next = (roleOrdinals.get(agent.role) ?? 0) + 1;
    roleOrdinals.set(agent.role, next);
    return `${agent.role}-${next}`;
  });
}
