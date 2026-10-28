// ============================================================================
// CronWebhookRelay — webhook 事件源的中继接线（N-CRON-WEBHOOK-CLOUD-HOOK）
// ----------------------------------------------------------------------------
// Neo 侧的一半：云端中继（另一仓，N-CRON-WEBHOOK-RELAY）把外部系统 POST 到
// hook URL 的投递经既有 cloud 事件流推回来，本模块负责：
//   帧路由 —— cron_hook 帧 → CronEventTrigger.ingestWebhook（绑定过滤/去重/
//     合批全在触发器里），处置终态后逐帧 ack（at-least-once 的确认侧）；
//   过期通告 —— cron_hook_expired 帧按 cronMissedTrace 同一套 automation 收件箱
//     机制落一条待过目（reason 'webhook-expired' + count）。收件箱按 reason
//     显示丢弃条数，不复用「应用离线」——排队超时和进程离线不是一回事；
//   hook 生命周期 —— register/rotate/remove 走 CronApiClient 的 hook 端点，
//     {url, token} 只作为返回值出现一次，绝不持久化、绝不落日志；
//   清理 —— 任务删除/停用时 best-effort 摘掉中继侧 hook（失败只告警）。
// 本机仍然不开端口、不挂 HTTP endpoint：入站面完全在中继侧。
// ============================================================================

import type { CronJobDefinition } from '../../shared/contract/cron';
import {
  buildCronAutomationConfig,
  formatCronScheduleLabel,
  getCronAutomationType,
  readCronSourceSessionId,
} from './cronAutomationBridge';
import { CronApiClient, type CronApiHookEvent, type CronApiHookSecret } from './cronApiClient';
import type { WebhookDelivery, WebhookIngestOutcome } from './cronEventTrigger';
import { getSessionAutomationService } from '../services/sessionAutomation';

export interface CronWebhookRelayDeps {
  getJobDefinitions(): CronJobDefinition[];
  /** CronEventTrigger.ingestWebhook 的直通口：帧在此进绑定过滤/去重/合批链路。 */
  ingestWebhook(delivery: WebhookDelivery): WebhookIngestOutcome;
}

/** webhook 任务创建护栏：中继活在云端 cron 配置后面，没配置就不许建。 */
export function assertWebhookScheduleCloudConfigured(isConfigured: boolean): void {
  if (!isConfigured) {
    throw new Error(
      'Webhook-triggered jobs require the Neo cloud scheduler to be configured; '
      + 'set the cloud scheduler URL and token in settings first.',
    );
  }
}

/**
 * 过期通告落收件箱：与 cronMissedTrace.ts 同一套 automation-inbox 机制
 * （upsert 任务自己的 automation 记录，missedNotice 承载通告），但不写会话
 * 回流消息——过期投递没有可回放的正文，一条待过目即可。
 */
function persistWebhookExpiredNote(definition: CronJobDefinition, count: number, at: number): void {
  const sourceSessionId = readCronSourceSessionId(definition) ?? null;
  const automationType = getCronAutomationType(definition);
  try {
    getSessionAutomationService().upsert({
      id: `${automationType}:${definition.id}`,
      sourceSessionId,
      type: automationType,
      status: definition.enabled ? 'active' : 'paused',
      title: definition.name,
      cadenceLabel: formatCronScheduleLabel(definition.schedule),
      sourceRefId: definition.id,
      config: {
        ...buildCronAutomationConfig(definition),
        missedNotice: { scheduledAt: at, reason: 'webhook-expired', count },
      },
    });
  } catch (error) {
    console.error(
      `[CronWebhookRelay] Failed to persist webhook-expired inbox note for job ${definition.id}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export class CronWebhookRelay {
  constructor(
    private readonly client: CronApiClient,
    private readonly deps: CronWebhookRelayDeps,
  ) {}

  /**
   * cloud 事件流上的 hook 帧入口（CronCloudRuntime.start 注入）。投递帧经
   * ingestWebhook 进触发链路后 ack——终态处置（入队/去重/忽略）即 ack 依据，
   * 不 ack 会让中继按 at-least-once 无限重推。过期帧是通告性的，无 ack 面。
   */
  readonly handleStreamFrame = async (event: CronApiHookEvent): Promise<void> => {
    if (event.type === 'hook-expired') {
      const definition = this.deps.getJobDefinitions().find((job) => job.id === event.jobId);
      if (!definition) {
        console.warn(`[CronWebhookRelay] Hook expiry for unknown job ${event.jobId} (count ${event.count}); dropped.`);
        return;
      }
      persistWebhookExpiredNote(definition, event.count, Date.now());
      return;
    }
    this.deps.ingestWebhook({
      jobId: event.jobId,
      deliveryId: event.deliveryId,
      receivedAt: event.receivedAt,
      body: event.body,
    });
    try {
      await this.client.ackHooks(event.jobId, [event.deliveryId]);
    } catch (error) {
      // ack 失败不中断事件流：中继会重投，deliveryId 去重保证不重跑。
      console.warn(
        `[CronWebhookRelay] Hook ack failed for job ${event.jobId} delivery ${event.deliveryId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  /**
   * 注册 hook：{url, token} 只在这里返回一次（调用方展示一次后丢弃）。
   * token 绝不持久化、绝不落日志——中继侧也只存哈希。
   */
  async registerJobHook(jobId: string): Promise<CronApiHookSecret> {
    assertWebhookScheduleCloudConfigured(this.client.isConfigured());
    return this.client.registerHook(jobId);
  }

  /** 轮换 hook token：旧 token 立即失效，新 {url, token} 同样只返回一次。 */
  async rotateJobHook(jobId: string): Promise<CronApiHookSecret> {
    assertWebhookScheduleCloudConfigured(this.client.isConfigured());
    return this.client.rotateHook(jobId);
  }

  /**
   * 任务删除/停用时的清理（best-effort）：只有 webhook 任务会发请求，其余任务
   * 零请求；云端未配置或请求失败只告警/静默——本地删除不被云端清理拖住。
   */
  removeHookForJob(definition: CronJobDefinition): void {
    const schedule = definition.schedule;
    if (schedule?.type !== 'event' || schedule.source !== 'webhook') return;
    if (!this.client.isConfigured()) return;
    void this.client.removeHook(definition.id).catch((error) => {
      console.warn(
        `[CronWebhookRelay] Hook removal failed for job ${definition.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    });
  }
}
