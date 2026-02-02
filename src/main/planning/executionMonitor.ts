// ============================================================================
// Execution Monitor - 计划执行监控
// ============================================================================
// 监控计划执行进度，检测偏离和异常
// ============================================================================

import { createLogger } from '../services/infra/logger';
import type { TaskPlan, TaskPhase, TaskStep } from './types';

const logger = createLogger('ExecutionMonitor');

/**
 * 偏离类型
 */
export type DeviationType =
  | 'unexpected_file_access'  // 访问了计划外的文件
  | 'unexpected_tool_use'     // 使用了计划外的工具
  | 'step_skip'               // 跳过了步骤
  | 'step_reorder'            // 步骤顺序改变
  | 'timeout_warning'         // 超时警告
  | 'iteration_warning'       // 迭代次数警告
  | 'rollback_detected';      // 检测到回退操作

/**
 * 偏离事件
 */
export interface DeviationEvent {
  type: DeviationType;
  severity: 'info' | 'warning' | 'error';
  message: string;
  timestamp: number;
  context?: Record<string, unknown>;
  suggestion?: string;
}

/**
 * 执行进度
 */
export interface ExecutionProgress {
  currentPhaseId: string | null;
  currentStepId: string | null;
  completedSteps: number;
  totalSteps: number;
  progressPercent: number;
  startTime: number;
  elapsedTime: number;
  estimatedRemaining: number;
  status: 'not_started' | 'in_progress' | 'completed' | 'paused' | 'failed';
}

/**
 * 监控配置
 */
export interface MonitorConfig {
  /** 超时阈值（毫秒）*/
  timeoutThreshold: number;
  /** 最大迭代次数 */
  maxIterations: number;
  /** 偏离容忍度 (0-1) */
  deviationTolerance: number;
  /** 是否自动暂停执行 */
  autoPauseOnDeviation: boolean;
  /** 警告回调 */
  onWarning?: (event: DeviationEvent) => void;
  /** 错误回调 */
  onError?: (event: DeviationEvent) => void;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: MonitorConfig = {
  timeoutThreshold: 5 * 60 * 1000, // 5 分钟
  maxIterations: 50,
  deviationTolerance: 0.3,
  autoPauseOnDeviation: false,
};

/**
 * 执行监控器
 */
export class ExecutionMonitor {
  private config: MonitorConfig;
  private plan: TaskPlan | null = null;
  private deviations: DeviationEvent[] = [];
  private toolCallHistory: Array<{ tool: string; timestamp: number }> = [];
  private fileAccessHistory: Array<{ file: string; operation: 'read' | 'write'; timestamp: number }> = [];
  private iterationCount: number = 0;
  private startTime: number = 0;
  private expectedFiles: Set<string> = new Set();
  private expectedTools: Set<string> = new Set();
  private completedStepIds: Set<string> = new Set();
  private isPaused: boolean = false;

