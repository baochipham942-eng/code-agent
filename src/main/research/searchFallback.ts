// ============================================================================
// Search Fallback Handler - 搜索回退处理器
// 实现搜索失败时的自动回退机制
// ============================================================================

import type { DataSourceType, SourceResult } from './types';
import { DataSourceRouter } from './dataSourceRouter';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SearchFallback');

// ----------------------------------------------------------------------------
// 类型定义
// ----------------------------------------------------------------------------

/**
 * 搜索执行函数类型
 */
export type SearchExecutor = (
  source: DataSourceType,
  query: string,
  options?: Record<string, unknown>
) => Promise<SearchExecutionResult>;

/**
 * 搜索执行结果
 */
export interface SearchExecutionResult {
  success: boolean;
  results: SourceResult[];
  error?: string;
  retryable?: boolean;
}

/**
 * 回退处理器配置
 */
export interface SearchFallbackConfig {
  /** 最大回退次数 */
  maxFallbacks?: number;
  /** 重试次数（每个数据源） */
  retryCount?: number;
  /** 重试延迟（毫秒） */
  retryDelayMs?: number;
  /** 是否启用优雅降级 */
  enableGracefulDegradation?: boolean;
  /** 部分成功时的最小结果数 */
  minResultsForPartialSuccess?: number;
}

/**
 * 搜索尝试结果
 */
export interface SearchAttemptResult {
  source: DataSourceType;
  success: boolean;
  results: SourceResult[];
  error?: string;
  attemptNumber: number;
  durationMs: number;
}

/**
 * 回退执行结果
 */
export interface FallbackExecutionResult {
  /** 是否成功（至少有一个数据源成功） */
  success: boolean;
  /** 合并的结果 */
  results: SourceResult[];
  /** 所有尝试的详情 */
  attempts: SearchAttemptResult[];
  /** 使用的数据源 */
  usedSources: DataSourceType[];
  /** 失败的数据源 */
  failedSources: DataSourceType[];
  /** 总耗时（毫秒） */
  totalDurationMs: number;
  /** 用户友好的状态消息 */
  statusMessage: string;
  /** 是否为部分成功（有失败但也有成功） */
  isPartialSuccess: boolean;
}

// ----------------------------------------------------------------------------
// 错误分类
// ----------------------------------------------------------------------------

/**
 * 错误类型
 */
export enum SearchErrorType {
  /** 网络错误（可重试） */
  NETWORK = 'network',
  /** 认证错误（不可重试） */
  AUTH = 'auth',
  /** 限流错误（可延迟重试） */
  RATE_LIMIT = 'rate_limit',
  /** 数据源不可用（应回退） */
  SOURCE_UNAVAILABLE = 'source_unavailable',
  /** 无结果（非错误，应回退） */
  NO_RESULTS = 'no_results',
  /** 超时（可重试） */
  TIMEOUT = 'timeout',
  /** 未知错误（应回退） */
  UNKNOWN = 'unknown',
}

/**
 * 分类错误类型
 */
export function classifyError(error: string | Error): {
  type: SearchErrorType;
  retryable: boolean;
  shouldFallback: boolean;
} {
  const message = typeof error === 'string' ? error : error.message;
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('network') || lowerMessage.includes('fetch') || lowerMessage.includes('econnrefused')) {
    return { type: SearchErrorType.NETWORK, retryable: true, shouldFallback: true };
  }

  if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
    return { type: SearchErrorType.TIMEOUT, retryable: true, shouldFallback: true };
  }

  if (lowerMessage.includes('401') || lowerMessage.includes('403') || lowerMessage.includes('unauthorized') || lowerMessage.includes('forbidden')) {
    return { type: SearchErrorType.AUTH, retryable: false, shouldFallback: true };
  }

  if (lowerMessage.includes('429') || lowerMessage.includes('rate limit') || lowerMessage.includes('too many requests')) {
    return { type: SearchErrorType.RATE_LIMIT, retryable: true, shouldFallback: true };
  }

  if (lowerMessage.includes('not found') || lowerMessage.includes('unavailable') || lowerMessage.includes('503') || lowerMessage.includes('502')) {
    return { type: SearchErrorType.SOURCE_UNAVAILABLE, retryable: false, shouldFallback: true };
  }

  if (lowerMessage.includes('no results') || lowerMessage.includes('empty')) {
    return { type: SearchErrorType.NO_RESULTS, retryable: false, shouldFallback: true };
  }

  return { type: SearchErrorType.UNKNOWN, retryable: false, shouldFallback: true };
}

