import type { PermissionRequestData } from './types';

export const permissionRequestTypeForLevel = (
  permissionLevel: string,
): PermissionRequestData['type'] => ({
  read: 'file_read',
  write: 'file_write',
  execute: 'command',
  network: 'network',
}[permissionLevel] || 'file_read');
