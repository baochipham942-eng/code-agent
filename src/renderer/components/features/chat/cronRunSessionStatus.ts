// ============================================================================
// cronRunSessionStatus — 定时任务运行记录的状态行判定（N-UI-CRON-RUN-RECORD-CLEAR）
// ----------------------------------------------------------------------------
// 纯函数：把「执行记录（CronJobExecution）+ 本会话等批准的停车审批」折成一行
// 用户可读的状态。数据真源：cronStore 的执行记录（host 启动扫描会把进程死掉的
// running 行标成 interrupted，见 cronService.initialize → markInterruptedCronExecutions）
// 与 sessionAutomationClient.listParkedApprovals 的 pending 行。这里不做任何
// 「猜测还活着」的兜底——执行记录说 running 才显示运行中，进程没了启动后就是
// interrupted，显示已中断。
// ============================================================================

import type { CronJobExecution } from '@shared/contract/cron';

export interface CronRunAwaitingApproval {
  /** requestId；批准/拒绝走 IPC_CHANNELS.AGENT_PERMISSION_RESPONSE。 */
  id: string;
  requestedAt: number;
  /** 工具名 / 脱敏参数预览（有才显示「等你批准：在干什么」）。 */
  label?: string;
}

export type CronRunStatusLine =
  | { kind: 'running'; startedAt: number }
  | { kind: 'awaiting'; approval: CronRunAwaitingApproval }
  | { kind: 'interrupted' }
  | { kind: 'finished'; durationMs: number };

const TERMINAL_INTERRUPTED: ReadonlySet<CronJobExecution['status']> = new Set(['failed', 'cancelled', 'interrupted']);

/**
 * 优先级：等批准 > 执行状态。等批准只认 pending（orphaned/voided 不可操作，
 * 且执行记录随后会被启动扫描/收口链路标成 interrupted）。
 * 执行记录缺失（老数据 / 云端运行）返回 null —— 没有真源就不编状态。
 */
export function deriveCronRunStatusLine(input: {
  execution: CronJobExecution | null;
  pendingApproval: CronRunAwaitingApproval | null;
}): CronRunStatusLine | null {
  if (input.pendingApproval) return { kind: 'awaiting', approval: input.pendingApproval };
  const execution = input.execution;
  if (!execution) return null;
  if (execution.status === 'running' || execution.status === 'pending' || execution.status === 'paused') {
    return { kind: 'running', startedAt: execution.startedAt ?? execution.scheduledAt };
  }
  if (execution.status === 'completed') {
    const durationMs = execution.duration
      ?? (execution.completedAt != null && execution.startedAt != null
        ? execution.completedAt - execution.startedAt
        : 0);
    return { kind: 'finished', durationMs: Math.max(0, durationMs) };
  }
  if (TERMINAL_INTERRUPTED.has(execution.status)) return { kind: 'interrupted' };
  return null;
}

/** 流逝时间拆件：单位词由调用方从 i18n 取（zh 时/分/秒，en h/m/s）。 */
export interface ElapsedParts {
  hours: number;
  minutes: number;
  seconds: number;
}

/** 拆出时分秒（不足一小时不带小时；不足一分不带分）。 */
export function splitElapsedParts(elapsedMs: number): ElapsedParts {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

/** 用 i18n 单位词把拆件拼成「N 时 N 分 / N 分 N 秒 / N 秒」。 */
export function composeElapsed(parts: ElapsedParts, units: { hm: string; ms: string; s: string }): string {
  if (parts.hours > 0) return units.hm.replace('{h}', String(parts.hours)).replace('{m}', String(parts.minutes));
  if (parts.minutes > 0) return units.ms.replace('{m}', String(parts.minutes)).replace('{s}', String(parts.seconds));
  return units.s.replace('{s}', String(parts.seconds));
}
