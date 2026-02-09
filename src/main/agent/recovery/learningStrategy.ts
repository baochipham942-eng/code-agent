// ============================================================================
// Learning Strategy - 错误学习与解决方案缓存
// ============================================================================
// 从成功的错误恢复中学习，缓存解决方案
// ============================================================================

import { createHash } from 'crypto';
import { createLogger } from '../../services/infra/logger';
import { DetailedErrorType, type ErrorClassification } from '../../errors/errorClassifier';

const logger = createLogger('LearningStrategy');

/**
 * 解决方案类型
 */
export type SolutionType =
  | 'param_adjustment'  // 调整参数
  | 'tool_switch'       // 切换工具
  | 'decomposition'     // 分解任务
  | 'retry_with_delay'  // 延迟重试
  | 'context_reduction' // 减少上下文
  | 'manual';           // 需要人工干预

/**
 * 错误解决方案
 */
export interface ErrorSolution {
  /** 错误签名 */
  errorSignature: string;
  /** 解决方案 */
  solution: {
    type: SolutionType;
    action: string;
    params?: Record<string, unknown>;
  };
  /** 置信度 (0-1) */
  confidence: number;
  /** 成功次数 */
  successCount: number;
  /** 失败次数 */
  failureCount: number;
  /** 首次记录时间 */
  firstSeen: number;
  /** 最后更新时间 */
  lastUpdated: number;
  /** 关联的工具 */
  toolName: string;
  /** 错误类型 */
  errorType: DetailedErrorType;
}

/**
 * 学习记录
 */
export interface LearningRecord {
  /** 错误签名 */
  errorSignature: string;
  /** 工具名称 */
  toolName: string;
  /** 错误消息 */
  errorMessage: string;
  /** 尝试的解决方案 */
  attemptedSolution: ErrorSolution['solution'];
  /** 是否成功 */
  success: boolean;
  /** 时间戳 */
  timestamp: number;
  /** 上下文 */
  context?: Record<string, unknown>;
}

/**
 * 计算错误签名
 *
 * 将错误消息标准化，去除变量部分（路径、数字等），
 * 生成稳定的签名用于匹配相似错误
 */
export function computeErrorSignature(
  toolName: string,
  errorMessage: string
): string {
  // 标准化错误消息
  const normalized = errorMessage
    // 替换路径
    .replace(/\/[^\s]+/g, '<path>')
    // 替换行号列号
    .replace(/:\d+:\d+/g, ':<line>')
    // 替换纯数字
    .replace(/\b\d+\b/g, '<num>')
    // 替换 UUID
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<uuid>'
    )
    // 替换哈希值
    .replace(/\b[0-9a-f]{32,}\b/gi, '<hash>')
    // 转换为小写
    .toLowerCase()
    // 移除多余空白
    .replace(/\s+/g, ' ')
    .trim();

  // 生成签名
  const hash = createHash('md5')
    .update(`${toolName}:${normalized}`)
    .digest('hex')
    .slice(0, 12);

  return hash;
}

/**
 * 学习策略管理器
 */
export class LearningStrategy {
  private solutions: Map<string, ErrorSolution> = new Map();
  private learningHistory: LearningRecord[] = [];
  private readonly maxHistorySize = 500;
  private readonly minConfidenceThreshold = 0.3;
  private readonly minSuccessCount = 2;

  constructor() {
    // 初始化预定义的解决方案
    this.initializeDefaultSolutions();
  }

  /**
   * 初始化预定义解决方案
   */
  private initializeDefaultSolutions(): void {
    const defaults: Array<Omit<ErrorSolution, 'errorSignature' | 'firstSeen' | 'lastUpdated'>> = [
      {
        solution: {
          type: 'retry_with_delay',
          action: '等待后重试',
          params: { delay: 1000, maxRetries: 3 },
        },
        confidence: 0.8,
        successCount: 10,
        failureCount: 2,
        toolName: '*',
        errorType: DetailedErrorType.NETWORK_TIMEOUT,
      },
      {
        solution: {
          type: 'retry_with_delay',
          action: '等待 60 秒后重试',
          params: { delay: 60000, maxRetries: 2 },
        },
        confidence: 0.7,
        successCount: 5,
        failureCount: 2,
        toolName: '*',
        errorType: DetailedErrorType.RATE_LIMIT_API,
      },
      {
        solution: {
          type: 'context_reduction',
          action: '减少上下文长度',
          params: { reduceBy: 0.3 },
        },
        confidence: 0.9,
        successCount: 15,
        failureCount: 1,
        toolName: '*',
        errorType: DetailedErrorType.MODEL_CONTEXT_LENGTH,
      },
      {
        solution: {
          type: 'tool_switch',
          action: '切换到 write_file',
        },
        confidence: 0.6,
        successCount: 8,
        failureCount: 4,
        toolName: 'edit_file',
        errorType: DetailedErrorType.LOGIC_STATE,
      },
      {
        solution: {
          type: 'decomposition',
          action: '分解为多个小任务',
        },
        confidence: 0.7,
        successCount: 6,
        failureCount: 2,
        toolName: 'task',
        errorType: DetailedErrorType.NETWORK_TIMEOUT,
      },
    ];

    for (const def of defaults) {
      const signature = `default_${def.toolName}_${def.errorType}`;
      this.solutions.set(signature, {
        ...def,
        errorSignature: signature,
        firstSeen: Date.now(),
        lastUpdated: Date.now(),
      });
    }
  }

