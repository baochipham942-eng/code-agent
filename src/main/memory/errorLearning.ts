// ============================================================================
// Error Learning - 错误模式聚类与学习
// ============================================================================
// 从错误中学习，识别常见错误模式
// 与 recovery/learningStrategy 配合使用
// ============================================================================

import { createHash } from 'crypto';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ErrorLearning');

/**
 * 错误模式
 */
export interface ErrorPattern {
  id: string;
  signature: string;
  examples: ErrorExample[];
  frequency: number;
  lastOccurred: number;
  category: ErrorCategory;
  commonCauses: string[];
  suggestedFixes: string[];
  successfulResolutions: Resolution[];
}

/**
 * 错误示例
 */
export interface ErrorExample {
  message: string;
  context: Record<string, unknown>;
  timestamp: number;
  toolName?: string;
  resolved: boolean;
  resolution?: string;
}

/**
 * 解决方案记录
 */
export interface Resolution {
  action: string;
  successCount: number;
  failureCount: number;
  lastUsed: number;
}

/**
 * 错误类别
 */
export type ErrorCategory =
  | 'file_operation'
  | 'network'
  | 'permission'
  | 'syntax'
  | 'logic'
  | 'resource'
  | 'configuration'
  | 'dependency'
  | 'unknown';

/**
 * 聚类配置
 */
export interface ClusteringConfig {
  /** 相似度阈值 */
  similarityThreshold: number;
  /** 最小样本数（形成模式所需） */
  minSamples: number;
  /** 最大模式数 */
  maxPatterns: number;
  /** 模式过期时间（天） */
  patternExpireDays: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ClusteringConfig = {
  similarityThreshold: 0.7,
  minSamples: 3,
  maxPatterns: 100,
  patternExpireDays: 30,
};

/**
 * 错误学习服务
 */
export class ErrorLearningService {
  private config: ClusteringConfig;
  private patterns: Map<string, ErrorPattern> = new Map();
  private recentErrors: ErrorExample[] = [];
  private readonly maxRecentErrors = 500;

  constructor(config: Partial<ClusteringConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 记录错误
   */
  recordError(
    message: string,
    context: Record<string, unknown> = {},
    toolName?: string
  ): ErrorPattern | null {
    const example: ErrorExample = {
      message,
      context,
      timestamp: Date.now(),
      toolName,
      resolved: false,
    };

    this.recentErrors.push(example);

    // 限制最近错误数量
    if (this.recentErrors.length > this.maxRecentErrors) {
      this.recentErrors = this.recentErrors.slice(-Math.floor(this.maxRecentErrors / 2));
    }

    // 计算错误签名
    const signature = this.computeSignature(message, toolName);

    // 查找或创建模式
    let pattern = this.patterns.get(signature);
    if (pattern) {
      pattern.examples.push(example);
      pattern.frequency++;
      pattern.lastOccurred = Date.now();

      // 限制示例数量
      if (pattern.examples.length > 10) {
        pattern.examples = pattern.examples.slice(-10);
      }
    } else {
      // 尝试与现有模式匹配
      const similarPattern = this.findSimilarPattern(message);
      if (similarPattern) {
        similarPattern.examples.push(example);
        similarPattern.frequency++;
        similarPattern.lastOccurred = Date.now();
        pattern = similarPattern;
      } else {
        // 创建新模式
        pattern = {
          id: signature,
          signature,
          examples: [example],
          frequency: 1,
          lastOccurred: Date.now(),
          category: this.categorizeError(message),
          commonCauses: [],
          suggestedFixes: [],
          successfulResolutions: [],
        };
        this.patterns.set(signature, pattern);
      }
    }

    // 检查是否达到聚类阈值
    if (pattern.frequency >= this.config.minSamples) {
      this.analyzePattern(pattern);
    }

    // 清理过期模式
    this.cleanupExpiredPatterns();

    return pattern;
  }

  /**
   * 记录解决方案
   */
  recordResolution(
    signature: string,
    action: string,
    success: boolean
  ): void {
    const pattern = this.patterns.get(signature);
    if (!pattern) return;

    // 标记最近的错误示例为已解决
    if (success) {
      const unresolvedExample = pattern.examples
        .slice()
        .reverse()
        .find((e) => !e.resolved);
      if (unresolvedExample) {
        unresolvedExample.resolved = true;
        unresolvedExample.resolution = action;
      }
    }

    // 更新解决方案统计
    let resolution = pattern.successfulResolutions.find((r) => r.action === action);
    if (resolution) {
      if (success) {
        resolution.successCount++;
      } else {
        resolution.failureCount++;
      }
      resolution.lastUsed = Date.now();
    } else {
      resolution = {
        action,
        successCount: success ? 1 : 0,
        failureCount: success ? 0 : 1,
        lastUsed: Date.now(),
      };
      pattern.successfulResolutions.push(resolution);
    }

    // 如果成功，添加到建议修复列表
    if (success && !pattern.suggestedFixes.includes(action)) {
      pattern.suggestedFixes.push(action);
    }
  }

  /**
   * 获取建议的修复方案
   */
  getSuggestedFixes(message: string, toolName?: string): string[] {
    const signature = this.computeSignature(message, toolName);
    let pattern = this.patterns.get(signature);

    if (!pattern) {
      pattern = this.findSimilarPattern(message) || undefined;
    }

    if (!pattern) return [];

    // 按成功率排序解决方案
    const sortedResolutions = [...pattern.successfulResolutions]
      .filter((r) => r.successCount > 0)
      .sort((a, b) => {
        const rateA = a.successCount / (a.successCount + a.failureCount);
        const rateB = b.successCount / (b.successCount + b.failureCount);
        return rateB - rateA;
      });

    return sortedResolutions.map((r) => r.action);
  }

  /**
   * 获取错误模式统计
   */
  getPatternStats(): {
    totalPatterns: number;
    totalErrors: number;
    byCategory: Record<ErrorCategory, number>;
    topPatterns: Array<{
      signature: string;
      frequency: number;
      category: ErrorCategory;
      resolutionRate: number;
    }>;
  } {
    const byCategory: Record<ErrorCategory, number> = {
      file_operation: 0,
      network: 0,
      permission: 0,
      syntax: 0,
      logic: 0,
      resource: 0,
      configuration: 0,
      dependency: 0,
      unknown: 0,
    };

    let totalErrors = 0;

    for (const pattern of this.patterns.values()) {
      byCategory[pattern.category] += pattern.frequency;
      totalErrors += pattern.frequency;
    }

    // 获取 Top 10 模式
    const topPatterns = Array.from(this.patterns.values())
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 10)
      .map((p) => {
        const resolved = p.examples.filter((e) => e.resolved).length;
        return {
          signature: p.signature,
          frequency: p.frequency,
          category: p.category,
          resolutionRate: p.examples.length > 0 ? resolved / p.examples.length : 0,
        };
      });

    return {
      totalPatterns: this.patterns.size,
      totalErrors,
      byCategory,
      topPatterns,
    };
  }

