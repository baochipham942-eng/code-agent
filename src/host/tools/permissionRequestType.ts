import type { PermissionRequestData } from './types';

/** permissionLevel → 审批请求类型：toolExecutor 的 default 分支与评测策略覆盖门共用同一张表。 */
const REQUEST_TYPE_BY_LEVEL: Record<string, PermissionRequestData['type']> = {
  read: 'file_read',
  write: 'file_write',
  execute: 'command',
  network: 'network',
};

export const permissionRequestTypeForLevel = (
  permissionLevel: string,
): PermissionRequestData['type'] => REQUEST_TYPE_BY_LEVEL[permissionLevel] ?? 'file_read';
