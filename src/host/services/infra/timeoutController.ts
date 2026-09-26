// ============================================================================
// Timeout Controller - Safe timeout Promise management
// Prevents timer leaks by properly cleaning up setTimeout references
// ============================================================================

/**
 * 超时控制器 - 用于安全地创建和清理超时 Promise
 *
 * 解决的问题：
 * - Promise.race 中未被使用的超时 Promise 会导致定时器泄漏
 * - 需要手动追踪和清理 setTimeout 引用
 *
 * @example
 * ```typescript
 * const controller = new TimeoutController();
 * try {
 *   const result = await Promise.race([
 *     someAsyncOperation(),
 *     controller.createTimeoutPromise(5000, 'Operation timeout'),
 *   ]);
 *   return result;
 * } finally {
 *   controller.clear();
 * }
 * ```
 */
export class TimeoutController {
  private timeoutId: NodeJS.Timeout | null = null;
  private timedOut = false;
  private startedAt = 0;
  private totalMs = 0;
  private remainingMs = 0;
  private paused = false;
  private rejectFn: ((reason: Error) => void) | null = null;
  private timeoutMessage = '';

  /**
   * 创建一个超时 Promise
   * @param ms 超时时间（毫秒）
   * @param message 超时错误信息
   */
  createTimeoutPromise<T = never>(ms: number, message?: string): Promise<T> {
    this.totalMs = ms;
    this.remainingMs = ms;
    this.startedAt = Date.now();
    this.timeoutMessage = message || `Operation timeout after ${ms}ms`;

    return new Promise<T>((_, reject) => {
      this.rejectFn = reject;
      this.timeoutId = setTimeout(() => {
        this.timedOut = true;
        reject(new Error(this.timeoutMessage));
      }, ms);
    });
  }

  /**
   * 清理定时器。清掉 reject 句柄，避免 pause 后的 resume 把已结束的计时器又点着。
   */
  clear(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.rejectFn = null;
    this.paused = false;
  }

  /**
   * 检查是否已超时
   */
  isTimedOut(): boolean {
    return this.timedOut;
  }

  /**
   * 暂停超时计时器，记录剩余时间。
   * remainingMs 是当前分段起点的剩余量，多次 pause/resume 必须从它扣，不能回退到 totalMs。
   */
  pause(now = Date.now()): void {
    if (this.paused || this.timedOut || this.timeoutId === null) return;

    const elapsed = now - this.startedAt;
    this.remainingMs = Math.max(0, this.remainingMs - elapsed);
    clearTimeout(this.timeoutId);
    this.timeoutId = null;
    this.paused = true;
  }

  /**
   * 恢复超时计时器，使用剩余时间继续倒计时
   */
  resume(now = Date.now()): void {
    if (!this.paused || this.timedOut || !this.rejectFn) return;

    this.startedAt = now;
    this.paused = false;
    this.timeoutId = setTimeout(() => {
      this.timedOut = true;
      this.rejectFn!(new Error(this.timeoutMessage));
    }, this.remainingMs);
  }

  /**
   * 检查是否已暂停
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * 获取剩余超时时间（毫秒）
   */
  getRemainingMs(now = Date.now()): number {
    if (this.paused) return this.remainingMs;
    if (this.timedOut) return 0;
    if (this.startedAt === 0) return this.totalMs;
    return Math.max(0, this.remainingMs - (now - this.startedAt));
  }

  /**
   * 已计入预算的已用时间（暂停区间不计）。墙钟预算用这个和上限比较。
   */
  getElapsedMs(now = Date.now()): number {
    if (this.timedOut) return this.totalMs;
    return Math.max(0, this.totalMs - this.getRemainingMs(now));
  }
}

/**
 * 带超时的 Promise 包装器
 *
 * 自动清理超时定时器，无需手动管理
 *
 * @param promise 要执行的 Promise
 * @param ms 超时时间（毫秒）
 * @param message 超时错误信息
 * @returns Promise 结果或超时错误
 *
 * @example
 * ```typescript
 * // 简单用法
 * const result = await withTimeout(fetch(url), 5000, 'Fetch timeout');
 *
 * // 替代手动 Promise.race + setTimeout
 * // 之前的写法（有泄漏风险）：
 * const result = await Promise.race([
 *   fetch(url),
 *   new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
 * ]);
 *
 * // 修复后的写法：
 * const result = await withTimeout(fetch(url), 5000, 'timeout');
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message?: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(message || `Operation timeout after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * 创建可取消的超时
 *
 * 适用于需要在多处取消超时的场景
 *
 * @param ms 超时时间（毫秒）
 * @param message 超时错误信息
 * @returns 超时 Promise 和取消函数
 *
 * @example
 * ```typescript
 * const { promise, cancel } = createCancellableTimeout(5000);
 * try {
 *   await Promise.race([someOperation(), promise]);
 * } finally {
 *   cancel();
 * }
 * ```
 */
