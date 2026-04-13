// ============================================================================
// Swarm Services Registry — IPC 边界与业务模块的解耦层
// ============================================================================
//
// 历史背景：swarm.ipc.ts 早期直 import 6 个业务 singleton（planApproval、
// launchApproval、parallelCoordinator、spawnGuard、teammateService、
// agentHistoryPersistence），ADR-008 已通过 EventBus 断开了反向边
// （业务 → IPC），但 IPC → 业务 的正向边仍是硬耦合。
//
// 本模块把 IPC 对业务能力的依赖收敛到一个 contract 接口：
//   - swarm.ipc.ts 通过 getSwarmServices() 取实例，不再直 import 业务模块
//   - main bootstrap 在启动时 registerSwarmServices() 注入真实 singleton
//   - 单测可以注入 mock 实现，无需 vi.mock 业务模块
//
// 所有类型来自下游模块的 `import type`，TS 编译期擦除，**不产生运行期依赖**。
// ============================================================================

import type { PlanApprovalGate } from './planApproval';
import type { SwarmLaunchApprovalGate } from './swarmLaunchApproval';
import type { ParallelAgentCoordinator } from './parallelAgentCoordinator';
import type { TeammateService } from './teammate/teammateService';
import type { CompletedAgentRun } from '../../shared/contract/agentHistory';

// ============================================================================
// Structural Interfaces — 只暴露 IPC 实际用到的方法子集
// ============================================================================

/**
 * SpawnGuard 的最小切面 — 只需要 cancel 方法。
 * 完整 SpawnGuard 类不导出，这里用结构类型避免暴露内部细节。
 */
export interface SpawnGuardLike {
  cancel(agentId: string): boolean;
}

/**
 * Agent run 历史持久化端口
 */
export interface AgentHistoryPort {
  persistAgentRun(sessionId: string, run: CompletedAgentRun): Promise<void>;
  getRecentAgentHistory(limit?: number): Promise<CompletedAgentRun[]>;
}

/**
 * Swarm IPC 层的全部业务依赖
 */
export interface SwarmServices {
  planApproval: PlanApprovalGate;
  launchApproval: SwarmLaunchApprovalGate;
  parallelCoordinator: ParallelAgentCoordinator;
  spawnGuard: SpawnGuardLike;
  teammateService: TeammateService;
  agentHistory: AgentHistoryPort;
}

// ============================================================================
// Registry
// ============================================================================

let registered: SwarmServices | null = null;

/**
 * 注入真实业务实例。由 main bootstrap 在 IPC handler 注册之前调用。
 * 重复调用会覆盖之前的注册（便于测试和重启场景）。
 */
export function registerSwarmServices(services: SwarmServices): void {
  registered = services;
}

/**
 * IPC handler 通过此 API 取业务依赖。
 * Fail-fast：未注册时抛错，避免静默 fallback 掩盖 wiring bug。
 */
export function getSwarmServices(): SwarmServices {
  if (!registered) {
    throw new Error(
      'SwarmServices not registered. Call registerSwarmServices() during app bootstrap before IPC handlers run.'
    );
  }
  return registered;
}

/**
 * 测试场景：清空注册表，下一次 getSwarmServices() 会抛错。
 */
export function resetSwarmServices(): void {
  registered = null;
}

/**
 * 检查是否已注册（用于幂等判断或 graceful degradation）
 */
export function hasSwarmServices(): boolean {
  return registered !== null;
}
