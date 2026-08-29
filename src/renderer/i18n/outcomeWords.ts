/**
 * User-facing terminal outcomes, shared by every renderer surface.
 *
 * Keep the axes explicit: a terminal outcome may use a different label for a
 * timeline sentence and a compact badge, while the same outcome/audience pair
 * must always resolve to one label and one reason phrase.
 */
import type { StreamInterruptionReason } from '@shared/contract';

type OutcomeKey =
  | 'cancelled-by-user'
  | 'interrupted-session-switch'
  | 'interrupted-restart'
  | 'interrupted-by-parent'
  | 'interrupted-unknown'
  | 'failed-tool'
  | 'failed-model'
  | 'failed-unknown'
  | 'failed-approval-denied'
  | 'failed-timeout'
  | 'failed-budget'
  | 'failed-dependency'
  | 'failed-unavailable'
  | 'failed-upstream'
  | 'completed'
  | 'completed-with-warnings'
  | 'aborted'
  | 'goal-met';

type OutcomeAudience = 'timeline' | 'badge' | 'detail' | 'notification';

interface OutcomeCopy {
  label: string;
  reason: string;
}

type OutcomeWords = Record<OutcomeKey, Record<OutcomeAudience, OutcomeCopy>>;

interface OutcomeWordsBundle {
  outcomeWords: OutcomeWords;
}

const STREAM_INTERRUPTION_OUTCOME_KEYS = {
  user: 'cancelled-by-user',
  'session-switch': 'interrupted-session-switch',
  'app-restart': 'interrupted-restart',
} as const satisfies Record<StreamInterruptionReason, OutcomeKey>;

/** One active/passive verdict shared by every stream-interruption surface. */
export function resolveStreamInterruptionOutcomeKey(
  reason: StreamInterruptionReason | null | undefined,
): (typeof STREAM_INTERRUPTION_OUTCOME_KEYS)[StreamInterruptionReason] {
  return STREAM_INTERRUPTION_OUTCOME_KEYS[reason ?? 'app-restart'];
}

