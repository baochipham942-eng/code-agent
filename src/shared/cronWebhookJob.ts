// ============================================================================
// cronWebhookJob —— webhook 触发任务的判据（shared：cronStore 与 renderer 组件共用）。
// 创建后编辑器要保持打开以展示一次性链接（cronStore.createJob），详情页据此渲染链接块；
// 两处口径必须一致。
// ============================================================================

import type { CronJobDefinition } from './contract/cron';

export function isWebhookCronJob(job: Pick<CronJobDefinition, 'schedule'>): boolean {
  return job.schedule.type === 'event' && job.schedule.source === 'webhook';
}
