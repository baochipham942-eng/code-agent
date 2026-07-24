// ============================================================================
// rolesClient - 渲染层角色 domain API 封装（E2 专家入口）
// 与 RolesTab 内部 helper 同一 IPC action（domain:roles list），供
// ExpertPanel / 侧栏最近专家条共用。
// ============================================================================

import { IPC_DOMAINS } from '@shared/ipc';
import type { RolePanelEntry } from '@shared/contract/roleAssets';
import type { RolePackEntry } from '@shared/contract/rolePackRegistry';
import ipcService from './ipcService';

export interface RolePackListItem {
  entry: RolePackEntry;
  tools: string[];
  installed: boolean;
  installState?: 'complete' | 'degraded';
  missingSkills?: string[];
  locallyModified?: boolean;
  hasUpdate: boolean;
}

export interface RolePackActionResult {
  success: boolean;
  roleId: string;
  installState?: 'complete' | 'degraded';
  missingSkills?: string[];
  locallyModified?: boolean;
  /** 命中提权判据且用户尚未过目；UI 据此弹确认卡 */
  elevation?: { looseMode: boolean; bashTool: boolean };
}

export async function listRoles(): Promise<RolePanelEntry[]> {
  return ipcService.invokeDomain<RolePanelEntry[]>(IPC_DOMAINS.ROLES, 'list');
}

export async function listRolePacks(): Promise<RolePackListItem[]> {
  return ipcService.invokeDomain<RolePackListItem[]>(IPC_DOMAINS.ROLES, 'rolePackList');
}

export async function installRolePack(
  roleId: string,
  options?: { acceptElevation?: boolean; elevationReviewed?: boolean },
): Promise<RolePackActionResult> {
  return ipcService.invokeDomain<RolePackActionResult>(IPC_DOMAINS.ROLES, 'rolePackInstall', { roleId, ...options });
}

export async function uninstallRolePack(roleId: string): Promise<RolePackActionResult> {
  return ipcService.invokeDomain<RolePackActionResult>(IPC_DOMAINS.ROLES, 'rolePackUninstall', { roleId });
}

export async function retryRolePackMissingSkills(roleId: string): Promise<RolePackActionResult> {
  return ipcService.invokeDomain<RolePackActionResult>(IPC_DOMAINS.ROLES, 'rolePackRetryMissingSkills', { roleId });
}

/**
 * 最近合作过的专家（侧栏头像条）：有工作记录（履历或记忆）的角色，最多 cap 个。
 * 履历只有原始行没有时间戳，保持 list 返回顺序，不伪造"最近"排序。
 */
export function recentExperts(entries: RolePanelEntry[], cap = 5): RolePanelEntry[] {
  return entries.filter((e) => e.lastWork !== null || e.memoryCount > 0).slice(0, cap);
}
