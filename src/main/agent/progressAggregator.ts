// ============================================================================
// Progress Aggregator - 聚合多 Agent 执行进度
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('ProgressAggregator');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * 单个 Agent 的进度
 */
export interface AgentProgress {
  /** Agent ID */
  agentId: string;
  /** Agent 名称 */
  agentName: string;
  /** 当前迭代 */
  currentIteration: number;
  /** 最大迭代 */
  maxIterations: number;
  /** 状态 */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** 开始时间 */
  startedAt?: number;
  /** 完成时间 */
  completedAt?: number;
  /** 当前操作描述 */
  currentOperation?: string;
  /** 已使用工具 */
  toolsUsed: string[];
  /** 错误信息 */
  error?: string;
}

/**
 * 聚合的总体进度
 */
export interface AggregatedProgress {
  /** 总 Agent 数量 */
  totalAgents: number;
  /** 已完成数量 */
  completedAgents: number;
  /** 运行中数量 */
  runningAgents: number;
  /** 失败数量 */
  failedAgents: number;
  /** 等待中数量 */
  pendingAgents: number;
  /** 总体进度百分比 (0-100) */
  overallProgress: number;
  /** 总迭代数 */
  totalIterations: number;
  /** 已完成迭代数 */
  completedIterations: number;
  /** 预计剩余时间（毫秒）*/
  estimatedTimeRemaining: number;
  /** 总耗时（毫秒）*/
  elapsedTime: number;
  /** 各 Agent 进度 */
  agentProgresses: AgentProgress[];
}

/**
 * 进度更新事件
 */
export interface ProgressUpdateEvent {
  type: 'iteration' | 'status_change' | 'tool_use' | 'error' | 'complete';
  agentId: string;
  data: Partial<AgentProgress>;
  timestamp: number;
}

/**
 * 进度监听器
 */
export type ProgressListener = (progress: AggregatedProgress) => void;

// ----------------------------------------------------------------------------
// Progress Aggregator
// ----------------------------------------------------------------------------

/**
 * 进度聚合器
 *
 * 收集并聚合多个 Agent 的执行进度，提供统一的进度视图。
 * 支持：
 * - 实时进度跟踪
 * - 时间估算
 * - 事件通知
 */
export class ProgressAggregator {
  private progresses: Map<string, AgentProgress> = new Map();
  private startTime: number = 0;
  private listeners: Set<ProgressListener> = new Set();
  private iterationHistory: Array<{
    agentId: string;
    timestamp: number;
    iteration: number;
  }> = [];

  /**
   * 初始化 Agent 进度
   */
  initAgent(agentId: string, agentName: string, maxIterations: number): void {
    const progress: AgentProgress = {
      agentId,
      agentName,
      currentIteration: 0,
      maxIterations,
      status: 'pending',
      toolsUsed: [],
    };

    this.progresses.set(agentId, progress);

    if (this.startTime === 0) {
      this.startTime = Date.now();
    }

    logger.debug(`Initialized progress for agent: ${agentId}`);
    this.notifyListeners();
  }

  /**
   * 更新 Agent 状态为运行中
   */
  startAgent(agentId: string): void {
    const progress = this.progresses.get(agentId);
    if (progress) {
      progress.status = 'running';
      progress.startedAt = Date.now();
      logger.debug(`Agent ${agentId} started`);
      this.notifyListeners();
    }
  }

  /**
   * 更新迭代进度
   */
  updateIteration(agentId: string, iteration: number, operation?: string): void {
    const progress = this.progresses.get(agentId);
    if (progress) {
      progress.currentIteration = iteration;
      progress.currentOperation = operation;

      // 记录迭代历史（用于估算时间）
      this.iterationHistory.push({
        agentId,
        timestamp: Date.now(),
        iteration,
      });

      // 只保留最近 100 条记录
      if (this.iterationHistory.length > 100) {
        this.iterationHistory.shift();
      }

      this.notifyListeners();
    }
  }

  /**
   * 记录工具使用
   */
  recordToolUse(agentId: string, toolName: string): void {
    const progress = this.progresses.get(agentId);
    if (progress && !progress.toolsUsed.includes(toolName)) {
      progress.toolsUsed.push(toolName);
    }
  }

  /**
   * 标记 Agent 完成
   */
  completeAgent(agentId: string, success: boolean, error?: string): void {
    const progress = this.progresses.get(agentId);
    if (progress) {
      progress.status = success ? 'completed' : 'failed';
      progress.completedAt = Date.now();
      progress.error = error;

      logger.debug(`Agent ${agentId} ${success ? 'completed' : 'failed'}`);
      this.notifyListeners();
    }
  }

