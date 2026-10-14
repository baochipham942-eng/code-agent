// ============================================================================
// cronHumanize —— 触发源类型推导（触发源 chip 用）。
// cron/every 调度 → 人话文案的纯函数已上移 src/shared/cronHumanize.ts
// （host 侧 cronAutomationBridge 也要用，renderer utils 它 import 不到）。
// 触发源推导与 host 侧 cronAutomationBridge.deriveSessionAutomationType 同一规则
// （agent.context.externalWatch → 事件、agent.context.heartbeatTask → 心跳），
// 再按 scheduleType 细分一次性/循环/定时。
// ============================================================================

import type { CronJobDefinition } from '@shared/contract';
import { EXTERNAL_WATCH } from '@shared/constants/feishu';

/** 触发源类型：对齐 contract 的 SessionAutomationType（事件/心跳），再按 scheduleType 细分 */
export type CronTriggerKind = 'cron' | 'at' | 'every' | 'heartbeat' | 'external_event';

export function getCronTriggerKind(job: CronJobDefinition): CronTriggerKind {
  const { action } = job;
  if (action.type === 'agent') {
    const context = action.context as Record<string, unknown> | undefined;
    if (context?.[EXTERNAL_WATCH.CONTEXT_KEY]) return 'external_event';
    if (context?.heartbeatTask) return 'heartbeat';
  }
  // 'event' 调度（通道消息/群监听）与 externalWatch 同属事件触发，chip 也标「事件」。
  if (job.scheduleType === 'event') return 'external_event';
  if (job.scheduleType === 'at') return 'at';
  if (job.scheduleType === 'every') return 'every';
  return 'cron';
}