export function createCancellableTimeout(
  ms: number,
  message?: string
): { promise: Promise<never>; cancel: () => void; pause: () => void; resume: () => void } {
  let timeoutId: NodeJS.Timeout | null = null;
  let rejectFn: ((reason: Error) => void) | null = null;
  let startedAt = Date.now();
  let remainingMs = ms;
  let paused = false;
  const timeoutMessage = message || `Operation timeout after ${ms}ms`;

  const promise = new Promise<never>((_, rej) => {
    rejectFn = rej;
    timeoutId = setTimeout(() => {
      rej(new Error(timeoutMessage));
    }, ms);
  });

  const cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  const pause = () => {
    if (paused || timeoutId === null) return;
    const elapsed = Date.now() - startedAt;
    remainingMs = Math.max(0, remainingMs - elapsed);
    clearTimeout(timeoutId);
    timeoutId = null;
    paused = true;
  };

  const resume = () => {
    if (!paused || !rejectFn) return;
    startedAt = Date.now();
    paused = false;
    timeoutId = setTimeout(() => {
      rejectFn!(new Error(timeoutMessage));
    }, remainingMs);
  };

  return { promise, cancel, pause, resume };
}

// ============================================================================
// 人等待时钟 — 审批 / AskUserQuestion 等待期间暂停已订阅的 TimeoutController
// ============================================================================
//
// 子代理总超时、DAG 任务超时、Goal 墙钟预算都通过 createHumanWaitBoundTimeout
// 订阅这里。begin/end 可重入：并行多张卡只暂停一次，最后一张结束才 resume。
// 拒绝、超时、取消、异常都必须走 end（withHumanWait 的 finally），不能留下永久暂停。

interface HumanWaitListener {
  pause(now: number): void;
  resume(now: number): void;
}

let humanWaitPending = 0;
let humanWaitSince: number | undefined;
let humanWaitAccumulatedMs = 0;
const humanWaitListeners = new Set<HumanWaitListener>();

function notifyHumanWait(paused: boolean, now: number): void {
  for (const listener of humanWaitListeners) {
    if (paused) listener.pause(now);
    else listener.resume(now);
  }
}

/** 人等待开始。已在等待中则只加引用计数。 */
export function beginHumanWait(now = Date.now()): void {
  humanWaitPending += 1;
  if (humanWaitPending === 1) {
    humanWaitSince = now;
    notifyHumanWait(true, now);
  }
}

/** 人等待结束。引用计数归零才 resume 订阅方。多余的 end 是空操作。 */
export function endHumanWait(now = Date.now()): void {
  if (humanWaitPending <= 0) return;
  humanWaitPending -= 1;
  if (humanWaitPending > 0) return;
  if (humanWaitSince !== undefined) {
    humanWaitAccumulatedMs += now - humanWaitSince;
    humanWaitSince = undefined;
  }
  notifyHumanWait(false, now);
}

/** 当前是否有人等待（审批卡 / AskUser 未结算）。 */
export function isHumanWaitActive(): boolean {
  return humanWaitPending > 0;
}

/**
 * 进程内已结束 + 正在进行的人等待合计毫秒。
 * 审批记录 waitMs 用同一时间源（Date.now）在 begin/end 边界取值。
 */
export function getHumanWaitMs(now = Date.now()): number {
  return humanWaitAccumulatedMs + (humanWaitSince !== undefined ? now - humanWaitSince : 0);
}

export async function withHumanWait<T>(work: () => Promise<T>): Promise<T> {
  beginHumanWait();
  try {
    return await work();
  } finally {
    endHumanWait();
  }
}

function bindTimeoutToHumanWait(controller: TimeoutController): () => void {
  const listener: HumanWaitListener = {
    pause: (now) => controller.pause(now),
    resume: (now) => controller.resume(now),
  };
  humanWaitListeners.add(listener);
  if (humanWaitPending > 0) listener.pause(humanWaitSince ?? Date.now());
  return () => {
    humanWaitListeners.delete(listener);
  };
}

/**
 * 带人等待暂停能力的超时。先 createTimeoutPromise 再订阅，
 * 否则 pause 时 timeoutId 仍是 null 会空操作。
 */
export function createHumanWaitBoundTimeout(
  ms: number,
  message?: string,
): { controller: TimeoutController; promise: Promise<never>; unbind: () => void } {
  const controller = new TimeoutController();
  const promise = controller.createTimeoutPromise<never>(ms, message);
  void promise.catch(() => {});
  const unbind = bindTimeoutToHumanWait(controller);
  return { controller, promise, unbind };
}