  /**
   * 获取聚合进度
   */
  getProgress(): AggregatedProgress {
    const progresses = Array.from(this.progresses.values());
    const now = Date.now();

    // 统计各状态数量
    let completedAgents = 0;
    let runningAgents = 0;
    let failedAgents = 0;
    let pendingAgents = 0;
    let totalIterations = 0;
    let completedIterations = 0;

    for (const p of progresses) {
      totalIterations += p.maxIterations;
      completedIterations += p.currentIteration;

      switch (p.status) {
        case 'completed':
          completedAgents++;
          completedIterations = Math.max(completedIterations, p.maxIterations);
          break;
        case 'running':
          runningAgents++;
          break;
        case 'failed':
          failedAgents++;
          break;
        case 'pending':
          pendingAgents++;
          break;
      }
    }

    // 计算总体进度
    const totalAgents = progresses.length;
    const overallProgress = totalAgents > 0
      ? Math.round((completedIterations / totalIterations) * 100)
      : 0;

    // 计算耗时
    const elapsedTime = this.startTime > 0 ? now - this.startTime : 0;

    // 估算剩余时间
    const estimatedTimeRemaining = this.estimateRemainingTime(
      completedIterations,
      totalIterations,
      elapsedTime
    );

    return {
      totalAgents,
      completedAgents,
      runningAgents,
      failedAgents,
      pendingAgents,
      overallProgress,
      totalIterations,
      completedIterations,
      estimatedTimeRemaining,
      elapsedTime,
      agentProgresses: progresses,
    };
  }

  /**
   * 获取单个 Agent 的进度
   */
  getAgentProgress(agentId: string): AgentProgress | undefined {
    return this.progresses.get(agentId);
  }

  /**
   * 添加进度监听器
   */
  addListener(listener: ProgressListener): void {
    this.listeners.add(listener);
  }

  /**
   * 移除进度监听器
   */
  removeListener(listener: ProgressListener): void {
    this.listeners.delete(listener);
  }

  /**
   * 重置聚合器
   */
  reset(): void {
    this.progresses.clear();
    this.iterationHistory = [];
    this.startTime = 0;
    logger.debug('Progress aggregator reset');
  }

  /**
   * 格式化进度为可读字符串
   */
  formatProgress(): string {
    const progress = this.getProgress();
    const lines: string[] = [];

    lines.push(`总体进度: ${progress.overallProgress}%`);
    lines.push(`Agent: ${progress.completedAgents}/${progress.totalAgents} 完成`);
    lines.push(`迭代: ${progress.completedIterations}/${progress.totalIterations}`);

    if (progress.estimatedTimeRemaining > 0) {
      const minutes = Math.ceil(progress.estimatedTimeRemaining / 60000);
      lines.push(`预计剩余: ${minutes} 分钟`);
    }

    lines.push('');
    lines.push('详细进度:');

    for (const p of progress.agentProgresses) {
      const statusIcon = this.getStatusIcon(p.status);
      const iterProgress = `${p.currentIteration}/${p.maxIterations}`;
      lines.push(`  ${statusIcon} ${p.agentName}: ${iterProgress}`);

      if (p.currentOperation) {
        lines.push(`     ${p.currentOperation}`);
      }
    }

    return lines.join('\n');
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private notifyListeners(): void {
    const progress = this.getProgress();
    for (const listener of this.listeners) {
      try {
        listener(progress);
      } catch (error) {
        logger.error('Progress listener error:', error);
      }
    }
  }

  private estimateRemainingTime(
    completed: number,
    total: number,
    elapsed: number
  ): number {
    if (completed === 0 || elapsed === 0) {
      return 0;
    }

    const remaining = total - completed;
    const avgTimePerIteration = elapsed / completed;
    return remaining * avgTimePerIteration;
  }

  private getStatusIcon(status: AgentProgress['status']): string {
    switch (status) {
      case 'pending':
        return '○';
      case 'running':
        return '●';
      case 'completed':
        return '✓';
      case 'failed':
        return '✗';
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let aggregatorInstance: ProgressAggregator | null = null;

/**
 * 获取 ProgressAggregator 单例
 */
export function getProgressAggregator(): ProgressAggregator {
  if (!aggregatorInstance) {
    aggregatorInstance = new ProgressAggregator();
  }
  return aggregatorInstance;
}

/**
 * 创建新的 ProgressAggregator 实例（用于隔离的任务）
 */
export function createProgressAggregator(): ProgressAggregator {
  return new ProgressAggregator();
}
