// ============================================================================
// Spawn Agent — status helpers
// Gen 7: Multi-Agent capability
//
// 从 spawnAgent.ts 拆出的 SpawnGuard 状态查询投影（N-SUBAGENT-ZEROTOOLS 返修：
// 为 max-lines 硬限拆分）。消费方：agent_message 工具与上层状态查询。
// ============================================================================

import { getSpawnGuard } from '../spawnGuard';

/**
 * Backward-compatible type for spawned agent status.
 */
export interface SpawnedAgent {
  id: string;
  role: string;
  status: 'idle' | 'running' | 'running-recovered' | 'dead-log-only' | 'completed' | 'failed' | 'killed';
  task?: string;
  result?: string;
  error?: string;
  /** 声明了但未装配的工具（N-SUBAGENT-ZEROTOOLS 返修 Important 2：结果收集接口透传）。 */
  missingTools?: string[];
}

/** SpawnGuard ManagedAgent → 对外状态投影（含 missingTools 透传）。 */
function projectManagedAgent(
  managed: import('../spawnGuard').ManagedAgent,
): SpawnedAgent {
  return {
    id: managed.id,
    role: managed.role,
    status: managed.status === 'cancelled' ? 'killed' : managed.status,
    task: managed.task,
    result: managed.result?.output,
    error: managed.error,
    ...(managed.result?.missingTools?.length
      ? { missingTools: managed.result.missingTools }
      : {}),
  };
}

// Export function to get agent status (used by agent_message tool)
export function getSpawnedAgent(
  agentId: string,
  scope?: import('../spawnGuard').SpawnGuardScopeFilter,
): SpawnedAgent | undefined {
  const guard = getSpawnGuard();
  const managed = guard.get(agentId, scope);
  if (!managed) return undefined;
  return projectManagedAgent(managed);
}

// Export function to list all agents
export function listSpawnedAgents(
  scope?: import('../spawnGuard').SpawnGuardScopeFilter,
): SpawnedAgent[] {
  const guard = getSpawnGuard();
  return guard.list(scope).map(projectManagedAgent);
}
