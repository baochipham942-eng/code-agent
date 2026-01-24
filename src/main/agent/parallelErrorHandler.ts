// ============================================================================
// Parallel Error Handler - 多 Agent 并行执行错误处理
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('ParallelErrorHandler');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 错误严重程度
 */
export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * 错误类型
 */
export type ParallelErrorType =
  | 'agent_failure'        // Agent 执行失败
  | 'resource_conflict'    // 资源冲突
  | 'timeout'              // 超时
  | 'budget_exceeded'      // 预算超支
  | 'dependency_failed'    // 依赖的 Agent 失败
  | 'tool_error'           // 工具执行错误
  | 'coordination_error'   // 协调错误
  | 'unknown';             // 未知错误

/**
 * Agent 错误信息
 */
export interface AgentError {
  /** Agent ID */
  agentId: string;
  /** Agent 名称 */
  agentName: string;
  /** 错误类型 */
  type: ParallelErrorType;
  /** 错误消息 */
  message: string;
  /** 严重程度 */
  severity: ErrorSeverity;
  /** 发生时间 */
  timestamp: number;
  /** 迭代次数 */
  iteration?: number;
  /** 相关工具 */
  relatedTool?: string;
  /** 原始错误 */
  originalError?: Error;
  /** 是否可恢复 */
  recoverable: boolean;
  /** 建议的恢复策略 */
  recoveryStrategy?: RecoveryStrategy;
}

/**
 * 恢复策略
 */
export type RecoveryStrategy =
  | 'retry'          // 重试
  | 'skip'           // 跳过
  | 'fallback'       // 降级
  | 'abort'          // 中止
  | 'continue'       // 继续（忽略）
  | 'escalate';      // 上报

/**
 * 错误恢复结果
 */
export interface RecoveryResult {
  /** 是否成功恢复 */
  recovered: boolean;
  /** 采用的策略 */
  strategy: RecoveryStrategy;
  /** 恢复消息 */
  message: string;
  /** 是否需要继续执行 */
  shouldContinue: boolean;
  /** 是否需要通知用户 */
  notifyUser: boolean;
}

/**
 * 错误统计
 */
export interface ErrorStats {
  /** 总错误数 */
  totalErrors: number;
  /** 按类型统计 */
  byType: Record<ParallelErrorType, number>;
  /** 按严重程度统计 */
  bySeverity: Record<ErrorSeverity, number>;
  /** 成功恢复数 */
  recoveredCount: number;
  /** 失败的 Agent 数 */
  failedAgents: Set<string>;
}

// ----------------------------------------------------------------------------
// Parallel Error Handler
// ----------------------------------------------------------------------------

/**
 * 并行错误处理器
 *
 * 处理多 Agent 并行执行中的各种错误情况，提供：
 * - 错误分类和分级
 * - 恢复策略推荐
 * - 错误聚合和报告
 * - 跨 Agent 错误传播控制
 */
export class ParallelErrorHandler {
  private errors: AgentError[] = [];
  private stats: ErrorStats = {
    totalErrors: 0,
    byType: {
      agent_failure: 0,
      resource_conflict: 0,
      timeout: 0,
      budget_exceeded: 0,
      dependency_failed: 0,
      tool_error: 0,
      coordination_error: 0,
      unknown: 0,
    },
    bySeverity: {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    },
    recoveredCount: 0,
    failedAgents: new Set(),
  };

  /**
   * 处理错误
   */
  handleError(
    agentId: string,
    agentName: string,
    error: Error | string,
    context?: {
      iteration?: number;
      tool?: string;
      type?: ParallelErrorType;
    }
  ): AgentError {
    const errorMessage = error instanceof Error ? error.message : error;
    const type = context?.type || this.inferErrorType(errorMessage);
    const severity = this.calculateSeverity(type, errorMessage);

    const agentError: AgentError = {
      agentId,
      agentName,
      type,
      message: errorMessage,
      severity,
      timestamp: Date.now(),
      iteration: context?.iteration,
      relatedTool: context?.tool,
      originalError: error instanceof Error ? error : undefined,
      recoverable: this.isRecoverable(type, severity),
      recoveryStrategy: this.suggestRecoveryStrategy(type, severity),
    };

    this.errors.push(agentError);
    this.updateStats(agentError);

    logger.error(`Agent error [${agentId}]:`, {
      type,
      severity,
      message: errorMessage,
      recoverable: agentError.recoverable,
    });

    return agentError;
  }