// ----------------------------------------------------------------------------
// Search Fallback Handler
// ----------------------------------------------------------------------------

/**
 * 搜索回退处理器
 *
 * 功能：
 * 1. 数据源失败时自动切换到备用源
 * 2. 网络错误自动重试
 * 3. 部分成功时的优雅降级
 * 4. 用户友好的错误提示
 */
export class SearchFallbackHandler {
  private dataSourceRouter: DataSourceRouter;
  private config: Required<SearchFallbackConfig>;

  constructor(
    dataSourceRouter: DataSourceRouter,
    config: SearchFallbackConfig = {}
  ) {
    this.dataSourceRouter = dataSourceRouter;
    this.config = {
      maxFallbacks: config.maxFallbacks ?? 3,
      retryCount: config.retryCount ?? 2,
      retryDelayMs: config.retryDelayMs ?? 1000,
      enableGracefulDegradation: config.enableGracefulDegradation ?? true,
      minResultsForPartialSuccess: config.minResultsForPartialSuccess ?? 1,
    };
  }

  /**
   * 执行带回退的搜索
   *
   * @param primarySource - 主数据源
   * @param query - 搜索查询
   * @param executor - 搜索执行函数
   * @param options - 搜索选项
   * @returns 回退执行结果
   */
  async executeWithFallback(
    primarySource: DataSourceType,
    query: string,
    executor: SearchExecutor,
    options?: Record<string, unknown>
  ): Promise<FallbackExecutionResult> {
    const startTime = Date.now();
    const attempts: SearchAttemptResult[] = [];
    const usedSources: DataSourceType[] = [];
    const failedSources: DataSourceType[] = [];
    let allResults: SourceResult[] = [];

    // 获取回退源列表
    const fallbackSources = this.dataSourceRouter.getFallbackSources(primarySource);
    const sourcesToTry = [primarySource, ...fallbackSources].slice(0, this.config.maxFallbacks + 1);

    logger.info('Starting search with fallback', {
      primarySource,
      query: query.slice(0, 50),
      fallbackSources,
    });

    for (const source of sourcesToTry) {
      const strategy = this.dataSourceRouter.getExecutionStrategy(source);
      const maxRetries = Math.min(strategy.retryCount, this.config.retryCount);

      for (let attemptNum = 0; attemptNum <= maxRetries; attemptNum++) {
        const attemptStart = Date.now();

        try {
          logger.debug(`Attempting search`, { source, attempt: attemptNum + 1 });

          const result = await this.executeWithTimeout(
            executor(source, query, options),
            strategy.timeout
          );

          const attempt: SearchAttemptResult = {
            source,
            success: result.success,
            results: result.results,
            error: result.error,
            attemptNumber: attemptNum + 1,
            durationMs: Date.now() - attemptStart,
          };
          attempts.push(attempt);

          if (result.success && result.results.length > 0) {
            usedSources.push(source);
            allResults = [...allResults, ...result.results];

            logger.info(`Search succeeded`, {
              source,
              resultsCount: result.results.length,
              attempt: attemptNum + 1,
            });

            // 主源成功，可以直接返回
            if (source === primarySource) {
              return this.buildResult(
                true,
                allResults,
                attempts,
                usedSources,
                failedSources,
                startTime,
                false
              );
            }

            // 回退源成功，继续（用于收集更多结果）
            break;
          }

          // 没有结果，检查是否应该重试
          if (result.error) {
            const errorClass = classifyError(result.error);

            if (!errorClass.retryable || attemptNum >= maxRetries) {
              // 不可重试或已达到重试上限
              failedSources.push(source);
              logger.warn(`Search failed, moving to fallback`, {
                source,
                error: result.error,
                errorType: errorClass.type,
              });
              break;
            }

            // 可重试，等待后重试
            logger.debug(`Retrying search`, {
              source,
              attempt: attemptNum + 1,
              delay: this.config.retryDelayMs,
            });
            await this.delay(this.config.retryDelayMs * (attemptNum + 1));
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorClass = classifyError(errorMessage);

          attempts.push({
            source,
            success: false,
            results: [],
            error: errorMessage,
            attemptNumber: attemptNum + 1,
            durationMs: Date.now() - attemptStart,
          });

          if (!errorClass.retryable || attemptNum >= maxRetries) {
            failedSources.push(source);
            logger.error(`Search exception`, { source, error: errorMessage });
            break;
          }

          await this.delay(this.config.retryDelayMs * (attemptNum + 1));
        }
      }
    }

    // 所有源都尝试完毕
    const isPartialSuccess = allResults.length >= this.config.minResultsForPartialSuccess && failedSources.length > 0;
    const success = allResults.length > 0;

    return this.buildResult(
      success,
      allResults,
      attempts,
      usedSources,
      failedSources,
      startTime,
      isPartialSuccess
    );
  }

  /**
   * 并行执行多个数据源的搜索（带回退）
   */
  async executeParallelWithFallback(
    sources: DataSourceType[],
    query: string,
    executor: SearchExecutor,
    options?: Record<string, unknown>
  ): Promise<FallbackExecutionResult> {
    const startTime = Date.now();
    const attempts: SearchAttemptResult[] = [];
    const usedSources: DataSourceType[] = [];
    const failedSources: DataSourceType[] = [];
    let allResults: SourceResult[] = [];

    logger.info('Starting parallel search with fallback', {
      sources,
      query: query.slice(0, 50),
    });

    // 并行执行所有主数据源
    const promises = sources.map(source =>
      this.executeWithFallback(source, query, executor, options)
    );

    const results = await Promise.allSettled(promises);

    // 合并结果
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        const fallbackResult = result.value;
        attempts.push(...fallbackResult.attempts);
        usedSources.push(...fallbackResult.usedSources);
        failedSources.push(...fallbackResult.failedSources);
        allResults.push(...fallbackResult.results);
      } else {
        failedSources.push(sources[i]);
        attempts.push({
          source: sources[i],
          success: false,
          results: [],
          error: result.reason?.message || 'Unknown error',
          attemptNumber: 1,
          durationMs: 0,
        });
      }
    }

