// ============================================================================
// Self Evaluate Tool - Evaluate and improve agent performance
// Gen 8: Self-Evolution capability
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getMemoryService } from '../../memory/memoryService';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('SelfEvaluate');

interface PerformanceMetric {
  timestamp: number;
  taskType: string;
  success: boolean;
  duration: number;
  toolsUsed: string[];
  iterations: number;
  notes?: string;
}

interface EvaluationResult {
  overallScore: number;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
}

// Performance history
const performanceHistory: PerformanceMetric[] = [];

export const selfEvaluateTool: Tool = {
  name: 'self_evaluate',
  description: `Evaluate agent performance and identify improvement areas.

Use this tool to:
- Record task completion metrics
- Analyze performance patterns
- Get improvement suggestions
- Track progress over time

Parameters:
- action: record, analyze, report, compare
- taskType: Type of task (for record)
- success: Whether task succeeded (for record)
- duration: Task duration in ms (for record)
- toolsUsed: Tools used during task (for record)
- iterations: Number of iterations (for record)
- notes: Additional notes (for record)
- period: Analysis period in hours (for analyze/report)`,
  generations: ['gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['record', 'analyze', 'report', 'compare', 'insights'],
        description: 'Action to perform',
      },
      taskType: {
        type: 'string',
        description: 'Type of task (coding, debugging, review, etc.)',
      },
      success: {
        type: 'boolean',
        description: 'Whether the task succeeded',
      },
      duration: {
        type: 'number',
        description: 'Task duration in milliseconds',
      },
      toolsUsed: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tools used during the task',
      },
      iterations: {
        type: 'number',
        description: 'Number of iterations/attempts',
      },
      notes: {
        type: 'string',
        description: 'Additional notes about the task',
      },
      period: {
        type: 'number',
        description: 'Analysis period in hours (default: 24)',
      },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as string;

    switch (action) {
      case 'record':
        return recordMetric(params);

      case 'analyze':
        return analyzePerformance(params);

      case 'report':
        return generateReport(params);

      case 'compare':
        return comparePerformance(params);

      case 'insights':
        return generateInsights(params, context);

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  },
};

function recordMetric(params: Record<string, unknown>): ToolExecutionResult {
  const taskType = params.taskType as string;
  const success = params.success as boolean;
  const duration = params.duration as number;
  const toolsUsed = (params.toolsUsed as string[]) || [];
  const iterations = (params.iterations as number) || 1;
  const notes = params.notes as string | undefined;

  if (!taskType || success === undefined) {
    return {
      success: false,
      error: 'taskType and success are required for record action',
    };
  }

  const metric: PerformanceMetric = {
    timestamp: Date.now(),
    taskType,
    success,
    duration: duration || 0,
    toolsUsed,
    iterations,
    notes,
  };

  performanceHistory.push(metric);

  // Store in long-term memory
  try {
    const memoryService = getMemoryService();
    memoryService.saveProjectKnowledge(
      `performance_${Date.now()}`,
      metric,
      'learned',
      success ? 0.9 : 0.5
    );
  } catch (error) {
    logger.error('Failed to store metric in memory', error);
  }

  return {
    success: true,
    output: `Performance metric recorded:
- Task Type: ${taskType}
- Success: ${success ? '✅' : '❌'}
- Duration: ${(duration / 1000).toFixed(1)}s
- Iterations: ${iterations}
- Tools: ${toolsUsed.join(', ') || 'none'}
${notes ? `- Notes: ${notes}` : ''}

Total recorded metrics: ${performanceHistory.length}`,
  };
}

