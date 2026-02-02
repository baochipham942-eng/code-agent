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

  /**
   * 创建一个超时 Promise
   * @param ms 超时时间（毫秒）
   * @param message 超时错误信息
   */
  createTimeoutPromise<T = never>(ms: number, message?: string): Promise<T> {
    return new Promise<T>((_, reject) => {
      this.timeoutId = setTimeout(() => {
        this.timedOut = true;
        reject(new Error(message || `Operation timeout after ${ms}ms`));
      }, ms);
    });
  }

  /**
   * 清理定时器
   */
  clear(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * 检查是否已超时
   */
  isTimedOut(): boolean {
    return this.timedOut;
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
): { promise: Promise<never>; cancel: () => void } {
  let timeoutId: NodeJS.Timeout | null = null;
  let reject: ((reason: Error) => void) | null = null;

  const promise = new Promise<never>((_, rej) => {
    reject = rej;
    timeoutId = setTimeout(() => {
      rej(new Error(message || `Operation timeout after ${ms}ms`));
    }, ms);
  });

  const cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return { promise, cancel };
}