    // 去重
    usedSources.length = 0;
    usedSources.push(...[...new Set(usedSources)]);
    failedSources.length = 0;
    failedSources.push(...[...new Set(failedSources)].filter(s => !usedSources.includes(s)));

    const isPartialSuccess = allResults.length > 0 && failedSources.length > 0;
    const success = allResults.length > 0;

    return this.buildResult(
      success,
      allResults,
      attempts,
      usedSources,
      failedSources,
      startTime,
      isPartialSuccess
    );
  }

  /**
   * 构建执行结果
   */
  private buildResult(
    success: boolean,
    results: SourceResult[],
    attempts: SearchAttemptResult[],
    usedSources: DataSourceType[],
    failedSources: DataSourceType[],
    startTime: number,
    isPartialSuccess: boolean
  ): FallbackExecutionResult {
    const totalDurationMs = Date.now() - startTime;

    // 生成状态消息
    let statusMessage: string;
    if (success && failedSources.length === 0) {
      statusMessage = `搜索成功，使用数据源：${usedSources.join(', ')}`;
    } else if (isPartialSuccess) {
      statusMessage = `部分搜索成功。成功：${usedSources.join(', ')}；失败：${failedSources.join(', ')}`;
    } else if (success) {
      statusMessage = `搜索完成（使用回退数据源）：${usedSources.join(', ')}`;
    } else {
      statusMessage = `所有数据源搜索失败：${failedSources.join(', ')}`;
    }

    return {
      success,
      results,
      attempts,
      usedSources,
      failedSources,
      totalDurationMs,
      statusMessage,
      isPartialSuccess,
    };
  }

  /**
   * 带超时的执行
   */
  private async executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('Search timeout')), timeoutMs)
      ),
    ]);
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<SearchFallbackConfig>): void {
    Object.assign(this.config, config);
  }

  /**
   * 生成用户友好的错误消息
   */
  static generateUserFriendlyMessage(result: FallbackExecutionResult): string {
    if (result.success && !result.isPartialSuccess) {
      return `✅ 搜索成功，找到 ${result.results.length} 条结果`;
    }

    if (result.isPartialSuccess) {
      return `⚠️ 部分搜索成功，找到 ${result.results.length} 条结果。` +
        `\n部分数据源暂时不可用：${result.failedSources.join(', ')}`;
    }

    // 完全失败
    const failedAttempts = result.attempts.filter(a => !a.success);
    const errors = [...new Set(failedAttempts.map(a => a.error).filter(Boolean))];

    let message = `❌ 搜索失败`;
    if (errors.length > 0) {
      message += `\n原因：${errors.slice(0, 3).join('; ')}`;
    }
    message += `\n建议：请检查网络连接或稍后重试`;

    return message;
  }
}

// 导出默认实例工厂
export function createSearchFallbackHandler(
  dataSourceRouter: DataSourceRouter,
  config?: SearchFallbackConfig
): SearchFallbackHandler {
  return new SearchFallbackHandler(dataSourceRouter, config);
}