  constructor(config: Partial<MonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 开始监控计划执行
   */
  startMonitoring(plan: TaskPlan): void {
    this.plan = plan;
    this.startTime = Date.now();
    this.deviations = [];
    this.toolCallHistory = [];
    this.fileAccessHistory = [];
    this.iterationCount = 0;
    this.completedStepIds = new Set();
    this.isPaused = false;

    // 分析计划，提取预期的文件和工具
    this.analyzeExpectations(plan);

    logger.info('开始监控计划执行', { planId: plan.id, totalSteps: plan.metadata.totalSteps });
  }

  /**
   * 停止监控
   */
  stopMonitoring(): void {
    logger.info('停止监控', {
      duration: Date.now() - this.startTime,
      deviations: this.deviations.length,
      iterations: this.iterationCount,
    });
  }

  /**
   * 记录工具调用
   */
  recordToolCall(toolName: string, params?: Record<string, unknown>): void {
    this.toolCallHistory.push({ tool: toolName, timestamp: Date.now() });

    // 检查是否是预期外的工具
    if (!this.expectedTools.has(toolName) && this.expectedTools.size > 0) {
      this.addDeviation({
        type: 'unexpected_tool_use',
        severity: 'warning',
        message: `使用了计划外的工具: ${toolName}`,
        timestamp: Date.now(),
        context: { toolName, params },
        suggestion: '检查是否需要更新计划以包含此工具',
      });
    }
  }

  /**
   * 记录文件访问
   */
  recordFileAccess(filePath: string, operation: 'read' | 'write'): void {
    this.fileAccessHistory.push({ file: filePath, operation, timestamp: Date.now() });

    // 检查是否是预期外的文件写入
    if (operation === 'write' && !this.expectedFiles.has(filePath) && this.expectedFiles.size > 0) {
      this.addDeviation({
        type: 'unexpected_file_access',
        severity: 'warning',
        message: `修改了计划外的文件: ${filePath}`,
        timestamp: Date.now(),
        context: { filePath, operation },
        suggestion: '确认这是必要的修改，或更新计划',
      });
    }
  }

  /**
   * 记录迭代
   */
  recordIteration(): void {
    this.iterationCount++;

    // 检查迭代次数
    if (this.iterationCount > this.config.maxIterations * 0.8) {
      this.addDeviation({
        type: 'iteration_warning',
        severity: 'warning',
        message: `迭代次数接近上限: ${this.iterationCount}/${this.config.maxIterations}`,
        timestamp: Date.now(),
        suggestion: '考虑简化任务或分解为更小的步骤',
      });
    }

    // 检查超时
    const elapsed = Date.now() - this.startTime;
    if (elapsed > this.config.timeoutThreshold * 0.8) {
      this.addDeviation({
        type: 'timeout_warning',
        severity: 'warning',
        message: `执行时间接近超时阈值: ${Math.round(elapsed / 1000)}秒`,
        timestamp: Date.now(),
        suggestion: '考虑保存进度并稍后继续',
      });
    }
  }

  /**
   * 记录步骤完成
   */
  recordStepComplete(phaseId: string, stepId: string): void {
    this.completedStepIds.add(stepId);

    // 检查是否跳过了步骤
    if (this.plan) {
      const phase = this.plan.phases.find((p) => p.id === phaseId);
      if (phase) {
        const stepIndex = phase.steps.findIndex((s) => s.id === stepId);
        const previousStep = phase.steps[stepIndex - 1];
        if (previousStep && !this.completedStepIds.has(previousStep.id)) {
          this.addDeviation({
            type: 'step_skip',
            severity: 'info',
            message: `跳过了步骤: ${previousStep.content.slice(0, 50)}...`,
            timestamp: Date.now(),
            context: { skippedStepId: previousStep.id, completedStepId: stepId },
          });
        }
      }
    }
  }

  /**
   * 检测回退操作
   */
  detectRollback(operation: string): void {
    const rollbackIndicators = ['git reset', 'git checkout', 'revert', 'undo', 'restore'];
    const isRollback = rollbackIndicators.some((indicator) =>
      operation.toLowerCase().includes(indicator)
    );

    if (isRollback) {
      this.addDeviation({
        type: 'rollback_detected',
        severity: 'warning',
        message: `检测到回退操作: ${operation}`,
        timestamp: Date.now(),
        suggestion: '确认回退是否是计划的一部分',
      });
    }
  }

  /**
   * 获取当前进度
   */
  getProgress(): ExecutionProgress {
    if (!this.plan) {
      return {
        currentPhaseId: null,
        currentStepId: null,
        completedSteps: 0,
        totalSteps: 0,
        progressPercent: 0,
        startTime: this.startTime,
        elapsedTime: 0,
        estimatedRemaining: 0,
        status: 'not_started',
      };
    }

    const completedSteps = this.completedStepIds.size;
    const totalSteps = this.plan.metadata.totalSteps;
    const progressPercent = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
    const elapsedTime = Date.now() - this.startTime;

    // 估算剩余时间
    const avgTimePerStep = completedSteps > 0 ? elapsedTime / completedSteps : 0;
    const remainingSteps = totalSteps - completedSteps;
    const estimatedRemaining = avgTimePerStep * remainingSteps;

    // 找当前步骤
    let currentPhaseId: string | null = null;
    let currentStepId: string | null = null;
    let status: ExecutionProgress['status'] = 'in_progress';

    for (const phase of this.plan.phases) {
      if (phase.status === 'in_progress') {
        currentPhaseId = phase.id;
        const inProgressStep = phase.steps.find((s) => s.status === 'in_progress');
        if (inProgressStep) {
          currentStepId = inProgressStep.id;
        }
        break;
      }
    }

    if (completedSteps === totalSteps && totalSteps > 0) {
      status = 'completed';
    } else if (this.isPaused) {
      status = 'paused';
    } else if (this.startTime === 0) {
      status = 'not_started';
    }

    return {
      currentPhaseId,
      currentStepId,
      completedSteps,
      totalSteps,
      progressPercent,
      startTime: this.startTime,
      elapsedTime,
      estimatedRemaining,
      status,
    };
  }

  /**
   * 获取所有偏离事件
   */
  getDeviations(): DeviationEvent[] {
    return [...this.deviations];
  }

  /**
   * 获取偏离统计
   */
  getDeviationStats(): {
    total: number;
    byType: Record<DeviationType, number>;
    bySeverity: Record<string, number>;
    deviationRate: number;
  } {
    const byType: Record<DeviationType, number> = {
      unexpected_file_access: 0,
      unexpected_tool_use: 0,
      step_skip: 0,
      step_reorder: 0,
      timeout_warning: 0,
      iteration_warning: 0,
      rollback_detected: 0,
    };

    const bySeverity: Record<string, number> = {
      info: 0,
      warning: 0,
      error: 0,
    };

    for (const deviation of this.deviations) {
      byType[deviation.type]++;
      bySeverity[deviation.severity]++;
    }

    const totalActions = this.toolCallHistory.length + this.fileAccessHistory.length;
    const deviationRate = totalActions > 0 ? this.deviations.length / totalActions : 0;

    return {
      total: this.deviations.length,
      byType,
      bySeverity,
      deviationRate,
    };
  }

  /**
   * 检查是否应该暂停
   */
  shouldPause(): boolean {
    if (!this.config.autoPauseOnDeviation) {
      return false;
    }

    const stats = this.getDeviationStats();
    return stats.deviationRate > this.config.deviationTolerance;
  }

  /**
   * 暂停监控
   */
  pause(): void {
    this.isPaused = true;
    logger.info('监控已暂停');
  }

  /**
   * 恢复监控
   */
  resume(): void {
    this.isPaused = false;
    logger.info('监控已恢复');
  }

  /**
   * 生成执行报告
   */
  generateReport(): string {
    const progress = this.getProgress();
    const stats = this.getDeviationStats();

    const lines: string[] = [];
    lines.push('=== 计划执行报告 ===\n');

    // 进度信息
    lines.push(`## 执行进度`);
    lines.push(`- 状态: ${progress.status}`);
    lines.push(`- 完成: ${progress.completedSteps}/${progress.totalSteps} 步骤 (${progress.progressPercent}%)`);
    lines.push(`- 用时: ${Math.round(progress.elapsedTime / 1000)}秒`);
    lines.push(`- 迭代: ${this.iterationCount}次`);
    lines.push('');

    // 偏离统计
    lines.push(`## 偏离统计`);
    lines.push(`- 总偏离: ${stats.total}`);
    lines.push(`- 偏离率: ${(stats.deviationRate * 100).toFixed(1)}%`);

    if (stats.total > 0) {
      lines.push('\n### 按类型:');
      for (const [type, count] of Object.entries(stats.byType)) {
        if (count > 0) {
          lines.push(`  - ${type}: ${count}`);
        }
      }

      lines.push('\n### 按严重程度:');
      for (const [severity, count] of Object.entries(stats.bySeverity)) {
        if (count > 0) {
          lines.push(`  - ${severity}: ${count}`);
        }
      }
    }

    // 偏离详情
    if (this.deviations.length > 0) {
      lines.push('\n## 偏离详情');
      for (const deviation of this.deviations.slice(-10)) {
        lines.push(`- [${deviation.severity}] ${deviation.message}`);
        if (deviation.suggestion) {
          lines.push(`  建议: ${deviation.suggestion}`);
        }
      }
    }

    return lines.join('\n');
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private addDeviation(event: DeviationEvent): void {
    this.deviations.push(event);

    // 触发回调
    if (event.severity === 'error' && this.config.onError) {
      this.config.onError(event);
    } else if (event.severity === 'warning' && this.config.onWarning) {
      this.config.onWarning(event);
    }

    // 检查是否需要自动暂停
    if (this.shouldPause()) {
      this.pause();
      logger.warn('检测到过多偏离，已自动暂停执行');
    }
  }

  private analyzeExpectations(plan: TaskPlan): void {
    this.expectedFiles.clear();
    this.expectedTools.clear();

    // 分析计划内容，提取预期的文件和工具
    for (const phase of plan.phases) {
      for (const step of phase.steps) {
        // 提取文件路径
        const filePatterns = [
          /`([^`\s]+\.[a-z]+)`/gi,
          /修改\s+(\S+\.[a-z]+)/gi,
          /创建\s+(\S+\.[a-z]+)/gi,
        ];
        for (const pattern of filePatterns) {
          let match;
          while ((match = pattern.exec(step.content)) !== null) {
            this.expectedFiles.add(match[1]);
          }
        }

        // 提取工具名称
        const toolPatterns = [
          /使用\s+`?(\w+)`?\s+工具/gi,
          /调用\s+`?(\w+)`?/gi,
          /运行\s+`?(\w+)`?/gi,
        ];
        for (const pattern of toolPatterns) {
          let match;
          while ((match = pattern.exec(step.content)) !== null) {
            this.expectedTools.add(match[1].toLowerCase());
          }
        }
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Factory Function
// ----------------------------------------------------------------------------

export function createExecutionMonitor(
  config?: Partial<MonitorConfig>
): ExecutionMonitor {
  return new ExecutionMonitor(config);
}
