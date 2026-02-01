// ============================================================================
// Outcome Detector - 成功判定器
// Gen 8: Self-Evolution - 多信号聚合判定执行结果
// ============================================================================

import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import type { ExecutionTrace, ToolCallWithResult } from './traceRecorder';

const logger = createLogger('OutcomeDetector');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type SignalType = 'user_feedback' | 'task_completion' | 'tool_success' | 'follow_up';

export interface OutcomeSignal {
  type: SignalType;
  value: unknown;
  weight: number;
  confidence: number;
  description: string;
}

export interface OutcomeResult {
  outcome: 'success' | 'failure' | 'partial';
  confidence: number;
  reason: string;
  signals: OutcomeSignal[];
}

// 信号权重配置
const SIGNAL_WEIGHTS = {
  user_feedback: 1.0,      // 用户显式反馈权重最高
  task_completion: 0.7,    // 任务完成检测
  tool_success: 0.5,       // 工具执行成功率
  follow_up: 0.3,          // 后续行为分析
};

// ----------------------------------------------------------------------------
// Outcome Detector Service
// ----------------------------------------------------------------------------

export class OutcomeDetector {
  /**
   * 多信号聚合判定
   */
  async detectOutcome(trace: ExecutionTrace): Promise<OutcomeResult> {
    const signals: OutcomeSignal[] = [];

    // 1. 用户显式反馈（权重 1.0）
    if (trace.userFeedback) {
      signals.push(this.getUserFeedbackSignal(trace.userFeedback));
    }

    // 2. 任务完成检测（权重 0.7）
    const completionSignal = await this.checkTaskCompletion(trace);
    if (completionSignal) {
      signals.push(completionSignal);
    }

    // 3. 工具执行成功率（权重 0.5）
    const toolSuccessSignal = this.analyzeToolResults(trace.toolCalls);
    signals.push(toolSuccessSignal);

    // 4. 后续行为分析（权重 0.3）
    const followUpSignal = await this.checkFollowUpBehavior(trace.sessionId);
    if (followUpSignal) {
      signals.push(followUpSignal);
    }

    // 聚合信号
    return this.aggregateSignals(signals);
  }

  /**
   * 快速判定（仅基于工具结果，不查询数据库）
   */
  quickDetect(toolCalls: ToolCallWithResult[]): OutcomeResult {
    const signal = this.analyzeToolResults(toolCalls);
    return this.aggregateSignals([signal]);
  }

  // --------------------------------------------------------------------------
  // Signal Generators
  // --------------------------------------------------------------------------

  /**
   * 用户反馈信号
   */
  private getUserFeedbackSignal(feedback: 'positive' | 'negative'): OutcomeSignal {
    return {
      type: 'user_feedback',
      value: feedback,
      weight: SIGNAL_WEIGHTS.user_feedback,
      confidence: 1.0, // 用户反馈是确定性信号
      description: feedback === 'positive'
        ? '用户给予正向反馈'
        : '用户给予负向反馈',
    };
  }

  /**
   * 任务完成检测信号
   * 检查是否有文件变更、测试通过、构建成功等
   */
  private async checkTaskCompletion(trace: ExecutionTrace): Promise<OutcomeSignal | null> {
    const toolCalls = trace.toolCalls;
    if (toolCalls.length === 0) {
      return null;
    }

    // 检测模式
    const hasFileWrite = toolCalls.some(tc =>
      ['write_file', 'edit_file'].includes(tc.name) && tc.result.success
    );
    const hasBashSuccess = toolCalls.some(tc =>
      tc.name === 'bash' && tc.result.success
    );
    const hasTestRun = toolCalls.some(tc =>
      tc.name === 'bash' &&
      tc.result.success &&
      (tc.args.command as string)?.includes('test')
    );
    const hasBuildSuccess = toolCalls.some(tc =>
      tc.name === 'bash' &&
      tc.result.success &&
      (tc.args.command as string)?.match(/build|compile|npm run|yarn/i)
    );

    // 计算完成度
    let completionScore = 0;
    const indicators: string[] = [];

    if (hasFileWrite) {
      completionScore += 0.3;
      indicators.push('文件已修改');
    }
    if (hasBashSuccess) {
      completionScore += 0.2;
      indicators.push('命令执行成功');
    }
    if (hasTestRun) {
      completionScore += 0.3;
      indicators.push('测试已运行');
    }
    if (hasBuildSuccess) {
      completionScore += 0.2;
      indicators.push('构建成功');
    }

    if (completionScore === 0) {
      return null;
    }

    return {
      type: 'task_completion',
      value: { hasFileWrite, hasBashSuccess, hasTestRun, hasBuildSuccess },
      weight: SIGNAL_WEIGHTS.task_completion,
      confidence: Math.min(completionScore, 1.0),
      description: `任务完成指标: ${indicators.join(', ')}`,
    };
  }

