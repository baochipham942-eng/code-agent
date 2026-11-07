import { createLogger } from '../infra/logger';

// ============================================================================
// Wake Run Guard — 无人值守醒来的两道保险（D3：goal run 挂死不再无限等待）
// ============================================================================
//
// 醒来（含 advance goal run）没有人在场：run 一旦停住——模型空转触发 anti_spin
// 暂停（conversationRuntime pause 后无人 resume），或底层链路卡死——没有任何
// 交互方会把它救回来，cron 执行行就会停在 running 直到被杀。这里各上一道闸：
//   - withWakeRunTimeout：墙钟超时。超时取消底层 run 并抛可区分错误（cron 记 failed）
//   - withGoalPauseAbort：观察到 goal_iteration 落到 paused 时取消 run、按 aborted 收尾
// 交互式 goal 的暂停/恢复（用户在场时的 pause/resume）不受影响：本文件只被
// 无人值守醒来链路（roleProactivity）使用。

const logger = createLogger('RoleProactivity');

/** 超时可以命中的两个阶段（warn 与错误文本都要写清是哪一段挂了） */
type WakeRunPhase = 'wake-run' | 'advance-goal-run';

export interface WakeRunTimeoutOptions {
  roleId: string;
  sessionId: string;
  phase: WakeRunPhase;
  /** 墙钟超时；生产传 ROLE_PROACTIVITY.WAKE_TIMEOUT_MS（测试可注入短超时） */
  timeoutMs: number;
  /** 超时后取消底层 run（orchestrator.cancel / agentLoop.cancel，按活动路径给） */
  cancel: () => Promise<void> | void;
}

/**
 * 给无人值守 run 套墙钟超时。超时时：warn 原因 → 取消底层 run → 抛
 * `Role wake timed out after <N>ms (<phase>)`（cron 执行记录据此标 failed）。
 * run 自身的失败原样上抛；取消后底层 run 的迟到拒绝被吞掉，不能变成 unhandled。
 */
export async function withWakeRunTimeout<T>(run: () => Promise<T>, options: WakeRunTimeoutOptions): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const runPromise = run();
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(
        `Role wake timed out after ${options.timeoutMs}ms (${options.phase}, role=${options.roleId}, session=${options.sessionId})`,
      ));
    }, options.timeoutMs);
  });
  try {
    return await Promise.race([runPromise, timeoutPromise]);
  } catch (error) {
    if (!timedOut) throw error;
    logger.warn('Role wake run timed out, cancelling underlying run', {
      roleId: options.roleId,
      sessionId: options.sessionId,
      phase: options.phase,
      timeoutMs: options.timeoutMs,
    });
    await Promise.resolve(options.cancel()).catch(() => undefined);
    void runPromise.catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** goal 暂停观察结果（orchestrator 路径读落库事件，headless 路径读 onEvent 闭包旗标） */
export interface GoalPauseObservation {
  paused: boolean;
  pauseReason?: string;
}

/** 暂停胜出时 withGoalPauseAbort 的返回哨兵（与 run 的正常返回值区分开） */
type GoalPausedSentinel = 'goal-paused';

export interface GoalPauseAbortOptions {
  roleId: string;
  sessionId: string;
  /** 轮询间隔（ms）：立即首查一次，之后按间隔查 */
  pollIntervalMs: number;
  observePause: () => Promise<GoalPauseObservation> | GoalPauseObservation;
  cancel: () => Promise<void> | void;
}

/**
 * 无人值守 goal run 的暂停闸：观察到 goal_iteration 落到 paused（如 anti_spin）
 * 时不再等待——取消底层 run、返回 'goal-paused'，由调用方按 aborted 收尾。
 * 醒来会话没有用户，paused 的 goal 永远不会被恢复，等下去就是挂死。
 */
export async function withGoalPauseAbort<T>(
  run: () => Promise<T>,
  options: GoalPauseAbortOptions,
): Promise<T | GoalPausedSentinel> {
  let lastPauseReason: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const pausePromise = new Promise<GoalPausedSentinel>((resolve) => {
    const poll = async () => {
      try {
        const state = await options.observePause();
        if (state.paused) {
          lastPauseReason = state.pauseReason;
          resolve('goal-paused');
        }
      } catch {
        // 观察失败（如事件服务暂不可用）只跳过本轮，不中止轮询
      }
    };
    void poll(); // 立即首查：暂停已发生时零延迟命中
    timer = setInterval(() => { void poll(); }, options.pollIntervalMs);
  });
  const runPromise = run();
  try {
    const winner = await Promise.race([runPromise, pausePromise]);
    if (winner === 'goal-paused') {
      logger.warn('Role wake goal run paused while unattended, aborting instead of waiting', {
        roleId: options.roleId,
        sessionId: options.sessionId,
        pauseReason: lastPauseReason,
      });
      await Promise.resolve(options.cancel()).catch(() => undefined);
      void runPromise.catch(() => {});
      return 'goal-paused';
    }
    return winner;
  } finally {
    if (timer) clearInterval(timer);
  }
}

/**
 * orchestrator 路径的暂停观察：读该会话落库的 goal_iteration 事件，
 * 最后一条的 goalStatus 为 paused 即视为暂停（带 pauseReason，如 anti_spin）。
 * 读不到 / 读失败按未暂停处理（不因观察面故障误杀 run）。
 */
export async function observeGoalPauseFromEvents(sessionId: string): Promise<GoalPauseObservation> {
  try {
    const { getSessionEventService } = await import('../../session/sessionEventService');
    const events = getSessionEventService().getEventsByType(sessionId, 'goal_iteration');
    const data = events[events.length - 1]?.eventData as { goalStatus?: string; pauseReason?: string } | undefined;
    return data?.goalStatus === 'paused'
      ? { paused: true, pauseReason: data.pauseReason }
      : { paused: false };
  } catch {
    return { paused: false };
  }
}
