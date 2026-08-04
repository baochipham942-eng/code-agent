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

/**
 * 概览细进度线的三态（+等待确认子态）——状态点颜色与文案的唯一判据。
 * waiting_approval 不单列第四态（2026-08-04 D3 拍板）：并入进行中，仅黄点 + 「等你确认」。
 */
export type RunOverviewTone = 'live' | 'waiting' | 'done' | 'error';

export function deriveRunOverviewTone(status: RunUiStatus): RunOverviewTone {
  if (status === 'waiting_approval') return 'waiting';
  if (isLiveRunStatus(status)) return 'live';
  if (status === 'completed') return 'done';
  return 'error';
}

export interface OverviewRunHeaderModel {
  /** 当前轮任务名：会话标题优先，缺失时退回 run.phase */
  title: string;
  /** 当前步骤（run.phase），与 title 相同则不重复渲染；完成/异常态为 null（动作句消失） */
  phase: string | null;
  status: RunUiStatus;
  /** 三态判据：状态点颜色 + 文案差异 */
  tone: RunOverviewTone;
  /** 步骤计数（第 N 步 / 共 M 步）；无 TODO 为 null */
  steps: { current: number; total: number } | null;
  /** 异常态的人话结局键；非异常态为 null */
  outcome: 'cancelled' | 'error' | null;
  /** 用时；起点未知时为 null（不假造 0） */
  elapsedMs: number | null;
  /** 活跃回合：秒表在走、给中断按钮 */
  live: boolean;
}

export function buildOverviewRunHeaderModel(args: {
  run: RunUiState;
  sessionTitle?: string | null;
  now: number;
  /** TODO 进度（summarizeTodoProgress）；total=0 视为无 TODO，不出步骤段 */
  todoProgress?: { completed: number; total: number } | null;
}): OverviewRunHeaderModel | null {
  // 「有没有 run」只认 turn 的存在：run.status 在空会话里也默认 'completed'，
  // 拿状态判存在会给从没跑过的会话摆一条「已完成」表头。
  if (!args.run.identity.turnId) return null;

  const live = isLiveRunStatus(args.run.status);
  const tone = deriveRunOverviewTone(args.run.status);
  const title = args.sessionTitle?.trim() || args.run.phase;
  const total = args.todoProgress?.total ?? 0;
  const completed = args.todoProgress?.completed ?? 0;

  return {
    title,
    // 完成/异常态不摆当前动作句（异常态由 outcome 人话结局顶替）
    phase: tone === 'live' || tone === 'waiting'
      ? (args.run.phase && args.run.phase !== title ? args.run.phase : null)
      : null,
    status: args.run.status,
    tone,
    steps: total > 0
      ? { current: tone === 'done' ? total : Math.min(completed + 1, total), total }
      : null,
    outcome: tone === 'error'
      ? (args.run.status === 'cancelled' ? 'cancelled' : 'error')
      : null,
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