  /**
   * 工具成功率分析信号
   */
  private analyzeToolResults(toolCalls: ToolCallWithResult[]): OutcomeSignal {
    if (toolCalls.length === 0) {
      return {
        type: 'tool_success',
        value: { successRate: 0, total: 0 },
        weight: SIGNAL_WEIGHTS.tool_success,
        confidence: 0.5, // 无工具调用时置信度中等
        description: '无工具调用',
      };
    }

    const successCount = toolCalls.filter(tc => tc.result.success).length;
    const successRate = successCount / toolCalls.length;

    // 分析失败工具
    const failedTools = toolCalls
      .filter(tc => !tc.result.success)
      .map(tc => tc.name);

    // 分析是否有关键工具失败
    const criticalTools = ['write_file', 'edit_file', 'bash'];
    const criticalFailures = failedTools.filter(t => criticalTools.includes(t));

    // 计算置信度
    let confidence = successRate;
    if (criticalFailures.length > 0) {
      confidence *= 0.7; // 关键工具失败降低置信度
    }

    return {
      type: 'tool_success',
      value: {
        successRate,
        total: toolCalls.length,
        successCount,
        failedTools,
        criticalFailures,
      },
      weight: SIGNAL_WEIGHTS.tool_success,
      confidence,
      description: `工具成功率: ${(successRate * 100).toFixed(0)}% (${successCount}/${toolCalls.length})`,
    };
  }

