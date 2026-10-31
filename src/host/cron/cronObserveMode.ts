// ============================================================================
// Cron observe mode (N-TRIGGER-OBSERVE-MODE) — 观察档运行的登记与拦截记账
// ----------------------------------------------------------------------------
// 观察档自动化的每一趟运行：会话登记进 observeModeGate（ToolExecutor 据此在审批之前拦下
// 对外副作用工具），通道结果回复在 cronResultDelivery 发送前拦下；两条路都只写一条
// kind 'action' / decision 'would_act' 的台账记录，什么都不发出去。
// ============================================================================

import type { CronJobDefinition } from '../../shared/contract/cron';
import { CRON_EVENT_DECISIONS } from '../../shared/constants';
import { resolveCronEventActionMode } from '../../shared/cronEventActionMode';
import { enterObserveMode, truncateObserveText } from '../tools/observeModeGate';
import { sqliteCronEventDecisionStore, type CronEventDecisionStore } from './cronEventDecisionLedger';

/** 通道结果回复在台账里的「工具名」。 */
const OBSERVE_CHANNEL_REPLY_TOOL = 'channel_reply';

export function isCronObserveMode(definition: Pick<CronJobDefinition, 'schedule' | 'actionMode'>): boolean {
  return resolveCronEventActionMode(definition) === 'observe';
}

/** 观察档任务：登记本次运行会话，返回解除登记函数；非观察档返回空操作。 */
export function enterObserveModeForCronRun(
  definition: CronJobDefinition,
  sessionId: string,
  executionId: string | undefined,
  store: CronEventDecisionStore = sqliteCronEventDecisionStore,
): () => void {
  if (!isCronObserveMode(definition)) return () => {};
  return enterObserveMode(sessionId, (interception) => {
    store.record([{
      jobId: definition.id,
      kind: 'action',
      decision: 'would_act',
      reason: `observe mode: ${interception.toolName} intercepted before sending`,
      ...(executionId ? { runId: executionId } : {}),
      tool: interception.toolName,
      ...(interception.target ? { target: interception.target } : {}),
      summary: interception.summary,
    }]);
  });
}

/** 观察档的通道结果回复：不发，记一条 would_act（目标 = 推送目标串，摘要 = 本会发出的正文）。 */
export function recordObservedChannelReply(
  definition: CronJobDefinition,
  executionId: string | undefined,
  target: string,
  body: string,
  store: CronEventDecisionStore = sqliteCronEventDecisionStore,
): void {
  store.record([{
    jobId: definition.id,
    kind: 'action',
    decision: 'would_act',
    reason: 'observe mode: channel reply intercepted before sending',
    ...(executionId ? { runId: executionId } : {}),
    tool: OBSERVE_CHANNEL_REPLY_TOOL,
    target,
    summary: truncateObserveText(body, CRON_EVENT_DECISIONS.MAX_SUMMARY_CHARS),
  }]);
}