export const outcomeWordsZh: OutcomeWordsBundle = {
  outcomeWords: {
    'cancelled-by-user': {
      timeline: { label: '已取消', reason: '你停止了这次执行' },
      badge: { label: '已取消', reason: '你停止了这次执行' },
      detail: { label: '任务已取消', reason: '你停止了这次执行' },
      notification: { label: '任务已取消', reason: '你停止了这次执行' },
    },
    'interrupted-session-switch': {
      timeline: { label: '已中断', reason: '切换会话时中断' },
      badge: { label: '已中断', reason: '切换会话时中断' },
      detail: { label: '任务已中断', reason: '切换会话时中断' },
      notification: { label: '任务已中断', reason: '切换会话时中断' },
    },
    'interrupted-restart': {
      timeline: { label: '已中断', reason: '应用重启时中断' },
      badge: { label: '已中断', reason: '应用重启时中断' },
      detail: { label: '任务已中断', reason: '应用重启时中断' },
      notification: { label: '任务已中断', reason: '应用重启时中断' },
    },
    'interrupted-by-parent': {
      timeline: { label: '已中断', reason: '上级任务停止了这次执行' },
      badge: { label: '已中断', reason: '上级任务停止了这次执行' },
      detail: { label: '任务已中断', reason: '上级任务停止了这次执行' },
      notification: { label: '任务已中断', reason: '上级任务停止了这次执行' },
    },
    'interrupted-unknown': {
      timeline: { label: '已中断', reason: '执行在完成前中断' },
      badge: { label: '已中断', reason: '执行在完成前中断' },
      detail: { label: '任务已中断', reason: '执行在完成前中断' },
      notification: { label: '任务已中断', reason: '执行在完成前中断' },
    },
    'failed-tool': {
      timeline: { label: '执行失败', reason: '工具没有完成这一步' },
      badge: { label: '失败', reason: '工具没有完成这一步' },
      detail: { label: '工具执行失败', reason: '工具没有完成这一步' },
      notification: { label: '工具执行失败', reason: '工具没有完成这一步' },
    },
    'failed-model': {
      timeline: { label: '生成失败', reason: '模型没有完成回复' },
      badge: { label: '失败', reason: '模型没有完成回复' },
      detail: { label: '模型生成失败', reason: '模型没有完成回复' },
      notification: { label: '模型生成失败', reason: '模型没有完成回复' },
    },
    'failed-unknown': {
      timeline: { label: '执行失败', reason: '执行过程中发生错误' },
      badge: { label: '失败', reason: '执行过程中发生错误' },
      detail: { label: '任务执行失败', reason: '执行过程中发生错误' },
      notification: { label: '任务执行失败', reason: '执行过程中发生错误' },
    },
    'failed-approval-denied': {
      timeline: { label: '未获批准', reason: '审批被拒绝' },
      badge: { label: '未批准', reason: '审批被拒绝' },
      detail: { label: '审批未通过', reason: '审批被拒绝' },
      notification: { label: '审批未通过', reason: '审批被拒绝' },
    },
    'failed-timeout': {
      timeline: { label: '已中断', reason: '等待回答或权限确认超时' },
      badge: { label: '已中断', reason: '等待回答或权限确认超时' },
      detail: { label: '任务已中断', reason: '等待回答或权限确认超时' },
      notification: { label: '任务已中断', reason: '等待回答或权限确认超时' },
    },
    'failed-budget': {
      timeline: { label: '预算用尽', reason: '执行达到预算上限' },
      badge: { label: '预算用尽', reason: '执行达到预算上限' },
      detail: { label: '任务未完成', reason: '执行达到预算上限' },
      notification: { label: '任务未完成', reason: '执行达到预算上限' },
    },
    'failed-dependency': {
      timeline: { label: '依赖失败', reason: '前置任务没有完成' },
      badge: { label: '依赖失败', reason: '前置任务没有完成' },
      detail: { label: '任务未完成', reason: '前置任务没有完成' },
      notification: { label: '任务未完成', reason: '前置任务没有完成' },
    },
    'failed-unavailable': {
      timeline: { label: '能力不可用', reason: '所需工具或运行环境不可用' },
      badge: { label: '不可用', reason: '所需工具或运行环境不可用' },
      detail: { label: '任务未完成', reason: '所需工具或运行环境不可用' },
      notification: { label: '任务未完成', reason: '所需工具或运行环境不可用' },
    },
    'failed-upstream': {
      timeline: { label: '服务出错', reason: '上游服务返回错误' },
      badge: { label: '失败', reason: '上游服务返回错误' },
      detail: { label: '服务出错了', reason: '上游服务返回错误' },
      notification: { label: '服务出错了', reason: '上游服务返回错误' },
    },
    completed: {
      timeline: { label: '已完成', reason: '步骤已全部执行' },
      badge: { label: '完成', reason: '步骤已全部执行' },
      detail: { label: '任务已完成', reason: '步骤已全部执行' },
      notification: { label: '任务已完成', reason: '步骤已全部执行' },
    },
    'completed-with-warnings': {
      timeline: { label: '已完成，有提醒', reason: '任务完成，但仍有未解决的问题' },
      badge: { label: '有提醒', reason: '任务完成，但仍有未解决的问题' },
      detail: { label: '任务已完成，有提醒', reason: '仍有问题需要留意' },
      notification: { label: '任务已完成，有提醒', reason: '仍有问题需要留意' },
    },
    aborted: {
      timeline: { label: '已中止', reason: '执行在完成前终止' },
      badge: { label: '已中止', reason: '执行在完成前终止' },
      detail: { label: '任务已中止', reason: '执行在完成前终止' },
      notification: { label: '任务已中止', reason: '执行在完成前终止' },
    },
    'goal-met': {
      timeline: { label: '目标达成', reason: '目标要求已经满足' },
      badge: { label: '目标达成', reason: '目标要求已经满足' },
      detail: { label: '目标已经达成', reason: '目标要求已经满足' },
      notification: { label: '目标已经达成', reason: '目标要求已经满足' },
    },
  },
};

