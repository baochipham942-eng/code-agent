// ============================================================================
// cronRoleBinding —— cron 任务的角色绑定判据（shared：store 与 renderer 组件共用）。
// 角色绑定 = AgentAction.roleId（以持久化角色身份跑）或 type: 'role-wake'
// （roleId 必填）。保存后的「已保存」复述视图（N-ROLE-ROUTINE-RESTATE）与
// cronStore 的编辑器开合都以此为准，两处口径必须一致。
// ============================================================================

import type { CronJobDefinition } from './contract/cron';

/** 角色绑定判据：AgentAction.roleId（trim 后非空）或 role-wake（roleId 必填）。 */
export function isRoleBoundCronJob(job: Pick<CronJobDefinition, 'action'>): boolean {
  if (job.action.type === 'role-wake') return Boolean(job.action.roleId);
  return job.action.type === 'agent' && Boolean(job.action.roleId?.trim());
}

/** 任务定义里的 roleId（非角色绑定动作给空串）。 */
export function cronJobBoundRoleId(job: Pick<CronJobDefinition, 'action'>): string {
  if (job.action.type === 'role-wake') return job.action.roleId;
  if (job.action.type === 'agent') return job.action.roleId?.trim() ?? '';
  return '';
}
