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
import type { TraceTurn } from '@shared/contract/trace';
import { isParkedApprovalClosureSentence } from '@shared/parkedApprovalClosure';

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
  | { kind: 'failed-denied' }
  | { kind: 'failed-generic' }
  | { kind: 'cancelled' }
  | { kind: 'finished'; durationMs: number };

export function hasParkedApprovalClosure(turn: Pick<TraceTurn, 'nodes'>): boolean {
  return turn.nodes.some((node) => (
    node.type === 'tool_call'
    && isParkedApprovalClosureSentence(node.toolCall?.result)
  ));
}

/**
 * 判断失败运行是否由命令/权限被拒引起（与执行记录 error 字段及权限拒绝信号同源，
 * 不扫模型自由回复文本）。中文关键词用 Unicode 转义，满足 chatI18nRatchet 对源码无汉字字面量的要求。
 * 只认「用户真的拒了」的信号：裸 "Permission denied" 多是 shell/文件系统权限错（EACCES），
 * UNATTENDED_APPROVAL_TIMEOUT 是无人批准超时（没人拒，也没人批）——两者都不是「命令被拒绝」。
 */
const PERMISSION_DENIAL_ERROR_RE =
  /(?:^|\b)(?:PERMISSION_DENIED(?:_[A-Z0-9_]+)?|Permission denied by user|Command was denied|command was denied|user denied|declined by user)(?:\b|$)/;
const PERMISSION_DENIAL_ZH_TOKENS = [
  String.fromCharCode(0x7528, 0x6237, 0x62d2, 0x7edd, 0x4e86, 0x8be5, 0x547d, 0x4ee4), // 用户拒绝了该命令
  String.fromCharCode(0x547d, 0x4ee4, 0x88ab, 0x62d2, 0x7edd), // 命令被拒绝
  String.fromCharCode(0x88ab, 0x81ea, 0x52a8, 0x62d2, 0x7edd), // 被自动拒绝
  String.fromCharCode(0x6743, 0x9650, 0x88ab, 0x62d2, 0x7edd), // 权限被拒绝
  String.fromCharCode(0x672a, 0x83b7, 0x81ea, 0x52a8, 0x6279, 0x51c6), // 未获自动批准
];

export function isCronExecutionPermissionDenialError(error: string | undefined | null): boolean {
  if (!error) return false;
  if (PERMISSION_DENIAL_ERROR_RE.test(error)) return true;
  return PERMISSION_DENIAL_ZH_TOKENS.some((token) => error.includes(token));
}

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
  if (execution.status === 'interrupted') return { kind: 'interrupted' };
  if (execution.status === 'cancelled') return { kind: 'cancelled' };
  if (execution.status === 'failed') {
    return isCronExecutionPermissionDenialError(execution.error)
      ? { kind: 'failed-denied' }
      : { kind: 'failed-generic' };
  }
  return null;
}

/** 终态运行（不再轮询；也不会自己变回运行中）。 */
export function isTerminalCronRunStatusKind(kind: CronRunStatusLine['kind'] | null | undefined): boolean {
  return (
    kind === 'finished'
    || kind === 'interrupted'
    || kind === 'failed-denied'
    || kind === 'failed-generic'
    || kind === 'cancelled'
  );
}

/** 按 executionId（优先）或 sessionId 匹配会话对应的执行记录。 */
export function findCronExecutionForSession(
  executions: readonly CronJobExecution[],
  args: { executionId?: string; sessionId: string },
): CronJobExecution | null {
  if (args.executionId) {
    const byId = executions.find((execution) => execution.id === args.executionId);
    if (byId) return byId;
  }
  return executions.find((execution) => execution.sessionId === args.sessionId) ?? null;
}

/**
 * 会话内观测到的最新运行状态（由 CronRunSessionStatusBar 同步写入）：
 * 供 ChatInput placeholder 与 useCronRunFollowUpSend 读取，无需重复挂轮询。
 */
const observedCronRunStatusBySession = new Map<string, CronRunStatusLine | null>();
const observedCronRunListeners = new Set<() => void>();

export function setObservedCronRunStatusForSession(sessionId: string, status: CronRunStatusLine | null): void {
  const prev = observedCronRunStatusBySession.get(sessionId);
  if (prev?.kind === status?.kind && prev === status) return;
  observedCronRunStatusBySession.set(sessionId, status);
  for (const listener of observedCronRunListeners) listener();
}

/** 状态行组件卸载时清掉本会话的观测值：模块级 Map 不随打开过的记录会话无限增长。 */
export function clearObservedCronRunStatusForSession(sessionId: string): void {
  if (!observedCronRunStatusBySession.delete(sessionId)) return;
  for (const listener of observedCronRunListeners) listener();
}

export function getObservedCronRunStatusForSession(sessionId: string | null | undefined): CronRunStatusLine | null {
  if (!sessionId) return null;
  return observedCronRunStatusBySession.get(sessionId) ?? null;
}

export function subscribeObservedCronRunStatus(listener: () => void): () => void {
  observedCronRunListeners.add(listener);
  return () => {
    observedCronRunListeners.delete(listener);
  };
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