export const outcomeWordsEn: OutcomeWordsBundle = {
  outcomeWords: {
    'cancelled-by-user': {
      timeline: { label: 'Cancelled', reason: 'You stopped this run' },
      badge: { label: 'Cancelled', reason: 'You stopped this run' },
      detail: { label: 'Task cancelled', reason: 'You stopped this run' },
      notification: { label: 'Task cancelled', reason: 'You stopped this run' },
    },
    'interrupted-session-switch': {
      timeline: { label: 'Interrupted', reason: 'Interrupted when you switched conversations' },
      badge: { label: 'Interrupted', reason: 'Interrupted when you switched conversations' },
      detail: { label: 'Task interrupted', reason: 'Interrupted when you switched conversations' },
      notification: { label: 'Task interrupted', reason: 'Interrupted when you switched conversations' },
    },
    'interrupted-restart': {
      timeline: { label: 'Interrupted', reason: 'Interrupted when the app restarted' },
      badge: { label: 'Interrupted', reason: 'Interrupted when the app restarted' },
      detail: { label: 'Task interrupted', reason: 'Interrupted when the app restarted' },
      notification: { label: 'Task interrupted', reason: 'Interrupted when the app restarted' },
    },
    'interrupted-by-parent': {
      timeline: { label: 'Interrupted', reason: 'The parent task stopped this run' },
      badge: { label: 'Interrupted', reason: 'The parent task stopped this run' },
      detail: { label: 'Task interrupted', reason: 'The parent task stopped this run' },
      notification: { label: 'Task interrupted', reason: 'The parent task stopped this run' },
    },
    'interrupted-unknown': {
      timeline: { label: 'Interrupted', reason: 'The run ended before completion' },
      badge: { label: 'Interrupted', reason: 'The run ended before completion' },
      detail: { label: 'Task interrupted', reason: 'The run ended before completion' },
      notification: { label: 'Task interrupted', reason: 'The run ended before completion' },
    },
    'failed-tool': {
      timeline: { label: 'Execution failed', reason: 'The tool did not finish this step' },
      badge: { label: 'Failed', reason: 'The tool did not finish this step' },
      detail: { label: 'Tool execution failed', reason: 'The tool did not finish this step' },
      notification: { label: 'Tool execution failed', reason: 'The tool did not finish this step' },
    },
    'failed-model': {
      timeline: { label: 'Generation failed', reason: 'The model did not finish its reply' },
      badge: { label: 'Failed', reason: 'The model did not finish its reply' },
      detail: { label: 'Model generation failed', reason: 'The model did not finish its reply' },
      notification: { label: 'Model generation failed', reason: 'The model did not finish its reply' },
    },
    'failed-unknown': {
      timeline: { label: 'Execution failed', reason: 'An error occurred during the run' },
      badge: { label: 'Failed', reason: 'An error occurred during the run' },
      detail: { label: 'Task failed', reason: 'An error occurred during the run' },
      notification: { label: 'Task failed', reason: 'An error occurred during the run' },
    },
    'failed-approval-denied': {
      timeline: { label: 'Not approved', reason: 'The approval was denied' },
      badge: { label: 'Denied', reason: 'The approval was denied' },
      detail: { label: 'Approval denied', reason: 'The approval was denied' },
      notification: { label: 'Approval denied', reason: 'The approval was denied' },
    },
    'failed-timeout': {
      timeline: { label: 'Interrupted', reason: 'Waiting for an answer or permission timed out' },
      badge: { label: 'Interrupted', reason: 'Waiting for an answer or permission timed out' },
      detail: { label: 'Task interrupted', reason: 'Waiting for an answer or permission timed out' },
      notification: { label: 'Task interrupted', reason: 'Waiting for an answer or permission timed out' },
    },
    'failed-budget': {
      timeline: { label: 'Budget exhausted', reason: 'The run reached its budget limit' },
      badge: { label: 'Budget exhausted', reason: 'The run reached its budget limit' },
      detail: { label: 'Task incomplete', reason: 'The run reached its budget limit' },
      notification: { label: 'Task incomplete', reason: 'The run reached its budget limit' },
    },
    'failed-dependency': {
      timeline: { label: 'Dependency failed', reason: 'A prerequisite task did not finish' },
      badge: { label: 'Dependency failed', reason: 'A prerequisite task did not finish' },
      detail: { label: 'Task incomplete', reason: 'A prerequisite task did not finish' },
      notification: { label: 'Task incomplete', reason: 'A prerequisite task did not finish' },
    },
    'failed-unavailable': {
      timeline: { label: 'Capability unavailable', reason: 'A required tool or runtime was unavailable' },
      badge: { label: 'Unavailable', reason: 'A required tool or runtime was unavailable' },
      detail: { label: 'Task incomplete', reason: 'A required tool or runtime was unavailable' },
      notification: { label: 'Task incomplete', reason: 'A required tool or runtime was unavailable' },
    },
    'failed-upstream': {
      timeline: { label: 'Service error', reason: 'The upstream service returned an error' },
      badge: { label: 'Failed', reason: 'The upstream service returned an error' },
      detail: { label: 'Service error', reason: 'The upstream service returned an error' },
      notification: { label: 'Service error', reason: 'The upstream service returned an error' },
    },
    completed: {
      timeline: { label: 'Completed', reason: 'All steps finished' },
      badge: { label: 'Done', reason: 'All steps finished' },
      detail: { label: 'Task completed', reason: 'All steps finished' },
      notification: { label: 'Task completed', reason: 'All steps finished' },
    },
    'completed-with-warnings': {
      timeline: { label: 'Completed with warnings', reason: 'The task finished with unresolved issues' },
      badge: { label: 'Warnings', reason: 'The task finished with unresolved issues' },
      detail: { label: 'Task completed with warnings', reason: 'Some issues still need attention' },
      notification: { label: 'Task completed with warnings', reason: 'Some issues still need attention' },
    },
    aborted: {
      timeline: { label: 'Aborted', reason: 'The run ended before completion' },
      badge: { label: 'Aborted', reason: 'The run ended before completion' },
      detail: { label: 'Task aborted', reason: 'The run ended before completion' },
      notification: { label: 'Task aborted', reason: 'The run ended before completion' },
    },
    'goal-met': {
      timeline: { label: 'Goal met', reason: 'The requested goal was satisfied' },
      badge: { label: 'Goal met', reason: 'The requested goal was satisfied' },
      detail: { label: 'Goal met', reason: 'The requested goal was satisfied' },
      notification: { label: 'Goal met', reason: 'The requested goal was satisfied' },
    },
  },
};
