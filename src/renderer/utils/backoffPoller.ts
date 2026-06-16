// ============================================================================
// backoffPoller — 带指数退避 + 熔断 + 节流日志的自调度轮询器。
//
// 解决两个问题：
//  1. 固定 setInterval 轮询在后端不可达时空转猛打（空闲也每 2~5s 一次）。
//  2. 每轮失败都打日志 → 后端挂掉时日志刷屏（实测可冲到百万行）。
//
// 行为：用 setTimeout 链式自调度（不重叠：等上一轮 settle 再排下一轮）。
// 成功 → 间隔重置为 baseInterval；失败 → 间隔 ×factor 直到 maxInterval。
// 日志只在「健康→失败」和「失败→恢复」两个状态切换点各打一次，避免刷屏。
// ============================================================================

export interface BackoffPollerOptions {
  /** 健康时的基础轮询间隔 (ms) */
  baseInterval: number;
  /** 失败退避的间隔上限 (ms) */
  maxInterval: number;
  /** 退避倍率（每次失败乘以此值，上限 maxInterval），默认 2 */
  factor?: number;
  /** 是否启动时立即跑一次，默认 true */
  runImmediately?: boolean;
  /** 进入失败状态时回调一次（节流，连续失败只回调首次） */
  onError?: (error: unknown, consecutiveFailures: number) => void;
  /** 从失败恢复到成功时回调一次 */
  onRecover?: () => void;
  /** 自定义定时器（测试用），默认全局 setTimeout/clearTimeout */
  setTimeoutFn?: (handler: () => void, timeout: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface BackoffPoller {
  /** 启动轮询（重复调用幂等） */
  start: () => void;
  /** 停止轮询并清理定时器 */
  stop: () => void;
  /** 当前调度间隔（ms），供观测/测试 */
  getCurrentInterval: () => number;
}

/**
 * 创建一个自调度轮询器。`task` 抛错视为一次失败并触发退避。
 */
export function createBackoffPoller(
  task: () => Promise<void>,
  options: BackoffPollerOptions,
): BackoffPoller {
  const {
    baseInterval,
    maxInterval,
    factor = 2,
    runImmediately = true,
    onError,
    onRecover,
    setTimeoutFn = (h, t) => setTimeout(h, t),
    clearTimeoutFn = (handle) => clearTimeout(handle),
  } = options;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let currentInterval = baseInterval;
  let consecutiveFailures = 0;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  };

  const scheduleNext = (): void => {
    if (!running) return;
    clearTimer();
    timer = setTimeoutFn(() => {
      void runOnce();
    }, currentInterval);
  };

  const runOnce = async (): Promise<void> => {
    if (!running) return;
    try {
      await task();
      // 成功：重置退避；若刚从失败恢复则回调一次
      if (consecutiveFailures > 0) {
        consecutiveFailures = 0;
        onRecover?.();
      }
      currentInterval = baseInterval;
    } catch (error) {
      consecutiveFailures += 1;
      // 只在首次失败时回调，避免刷屏
      if (consecutiveFailures === 1) {
        onError?.(error, consecutiveFailures);
      }
      currentInterval = Math.min(currentInterval * factor, maxInterval);
    } finally {
      scheduleNext();
    }
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      currentInterval = baseInterval;
      consecutiveFailures = 0;
      if (runImmediately) {
        void runOnce();
      } else {
        scheduleNext();
      }
    },
    stop: () => {
      running = false;
      clearTimer();
    },
    getCurrentInterval: () => currentInterval,
  };
}
