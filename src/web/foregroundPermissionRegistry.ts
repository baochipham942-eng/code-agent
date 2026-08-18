import type { PermissionDeliveryOutcome, PermissionResponse } from '../shared/contract/permission';
import type { OrchestratorPermissionIsland } from '../host/agent/orchestratorPermissions';

/**
 * `/api/run` owns its permission island per run, unlike TaskManager's desktop
 * orchestrator. Keep the active island discoverable by the HTTP response route
 * without letting an older concurrent run unregister the newer one.
 */
const foregroundPermissionIslands = new Map<string, OrchestratorPermissionIsland>();

export function registerForegroundPermissionIsland(
  sessionId: string,
  island: OrchestratorPermissionIsland,
): void {
  foregroundPermissionIslands.set(sessionId, island);
}

export function unregisterForegroundPermissionIsland(
  sessionId: string,
  island: OrchestratorPermissionIsland,
): void {
  if (foregroundPermissionIslands.get(sessionId) === island) {
    foregroundPermissionIslands.delete(sessionId);
  }
}

export function deliverForegroundPermissionResponse(
  sessionId: string,
  requestId: string,
  response: PermissionResponse,
): PermissionDeliveryOutcome | undefined {
  const island = foregroundPermissionIslands.get(sessionId);
  if (!island) return undefined;
  // 同一会话可能同时有前台 run 和后台任务（delegate_task）在等审批：只有这个
  // requestId 确实登记在前台岛上才由它应答，否则返回 undefined 让调用方继续
  // 投给 TaskManager——否则前台岛的 unknown_request 会把后台审批的点击整个吞掉。
  if (!island.listPendingRequests().some((request) => request.id === requestId)) {
    return undefined;
  }
  return island.handlePermissionResponse(requestId, response);
}
