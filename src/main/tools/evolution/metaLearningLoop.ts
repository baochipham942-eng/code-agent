// ============================================================================
// Meta Learning Loop - Automatic pattern extraction and strategy optimization
// Gen 8: Self-Evolution capability
// Enhanced with trace-based learning
// ============================================================================

import { getEvolutionPersistence, type LearnedPattern, type Strategy } from '../../services';
import { createLogger } from '../../services/infra/logger';
import type { Message } from '../../../shared/types';
import type { ExecutionTrace } from '../../evolution/traceRecorder';
import type { OutcomeResult } from '../../evolution/outcomeDetector';

const logger = createLogger('MetaLearningLoop');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface ToolExecution {
  name: string;
  input: unknown;
  output?: unknown;
  success: boolean;
  duration: number;
  timestamp: number;
  errorMessage?: string;
}

export interface SessionAnalysis {
  sessionId: string;
  startTime: number;
  endTime: number;
  toolExecutions: ToolExecution[];
  messages: Message[];
  success: boolean;
  taskType?: string;
}

export interface ExtractedPattern {
  type: LearnedPattern['type'];
  name: string;
  context: string;
  pattern: string;
  solution?: string;
  confidence: number;
  tags: string[];
}

export interface LearningResult {
  patternsLearned: number;
  strategiesUpdated: number;
  insights: string[];
  recommendations: string[];
}

// ----------------------------------------------------------------------------
// Analysis Thresholds
// ----------------------------------------------------------------------------

const THRESHOLDS = {
  /** Minimum tool sequence length to consider a pattern */
  MIN_SEQUENCE_LENGTH: 2,
  /** Minimum occurrences to consider a pattern significant */
  MIN_OCCURRENCES: 2,
  /** Minimum success rate to recommend a strategy */
  MIN_SUCCESS_RATE: 0.6,
  /** Minimum confidence for pattern extraction */
  MIN_CONFIDENCE: 0.5,
  /** Maximum patterns to extract per session */
  MAX_PATTERNS_PER_SESSION: 5,
  /** Time window for pattern aggregation (24 hours) */
  AGGREGATION_WINDOW_MS: 24 * 60 * 60 * 1000,
};

// ----------------------------------------------------------------------------
// Meta Learning Loop Service
// ----------------------------------------------------------------------------

class MetaLearningLoopService {
  private sessionHistory: SessionAnalysis[] = [];
  private isRunning = false;
  private lastRunTime = 0;

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Trigger learning after a session ends
   */
  async onSessionEnd(analysis: SessionAnalysis): Promise<LearningResult> {
    logger.info('Session ended, triggering meta learning', {
      sessionId: analysis.sessionId,
      toolCount: analysis.toolExecutions.length,
      success: analysis.success,
    });

    // Store in history
    this.sessionHistory.push(analysis);

    // Trim old sessions
    this.trimSessionHistory();

    // Run learning loop
    return this.runLearningLoop(analysis);
  }

  /**
   * Trigger learning after a tool failure
   */
  async onToolFailure(execution: ToolExecution, context: string): Promise<ExtractedPattern | null> {
    logger.info('Tool failure detected, analyzing for anti-pattern', {
      tool: execution.name,
      error: execution.errorMessage,
    });

    // Check if this is a recurring failure
    const recentFailures = this.getRecentFailures(execution.name);

    if (recentFailures.length >= THRESHOLDS.MIN_OCCURRENCES) {
      // This is a recurring failure - extract anti-pattern
      const pattern = await this.extractFailurePattern(execution, recentFailures, context);
      if (pattern) {
        await this.persistPattern(pattern);
        return pattern;
      }
    }

    return null;
  }

  /**
   * Force a learning cycle (for manual triggers or scheduled runs)
   */
  async runManualLearning(): Promise<LearningResult> {
    if (this.sessionHistory.length === 0) {
      return {
        patternsLearned: 0,
        strategiesUpdated: 0,
        insights: ['No session history available for learning'],
        recommendations: [],
      };
    }

    // Analyze all recent sessions
    return this.runAggregatedLearning();
  }

  /**
   * Get learning statistics
   */
  getStats(): {
    sessionsAnalyzed: number;
    lastRunTime: number;
    isRunning: boolean;
  } {
    return {
      sessionsAnalyzed: this.sessionHistory.length,
      lastRunTime: this.lastRunTime,
      isRunning: this.isRunning,
    };
  }