function analyzePerformance(params: Record<string, unknown>): ToolExecutionResult {
  const period = ((params.period as number) || 24) * 60 * 60 * 1000; // Convert hours to ms
  const cutoff = Date.now() - period;

  const recentMetrics = performanceHistory.filter((m) => m.timestamp >= cutoff);

  if (recentMetrics.length === 0) {
    return {
      success: true,
      output: `No metrics recorded in the last ${(period / 3600000).toFixed(0)} hours.

Use action='record' to track task performance.`,
    };
  }

  // Calculate statistics
  const totalTasks = recentMetrics.length;
  const successCount = recentMetrics.filter((m) => m.success).length;
  const successRate = (successCount / totalTasks) * 100;

  const avgDuration = recentMetrics.reduce((sum, m) => sum + m.duration, 0) / totalTasks;
  const avgIterations = recentMetrics.reduce((sum, m) => sum + m.iterations, 0) / totalTasks;

  // Group by task type
  const byTaskType = new Map<string, PerformanceMetric[]>();
  for (const metric of recentMetrics) {
    const existing = byTaskType.get(metric.taskType) || [];
    existing.push(metric);
    byTaskType.set(metric.taskType, existing);
  }

  // Find most used tools
  const toolUsage = new Map<string, number>();
  for (const metric of recentMetrics) {
    for (const tool of metric.toolsUsed) {
      toolUsage.set(tool, (toolUsage.get(tool) || 0) + 1);
    }
  }

  const topTools = Array.from(toolUsage.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Task type breakdown
  const taskBreakdown = Array.from(byTaskType.entries()).map(([type, metrics]) => {
    const typeSuccess = metrics.filter((m) => m.success).length;
    return `- **${type}**: ${typeSuccess}/${metrics.length} success (${((typeSuccess / metrics.length) * 100).toFixed(0)}%)`;
  }).join('\n');

  return {
    success: true,
    output: `## Performance Analysis (Last ${(period / 3600000).toFixed(0)}h)

### Overall Statistics
- Total Tasks: ${totalTasks}
- Success Rate: ${successRate.toFixed(1)}%
- Avg Duration: ${(avgDuration / 1000).toFixed(1)}s
- Avg Iterations: ${avgIterations.toFixed(1)}

### By Task Type
${taskBreakdown}

### Most Used Tools
${topTools.map(([tool, count]) => `- ${tool}: ${count} uses`).join('\n')}`,
  };
}

function generateReport(params: Record<string, unknown>): ToolExecutionResult {
  const period = ((params.period as number) || 24) * 60 * 60 * 1000;
  const cutoff = Date.now() - period;

  const recentMetrics = performanceHistory.filter((m) => m.timestamp >= cutoff);

  if (recentMetrics.length < 5) {
    return {
      success: true,
      output: `Not enough data for a detailed report. Need at least 5 recorded tasks.

Current recorded: ${recentMetrics.length}`,
    };
  }

  const evaluation = evaluatePerformance(recentMetrics);

  return {
    success: true,
    output: `## Performance Report

### Overall Score: ${evaluation.overallScore}/100

### Strengths 💪
${evaluation.strengths.map((s) => `- ${s}`).join('\n')}

### Areas for Improvement 🎯
${evaluation.weaknesses.map((w) => `- ${w}`).join('\n')}

### Suggestions 💡
${evaluation.suggestions.map((s) => `- ${s}`).join('\n')}

---
Based on ${recentMetrics.length} tasks in the last ${(period / 3600000).toFixed(0)} hours.`,
  };
}

function comparePerformance(params: Record<string, unknown>): ToolExecutionResult {
  const period = ((params.period as number) || 24) * 60 * 60 * 1000;

  // Current period
  const currentCutoff = Date.now() - period;
  const currentMetrics = performanceHistory.filter((m) => m.timestamp >= currentCutoff);

  // Previous period
  const previousCutoff = currentCutoff - period;
  const previousMetrics = performanceHistory.filter(
    (m) => m.timestamp >= previousCutoff && m.timestamp < currentCutoff
  );

  if (previousMetrics.length === 0) {
    return {
      success: true,
      output: 'Not enough historical data for comparison.',
    };
  }

  // Calculate metrics for both periods
  const currentSuccess = currentMetrics.length > 0
    ? (currentMetrics.filter((m) => m.success).length / currentMetrics.length) * 100
    : 0;
  const previousSuccess = (previousMetrics.filter((m) => m.success).length / previousMetrics.length) * 100;

  const currentAvgDuration = currentMetrics.length > 0
    ? currentMetrics.reduce((sum, m) => sum + m.duration, 0) / currentMetrics.length
    : 0;
  const previousAvgDuration = previousMetrics.reduce((sum, m) => sum + m.duration, 0) / previousMetrics.length;

  const successDiff = currentSuccess - previousSuccess;
  const durationDiff = ((currentAvgDuration - previousAvgDuration) / previousAvgDuration) * 100;

  return {
    success: true,
    output: `## Performance Comparison

### Current Period vs Previous Period

| Metric | Current | Previous | Change |
|--------|---------|----------|--------|
| Tasks | ${currentMetrics.length} | ${previousMetrics.length} | ${currentMetrics.length - previousMetrics.length > 0 ? '+' : ''}${currentMetrics.length - previousMetrics.length} |
| Success Rate | ${currentSuccess.toFixed(1)}% | ${previousSuccess.toFixed(1)}% | ${successDiff > 0 ? '📈 +' : successDiff < 0 ? '📉 ' : ''}${successDiff.toFixed(1)}% |
| Avg Duration | ${(currentAvgDuration / 1000).toFixed(1)}s | ${(previousAvgDuration / 1000).toFixed(1)}s | ${durationDiff < 0 ? '⚡ ' : durationDiff > 0 ? '🐢 +' : ''}${durationDiff.toFixed(1)}% |

### Interpretation
${successDiff > 5 ? '✅ Significant improvement in success rate!' :
  successDiff < -5 ? '⚠️ Success rate has declined - investigate causes' :
  '➡️ Success rate is stable'}

${durationDiff < -10 ? '⚡ Tasks are being completed faster!' :
  durationDiff > 10 ? '🐢 Tasks are taking longer - review workflow' :
  '➡️ Task duration is stable'}`,
  };
}

function generateInsights(
  params: Record<string, unknown>,
  context: ToolContext
): ToolExecutionResult {
  if (performanceHistory.length < 10) {
    return {
      success: true,
      output: `Need at least 10 recorded tasks to generate insights.

Current: ${performanceHistory.length}/10`,
    };
  }

  const insights: string[] = [];

  // Analyze failure patterns
  const failures = performanceHistory.filter((m) => !m.success);
  if (failures.length > 0) {
    const failureByType = new Map<string, number>();
    for (const f of failures) {
      failureByType.set(f.taskType, (failureByType.get(f.taskType) || 0) + 1);
    }

    const topFailureType = Array.from(failureByType.entries())
      .sort((a, b) => b[1] - a[1])[0];

    if (topFailureType) {
      insights.push(`Most failures occur in "${topFailureType[0]}" tasks (${topFailureType[1]} failures) - consider additional preparation or different approach for these tasks`);
    }
  }

  // Analyze tool effectiveness
  const successByTool = new Map<string, { success: number; total: number }>();
  for (const metric of performanceHistory) {
    for (const tool of metric.toolsUsed) {
      const existing = successByTool.get(tool) || { success: 0, total: 0 };
      existing.total++;
      if (metric.success) existing.success++;
      successByTool.set(tool, existing);
    }
  }

  // Find tools with high success correlation
  const effectiveTools = Array.from(successByTool.entries())
    .filter(([_, stats]) => stats.total >= 3)
    .map(([tool, stats]) => ({
      tool,
      rate: (stats.success / stats.total) * 100,
    }))
    .sort((a, b) => b.rate - a.rate);

  if (effectiveTools.length > 0 && effectiveTools[0].rate > 80) {
    insights.push(`"${effectiveTools[0].tool}" tool has a ${effectiveTools[0].rate.toFixed(0)}% success correlation - prioritize using this tool`);
  }

  // Analyze iteration patterns
  const highIterationTasks = performanceHistory.filter((m) => m.iterations > 3);
  if (highIterationTasks.length > performanceHistory.length * 0.3) {
    insights.push('Many tasks require multiple iterations - consider better planning or asking clarifying questions earlier');
  }

  // Duration insights
  const avgDuration = performanceHistory.reduce((sum, m) => sum + m.duration, 0) / performanceHistory.length;
  const longTasks = performanceHistory.filter((m) => m.duration > avgDuration * 2);
  if (longTasks.length > 0) {
    const longTaskTypes = [...new Set(longTasks.map((t) => t.taskType))];
    insights.push(`${longTaskTypes.join(', ')} tasks tend to take longer - consider breaking them into smaller subtasks`);
  }

  if (insights.length === 0) {
    insights.push('Performance is consistent - continue current patterns');
  }

  return {
    success: true,
    output: `## Performance Insights

Based on analysis of ${performanceHistory.length} recorded tasks:

${insights.map((i, idx) => `${idx + 1}. ${i}`).join('\n\n')}

---
💡 These insights are generated from your task history. Record more tasks for better analysis.`,
  };
}

function evaluatePerformance(metrics: PerformanceMetric[]): EvaluationResult {
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const suggestions: string[] = [];

  const successRate = (metrics.filter((m) => m.success).length / metrics.length) * 100;
  const avgIterations = metrics.reduce((sum, m) => sum + m.iterations, 0) / metrics.length;
  const avgDuration = metrics.reduce((sum, m) => sum + m.duration, 0) / metrics.length;

  // Calculate score (0-100)
  let score = 0;
  score += Math.min(successRate * 0.5, 50); // Max 50 points for success rate
  score += avgIterations <= 2 ? 25 : avgIterations <= 5 ? 15 : 5; // Iteration efficiency
  score += avgDuration < 60000 ? 25 : avgDuration < 180000 ? 15 : 5; // Duration efficiency

  // Identify strengths
  if (successRate >= 80) {
    strengths.push('High task success rate');
  }
  if (avgIterations <= 2) {
    strengths.push('Efficient - tasks completed with few iterations');
  }
  if (avgDuration < 60000) {
    strengths.push('Fast task completion');
  }

  // Identify weaknesses
  if (successRate < 60) {
    weaknesses.push('Low success rate - many tasks fail');
    suggestions.push('Review failed task patterns and adjust approach');
  }
  if (avgIterations > 5) {
    weaknesses.push('Many iterations needed per task');
    suggestions.push('Improve initial understanding before starting tasks');
  }
  if (avgDuration > 180000) {
    weaknesses.push('Tasks take a long time to complete');
    suggestions.push('Break large tasks into smaller, focused subtasks');
  }

  // Default suggestion if performing well
  if (suggestions.length === 0) {
    suggestions.push('Continue current approach - performance is good');
  }

  return {
    overallScore: Math.round(score),
    strengths: strengths.length > 0 ? strengths : ['Consistent task execution'],
    weaknesses: weaknesses.length > 0 ? weaknesses : ['No significant weaknesses identified'],
    suggestions,
  };
}

// Export function to get performance history
export function getPerformanceHistory(): PerformanceMetric[] {
  return [...performanceHistory];
}