  /**
   * 查找匹配的解决方案
   */
  findSolution(
    toolName: string,
    errorMessage: string,
    classification: ErrorClassification
  ): ErrorSolution | null {
    const signature = computeErrorSignature(toolName, errorMessage);

    // 1. 精确匹配
    const exactMatch = this.solutions.get(signature);
    if (exactMatch && this.isValidSolution(exactMatch)) {
      logger.debug(`找到精确匹配的解决方案: ${signature}`);
      return exactMatch;
    }

    // 2. 工具 + 错误类型匹配
    const toolTypeKey = `default_${toolName}_${classification.type}`;
    const toolTypeMatch = this.solutions.get(toolTypeKey);
    if (toolTypeMatch && this.isValidSolution(toolTypeMatch)) {
      logger.debug(`找到工具+类型匹配的解决方案: ${toolTypeKey}`);
      return toolTypeMatch;
    }

    // 3. 通用错误类型匹配
    const genericKey = `default_*_${classification.type}`;
    const genericMatch = this.solutions.get(genericKey);
    if (genericMatch && this.isValidSolution(genericMatch)) {
      logger.debug(`找到通用解决方案: ${genericKey}`);
      return genericMatch;
    }

    return null;
  }

  /**
   * 检查解决方案是否有效
   */
  private isValidSolution(solution: ErrorSolution): boolean {
    return (
      solution.confidence >= this.minConfidenceThreshold &&
      solution.successCount >= this.minSuccessCount
    );
  }

  /**
   * 记录学习结果
   */
  learn(
    toolName: string,
    errorMessage: string,
    solution: ErrorSolution['solution'],
    success: boolean,
    classification: ErrorClassification,
    context?: Record<string, unknown>
  ): void {
    const signature = computeErrorSignature(toolName, errorMessage);

    // 更新或创建解决方案记录
    let existingSolution = this.solutions.get(signature);

    if (existingSolution) {
      if (success) {
        existingSolution.successCount++;
      } else {
        existingSolution.failureCount++;
      }
      // 重新计算置信度
      existingSolution.confidence = this.calculateConfidence(
        existingSolution.successCount,
        existingSolution.failureCount
      );
      existingSolution.lastUpdated = Date.now();
    } else if (success) {
      // 只有成功时才创建新记录
      existingSolution = {
        errorSignature: signature,
        solution,
        confidence: 0.5, // 初始置信度
        successCount: 1,
        failureCount: 0,
        firstSeen: Date.now(),
        lastUpdated: Date.now(),
        toolName,
        errorType: classification.type,
      };
      this.solutions.set(signature, existingSolution);
    }

    // 记录学习历史
    this.learningHistory.push({
      errorSignature: signature,
      toolName,
      errorMessage,
      attemptedSolution: solution,
      success,
      timestamp: Date.now(),
      context,
    });

    // 限制历史大小
    if (this.learningHistory.length > this.maxHistorySize) {
      this.learningHistory = this.learningHistory.slice(-Math.floor(this.maxHistorySize / 2));
    }

    logger.info(`学习记录: ${signature}`, {
      success,
      solutionType: solution.type,
      newConfidence: existingSolution?.confidence,
    });
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(successCount: number, failureCount: number): number {
    const total = successCount + failureCount;
    if (total === 0) return 0;

    // 威尔逊评分区间下界（置信区间 95%）
    const z = 1.96;
    const p = successCount / total;
    const denominator = 1 + (z * z) / total;
    const center = p + (z * z) / (2 * total);
    const deviation = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);

    return (center - deviation) / denominator;
  }

  /**
   * 获取建议的解决方案
   */
  suggestSolution(
    toolName: string,
    errorMessage: string,
    classification: ErrorClassification
  ): {
    solution: ErrorSolution['solution'] | null;
    confidence: number;
    source: 'learned' | 'default' | 'none';
  } {
    const solution = this.findSolution(toolName, errorMessage, classification);

    if (solution) {
      return {
        solution: solution.solution,
        confidence: solution.confidence,
        source: solution.errorSignature.startsWith('default_') ? 'default' : 'learned',
      };
    }

    // 根据错误类型提供默认建议
    return this.getDefaultSuggestion(classification);
  }

