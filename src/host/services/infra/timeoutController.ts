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

    const elapsed = Math.max(0, now - this.startedAt);
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
    const elapsed = Math.max(0, Date.now() - startedAt);
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
// 按 sessionId 分区：会话 A 挂着审批卡不得冻会话 B 的子代理总超时 / DAG /
// Goal 墙钟 / idle watchdog。begin/end 在同一会话内可重入（并行多张卡只暂停
// 一次，最后一张结束才 resume）。拿不到 sessionId 的入口不暂停（保守）。
// 拒绝、超时、取消、异常都必须走 end（withHumanWait 的 finally）。

interface HumanWaitListener {
  pause(now: number): void;
  resume(now: number): void;
}

interface HumanWaitScopeState {
  pending: number;
  since?: number;
  accumulatedMs: number;
  listeners: Set<HumanWaitListener>;
}

const humanWaitScopes = new Map<string, HumanWaitScopeState>();

function getHumanWaitScope(sessionId: string): HumanWaitScopeState {
  let state = humanWaitScopes.get(sessionId);
  if (!state) {
    state = { pending: 0, accumulatedMs: 0, listeners: new Set() };
    humanWaitScopes.set(sessionId, state);
  }
  return state;
}

function notifyHumanWaitScope(state: HumanWaitScopeState, paused: boolean, now: number): void {
  for (const listener of state.listeners) {
    if (paused) listener.pause(now);
    else listener.resume(now);
  }
}

/** 人等待开始。无 sessionId 则空操作。已在该会话等待中则只加引用计数。 */
export function beginHumanWait(sessionId?: string, now = Date.now()): void {
  if (!sessionId) return;
  const state = getHumanWaitScope(sessionId);
  state.pending += 1;
  if (state.pending === 1) {
    state.since = now;
    notifyHumanWaitScope(state, true, now);
  }
}

/** 人等待结束。引用计数归零才 resume 该会话的订阅方。多余的 end 是空操作。 */
export function endHumanWait(sessionId?: string, now = Date.now()): void {
  if (!sessionId) return;
  const state = humanWaitScopes.get(sessionId);
  if (!state || state.pending <= 0) return;
  state.pending -= 1;
  if (state.pending > 0) return;
  if (state.since !== undefined) {
    state.accumulatedMs += now - state.since;
    state.since = undefined;
  }
  notifyHumanWaitScope(state, false, now);
}

/** 该会话当前是否有人等待（审批卡 / AskUser 未结算）。无 sessionId 视为未等待。 */
export function isHumanWaitActive(sessionId?: string): boolean {
  if (!sessionId) return false;
  return (humanWaitScopes.get(sessionId)?.pending ?? 0) > 0;
}

/**
 * 该会话已结束 + 正在进行的人等待合计毫秒。
 * 审批记录 waitMs 用同一时间源（Date.now）在 begin/end 边界取值。
 */
export function getHumanWaitMs(sessionId?: string, now = Date.now()): number {
  if (!sessionId) return 0;
  const state = humanWaitScopes.get(sessionId);
  if (!state) return 0;
  return state.accumulatedMs + (state.since !== undefined ? now - state.since : 0);
}

export async function withHumanWait<T>(work: () => Promise<T>, sessionId?: string): Promise<T> {
  beginHumanWait(sessionId);
  try {
    return await work();
  } finally {
    endHumanWait(sessionId);
  }
}

function bindTimeoutToHumanWait(controller: TimeoutController, sessionId?: string): () => void {
  if (!sessionId) return () => {};
  const state = getHumanWaitScope(sessionId);
  const listener: HumanWaitListener = {
    pause: (now) => controller.pause(now),
    resume: (now) => controller.resume(now),
  };
  state.listeners.add(listener);
  // 订阅时用 Date.now() pause，不能用 since（早于 startedAt 会把 elapsed 算成负数、拉长预算）。
  if (state.pending > 0) listener.pause(Date.now());
  return () => {
    state.listeners.delete(listener);
  };
}

/**
 * 带人等待暂停能力的超时。先 createTimeoutPromise 再订阅，
 * 否则 pause 时 timeoutId 仍是 null 会空操作。无 sessionId 则不订阅（保守）。
 */
export function createHumanWaitBoundTimeout(
  ms: number,
  message?: string,
  sessionId?: string,
): { controller: TimeoutController; promise: Promise<never>; unbind: () => void } {
  const controller = new TimeoutController();
  const promise = controller.createTimeoutPromise<never>(ms, message);
  void promise.catch(() => {});
  const unbind = bindTimeoutToHumanWait(controller, sessionId);
  return { controller, promise, unbind };
}
