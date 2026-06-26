// ============================================================================
// IPC Timeout Utility - IPC 调用超时保护
// ============================================================================

import { createLogger } from '../../services/infra/logger';

const logger = createLogger('IPCTimeout');

/**
 * 默认 IPC 超时时间（毫秒）
 */
export const DEFAULT_IPC_TIMEOUT = 30000; // 30 秒

/**
 * 超时错误
 */
export class TimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * 为 Promise 添加超时
 *
 * @param promise - 要执行的 Promise
 * @param timeoutMs - 超时时间（毫秒）
 * @param operationName - 操作名称（用于错误消息）
 * @returns 带超时的 Promise
 *
 * @example
 * const result = await withTimeout(
 *   fetchData(),
 *   5000,
 *   'fetchData'
 * );
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = DEFAULT_IPC_TIMEOUT,
  operationName: string = 'operation'
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      logger.warn(`Operation timed out: ${operationName} (${timeoutMs}ms)`);
      reject(new TimeoutError(`${operationName} timed out after ${timeoutMs}ms`, timeoutMs));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * 创建带超时的 IPC Handler 包装器
 *
 * @param handler - 原始 handler 函数
 * @param timeoutMs - 超时时间（毫秒）
 * @param handlerName - handler 名称（用于日志）
 * @returns 包装后的 handler
 *
 * @example
 * ipcMain.handle('session:get', createTimeoutHandler(
 *   async (event, sessionId) => {
 *     return await db.getSession(sessionId);
 *   },
 *   10000,
 *   'session:get'
 * ));
 */
export function createTimeoutHandler<TArgs extends unknown[], TResult>(
  handler: (...args: TArgs) => Promise<TResult>,
  timeoutMs: number = DEFAULT_IPC_TIMEOUT,
  handlerName: string = 'handler'
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs): Promise<TResult> => {
    return withTimeout(handler(...args), timeoutMs, handlerName);
  };
}

/**
 * 带重试的超时 Promise
 *
 * @param promiseFactory - 返回 Promise 的工厂函数（每次重试会调用）
 * @param options - 配置选项
 * @returns 执行结果
 *
 * @example
 * const result = await withTimeoutRetry(
 *   () => fetchData(),
 *   { timeoutMs: 5000, maxRetries: 3, operationName: 'fetchData' }
 * );
 */
export async function withTimeoutRetry<T>(
  promiseFactory: () => Promise<T>,
  options: {
    timeoutMs?: number;
    maxRetries?: number;
    retryDelayMs?: number;
    operationName?: string;
    shouldRetry?: (error: Error) => boolean;
  } = {}
): Promise<T> {
  const {
    timeoutMs = DEFAULT_IPC_TIMEOUT,
    maxRetries = 3,
    retryDelayMs = 1000,
    operationName = 'operation',
    shouldRetry = (error) => error instanceof TimeoutError,
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(promiseFactory(), timeoutMs, operationName);
    } catch (error) {
      lastError = error as Error;

      if (!shouldRetry(lastError) || attempt === maxRetries) {
        throw lastError;
      }

      logger.info(
        `Retry ${attempt}/${maxRetries} for ${operationName} after ${retryDelayMs}ms`
      );

      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw lastError;
}

/**
 * 取消令牌
 */
export interface CancellationToken {
  readonly isCancelled: boolean;
  onCancel(callback: () => void): void;
}

/**
 * 取消令牌源
 */
export class CancellationTokenSource {
  private _isCancelled = false;
  private callbacks: Array<() => void> = [];

  get token(): CancellationToken {
    return {
      isCancelled: this._isCancelled,
      onCancel: (callback) => {
        if (this._isCancelled) {
          callback();
        } else {
          this.callbacks.push(callback);
        }
      },
    };
  }

  cancel(): void {
    if (!this._isCancelled) {
      this._isCancelled = true;
      for (const callback of this.callbacks) {
        try {
          callback();
        } catch (error) {
          logger.error('Cancellation callback error', error);
        }
      }
      this.callbacks = [];
    }
  }
}

/**
 * 带取消的超时 Promise
 *
 * @param promise - 要执行的 Promise
 * @param timeoutMs - 超时时间
 * @param token - 取消令牌
 * @param operationName - 操作名称
 */
export function withTimeoutAndCancellation<T>(
  promise: Promise<T>,
  timeoutMs: number,
  token: CancellationToken,
  operationName: string = 'operation'
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (token.isCancelled) {
      reject(new Error(`${operationName} was cancelled`));
      return;
    }

    const timer = setTimeout(() => {
      reject(new TimeoutError(`${operationName} timed out after ${timeoutMs}ms`, timeoutMs));
    }, timeoutMs);

    token.onCancel(() => {
      clearTimeout(timer);
      reject(new Error(`${operationName} was cancelled`));
    });

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}
