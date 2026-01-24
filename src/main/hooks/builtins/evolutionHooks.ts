// ============================================================================
// Evolution Hooks - Meta learning and capability gap detection hooks
// Gen 8: Self-Evolution capability
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import type { SessionContext, HookExecutionResult } from '../events';
import type { Message } from '../../../shared/types';
import {
  getMetaLearningLoop,
  getCapabilityGapDetector,
  type SessionAnalysis,
  type ToolExecution,
} from '../../tools/evolution';

const logger = createLogger('EvolutionHooks');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface ToolExecutionRecord {
  name: string;
  input: unknown;
  output?: unknown;
  success: boolean;
  timestamp: number;
  errorMessage?: string;
}

export interface EvolutionHookResult extends HookExecutionResult {
  patternsLearned?: number;
  gapsDetected?: number;
  strategiesUpdated?: number;
  insights?: string[];
}

// ----------------------------------------------------------------------------
// Session End Meta Learning Hook
// ----------------------------------------------------------------------------

/**
 * Session end hook that triggers meta learning loop
 *
 * Analyzes the session for:
 * - Tool usage patterns
 * - Success/failure patterns
 * - Capability gaps
 * - Strategy updates
 */
export async function sessionEndMetaLearningHook(
  context: SessionContext,
  messages: Message[],
  toolExecutions: ToolExecutionRecord[]
): Promise<EvolutionHookResult> {
  const startTime = Date.now();

  try {
    // Convert tool executions to the expected format
    const executions: ToolExecution[] = toolExecutions.map(te => ({
      name: te.name,
      input: te.input,
      output: te.output,
      success: te.success,
      duration: 0, // We don't have duration in the record
      timestamp: te.timestamp,
      errorMessage: te.errorMessage,
    }));

    // Determine session success (majority of tools succeeded)
    const successRate = executions.length > 0
      ? executions.filter(e => e.success).length / executions.length
      : 1;
    const sessionSuccess = successRate >= 0.7;

    // Create session analysis
    const analysis: SessionAnalysis = {
      sessionId: context.sessionId,
      startTime: messages[0]?.timestamp || Date.now(),
      endTime: Date.now(),
      toolExecutions: executions,
      messages,
      success: sessionSuccess,
      taskType: inferTaskType(messages),
    };

    // Run meta learning loop
    const metaLearning = getMetaLearningLoop();
    const learningResult = await metaLearning.onSessionEnd(analysis);

    // Run capability gap detection
    const gapDetector = getCapabilityGapDetector();
    const gapResult = await gapDetector.analyzeSession(analysis);

    // Combine results
    const totalPatternsLearned = learningResult.patternsLearned;
    const totalGapsDetected = gapResult.newGaps.length + gapResult.updatedGaps.length;
    const allInsights = [
      ...learningResult.insights,
      ...learningResult.recommendations,
      ...gapResult.insights,
    ];

    logger.info('Evolution hooks completed', {
      sessionId: context.sessionId,
      patternsLearned: totalPatternsLearned,
      gapsDetected: totalGapsDetected,
      strategiesUpdated: learningResult.strategiesUpdated,
    });

    // Build message summary
    const messageParts: string[] = [];

    if (totalPatternsLearned > 0) {
      messageParts.push(`Learned ${totalPatternsLearned} pattern(s)`);
    }

    if (gapResult.newGaps.length > 0) {
      messageParts.push(`Detected ${gapResult.newGaps.length} new capability gap(s)`);
    }

    if (learningResult.strategiesUpdated > 0) {
      messageParts.push(`Updated ${learningResult.strategiesUpdated} strategy(s)`);
    }

    return {
      action: 'continue',
      message: messageParts.length > 0
        ? `Meta learning: ${messageParts.join(', ')}`
        : undefined,
      patternsLearned: totalPatternsLearned,
      gapsDetected: totalGapsDetected,
      strategiesUpdated: learningResult.strategiesUpdated,
      insights: allInsights,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    logger.error('Meta learning hook failed:', error);
    return {
      action: 'continue', // Don't block on learning failure
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: Date.now() - startTime,
    };
  }
}

// ----------------------------------------------------------------------------
// Tool Failure Hook
// ----------------------------------------------------------------------------

/**
 * Hook triggered on tool failure to detect patterns
 */
export async function postToolUseFailureEvolutionHook(
  toolName: string,
  errorMessage: string,
  context: string
): Promise<EvolutionHookResult> {
  const startTime = Date.now();

  try {
    const metaLearning = getMetaLearningLoop();

    const execution: ToolExecution = {
      name: toolName,
      input: {},
      success: false,
      duration: 0,
      timestamp: Date.now(),
      errorMessage,
    };

    const pattern = await metaLearning.onToolFailure(execution, context);

    if (pattern) {
      logger.info('Anti-pattern detected from tool failure', {
        tool: toolName,
        pattern: pattern.name,
      });

      return {
        action: 'continue',
        message: `Recorded anti-pattern: ${pattern.name}`,
        patternsLearned: 1,
        duration: Date.now() - startTime,
      };
    }

    return {
      action: 'continue',
      duration: Date.now() - startTime,
    };
  } catch (error) {
    logger.error('Tool failure evolution hook failed:', error);
    return {
      action: 'continue',
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: Date.now() - startTime,
    };
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Infer task type from messages
 */
function inferTaskType(messages: Message[]): string | undefined {
  if (messages.length === 0) return undefined;

  // Look at first user message to determine task type
  const firstUserMessage = messages.find(m => m.role === 'user');
  if (!firstUserMessage?.content) return undefined;

  const content = firstUserMessage.content.toLowerCase();

  // Check for common task patterns
  if (content.includes('fix') || content.includes('bug') || content.includes('error')) {
    return 'debugging';
  }
  if (content.includes('add') || content.includes('implement') || content.includes('create')) {
    return 'feature';
  }
  if (content.includes('refactor') || content.includes('improve') || content.includes('clean')) {
    return 'refactoring';
  }
  if (content.includes('test') || content.includes('testing')) {
    return 'testing';
  }
  if (content.includes('review') || content.includes('check')) {
    return 'review';
  }
  if (content.includes('explain') || content.includes('how') || content.includes('what')) {
    return 'explanation';
  }
  if (content.includes('deploy') || content.includes('release') || content.includes('build')) {
    return 'deployment';
  }

  return 'general';
}

// ----------------------------------------------------------------------------
// Export capability gap statistics
// ----------------------------------------------------------------------------

export async function getCapabilityGapStats(): Promise<{
  totalGaps: number;
  openGaps: number;
  topPriorities: Array<{ name: string; severity: string }>;
}> {
  try {
    const detector = getCapabilityGapDetector();
    await detector.initialize();

    const stats = detector.getStatistics();
    const openGaps = detector.getOpenGaps();

    return {
      totalGaps: stats.totalGaps,
      openGaps: stats.byStatus.open + stats.byStatus.in_progress,
      topPriorities: openGaps.slice(0, 3).map(g => ({
        name: g.name,
        severity: g.severity,
      })),
    };
  } catch {
    return {
      totalGaps: 0,
      openGaps: 0,
      topPriorities: [],
    };
  }
}

export async function getMetaLearningStats(): Promise<{
  sessionsAnalyzed: number;
  isRunning: boolean;
}> {
  const loop = getMetaLearningLoop();
  const stats = loop.getStats();

  return {
    sessionsAnalyzed: stats.sessionsAnalyzed,
    isRunning: stats.isRunning,
  };
}
