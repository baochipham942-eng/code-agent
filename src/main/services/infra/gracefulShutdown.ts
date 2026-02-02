// ============================================================================
// Graceful Shutdown - Coordinated cleanup on process exit
// ============================================================================

import { createLogger } from './logger';

const logger = createLogger('GracefulShutdown');

// ============================================================================
// Types
// ============================================================================

export interface ShutdownHandler {
  /** 处理器名称（用于日志） */
  name: string;
  /** 清理函数 */
  handler: () => Promise<void>;
  /** 优先级（数字越小越先执行） */
  priority: number;
}

// ============================================================================
// Configuration
// ============================================================================

/** 默认关闭超时（毫秒） */
const DEFAULT_SHUTDOWN_TIMEOUT = 5000;

// ============================================================================
// State
// ============================================================================

const shutdownHandlers: ShutdownHandler[] = [];
let isShuttingDown = false;
let shutdownPromise: Promise<never> | null = null;

// ============================================================================
// Public API
// ============================================================================

/**
 * 注册关闭处理器
 *
 * 处理器将在进程退出时按优先级顺序执行
 *
 * @param name 处理器名称（用于日志）
 * @param handler 清理函数
 * @param priority 优先级（数字越小越先执行，默认 5）
 *
 * @example
 * ```typescript
 * // 注册数据库关闭处理器（优先级低，最后关闭）
 * onShutdown('database', async () => {
 *   await db.close();
 * }, 10);
 *
 * // 注册任务取消处理器（优先级高，先执行）
 * onShutdown('taskManager', async () => {
 *   await taskManager.cancelAll();
 * }, 1);
 * ```
 */
export function onShutdown(
  name: string,
  handler: () => Promise<void>,
  priority: number = 5
): void {
  shutdownHandlers.push({ name, handler, priority });
  // 按优先级排序（数字越小越靠前）
  shutdownHandlers.sort((a, b) => a.priority - b.priority);
  logger.debug(`Shutdown handler registered: ${name} (priority: ${priority})`);
}

/**
 * 移除关闭处理器
 *
 * @param name 要移除的处理器名称
 */
export function removeShutdownHandler(name: string): boolean {
  const index = shutdownHandlers.findIndex(h => h.name === name);
  if (index !== -1) {
    shutdownHandlers.splice(index, 1);
    logger.debug(`Shutdown handler removed: ${name}`);
    return true;
  }
  return false;
}

/**
 * 执行优雅退出
 *
 * 按优先级顺序执行所有注册的清理处理器，然后退出进程
 *
 * @param exitCode 退出码（默认 0）
 * @param timeout 超时时间（毫秒，默认 5000）
 *
 * @example
 * ```typescript
 * // 处理 SIGTERM
 * process.on('SIGTERM', () => gracefulShutdown(0));
 *
 * // 处理致命错误
 * process.on('uncaughtException', (error) => {
 *   console.error('Fatal error:', error);
 *   gracefulShutdown(1);
 * });
 * ```
 */
export async function gracefulShutdown(
  exitCode: number = 0,
  timeout: number = DEFAULT_SHUTDOWN_TIMEOUT
): Promise<never> {
  // 防止重复调用
  if (shutdownPromise) {
    return shutdownPromise;
  }

  if (isShuttingDown) {
    // 已在关闭中，等待完成
    await new Promise(resolve => setTimeout(resolve, timeout));
    process.exit(exitCode);
  }

  isShuttingDown = true;
  logger.info('Graceful shutdown initiated', { exitCode, handlerCount: shutdownHandlers.length });

  shutdownPromise = (async () => {
    const startTime = Date.now();

    // 创建超时 Promise
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        logger.warn('Shutdown timeout reached, forcing exit');
        resolve();
      }, timeout);
    });

    // 执行所有清理处理器
    const cleanupPromise = executeHandlers();

    // 等待清理完成或超时
    await Promise.race([cleanupPromise, timeoutPromise]);

    const duration = Date.now() - startTime;
    logger.info(`Graceful shutdown completed in ${duration}ms`);

    // 退出进程
    process.exit(exitCode);
  })() as Promise<never>;

  return shutdownPromise;
}

/**
 * 检查是否正在关闭
 */
export function isInShutdown(): boolean {
  return isShuttingDown;
}

/**
 * 获取关闭管理器实例（用于 Electron app 事件）
 */
export function getShutdownManager() {
  return {
    isInShutdown,
    gracefulShutdown,
    onShutdown,
  };
}

// ============================================================================
// Internal
// ============================================================================

/**
 * 按顺序执行所有处理器
 */
async function executeHandlers(): Promise<void> {
  for (const { name, handler } of shutdownHandlers) {
    try {
      logger.debug(`Executing shutdown handler: ${name}`);
      await handler();
      logger.debug(`Shutdown handler completed: ${name}`);
    } catch (error) {
      // 单个处理器失败不应阻止其他处理器执行
      logger.error(`Shutdown handler failed: ${name}`, error as Error);
    }
  }
}

// ============================================================================
// Process Signal Handlers (Optional auto-setup)
// ============================================================================

/**
 * 设置默认的进程信号处理器
 *
 * 自动处理 SIGTERM 和 SIGINT 信号
 *
 * @param options 配置选项
 *
 * @example
 * ```typescript
 * // 在应用启动时调用
 * setupDefaultSignalHandlers();
 * ```
 */
export function setupDefaultSignalHandlers(options?: {
  /** 是否处理 SIGINT (Ctrl+C)，默认 true */
  handleSigint?: boolean;
  /** 是否处理 SIGTERM，默认 true */
  handleSigterm?: boolean;
}): void {
  const { handleSigint = true, handleSigterm = true } = options || {};

  if (handleSigterm) {
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM');
      gracefulShutdown(0);
    });
  }

  if (handleSigint) {
    process.on('SIGINT', () => {
      logger.info('Received SIGINT');
      gracefulShutdown(0);
    });
  }

  logger.debug('Default signal handlers set up');
}
