// ============================================================================
// Query Metrics Tool - Agent 自查询观测数据
// ============================================================================
// Harness Engineering P2a: Agent 可查询自身性能数据，用于自诊断和优化。
// 5 种查询动作:
// - session_summary: Token 用量、成本、工具统计
// - error_patterns: 错误模式及频率
// - tool_performance: 按工具的成功率和延迟
// - review_history: Review Loop 迭代历史和分数
// - capability_gaps: 从错误模式检测的能力缺口
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getTelemetryCollector } from '../../telemetry/telemetryCollector';
import { getTelemetryStorage } from '../../telemetry/telemetryStorage';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('QueryMetrics');

type QueryAction =
  | 'session_summary'
  | 'error_patterns'
  | 'tool_performance'
  | 'review_history'
  | 'capability_gaps';

export const queryMetricsTool: Tool = {
  name: 'query_metrics',
  description: `Query agent performance metrics for self-diagnosis.

Available actions:
- session_summary: Token usage, cost estimate, tool call statistics for the current session
- error_patterns: Recurring error patterns and their frequencies
- tool_performance: Per-tool success rate and average latency
- review_history: Review Loop iteration history and scores (if applicable)
- capability_gaps: Detected capability gaps from error patterns

Use this tool when:
- You notice repeated failures and want to understand patterns
- You want to check resource usage (tokens, cost) mid-session
- You need to assess which tools are performing well vs poorly
- After a Review Loop, to understand iteration history`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['session_summary', 'error_patterns', 'tool_performance', 'review_history', 'capability_gaps'],
        description: 'The type of metrics to query',
      },
    },
    required: ['action'],
  },

  requiresPermission: false,
  permissionLevel: 'read',

  async execute(
    params: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const action = params.action as QueryAction;

    try {
      switch (action) {
        case 'session_summary':
          return querySessionSummary(context);
        case 'error_patterns':
          return queryErrorPatterns(context);
        case 'tool_performance':
          return queryToolPerformance(context);
        case 'review_history':
          return queryReviewHistory();
        case 'capability_gaps':
          return queryCapabilityGaps();
        default:
          return {
            success: false,
            error: `Unknown action: ${action}. Valid actions: session_summary, error_patterns, tool_performance, review_history, capability_gaps`,
          };
      }
    } catch (error) {
      logger.error(`[QueryMetrics] Error querying ${action}:`, error);
      return {
        success: false,
        error: `Failed to query ${action}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================================
// Query Implementations
// ============================================================================

function querySessionSummary(context: ToolContext): ToolExecutionResult {
  const collector = getTelemetryCollector();
  const sessionId = context.sessionId;

  if (!sessionId) {
    return {
      success: true,
      output: 'No active session found. Session metrics are only available during an active session.',
    };
  }

  const sessionData = collector.getSessionData(sessionId);

  if (!sessionData) {
    return {
      success: true,
      output: `Session ${sessionId} not found or already ended.`,
    };
  }

  const durationMin = sessionData.durationMs
    ? (sessionData.durationMs / 60000).toFixed(1)
    : ((Date.now() - sessionData.startTime) / 60000).toFixed(1);

  const output = [
    '## Session Summary',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Session ID | ${sessionData.id.substring(0, 8)}... |`,
    `| Duration | ${durationMin} min |`,
    `| Turns | ${sessionData.turnCount} |`,
    `| Input Tokens | ${sessionData.totalInputTokens.toLocaleString()} |`,
    `| Output Tokens | ${sessionData.totalOutputTokens.toLocaleString()} |`,
    `| Total Tokens | ${sessionData.totalTokens.toLocaleString()} |`,
    `| Tool Calls | ${sessionData.totalToolCalls} |`,
    `| Tool Success Rate | ${(sessionData.toolSuccessRate * 100).toFixed(1)}% |`,
    `| Errors | ${sessionData.totalErrors} |`,
    `| Model | ${sessionData.modelProvider}/${sessionData.modelName} |`,
  ];

  return { success: true, output: output.join('\n') };
}

function queryErrorPatterns(context: ToolContext): ToolExecutionResult {
  const collector = getTelemetryCollector();
  const sessionId = context.sessionId;

  if (!sessionId) {
    return { success: true, output: 'No active session. Error patterns require an active session.' };
  }

  const errorSummary = collector.getErrorSummary(sessionId);

  if (errorSummary.totalErrors === 0) {
    return { success: true, output: '## Error Patterns\n\nNo errors detected in this session. All tool calls succeeded.' };
  }

  const lines = [
    '## Error Patterns',
    '',
    `Total errors: ${errorSummary.totalErrors}`,
    '',
    '### Errors by Tool',
    '| Tool | Error Count |',
    '|------|------------|',
  ];

  for (const [tool, count] of Object.entries(errorSummary.errorsByTool).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${tool} | ${count} |`);
  }

  if (errorSummary.topErrors.length > 0) {
    lines.push('', '### Top Error Messages', '| Error | Count |', '|-------|-------|');
    for (const { error, count } of errorSummary.topErrors) {
      lines.push(`| ${error.substring(0, 60)} | ${count} |`);
    }
  }

  return { success: true, output: lines.join('\n') };
}

function queryToolPerformance(context: ToolContext): ToolExecutionResult {
  const collector = getTelemetryCollector();
  const sessionId = context.sessionId;

  if (!sessionId) {
    return { success: true, output: 'No active session. Tool performance requires an active session.' };
  }

  const perfData = collector.getToolPerformance(sessionId);

  if (perfData.length === 0) {
    return { success: true, output: '## Tool Performance\n\nNo tool calls recorded yet.' };
  }

  const totalCalls = perfData.reduce((s, p) => s + p.total, 0);

  const lines = [
    '## Tool Performance',
    '',
    `Total tools used: ${perfData.length}, Total calls: ${totalCalls}`,
    '',
    '| Tool | Calls | Success Rate | Avg Latency |',
    '|------|-------|-------------|-------------|',
  ];

  for (const stat of perfData) {
    lines.push(`| ${stat.name} | ${stat.total} | ${(stat.successRate * 100).toFixed(0)}% | ${stat.avgDurationMs}ms |`);
  }

  return { success: true, output: lines.join('\n') };
}

function queryReviewHistory(): ToolExecutionResult {
  // Review Loop history is stored in-memory during the session
  // Access via the reviewLoopHistory global (if available)
  try {
    const { getReviewLoopHistory } = require('../hybrid/reviewLoop');
    const history = getReviewLoopHistory?.() || [];

    if (history.length === 0) {
      return {
        success: true,
        output: '## Review Loop History\n\nNo Review Loop iterations in this session. Review Loops are triggered for complex tasks (complexity >= moderate, steps >= 3).',
      };
    }

    const lines = [
      '## Review Loop History',
      '',
      '| Task | Iterations | Final Score | Passed | Exit Reason | Duration |',
      '|------|-----------|-------------|--------|-------------|----------|',
    ];

    for (const entry of history) {
      lines.push(
        `| ${(entry.task || '').substring(0, 30)} | ${entry.iterations} | ${entry.finalScore.toFixed(2)} | ${entry.passed ? 'Yes' : 'No'} | ${entry.exitReason} | ${(entry.durationMs / 1000).toFixed(1)}s |`,
      );
    }

    return { success: true, output: lines.join('\n') };
  } catch {
    return {
      success: true,
      output: '## Review Loop History\n\nNo Review Loop data available. Review Loops are only active for complex tasks.',
    };
  }
}

function queryCapabilityGaps(): ToolExecutionResult {
  try {
    const { getCapabilityGapDetector } = require('./capabilityGapDetector');
    const detector = getCapabilityGapDetector();
    const analysis = detector.analyze();

    if (!analysis || analysis.gaps.length === 0) {
      return {
        success: true,
        output: '## Capability Gaps\n\nNo capability gaps detected. The agent is performing within expected parameters.',
      };
    }

    const lines = [
      '## Capability Gaps',
      '',
      `Total gaps: ${analysis.gaps.length}, Critical: ${analysis.statistics.critical}`,
      '',
      '| Category | Severity | Occurrences | Description | Suggestion |',
      '|----------|----------|-------------|-------------|------------|',
    ];

    for (const gap of analysis.gaps.slice(0, 10)) {
      lines.push(
        `| ${gap.category} | ${gap.severity} | ${gap.occurrences} | ${gap.description.substring(0, 40)} | ${(gap.suggestion || '').substring(0, 40)} |`,
      );
    }

    return { success: true, output: lines.join('\n') };
  } catch {
    return {
      success: true,
      output: '## Capability Gaps\n\nCapability gap detection is not initialized. Gaps are detected automatically when error patterns emerge (>= 3 similar errors).',
    };
  }
}