  /**
   * 获取特定工具的错误模式
   */
  getPatternsForTool(toolName: string): ErrorPattern[] {
    return Array.from(this.patterns.values()).filter((p) =>
      p.examples.some((e) => e.toolName === toolName)
    );
  }

  /**
   * 导出学习数据
   */
  exportData(): {
    patterns: ErrorPattern[];
    config: ClusteringConfig;
    exportedAt: number;
  } {
    return {
      patterns: Array.from(this.patterns.values()),
      config: this.config,
      exportedAt: Date.now(),
    };
  }

  /**
   * 导入学习数据
   */
  importData(data: { patterns: ErrorPattern[] }): void {
    for (const pattern of data.patterns) {
      const existing = this.patterns.get(pattern.signature);
      if (existing) {
        // 合并数据
        existing.frequency += pattern.frequency;
        existing.examples.push(...pattern.examples);
        existing.successfulResolutions = this.mergeResolutions(
          existing.successfulResolutions,
          pattern.successfulResolutions
        );
        if (pattern.lastOccurred > existing.lastOccurred) {
          existing.lastOccurred = pattern.lastOccurred;
        }
      } else {
        this.patterns.set(pattern.signature, pattern);
      }
    }

    logger.info(`导入了 ${data.patterns.length} 个错误模式`);
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  /**
   * 计算错误签名
   */
  private computeSignature(message: string, toolName?: string): string {
    // 标准化错误消息
    const normalized = message
      // 替换路径
      .replace(/\/[^\s]+/g, '<path>')
      // 替换行号
      .replace(/:\d+:\d+/g, ':<line>')
      // 替换数字
      .replace(/\b\d+\b/g, '<num>')
      // 转换为小写
      .toLowerCase()
      // 移除多余空白
      .replace(/\s+/g, ' ')
      .trim();

    const input = toolName ? `${toolName}:${normalized}` : normalized;
    return createHash('md5').update(input).digest('hex').slice(0, 12);
  }

  /**
   * 查找相似模式
   */
  private findSimilarPattern(message: string): ErrorPattern | null {
    const normalizedMessage = message.toLowerCase();

    for (const pattern of this.patterns.values()) {
      // 检查示例中是否有相似的错误
      for (const example of pattern.examples) {
        const similarity = this.calculateSimilarity(
          normalizedMessage,
          example.message.toLowerCase()
        );
        if (similarity >= this.config.similarityThreshold) {
          return pattern;
        }
      }
    }

    return null;
  }

  /**
   * 计算字符串相似度（Jaccard 相似度）
   */
  private calculateSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));

