import type { AgentRunOptions } from '../research/types';

type CronAgentRunOptions = Pick<AgentRunOptions, 'mode' | 'agentOverrideId' | 'turnSystemContext'>;

/**
 * Resolve the persistent-role context for an unattended cron agent run.
 * A missing or deleted role deliberately falls back to the default agent.
 */
export async function buildCronAgentRunOptions(
  roleId: string | undefined,
  workingDirectory: string | undefined,
): Promise<CronAgentRunOptions | undefined> {
  if (!roleId) return undefined;

  const { buildRoleContextBlock } = await import('../services/roleAssets/roleAssetService');
  const contextBlock = await buildRoleContextBlock(roleId, workingDirectory);
  if (!contextBlock) {
    // D5 兜底：roleId 非可解析持久化角色（用户删了/写错）→ 降级默认 agent，fail-loud 不中断
    console.warn(`[CronService] agent roleId=${roleId} 不是可解析的持久化角色，降级默认 agent 跑（任务不中断）`);
    return undefined;
  }

  console.error(`[CronService] agent 以角色身份跑 role=${roleId}（已注入 role context）`);
  return { mode: 'normal', agentOverrideId: roleId, turnSystemContext: [contextBlock] };
}
