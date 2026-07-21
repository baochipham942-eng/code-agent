// ============================================================================
// rolesClient - 渲染层角色 domain API 封装（E2 专家入口）
// 与 RolesTab 内部 helper 同一 IPC action（domain:roles list），供
// ExpertPanel / 侧栏最近专家条共用。
// ============================================================================

import { IPC_DOMAINS } from '@shared/ipc';
import type { RolePanelEntry } from '@shared/contract/roleAssets';
import ipcService from './ipcService';

export async function listRoles(): Promise<RolePanelEntry[]> {
  return ipcService.invokeDomain<RolePanelEntry[]>(IPC_DOMAINS.ROLES, 'list');
}

/**
 * 最近合作过的专家（侧栏头像条）：有工作记录（履历或记忆）的角色，最多 cap 个。
 * 履历只有原始行没有时间戳，保持 list 返回顺序，不伪造"最近"排序。
 */
export function recentExperts(entries: RolePanelEntry[], cap = 5): RolePanelEntry[] {
  return entries.filter((e) => e.lastWork !== null || e.memoryCount > 0).slice(0, cap);
}