  // --------------------------------------------------------------------------
  // Gen8 Trace-Based Learning
  // --------------------------------------------------------------------------

  /**
   * 从执行轨迹学习（Gen8 增强版）
   * 使用 LLM 进行更智能的洞察提取
   */
  async learnFromTrace(
    trace: ExecutionTrace,
    outcomeResult: OutcomeResult
  ): Promise<LearningResult> {
    logger.info('Learning from trace', {
      traceId: trace.id,
      outcome: outcomeResult.outcome,
      confidence: outcomeResult.confidence,
    });

    const result: LearningResult = {
      patternsLearned: 0,
      strategiesUpdated: 0,
      insights: [],
      recommendations: [],
    };

    // 只从成功案例学习
    if (outcomeResult.outcome !== 'success' || outcomeResult.confidence < 0.7) {
      result.insights.push('Not a confident success, skipping learning');
      return result;
    }

    try {
      // 动态导入避免循环依赖
      const { getLLMInsightExtractor } = await import('../../evolution/llmInsightExtractor');
      const { getSafeInjector } = await import('../../evolution/safeInjector');

      const extractor = getLLMInsightExtractor();
      const injector = getSafeInjector();

      // 使用 LLM 提取洞察
      const insights = await extractor.extractFromSuccessfulTraces([trace]);

      for (const insight of insights) {
        // 验证安全性
        const savedInsight = await extractor.saveInsight(insight, trace.projectPath);
        const safety = injector.validateSafety(savedInsight);

        if (safety.safe) {
          result.patternsLearned++;
          result.insights.push(`Learned: ${insight.name} (confidence: ${insight.confidence.toFixed(2)})`);
        } else {
          result.insights.push(`Skipped unsafe insight: ${insight.name} - ${safety.reasons.join(', ')}`);
        }
      }

      // 推断用户偏好
      const preferences = await extractor.inferPreferences([trace]);
      for (const pref of preferences) {
        result.insights.push(`Inferred preference: ${pref.key} = ${pref.value}`);
      }

      logger.info('Trace learning completed', {
        traceId: trace.id,
        patternsLearned: result.patternsLearned,
        insightsCount: result.insights.length,
      });
    } catch (error) {
      logger.error('Trace learning failed:', error);
      result.insights.push(`Learning error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }

    return result;
  }

  /**
   * 批量从历史轨迹学习
   */
  async learnFromHistoricalTraces(limit: number = 50): Promise<LearningResult> {
    const result: LearningResult = {
      patternsLearned: 0,
      strategiesUpdated: 0,
      insights: [],
      recommendations: [],
    };

    try {
      const { TraceRecorder } = await import('../../evolution/traceRecorder');
      const { getLLMInsightExtractor } = await import('../../evolution/llmInsightExtractor');

      // 获取成功的历史轨迹
      const traces = TraceRecorder.getSuccessfulTraces({
        minConfidence: 0.7,
        limit,
        since: Date.now() - 7 * 24 * 60 * 60 * 1000, // 最近 7 天
      });

      if (traces.length === 0) {
        result.insights.push('No successful traces found for learning');
        return result;
      }

      const extractor = getLLMInsightExtractor();
      const insights = await extractor.extractFromSuccessfulTraces(traces);

      for (const insight of insights) {
        await extractor.saveInsight(insight);
        result.patternsLearned++;
        result.insights.push(`Learned from ${traces.length} traces: ${insight.name}`);
      }

      logger.info('Historical trace learning completed', {
        tracesAnalyzed: traces.length,
        patternsLearned: result.patternsLearned,
      });
    } catch (error) {
      logger.error('Historical trace learning failed:', error);
      result.insights.push(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // Learning Loop Implementation
  // --------------------------------------------------------------------------

  private async runLearningLoop(currentSession: SessionAnalysis): Promise<LearningResult> {
    if (this.isRunning) {
      logger.debug('Learning loop already running, skipping');
      return {
        patternsLearned: 0,
        strategiesUpdated: 0,
        insights: ['Learning loop already in progress'],
        recommendations: [],
      };
    }

    this.isRunning = true;
    this.lastRunTime = Date.now();

    try {
      const result: LearningResult = {
        patternsLearned: 0,
        strategiesUpdated: 0,
        insights: [],
        recommendations: [],
      };

      // 1. Extract tool usage patterns
      const toolPatterns = this.analyzeToolUsagePatterns(currentSession);
      for (const pattern of toolPatterns.slice(0, THRESHOLDS.MAX_PATTERNS_PER_SESSION)) {
        await this.persistPattern(pattern);
        result.patternsLearned++;
      }

      // 2. Analyze success/failure patterns
      const outcomePatterns = this.analyzeOutcomePatterns(currentSession);
      for (const pattern of outcomePatterns) {
        await this.persistPattern(pattern);
        result.patternsLearned++;
      }

      // 3. Update strategies based on session outcome
      const strategyUpdates = await this.updateStrategiesFromSession(currentSession);
      result.strategiesUpdated = strategyUpdates;

      // 4. Generate insights
      result.insights = this.generateInsights(currentSession);

      // 5. Generate recommendations
      result.recommendations = await this.generateRecommendations(currentSession);

      logger.info('Meta learning loop completed', {
        patternsLearned: result.patternsLearned,
        strategiesUpdated: result.strategiesUpdated,
        insights: result.insights.length,
      });

      return result;
    } finally {
      this.isRunning = false;
    }
  }

  private async runAggregatedLearning(): Promise<LearningResult> {
    const result: LearningResult = {
      patternsLearned: 0,
      strategiesUpdated: 0,
      insights: [],
      recommendations: [],
    };

    // Aggregate patterns across sessions
    const allToolSequences = new Map<string, number>();
    const allToolSuccessRates = new Map<string, { success: number; total: number }>();

    for (const session of this.sessionHistory) {
      // Collect tool sequences
      const sequence = session.toolExecutions.map(e => e.name).join(' -> ');
      if (sequence.length > 0) {
        allToolSequences.set(sequence, (allToolSequences.get(sequence) || 0) + 1);
      }

      // Collect tool success rates
      for (const exec of session.toolExecutions) {
        const stats = allToolSuccessRates.get(exec.name) || { success: 0, total: 0 };
        stats.total++;
        if (exec.success) stats.success++;
        allToolSuccessRates.set(exec.name, stats);
      }
    }

    // Extract significant patterns
    for (const [sequence, count] of allToolSequences) {
      if (count >= THRESHOLDS.MIN_OCCURRENCES) {
        const tools = sequence.split(' -> ');
        if (tools.length >= THRESHOLDS.MIN_SEQUENCE_LENGTH) {
          const pattern: ExtractedPattern = {
            type: 'success',
            name: `Common workflow: ${tools[0]} to ${tools[tools.length - 1]}`,
            context: 'Aggregated from multiple sessions',
            pattern: `Tool sequence used ${count} times: ${sequence}`,
            confidence: Math.min(0.5 + count * 0.1, 0.95),
            tags: ['workflow', 'aggregated', ...tools],
          };
          await this.persistPattern(pattern);
          result.patternsLearned++;
        }
      }
    }

    // Generate insights from success rates
    for (const [tool, stats] of allToolSuccessRates) {
      const rate = stats.success / stats.total;
      if (rate < 0.5 && stats.total >= 3) {
        result.insights.push(`Tool "${tool}" has low success rate (${(rate * 100).toFixed(0)}% over ${stats.total} uses)`);
      }
      if (rate >= 0.9 && stats.total >= 5) {
        result.insights.push(`Tool "${tool}" is highly reliable (${(rate * 100).toFixed(0)}% success over ${stats.total} uses)`);
      }
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // Pattern Analysis
  // --------------------------------------------------------------------------

  private analyzeToolUsagePatterns(session: SessionAnalysis): ExtractedPattern[] {
    const patterns: ExtractedPattern[] = [];
    const executions = session.toolExecutions;

    if (executions.length < THRESHOLDS.MIN_SEQUENCE_LENGTH) {
      return patterns;
    }

    // Find successful tool sequences
    const sequences: string[][] = [];
    let currentSequence: string[] = [];
    let lastSuccess = true;

    for (const exec of executions) {
      if (exec.success) {
        currentSequence.push(exec.name);
        lastSuccess = true;
      } else {
        // End current sequence on failure
        if (currentSequence.length >= THRESHOLDS.MIN_SEQUENCE_LENGTH) {
          sequences.push([...currentSequence]);
        }
        currentSequence = [];
        lastSuccess = false;
      }
    }

    // Capture final sequence if successful
    if (lastSuccess && currentSequence.length >= THRESHOLDS.MIN_SEQUENCE_LENGTH) {
      sequences.push(currentSequence);
    }

    // Convert sequences to patterns
    for (const seq of sequences) {
      const uniqueTools = [...new Set(seq)];
      patterns.push({
        type: 'success',
        name: `Workflow: ${seq[0]} to ${seq[seq.length - 1]}`,
        context: session.taskType || 'General task',
        pattern: `Successful tool sequence: ${seq.join(' -> ')}`,
        solution: `Use this sequence for similar tasks involving ${uniqueTools.join(', ')}`,
        confidence: 0.6 + Math.min(seq.length * 0.05, 0.3),
        tags: ['workflow', 'tool-sequence', ...uniqueTools],
      });
    }

    return patterns;
  }

  private analyzeOutcomePatterns(session: SessionAnalysis): ExtractedPattern[] {
    const patterns: ExtractedPattern[] = [];

    // Analyze session outcome
    if (session.success) {
      // Extract successful task completion pattern
      const toolsUsed = [...new Set(session.toolExecutions.map(e => e.name))];
      if (toolsUsed.length > 0 && session.taskType) {
        patterns.push({
          type: 'success',
          name: `Successful ${session.taskType}`,
          context: `Task type: ${session.taskType}`,
          pattern: `Completed successfully using: ${toolsUsed.join(', ')}`,
          confidence: 0.75,
          tags: ['task-completion', session.taskType, ...toolsUsed],
        });
      }
    } else {
      // Analyze failure
      const failedTools = session.toolExecutions.filter(e => !e.success);
      if (failedTools.length > 0) {
        const failureSummary = failedTools
          .map(e => `${e.name}: ${e.errorMessage || 'unknown error'}`)
          .join('; ');

        patterns.push({
          type: 'failure',
          name: `Failed ${session.taskType || 'task'}`,
          context: `Task type: ${session.taskType || 'unknown'}`,
          pattern: `Failures: ${failureSummary}`,
          solution: 'Review error messages and adjust approach',
          confidence: 0.65,
          tags: ['failure', 'error-recovery', ...failedTools.map(e => e.name)],
        });
      }
    }

    return patterns;
  }

  private async extractFailurePattern(
    execution: ToolExecution,
    recentFailures: ToolExecution[],
    context: string
  ): Promise<ExtractedPattern | null> {
    // Group similar errors
    const errorMessages = recentFailures
      .map(e => e.errorMessage)
      .filter((e): e is string => !!e);

    if (errorMessages.length === 0) return null;

    // Find common error patterns
    const commonError = this.findCommonErrorPattern(errorMessages);

    return {
      type: 'anti_pattern',
      name: `Avoid: ${execution.name} failure pattern`,
      context,
      pattern: `Tool ${execution.name} fails with: ${commonError}`,
      solution: 'Check inputs and preconditions before calling this tool',
      confidence: 0.7 + Math.min(recentFailures.length * 0.05, 0.25),
      tags: ['anti-pattern', execution.name, 'error'],
    };
  }

  private findCommonErrorPattern(errors: string[]): string {
    if (errors.length === 0) return 'unknown';
    if (errors.length === 1) return errors[0].substring(0, 100);

    // Simple: return the most common error (or first if all unique)
    const counts = new Map<string, number>();
    for (const error of errors) {
      const normalized = error.substring(0, 100);
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }

    let mostCommon = errors[0].substring(0, 100);
    let maxCount = 0;

    for (const [error, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        mostCommon = error;
      }
    }

    return mostCommon;
  }

  // --------------------------------------------------------------------------
  // Strategy Updates
  // --------------------------------------------------------------------------

  private async updateStrategiesFromSession(session: SessionAnalysis): Promise<number> {
    const persistence = getEvolutionPersistence();
    const strategies = persistence.getAllStrategies();
    let updatedCount = 0;

    // Match session to existing strategies
    for (const strategy of strategies) {
      const isMatch = this.sessionMatchesStrategy(session, strategy);
      if (isMatch) {
        // Record feedback
        await persistence.recordFeedback({
          strategyId: strategy.id,
          success: session.success,
          duration: session.endTime - session.startTime,
          notes: session.success
            ? 'Session completed successfully'
            : `Session failed: ${session.toolExecutions.filter(e => !e.success).length} tool failures`,
        });
        updatedCount++;
      }
    }

    return updatedCount;
  }

  private sessionMatchesStrategy(session: SessionAnalysis, strategy: Strategy): boolean {
    // Match by tags
    const sessionTags = new Set([
      session.taskType,
      ...session.toolExecutions.map(e => e.name),
    ].filter(Boolean));

    const matchingTags = strategy.tags.filter(t => sessionTags.has(t));

    // Match if at least 2 tags match
    return matchingTags.length >= 2;
  }

  // --------------------------------------------------------------------------
  // Insights & Recommendations
  // --------------------------------------------------------------------------

  private generateInsights(session: SessionAnalysis): string[] {
    const insights: string[] = [];
    const executions = session.toolExecutions;

    if (executions.length === 0) {
      insights.push('No tool usage in this session');
      return insights;
    }

    // Calculate success rate
    const successRate = executions.filter(e => e.success).length / executions.length;

    if (successRate === 1) {
      insights.push('All tools executed successfully');
    } else if (successRate < 0.5) {
      insights.push(`Low tool success rate: ${(successRate * 100).toFixed(0)}%`);
    }

    // Calculate average duration
    const avgDuration = executions.reduce((sum, e) => sum + e.duration, 0) / executions.length;
    if (avgDuration > 10000) {
      insights.push(`Average tool execution time is high: ${(avgDuration / 1000).toFixed(1)}s`);
    }

    // Find most used tool
    const toolCounts = new Map<string, number>();
    for (const exec of executions) {
      toolCounts.set(exec.name, (toolCounts.get(exec.name) || 0) + 1);
    }

    const [mostUsed, count] = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])[0] || ['none', 0];

    if (count > 3) {
      insights.push(`Most used tool: ${mostUsed} (${count} times)`);
    }

    return insights;
  }

  private async generateRecommendations(session: SessionAnalysis): Promise<string[]> {
    const recommendations: string[] = [];
    const persistence = getEvolutionPersistence();

    // Check for relevant existing patterns
    const reliablePatterns = persistence.getReliablePatterns(0.8);
    const sessionTools = new Set(session.toolExecutions.map(e => e.name));

    for (const pattern of reliablePatterns.slice(0, 3)) {
      const patternTools = pattern.tags.filter(t =>
        ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'].includes(t)
      );

      if (patternTools.some(t => sessionTools.has(t))) {
        recommendations.push(`Consider applying pattern: ${pattern.name}`);
      }
    }

    // If session failed, recommend reviewing anti-patterns
    if (!session.success) {
      const antiPatterns = persistence.getPatternsByType('anti_pattern');
      if (antiPatterns.length > 0) {
        recommendations.push('Review known anti-patterns to avoid common pitfalls');
      }
    }

    return recommendations;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async persistPattern(pattern: ExtractedPattern): Promise<void> {
    const persistence = getEvolutionPersistence();

    // Check for duplicate patterns (simple name match)
    const existing = persistence.getAllPatterns().find(p =>
      p.name === pattern.name && p.type === pattern.type
    );

    if (existing) {
      // Update existing pattern
      await persistence.updatePattern(existing.id, {
        confidence: Math.min(existing.confidence + 0.05, 0.99),
        occurrences: existing.occurrences + 1,
        lastSeen: Date.now(),
      });
    } else {
      // Create new pattern
      await persistence.createPattern({
        ...pattern,
        occurrences: 1,
        lastSeen: Date.now(),
      });
    }
  }

  private getRecentFailures(toolName: string): ToolExecution[] {
    const cutoff = Date.now() - THRESHOLDS.AGGREGATION_WINDOW_MS;
    const failures: ToolExecution[] = [];

    for (const session of this.sessionHistory) {
      if (session.startTime < cutoff) continue;

      for (const exec of session.toolExecutions) {
        if (exec.name === toolName && !exec.success) {
          failures.push(exec);
        }
      }
    }

    return failures;
  }

  private trimSessionHistory(): void {
    const cutoff = Date.now() - THRESHOLDS.AGGREGATION_WINDOW_MS;
    this.sessionHistory = this.sessionHistory.filter(s => s.startTime >= cutoff);
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let metaLearningLoopInstance: MetaLearningLoopService | null = null;

export function getMetaLearningLoop(): MetaLearningLoopService {
  if (!metaLearningLoopInstance) {
    metaLearningLoopInstance = new MetaLearningLoopService();
  }
  return metaLearningLoopInstance;
}

// Export for testing
export { MetaLearningLoopService };
