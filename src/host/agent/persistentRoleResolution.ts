import { isPersistentRole } from '../services/roleAssets/roleAssetService';

/**
 * 轮级解析：只有存在资产目录的 agent 才能成为角色记忆的默认归属。
 * 预定义的 explore/coder 等普通 agent 不能因此写入 roles/<agentId>/。
 */
export async function resolvePersistentRoleId(agentId: string | undefined): Promise<string | undefined> {
  if (!agentId || !(await isPersistentRole(agentId))) return undefined;
  return agentId;
}