  /**
   * 后续行为检查信号
   * 检查用户是否在同一会话中重新请求相同任务（表示之前失败）
   */
  private async checkFollowUpBehavior(sessionId: string): Promise<OutcomeSignal | null> {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return null;

    try {
      // 获取该会话最近的用户消息
      const recentMessages = dbInstance.prepare(`
        SELECT content FROM messages
        WHERE session_id = ? AND role = 'user'
        ORDER BY timestamp DESC
        LIMIT 5
      `).all(sessionId) as Array<{ content: string }>;

      if (recentMessages.length < 2) {
        return null;
      }

      // 简单检测：是否有重复的请求模式
      const lastMessage = recentMessages[0].content.toLowerCase();
      const previousMessages = recentMessages.slice(1).map(m => m.content.toLowerCase());

      // 检查是否有类似的请求
      const hasSimilarRequest = previousMessages.some(prev => {
        // 简单的相似度检测（可以后续用更复杂的算法）
        const words1 = new Set(lastMessage.split(/\s+/));
        const words2 = new Set(prev.split(/\s+/));
        const intersection = [...words1].filter(w => words2.has(w));
        const similarity = intersection.length / Math.max(words1.size, words2.size);
        return similarity > 0.7;
      });

      if (hasSimilarRequest) {
        return {
          type: 'follow_up',
          value: { hasSimilarRequest: true },
          weight: SIGNAL_WEIGHTS.follow_up,
          confidence: 0.6,
          description: '检测到用户重复类似请求，可能表示之前执行不满意',
        };
      }

      return null;
    } catch (error) {
      logger.error('[OutcomeDetector] Failed to check follow-up behavior:', error);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Signal Aggregation
  // --------------------------------------------------------------------------

  /**
   * 聚合所有信号得出最终判定
   */
  private aggregateSignals(signals: OutcomeSignal[]): OutcomeResult {
    if (signals.length === 0) {
      return {
        outcome: 'partial',
        confidence: 0.5,
        reason: '没有足够的信号来判定结果',
        signals: [],
      };
    }

    // 用户反馈是确定性信号，直接使用
    const userFeedback = signals.find(s => s.type === 'user_feedback');
    if (userFeedback) {
      const isPositive = userFeedback.value === 'positive';
      return {
        outcome: isPositive ? 'success' : 'failure',
        confidence: 1.0,
        reason: isPositive ? '用户确认成功' : '用户反馈失败',
        signals,
      };
    }

    // 加权计算
    let positiveScore = 0;
    let negativeScore = 0;
    let totalWeight = 0;

    for (const signal of signals) {
      const effectiveWeight = signal.weight * signal.confidence;
      totalWeight += signal.weight;

      // 根据信号类型判断正负
      if (signal.type === 'tool_success') {
        const value = signal.value as { successRate: number };
        if (value.successRate >= 0.8) {
          positiveScore += effectiveWeight;
        } else if (value.successRate < 0.5) {
          negativeScore += effectiveWeight;
        } else {
          // 中等成功率贡献部分正分
          positiveScore += effectiveWeight * value.successRate;
          negativeScore += effectiveWeight * (1 - value.successRate);
        }
      } else if (signal.type === 'task_completion') {
        positiveScore += effectiveWeight;
      } else if (signal.type === 'follow_up') {
        const value = signal.value as { hasSimilarRequest?: boolean };
        if (value.hasSimilarRequest) {
          negativeScore += effectiveWeight;
        }
      }
    }

    // 归一化
    const normalizedPositive = totalWeight > 0 ? positiveScore / totalWeight : 0.5;
    const normalizedNegative = totalWeight > 0 ? negativeScore / totalWeight : 0.5;

    // 确定结果
    let outcome: 'success' | 'failure' | 'partial';
    let confidence: number;
    let reason: string;

    if (normalizedPositive > 0.7 && normalizedNegative < 0.3) {
      outcome = 'success';
      confidence = normalizedPositive;
      reason = '多数信号表明任务成功完成';
    } else if (normalizedNegative > 0.6) {
      outcome = 'failure';
      confidence = normalizedNegative;
      reason = '多数信号表明任务执行失败';
    } else {
      outcome = 'partial';
      confidence = Math.max(normalizedPositive, normalizedNegative);
      reason = '任务部分完成或结果不确定';
    }

    // 生成详细原因
    const signalSummary = signals
      .map(s => s.description)
      .join('; ');
    reason = `${reason} (${signalSummary})`;

    return {
      outcome,
      confidence,
      reason,
      signals,
    };
  }

  // --------------------------------------------------------------------------
  // Signal Persistence
  // --------------------------------------------------------------------------

  /**
   * 保存信号到数据库
   */
  async persistSignals(traceId: string, signals: OutcomeSignal[]): Promise<void> {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) {
      logger.error('[OutcomeDetector] Database not initialized');
      return;
    }

    try {
      const stmt = dbInstance.prepare(`
        INSERT INTO outcome_signals (id, trace_id, signal_type, signal_value, weight, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();
      for (const signal of signals) {
        const id = `sig_${now}_${Math.random().toString(36).substr(2, 9)}`;
        stmt.run(
          id,
          traceId,
          signal.type,
          JSON.stringify(signal.value),
          signal.weight,
          now
        );
      }

      logger.debug('[OutcomeDetector] Signals persisted', {
        traceId,
        signalCount: signals.length,
      });
    } catch (error) {
      logger.error('[OutcomeDetector] Failed to persist signals:', error);
    }
  }

  /**
   * 获取轨迹的所有信号
   */
  static getSignalsForTrace(traceId: string): OutcomeSignal[] {
    const db = getDatabase();
    const dbInstance = db.getDb();
    if (!dbInstance) return [];

    try {
      const rows = dbInstance.prepare(`
        SELECT signal_type, signal_value, weight FROM outcome_signals
        WHERE trace_id = ?
        ORDER BY created_at
      `).all(traceId) as Array<{
        signal_type: string;
        signal_value: string;
        weight: number;
      }>;

      return rows.map(row => ({
        type: row.signal_type as SignalType,
        value: JSON.parse(row.signal_value),
        weight: row.weight,
        confidence: 1.0, // 从数据库读取时置信度设为 1
        description: '', // 历史记录不包含描述
      }));
    } catch (error) {
      logger.error('[OutcomeDetector] Failed to get signals:', error);
      return [];
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let outcomeDetectorInstance: OutcomeDetector | null = null;

export function getOutcomeDetector(): OutcomeDetector {
  if (!outcomeDetectorInstance) {
    outcomeDetectorInstance = new OutcomeDetector();
  }
  return outcomeDetectorInstance;
}

// 导出用于测试
export { OutcomeDetector as OutcomeDetectorClass };