  /**
   * 尝试恢复错误
   */
  async tryRecover(
    error: AgentError,
    retryFn?: () => Promise<void>
  ): Promise<RecoveryResult> {
    const strategy = error.recoveryStrategy || 'abort';

    switch (strategy) {
      case 'retry':
        if (retryFn) {
          try {
            await retryFn();
            this.stats.recoveredCount++;
            return {
              recovered: true,
              strategy: 'retry',
              message: `Successfully retried after ${error.type}`,
              shouldContinue: true,
              notifyUser: false,
            };
          } catch (retryError) {
            return {
              recovered: false,
              strategy: 'retry',
              message: `Retry failed: ${retryError instanceof Error ? retryError.message : 'Unknown error'}`,
              shouldContinue: false,
              notifyUser: true,
            };
          }
        }
        return {
          recovered: false,
          strategy: 'retry',
          message: 'No retry function provided',
          shouldContinue: false,
          notifyUser: true,
        };

      case 'skip':
        this.stats.recoveredCount++;
        return {
          recovered: true,
          strategy: 'skip',
          message: `Skipped operation due to ${error.type}`,
          shouldContinue: true,
          notifyUser: false,
        };

      case 'continue':
        this.stats.recoveredCount++;
        return {
          recovered: true,
          strategy: 'continue',
          message: `Continuing despite ${error.type}`,
          shouldContinue: true,
          notifyUser: false,
        };

      case 'fallback':
        return {
          recovered: true,
          strategy: 'fallback',
          message: `Falling back due to ${error.type}`,
          shouldContinue: true,
          notifyUser: true,
        };

      case 'escalate':
        return {
          recovered: false,
          strategy: 'escalate',
          message: `Escalating ${error.severity} error: ${error.message}`,
          shouldContinue: false,
          notifyUser: true,
        };

      case 'abort':
      default:
        this.stats.failedAgents.add(error.agentId);
        return {
          recovered: false,
          strategy: 'abort',
          message: `Aborting due to ${error.type}: ${error.message}`,
          shouldContinue: false,
          notifyUser: true,
        };
    }
  }

  /**
   * 检查是否应该继续执行
   */
  shouldContinueExecution(): boolean {
    // 如果有 critical 错误，停止执行
    if (this.stats.bySeverity.critical > 0) {
      return false;
    }

    // 如果超过半数 Agent 失败，停止执行
    if (this.stats.failedAgents.size > 0 && this.errors.length > 0) {
      const uniqueAgents = new Set(this.errors.map((e) => e.agentId));
      if (this.stats.failedAgents.size >= uniqueAgents.size * 0.5) {
        return false;
      }
    }

    return true;
  }

  /**
   * 获取某个 Agent 的所有错误
   */
  getAgentErrors(agentId: string): AgentError[] {
    return this.errors.filter((e) => e.agentId === agentId);
  }

  /**
   * 获取所有错误
   */
  getAllErrors(): AgentError[] {
    return [...this.errors];
  }

  /**
   * 获取错误统计
   */
  getStats(): ErrorStats {
    return { ...this.stats };
  }