  /**
   * 获取默认建议
   */
  private getDefaultSuggestion(classification: ErrorClassification): {
    solution: ErrorSolution['solution'] | null;
    confidence: number;
    source: 'learned' | 'default' | 'none';
  } {
    if (classification.retryable) {
      return {
        solution: {
          type: 'retry_with_delay',
          action: '延迟后重试',
          params: {
            delay: classification.retryDelay || 1000,
            maxRetries: classification.maxRetries || 3,
          },
        },
        confidence: 0.5,
        source: 'default',
      };
    }

    return {
      solution: null,
      confidence: 0,
      source: 'none',
    };
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalSolutions: number;
    totalLearningRecords: number;
    averageConfidence: number;
    byType: Record<string, { count: number; avgConfidence: number }>;
    recentSuccess: number;
    recentFailure: number;
  } {
    const byType: Record<string, { count: number; totalConfidence: number }> = {};

    let totalConfidence = 0;
    for (const solution of this.solutions.values()) {
      totalConfidence += solution.confidence;

      if (!byType[solution.errorType]) {
        byType[solution.errorType] = { count: 0, totalConfidence: 0 };
      }
      byType[solution.errorType].count++;
      byType[solution.errorType].totalConfidence += solution.confidence;
    }

    const byTypeWithAvg: Record<string, { count: number; avgConfidence: number }> = {};
    for (const [type, data] of Object.entries(byType)) {
      byTypeWithAvg[type] = {
        count: data.count,
        avgConfidence: data.count > 0 ? data.totalConfidence / data.count : 0,
      };
    }

    // 最近 24 小时的记录
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentRecords = this.learningHistory.filter((r) => r.timestamp > oneDayAgo);

    return {
      totalSolutions: this.solutions.size,
      totalLearningRecords: this.learningHistory.length,
      averageConfidence: this.solutions.size > 0 ? totalConfidence / this.solutions.size : 0,
      byType: byTypeWithAvg,
      recentSuccess: recentRecords.filter((r) => r.success).length,
      recentFailure: recentRecords.filter((r) => !r.success).length,
    };
  }

  /**
   * 导出解决方案（用于持久化）
   */
  exportSolutions(): ErrorSolution[] {
    return Array.from(this.solutions.values());
  }

  /**
   * 导入解决方案
   */
  importSolutions(solutions: ErrorSolution[]): void {
    for (const solution of solutions) {
      const existing = this.solutions.get(solution.errorSignature);
      if (!existing || solution.lastUpdated > existing.lastUpdated) {
        this.solutions.set(solution.errorSignature, solution);
      }
    }
  }

  /**
   * 清除低置信度的解决方案
   */
  pruneWeakSolutions(minConfidence: number = 0.2): number {
    let pruned = 0;
    for (const [signature, solution] of this.solutions.entries()) {
      if (
        solution.confidence < minConfidence &&
        !signature.startsWith('default_')
      ) {
        this.solutions.delete(signature);
        pruned++;
      }
    }
    return pruned;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let strategyInstance: LearningStrategy | null = null;

export function getLearningStrategy(): LearningStrategy {
  if (!strategyInstance) {
    strategyInstance = new LearningStrategy();
  }
  return strategyInstance;
}

export function createLearningStrategy(): LearningStrategy {
  return new LearningStrategy();
}

// ----------------------------------------------------------------------------
// Persistence (saveToDisk / loadFromDisk)
// ----------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';

const PERSISTENCE_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  '.code-agent',
  'learning'
);

const SOLUTIONS_FILE = path.join(PERSISTENCE_DIR, 'solutions.json');

/**
 * 将学习策略持久化到磁盘
 */
export async function saveToDisk(strategy?: LearningStrategy): Promise<void> {
  const s = strategy || getLearningStrategy();
  const solutions = s.exportSolutions();

  try {
    await fs.promises.mkdir(PERSISTENCE_DIR, { recursive: true });
    await fs.promises.writeFile(
      SOLUTIONS_FILE,
      JSON.stringify(solutions, null, 2),
      'utf-8'
    );
    logger.info(`[LearningStrategy] Saved ${solutions.length} solutions to disk`);
  } catch (err) {
    logger.warn('[LearningStrategy] Failed to save to disk:', err);
  }
}

/**
 * 从磁盘加载学习策略
 */
export async function loadFromDisk(strategy?: LearningStrategy): Promise<void> {
  const s = strategy || getLearningStrategy();

  try {
    const data = await fs.promises.readFile(SOLUTIONS_FILE, 'utf-8');
    const solutions = JSON.parse(data) as ErrorSolution[];
    s.importSolutions(solutions);
    logger.info(`[LearningStrategy] Loaded ${solutions.length} solutions from disk`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('[LearningStrategy] Failed to load from disk:', err);
    }
  }
}
