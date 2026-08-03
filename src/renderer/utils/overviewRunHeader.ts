// ============================================================================
// Overview Run header 视图模型（T1 主路径收口）
// ----------------------------------------------------------------------------
// 概览主视线是「进度与干预」：有 run 时置顶一条 Run header（任务名 + 状态 +
// 用时 + 中断），无 run 时返回 null——不摆空壳。
// 数据全部来自既有 run/turn 状态（RunUiState），不另起轮询。
// ============================================================================

import type { RunUiState, RunUiStatus } from '../types/runWorkbench';

/**
 * run 处于这些状态说明有活跃回合在跑。此前 useTaskActivity / RunWorkbenchCards
 * 各存一份同样的集合，T1 收敛到这里作为唯一真源。
 */
const LIVE_RUN_STATUSES: ReadonlySet<RunUiStatus> = new Set([
  'planning',
  'running',
  'using_tools',
  'verifying',
  'waiting_approval',
]);

export function isLiveRunStatus(status: RunUiStatus): boolean {
  return LIVE_RUN_STATUSES.has(status);
}

export interface OverviewRunHeaderModel {
  /** 当前轮任务名：会话标题优先，缺失时退回 run.phase */
  title: string;
  /** 当前步骤（run.phase），与 title 相同则不重复渲染 */
  phase: string | null;
  status: RunUiStatus;
  /** 用时；起点未知时为 null（不假造 0） */
  elapsedMs: number | null;
  /** 活跃回合：秒表在走、给中断按钮 */
  live: boolean;
}

export function buildOverviewRunHeaderModel(args: {
  run: RunUiState;
  sessionTitle?: string | null;
  now: number;
}): OverviewRunHeaderModel | null {
  // 「有没有 run」只认 turn 的存在：run.status 在空会话里也默认 'completed'，
  // 拿状态判存在会给从没跑过的会话摆一条「已完成」表头。
  if (!args.run.identity.turnId) return null;

  const live = isLiveRunStatus(args.run.status);
  const title = args.sessionTitle?.trim() || args.run.phase;
  const phase = args.run.phase && args.run.phase !== title ? args.run.phase : null;

  return {
    title,
    phase,
    status: args.run.status,
    elapsedMs: elapsedMs(args.run, live, args.now),
    live,
  };
}

function elapsedMs(run: RunUiState, live: boolean, now: number): number | null {
  if (run.startedAt === undefined) return null;
  const end = live ? now : run.endedAt ?? now;
  return Math.max(0, end - run.startedAt);
}

/** 用时显示成 m:ss / h:mm:ss —— 纯数字，不需要按语言翻单位。 */
export function formatElapsedClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return hours > 0
    ? `${hours}:${mm}:${String(seconds).padStart(2, '0')}`
    : `${mm}:${String(seconds).padStart(2, '0')}`;
}