  /**
   * 生成错误报告
   */
  generateReport(): string {
    const lines: string[] = [];

    lines.push('=== 并行执行错误报告 ===');
    lines.push('');
    lines.push(`总错误数: ${this.stats.totalErrors}`);
    lines.push(`成功恢复: ${this.stats.recoveredCount}`);
    lines.push(`失败 Agent: ${this.stats.failedAgents.size}`);
    lines.push('');

    lines.push('按严重程度:');
    for (const [severity, count] of Object.entries(this.stats.bySeverity)) {
      if (count > 0) {
        lines.push(`  ${severity}: ${count}`);
      }
    }
    lines.push('');

    lines.push('按类型:');
    for (const [type, count] of Object.entries(this.stats.byType)) {
      if (count > 0) {
        lines.push(`  ${type}: ${count}`);
      }
    }
    lines.push('');

    if (this.errors.length > 0) {
      lines.push('详细错误:');
      for (const error of this.errors) {
        lines.push(`  [${error.severity}] ${error.agentName}: ${error.message}`);
        if (error.relatedTool) {
          lines.push(`    工具: ${error.relatedTool}`);
        }
        if (error.recoveryStrategy) {
          lines.push(`    恢复策略: ${error.recoveryStrategy}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * 重置处理器
   */
  reset(): void {
    this.errors = [];
    this.stats = {
      totalErrors: 0,
      byType: {
        agent_failure: 0,
        resource_conflict: 0,
        timeout: 0,
        budget_exceeded: 0,
        dependency_failed: 0,
        tool_error: 0,
        coordination_error: 0,
        unknown: 0,
      },
      bySeverity: {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0,
      },
      recoveredCount: 0,
      failedAgents: new Set(),
    };
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private inferErrorType(message: string): ParallelErrorType {
    const lowerMessage = message.toLowerCase();

    if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
      return 'timeout';
    }
    if (lowerMessage.includes('budget') || lowerMessage.includes('cost') || lowerMessage.includes('limit exceeded')) {
      return 'budget_exceeded';
    }
    if (lowerMessage.includes('lock') || lowerMessage.includes('conflict') || lowerMessage.includes('resource')) {
      return 'resource_conflict';
    }
    if (lowerMessage.includes('dependency') || lowerMessage.includes('depends on')) {
      return 'dependency_failed';
    }
    if (lowerMessage.includes('tool') || lowerMessage.includes('execute')) {
      return 'tool_error';
    }
    if (lowerMessage.includes('coordinate') || lowerMessage.includes('orchestrat')) {
      return 'coordination_error';
    }
    if (lowerMessage.includes('agent') || lowerMessage.includes('failed')) {
      return 'agent_failure';
    }

    return 'unknown';
  }

  private calculateSeverity(type: ParallelErrorType, message: string): ErrorSeverity {
    // Critical 情况
    if (type === 'budget_exceeded') {
      return 'critical';
    }
    if (message.toLowerCase().includes('critical') || message.toLowerCase().includes('fatal')) {
      return 'critical';
    }

    // High 情况
    if (type === 'agent_failure' || type === 'coordination_error') {
      return 'high';
    }
    if (type === 'dependency_failed') {
      return 'high';
    }

    // Medium 情况
    if (type === 'timeout' || type === 'resource_conflict') {
      return 'medium';
    }
    if (type === 'tool_error') {
      return 'medium';
    }

    // Low 情况
    return 'low';
  }

  private isRecoverable(type: ParallelErrorType, severity: ErrorSeverity): boolean {
    // Critical 错误不可恢复
    if (severity === 'critical') {
      return false;
    }

    // 某些类型可以恢复
    switch (type) {
      case 'timeout':
      case 'resource_conflict':
      case 'tool_error':
        return true;
      case 'budget_exceeded':
      case 'dependency_failed':
        return false;
      default:
        return severity === 'low' || severity === 'medium';
    }
  }

  private suggestRecoveryStrategy(
    type: ParallelErrorType,
    severity: ErrorSeverity
  ): RecoveryStrategy {
    // Critical 直接中止
    if (severity === 'critical') {
      return 'abort';
    }

    // High 上报
    if (severity === 'high') {
      return 'escalate';
    }

    // 根据类型决定
    switch (type) {
      case 'timeout':
        return 'retry';
      case 'resource_conflict':
        return 'retry';
      case 'tool_error':
        return 'skip';
      case 'dependency_failed':
        return 'abort';
      case 'budget_exceeded':
        return 'abort';
      case 'coordination_error':
        return 'fallback';
      default:
        return severity === 'low' ? 'continue' : 'skip';
    }
  }

  private updateStats(error: AgentError): void {
    this.stats.totalErrors++;
    this.stats.byType[error.type]++;
    this.stats.bySeverity[error.severity]++;

    if (!error.recoverable) {
      this.stats.failedAgents.add(error.agentId);
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let handlerInstance: ParallelErrorHandler | null = null;

/**
 * 获取 ParallelErrorHandler 单例
 */
export function getParallelErrorHandler(): ParallelErrorHandler {
  if (!handlerInstance) {
    handlerInstance = new ParallelErrorHandler();
  }
  return handlerInstance;
}

/**
 * 创建新的 ParallelErrorHandler 实例（用于隔离的任务）
 */
export function createParallelErrorHandler(): ParallelErrorHandler {
  return new ParallelErrorHandler();
}
