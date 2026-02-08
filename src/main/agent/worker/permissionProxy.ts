// ============================================================================
// Permission Proxy - Phase 2 进程隔离（Stub）
// ============================================================================

export interface PermissionProxy {
  checkPermission(workerId: string, tool: string, args: unknown): Promise<boolean>;
}

export function getPermissionProxy(): PermissionProxy {
  throw new Error('PermissionProxy is not yet implemented (Phase 2)');
}
