// ============================================================================
// Webhook hook 注册/轮换的服务侧护栏（N-CRON-WEBHOOK-CLOUD-HOOK-FU1）
// ----------------------------------------------------------------------------
// {url, token} 只经返回值交给调用方展示一次：这里不记录、不持久化、不拼进错误信息。
// ============================================================================
import type { CronJobDefinition } from '../../shared/contract/cron';
import type { CronApiHookSecret } from './cronApiClient';
import type { CronWebhookRelay } from './cronWebhookRelay';

export async function runWebhookHookOp(
  operation: 'register' | 'rotate',
  jobId: string,
  jobs: ReadonlyMap<string, { definition: CronJobDefinition }>,
  relay: CronWebhookRelay | undefined,
  ensureCloudStream: () => void,
): Promise<CronApiHookSecret> {
  const schedule = jobs.get(jobId)?.definition.schedule;
  if (schedule?.type !== 'event' || schedule.source !== 'webhook') {
    throw new Error(`Job ${jobId} is not a webhook-triggered job`);
  }
  if (!relay) throw new Error('Cron service is not initialized');
  const secret = operation === 'register'
    ? await relay.registerJobHook(jobId)
    : await relay.rotateJobHook(jobId);
  // hook 的唯一投递通道是云端事件流：URL 交出去之前保证流已在跑（配置是启动后才补的也行）。
  ensureCloudStream();
  return secret;
}