    const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);

    return intersection.size / union.size;
  }

  /**
   * 分类错误
   */
  private categorizeError(message: string): ErrorCategory {
    const lowerMessage = message.toLowerCase();

    if (/file|path|directory|enoent|eacces|read|write/.test(lowerMessage)) {
      return 'file_operation';
    }
    if (/network|timeout|connection|fetch|api|http/.test(lowerMessage)) {
      return 'network';
    }
    if (/permission|denied|forbidden|unauthorized/.test(lowerMessage)) {
      return 'permission';
    }
    if (/syntax|parse|unexpected|token/.test(lowerMessage)) {
      return 'syntax';
    }
    if (/undefined|null|type|reference/.test(lowerMessage)) {
      return 'logic';
    }
    if (/memory|resource|limit|quota/.test(lowerMessage)) {
      return 'resource';
    }
    if (/config|env|setting|option/.test(lowerMessage)) {
      return 'configuration';
    }
    if (/module|import|require|dependency|package/.test(lowerMessage)) {
      return 'dependency';
    }

    return 'unknown';
  }

  /**
   * 分析模式，提取常见原因
   */
  private analyzePattern(pattern: ErrorPattern): void {
    const messages = pattern.examples.map((e) => e.message.toLowerCase());

    // 提取常见关键词作为可能原因
    const wordCounts = new Map<string, number>();
    for (const message of messages) {
      const words = message.split(/\s+/);
      for (const word of words) {
        if (word.length > 3) { // 忽略短词
          wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
        }
      }
    }

    // 找出出现频率高的词
    const threshold = Math.ceil(messages.length * 0.7);
    const commonWords = Array.from(wordCounts.entries())
      .filter(([_, count]) => count >= threshold)
      .map(([word]) => word);

    // 根据类别生成常见原因描述
    const causes = this.generateCauses(pattern.category, commonWords);
    pattern.commonCauses = causes;
  }

  /**
   * 根据类别生成常见原因
   */
  private generateCauses(category: ErrorCategory, keywords: string[]): string[] {
    const baseCauses: Record<ErrorCategory, string[]> = {
      file_operation: ['文件路径不存在', '没有文件访问权限', '文件被其他进程占用'],
      network: ['网络连接超时', 'API 服务不可用', 'DNS 解析失败'],
      permission: ['缺少必要权限', 'API 密钥无效', '访问被拒绝'],
      syntax: ['代码语法错误', '格式不正确', '缺少必要字符'],
      logic: ['空值引用', '类型不匹配', '状态不一致'],
      resource: ['内存不足', '资源限制', '配额超出'],
      configuration: ['配置缺失', '配置格式错误', '环境变量未设置'],
      dependency: ['依赖未安装', '版本冲突', '模块未找到'],
      unknown: ['未知错误'],
    };

    return baseCauses[category] || baseCauses.unknown;
  }

  /**
   * 合并解决方案记录
   */
  private mergeResolutions(a: Resolution[], b: Resolution[]): Resolution[] {
    const merged = new Map<string, Resolution>();

    for (const r of [...a, ...b]) {
      const existing = merged.get(r.action);
      if (existing) {
        existing.successCount += r.successCount;
        existing.failureCount += r.failureCount;
        if (r.lastUsed > existing.lastUsed) {
          existing.lastUsed = r.lastUsed;
        }
      } else {
        merged.set(r.action, { ...r });
      }
    }

    return Array.from(merged.values());
  }

  /**
   * 清理过期模式
   */
  private cleanupExpiredPatterns(): void {
    const expireTime = Date.now() - this.config.patternExpireDays * 24 * 60 * 60 * 1000;

    for (const [signature, pattern] of this.patterns.entries()) {
      if (pattern.lastOccurred < expireTime) {
        this.patterns.delete(signature);
      }
    }

    // 限制模式数量
    if (this.patterns.size > this.config.maxPatterns) {
      const sorted = Array.from(this.patterns.entries())
        .sort((a, b) => b[1].frequency - a[1].frequency);

      this.patterns = new Map(sorted.slice(0, this.config.maxPatterns));
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let serviceInstance: ErrorLearningService | null = null;

export function getErrorLearningService(
  config?: Partial<ClusteringConfig>
): ErrorLearningService {
  if (!serviceInstance || config) {
    serviceInstance = new ErrorLearningService(config);
  }
  return serviceInstance;
}

export function createErrorLearningService(
  config?: Partial<ClusteringConfig>
): ErrorLearningService {
  return new ErrorLearningService(config);
}
