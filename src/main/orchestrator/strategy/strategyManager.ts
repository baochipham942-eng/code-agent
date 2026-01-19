// ============================================================================
// StrategyManager - 策略管理器
// 管理策略的存储、评估和演进
// ============================================================================

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import type {
  Strategy,
  StrategyType,
  StrategyRule,
  StrategyEvaluation,
  RuleCondition,
  RuleAction,
  StrategyConfig,
  StrategyPerformance,
  LearningFeedback,
  LearningResult,
  StrategyUpdate,
} from './types';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('StrategyManager');

// ============================================================================
// 配置
// ============================================================================

const DEFAULT_CONFIG: StrategyConfig = {
  enableLearning: true,
  syncInterval: 300000, // 5 分钟
  maxLocalStrategies: 50,
  autoActivateThreshold: 0.8,
  conflictResolution: 'local',
  shareAnonymously: false,
};

// ============================================================================
// 内置策略
// ============================================================================

const BUILTIN_STRATEGIES: Strategy[] = [
  {
    id: 'routing-default',
    name: '默认路由策略',
    description: '基于任务特征的默认路由策略',
    type: 'routing',
    source: 'default',
    status: 'active',
    version: 1,
    rules: [
      {
        id: 'r1-sensitive-local',
        condition: {
          type: 'keyword',
          operator: 'contains',
          value: ['password', 'secret', 'token', 'key', '密码', '密钥'],
          field: 'prompt',
        },
        action: {
          type: 'route',
          target: 'local',
        },
        priority: 100,
        weight: 1.0,
      },
      {
        id: 'r2-file-local',
        condition: {
          type: 'keyword',
          operator: 'contains',
          value: ['read file', 'write file', '读取文件', '写入文件', 'edit', '编辑'],
          field: 'prompt',
        },
        action: {
          type: 'route',
          target: 'local',
        },
        priority: 80,
        weight: 1.0,
      },
      {
        id: 'r3-search-cloud',
        condition: {
          type: 'keyword',
          operator: 'contains',
          value: ['search', 'research', '搜索', '研究', '查找'],
          field: 'prompt',
        },
        action: {
          type: 'route',
          target: 'cloud',
        },
        priority: 70,
        weight: 1.0,
      },
      {
        id: 'r4-complex-hybrid',
        condition: {
          type: 'composite',
          operator: 'and',
          value: null,
          children: [
            {
              type: 'pattern',
              operator: 'matches',
              value: '.{500,}',
              field: 'prompt',
            },
            {
              type: 'keyword',
              operator: 'contains',
              value: ['implement', 'refactor', '实现', '重构'],
              field: 'prompt',
            },
          ],
        },
        action: {
          type: 'route',
          target: 'hybrid',
        },
        priority: 60,
        weight: 1.0,
      },
    ],
    metadata: {
      tags: ['builtin', 'routing'],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'tool-selection-default',
    name: '默认工具选择策略',
    description: '基于任务类型选择合适的工具',
    type: 'tool_selection',
    source: 'default',
    status: 'active',
    version: 1,
    rules: [
      {
        id: 't1-code-search',
        condition: {
          type: 'keyword',
          operator: 'contains',
          value: ['find', 'search', 'locate', '查找', '搜索', '定位'],
          field: 'prompt',
        },
        action: {
          type: 'select_tool',
          target: 'grep',
          params: { priority: 'high' },
        },
        priority: 80,
        weight: 1.0,
      },
      {
        id: 't2-file-list',
        condition: {
          type: 'keyword',
          operator: 'contains',
          value: ['list', 'directory', '列出', '目录'],
          field: 'prompt',
        },
        action: {
          type: 'select_tool',
          target: 'glob',
        },
        priority: 70,
        weight: 1.0,
      },
    ],
    metadata: {
      tags: ['builtin', 'tool_selection'],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'agent-selection-default',
    name: '默认 Agent 选择策略',
    description: '基于任务类型选择合适的 Agent',
    type: 'agent_selection',
    source: 'default',
    status: 'active',
    version: 1,
    rules: [
      {
        id: 'a1-planning',
        condition: {
          type: 'keyword',
          operator: 'contains',
          value: ['plan', 'design', 'architect', '计划', '设计', '架构'],
          field: 'prompt',
        },
        action: {
          type: 'select_agent',
          target: 'planner',
        },
        priority: 90,
        weight: 1.0,
      },
      {
        id: 'a2-research',
        condition: {
          type: 'keyword',
          operator: 'contains',
          value: ['research', 'investigate', 'analyze', '研究', '调查', '分析'],
          field: 'prompt',
        },
        action: {
          type: 'select_agent',
          target: 'researcher',
        },
        priority: 85,
        weight: 1.0,
      },
      {
        id: 'a3-review',
        condition: {
          type: 'keyword',
          operator: 'contains',
          value: ['review', 'check', 'audit', '审查', '检查', '审计'],
          field: 'prompt',
        },
        action: {
          type: 'select_agent',
          target: 'reviewer',
        },
        priority: 80,
        weight: 1.0,
      },
    ],
    metadata: {
      tags: ['builtin', 'agent_selection'],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

// ============================================================================
// StrategyManager 类
// ============================================================================

export class StrategyManager extends EventEmitter {
  private config: StrategyConfig;
  private strategies: Map<string, Strategy> = new Map();
  private storageDir: string;
  private initialized = false;
  private feedbackBuffer: LearningFeedback[] = [];

  constructor(config: Partial<StrategyConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.storageDir = path.join(app?.getPath('userData') || '.', 'strategies');
  }

  /**
   * 初始化
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      await this.loadStrategies();
      this.initialized = true;
    } catch (error) {
      logger.error('Initialize failed:', error);
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // 策略管理
  // --------------------------------------------------------------------------

  /**
   * 注册策略
   */
  async registerStrategy(strategy: Strategy): Promise<void> {
    await this.ensureInitialized();

    // 检查限制
    if (this.strategies.size >= this.config.maxLocalStrategies) {
      throw new Error('Max local strategies limit reached');
    }

    this.strategies.set(strategy.id, strategy);
    await this.saveStrategy(strategy);
    this.emit('strategy:registered', strategy);
  }

  /**
   * 更新策略
   */
  async updateStrategy(id: string, updates: Partial<Strategy>): Promise<void> {
    await this.ensureInitialized();

    const strategy = this.strategies.get(id);
    if (!strategy) {
      throw new Error(`Strategy ${id} not found`);
    }

    const updated = {
      ...strategy,
      ...updates,
      version: strategy.version + 1,
      updatedAt: new Date().toISOString(),
    };

    this.strategies.set(id, updated);
    await this.saveStrategy(updated);
    this.emit('strategy:updated', updated);
  }

  /**
   * 删除策略
   */
  async removeStrategy(id: string): Promise<void> {
    await this.ensureInitialized();

    const strategy = this.strategies.get(id);
    if (!strategy) return;

    // 不能删除内置策略
    if (strategy.source === 'default') {
      throw new Error('Cannot remove builtin strategy');
    }

    this.strategies.delete(id);
    await this.deleteStrategyFile(id);
    this.emit('strategy:removed', { id });
  }

  /**
   * 获取策略
   */
  getStrategy(id: string): Strategy | undefined {
    return this.strategies.get(id);
  }

  /**
   * 获取类型的策略
   */
  getStrategiesByType(type: StrategyType): Strategy[] {
    return Array.from(this.strategies.values())
      .filter((s) => s.type === type && s.status === 'active')
      .sort((a, b) => b.version - a.version);
  }

  /**
   * 获取所有策略
   */
  getAllStrategies(): Strategy[] {
    return Array.from(this.strategies.values());
  }

  // --------------------------------------------------------------------------
  // 策略评估
  // --------------------------------------------------------------------------

  /**
   * 评估策略
   */
  evaluate(
    type: StrategyType,
    context: { prompt: string; [key: string]: unknown }
  ): StrategyEvaluation | null {
    const strategies = this.getStrategiesByType(type);
    if (strategies.length === 0) return null;

    let bestEvaluation: StrategyEvaluation | null = null;
    let bestScore = 0;

    for (const strategy of strategies) {
      const evaluation = this.evaluateStrategy(strategy, context);
      if (evaluation.matched && evaluation.confidence > bestScore) {
        bestScore = evaluation.confidence;
        bestEvaluation = evaluation;
      }
    }

    return bestEvaluation;
  }

  /**
   * 评估单个策略
   */
  private evaluateStrategy(
    strategy: Strategy,
    context: Record<string, unknown>
  ): StrategyEvaluation {
    const matchedRules: string[] = [];
    let totalWeight = 0;
    let weightedScore = 0;
    let suggestedAction: RuleAction | undefined;
    let highestPriority = 0;

    // 评估每条规则
    for (const rule of strategy.rules) {
      const matched = this.evaluateCondition(rule.condition, context);
      if (matched) {
        matchedRules.push(rule.id);
        weightedScore += rule.weight * rule.priority;
        totalWeight += rule.weight;

        if (rule.priority > highestPriority) {
          highestPriority = rule.priority;
          suggestedAction = rule.action;
        }
      }
    }

    const confidence = totalWeight > 0 ? weightedScore / (totalWeight * 100) : 0;

    return {
      strategyId: strategy.id,
      taskId: (context.taskId as string) || '',
      matched: matchedRules.length > 0,
      matchedRules,
      confidence: Math.min(1, confidence),
      suggestedAction,
      evaluatedAt: new Date().toISOString(),
    };
  }

  /**
   * 评估条件
   */
  private evaluateCondition(condition: RuleCondition, context: Record<string, unknown>): boolean {
    const fieldValue = condition.field ? context[condition.field] : context;
    const value = condition.value;

    switch (condition.type) {
      case 'keyword':
        return this.evaluateKeyword(fieldValue, value as string[], condition.operator);

      case 'pattern':
        return this.evaluatePattern(fieldValue, value as string, condition.operator);

      case 'capability':
        return this.evaluateCapability(fieldValue, value, condition.operator);

      case 'context':
        return this.evaluateContext(fieldValue, value, condition.operator);

      case 'composite':
        return this.evaluateComposite(condition.children || [], context, condition.operator);

      default:
        return false;
    }
  }

  /**
   * 评估关键词条件
   */
  private evaluateKeyword(
    fieldValue: unknown,
    keywords: string[],
    operator: string
  ): boolean {
    if (typeof fieldValue !== 'string') return false;
    const lowerValue = fieldValue.toLowerCase();

    switch (operator) {
      case 'contains':
        return keywords.some((kw) => lowerValue.includes(kw.toLowerCase()));
      case 'equals':
        return keywords.some((kw) => lowerValue === kw.toLowerCase());
      case 'in':
        return keywords.some((kw) => kw.toLowerCase().includes(lowerValue));
      default:
        return false;
    }
  }

  /**
   * 评估模式条件
   */
  private evaluatePattern(
    fieldValue: unknown,
    pattern: string,
    operator: string
  ): boolean {
    if (typeof fieldValue !== 'string') return false;

    try {
      const regex = new RegExp(pattern, 'i');
      return operator === 'matches' ? regex.test(fieldValue) : !regex.test(fieldValue);
    } catch {
      return false;
    }
  }

  /**
   * 评估能力条件
   */
  private evaluateCapability(
    fieldValue: unknown,
    value: unknown,
    operator: string
  ): boolean {
    if (!Array.isArray(fieldValue)) return false;
    const capabilities = value as string[];

    switch (operator) {
      case 'contains':
        return capabilities.some((c) => fieldValue.includes(c));
      case 'equals':
        return JSON.stringify(fieldValue.sort()) === JSON.stringify(capabilities.sort());
      default:
        return false;
    }
  }

  /**
   * 评估上下文条件
   */
  private evaluateContext(
    fieldValue: unknown,
    value: unknown,
    operator: string
  ): boolean {
    switch (operator) {
      case 'gt':
        return typeof fieldValue === 'number' && fieldValue > (value as number);
      case 'lt':
        return typeof fieldValue === 'number' && fieldValue < (value as number);
      case 'equals':
        return fieldValue === value;
      default:
        return false;
    }
  }

  /**
   * 评估复合条件
   */
  private evaluateComposite(
    children: RuleCondition[],
    context: Record<string, unknown>,
    operator: string
  ): boolean {
    if (children.length === 0) return false;

    switch (operator) {
      case 'and':
        return children.every((c) => this.evaluateCondition(c, context));
      case 'or':
        return children.some((c) => this.evaluateCondition(c, context));
      case 'not':
        return !this.evaluateCondition(children[0], context);
      default:
        return false;
    }
  }

  // --------------------------------------------------------------------------
  // 学习与反馈
  // --------------------------------------------------------------------------

  /**
   * 提交反馈
   */
  async submitFeedback(feedback: LearningFeedback): Promise<void> {
    if (!this.config.enableLearning) return;

    this.feedbackBuffer.push(feedback);
    this.emit('feedback:received', feedback);

    // 批量处理反馈
    if (this.feedbackBuffer.length >= 10) {
      await this.processFeedback();
    }
  }

  /**
   * 处理反馈
   */
  async processFeedback(): Promise<LearningResult[]> {
    if (this.feedbackBuffer.length === 0) return [];

    const results: LearningResult[] = [];
    const feedbackToProcess = [...this.feedbackBuffer];
    this.feedbackBuffer = [];

    for (const feedback of feedbackToProcess) {
      const result = await this.learnFromFeedback(feedback);
      if (result) {
        results.push(result);
      }
    }

    return results;
  }

  /**
   * 从反馈学习
   */
  private async learnFromFeedback(feedback: LearningFeedback): Promise<LearningResult | null> {
    const updates: StrategyUpdate[] = [];

    // 获取相关策略
    const strategy = feedback.strategyId ? this.strategies.get(feedback.strategyId) : null;

    if (strategy) {
      // 更新规则权重
      for (const ruleId of feedback.context.appliedRules) {
        const rule = strategy.rules.find((r) => r.id === ruleId);
        if (rule) {
          const oldWeight = rule.weight;
          let newWeight: number;

          if (feedback.feedback.type === 'positive') {
            newWeight = Math.min(2.0, oldWeight * 1.1);
          } else if (feedback.feedback.type === 'negative') {
            newWeight = Math.max(0.1, oldWeight * 0.9);
          } else {
            newWeight = oldWeight;
          }

          if (newWeight !== oldWeight) {
            rule.weight = newWeight;
            updates.push({
              strategyId: strategy.id,
              ruleId: rule.id,
              updateType: 'weight_adjust',
              before: oldWeight,
              after: newWeight,
              reason: `Feedback: ${feedback.feedback.type}`,
            });
          }
        }
      }

      // 更新性能统计
      if (!strategy.metadata.performance) {
        strategy.metadata.performance = {
          usageCount: 0,
          successCount: 0,
          failureCount: 0,
          successRate: 0,
          averageLatency: 0,
        };
      }

      const perf = strategy.metadata.performance;
      perf.usageCount++;
      if (feedback.feedback.type === 'positive') {
        perf.successCount++;
      } else if (feedback.feedback.type === 'negative') {
        perf.failureCount++;
      }
      perf.successRate = perf.successCount / perf.usageCount;
      perf.lastUsedAt = new Date().toISOString();

      // 保存更新
      if (updates.length > 0) {
        strategy.version++;
        strategy.updatedAt = new Date().toISOString();
        await this.saveStrategy(strategy);
      }
    }

    // 如果有纠正，尝试创建新规则
    let newRules: StrategyRule[] | undefined;
    if (feedback.feedback.correction) {
      const newRule = this.createRuleFromCorrection(feedback);
      if (newRule) {
        newRules = [newRule];
      }
    }

    return {
      feedbackId: feedback.id,
      processedAt: new Date().toISOString(),
      strategyUpdates: updates.length > 0 ? updates : undefined,
      newRules,
    };
  }

  /**
   * 从纠正创建新规则
   */
  private createRuleFromCorrection(feedback: LearningFeedback): StrategyRule | null {
    if (!feedback.feedback.correction) return null;

    // 从 prompt 提取关键词
    const words = feedback.context.prompt.toLowerCase().split(/\s+/);
    const keywords = words.filter((w) => w.length > 3).slice(0, 5);

    if (keywords.length === 0) return null;

    return {
      id: `learned_${Date.now()}`,
      condition: {
        type: 'keyword',
        operator: 'contains',
        value: keywords,
        field: 'prompt',
      },
      action: feedback.feedback.correction,
      priority: 50,
      weight: 0.5, // 新规则从低权重开始
    };
  }

  /**
   * 更新性能统计
   */
  updatePerformance(
    strategyId: string,
    result: { success: boolean; latency: number }
  ): void {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) return;

    if (!strategy.metadata.performance) {
      strategy.metadata.performance = {
        usageCount: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        averageLatency: 0,
      };
    }

    const perf = strategy.metadata.performance;
    const totalLatency = perf.averageLatency * perf.usageCount + result.latency;
    perf.usageCount++;
    if (result.success) {
      perf.successCount++;
    } else {
      perf.failureCount++;
    }
    perf.successRate = perf.successCount / perf.usageCount;
    perf.averageLatency = totalLatency / perf.usageCount;
    perf.lastUsedAt = new Date().toISOString();
  }

  // --------------------------------------------------------------------------
  // 存储操作
  // --------------------------------------------------------------------------

  /**
   * 加载策略
   */
  private async loadStrategies(): Promise<void> {
    // 加载内置策略
    for (const strategy of BUILTIN_STRATEGIES) {
      this.strategies.set(strategy.id, strategy);
    }

    // 加载本地策略
    try {
      const files = await fs.readdir(this.storageDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const filePath = path.join(this.storageDir, file);
          const data = await fs.readFile(filePath, 'utf-8');
          const strategy = JSON.parse(data) as Strategy;
          this.strategies.set(strategy.id, strategy);
        } catch {
          // 忽略无法加载的文件
        }
      }
    } catch {
      // 目录不存在
    }
  }

  /**
   * 保存策略
   */
  private async saveStrategy(strategy: Strategy): Promise<void> {
    // 不保存内置策略
    if (strategy.source === 'default') return;

    const filePath = path.join(this.storageDir, `${strategy.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(strategy, null, 2), 'utf-8');
  }

  /**
   * 删除策略文件
   */
  private async deleteStrategyFile(id: string): Promise<void> {
    const filePath = path.join(this.storageDir, `${id}.json`);
    try {
      await fs.unlink(filePath);
    } catch {
      // 文件不存在
    }
  }

  // --------------------------------------------------------------------------
  // 辅助方法
  // --------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalStrategies: number;
    byType: Record<string, number>;
    bySource: Record<string, number>;
    topPerformers: Array<{ id: string; successRate: number }>;
  } {
    const strategies = Array.from(this.strategies.values());
    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};

    for (const s of strategies) {
      byType[s.type] = (byType[s.type] || 0) + 1;
      bySource[s.source] = (bySource[s.source] || 0) + 1;
    }

    const withPerformance = strategies.filter((s) => (s.metadata.performance?.usageCount ?? 0) > 0);
    const topPerformers = withPerformance
      .sort((a, b) => (b.metadata.performance?.successRate || 0) - (a.metadata.performance?.successRate || 0))
      .slice(0, 5)
      .map((s) => ({
        id: s.id,
        successRate: s.metadata.performance?.successRate || 0,
      }));

    return {
      totalStrategies: strategies.length,
      byType,
      bySource,
      topPerformers,
    };
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.strategies.clear();
    this.feedbackBuffer = [];
    this.removeAllListeners();
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let managerInstance: StrategyManager | null = null;

export function getStrategyManager(): StrategyManager {
  if (!managerInstance) {
    managerInstance = new StrategyManager();
  }
  return managerInstance;
}

export function initStrategyManager(config: Partial<StrategyConfig>): StrategyManager {
  managerInstance = new StrategyManager(config);
  return managerInstance;
}
