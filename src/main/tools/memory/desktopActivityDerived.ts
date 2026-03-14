// ============================================================================
// Desktop Activity Derived Tools - Time-slice summaries / todos / semantic search
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getDesktopActivityUnderstandingService } from '../../memory/desktopActivityUnderstandingService';
import type {
  DesktopActivitySemanticMatch,
  DesktopActivitySliceSummary,
  DesktopActivityTodoCandidate,
} from '../../../shared/types';

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function formatTimeRange(fromMs: number, toMs: number): string {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return `${formatter.format(new Date(fromMs))} - ${formatter.format(new Date(toMs))}`;
}

async function maybeRefresh(params: Record<string, unknown>): Promise<void> {
  const refresh = asBoolean(params.refresh);
  if (refresh === false) return;

  const sinceHours = asNumber(params.since_hours);
  await getDesktopActivityUnderstandingService().refreshRecentActivity({
    lookbackHours: sinceHours ? Math.max(sinceHours, 6) : undefined,
  });
}

function buildEmptyOutput(reason: string): ToolExecutionResult {
  return {
    success: true,
    output: reason,
  };
}

function formatSummary(summary: DesktopActivitySliceSummary): string {
  const apps = summary.topApps.map((item) => `${item.appName}(${item.count})`).join('，');
  const subjects = summary.salientSubjects.length > 0
    ? ` | 主题：${summary.salientSubjects.join(' / ')}`
    : '';

  return `${formatTimeRange(summary.fromMs, summary.toMs)} | ${summary.summary}\n   apps=${apps}${subjects}`;
}

function formatTodo(todo: DesktopActivityTodoCandidate): string {
  const evidence = todo.evidence.length > 0 ? ` | 线索：${todo.evidence.join(' / ')}` : '';
  return `[${todo.confidence.toFixed(2)}] ${todo.content}${evidence}`;
}

function formatSearchMatch(match: DesktopActivitySemanticMatch): string {
  return `[${match.score.toFixed(2)}] ${formatTimeRange(match.summary.fromMs, match.summary.toMs)}\n` +
    `   ${match.summary.summary}\n` +
    `   ${match.snippet}`;
}

export const desktopActivitySummaryTool: Tool = {
  name: 'desktop_activity_summary',
  description: `Read derived time-slice summaries from local native desktop activity.

Use this when you need:
- A compact work log instead of raw events
- What happened over the last few hours in 30-minute slices
- Summaries that can be consumed by memory/search layers

This reads derived summaries generated from the local desktop collector.`,
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      since_hours: {
        type: 'number',
        description: 'Only include summaries whose time slice overlaps the last N hours. Default: 6.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of summary slices to return. Default: 6.',
      },
      refresh: {
        type: 'boolean',
        description: 'If true or omitted, refresh derived summaries before reading.',
      },
    },
  },
  tags: ['memory', 'search'],
  aliases: ['desktop summary', 'activity summary', 'work summary'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    await maybeRefresh(params);

    const sinceHours = asNumber(params.since_hours) || 6;
    const limit = asNumber(params.limit) || 6;
    const summaries = getDesktopActivityUnderstandingService().listRecentSummaries({
      limit,
      sinceHours,
    });

    if (summaries.length === 0) {
      return buildEmptyOutput('最近没有可读取的桌面活动时间片摘要。请先开启 native desktop collector 并等待至少一个时间片累积。');
    }

    const lines = [
      `最近 ${sinceHours} 小时内共读取到 ${summaries.length} 个时间片摘要：`,
      '',
      ...summaries.map((summary, index) => `${index + 1}. ${formatSummary(summary)}`),
    ];

    return {
      success: true,
      output: lines.join('\n'),
      result: { summaries },
      metadata: {
        count: summaries.length,
      },
    };
  },
};

export const desktopActivityTodoCandidatesTool: Tool = {
  name: 'desktop_activity_todo_candidates',
  description: `Read todo candidates derived from local native desktop activity summaries.

Use this when you need:
- Suggested follow-ups inferred from recent work slices
- A minimal backlog recovered from desktop activity
- Inputs for later todo orchestration without parsing raw events

This reads derived todo candidates generated from local desktop activity summaries.`,
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      since_hours: {
        type: 'number',
        description: 'Only include todo candidates created within the last N hours. Default: 12.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of todo candidates to return. Default: 8.',
      },
      refresh: {
        type: 'boolean',
        description: 'If true or omitted, refresh derived summaries before reading.',
      },
    },
  },
  tags: ['memory', 'planning'],
  aliases: ['desktop todos', 'activity todos', 'recent todo candidates'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    await maybeRefresh(params);

    const sinceHours = asNumber(params.since_hours) || 12;
    const limit = asNumber(params.limit) || 8;
    const todos = getDesktopActivityUnderstandingService().listTodoCandidates({
      limit,
      sinceHours,
    });

    if (todos.length === 0) {
      return buildEmptyOutput('最近没有提取到桌面活动待办候选。当前规则只会保留相对明确的工作主题。');
    }

    const lines = [
      `最近 ${sinceHours} 小时共提取到 ${todos.length} 条桌面活动待办候选：`,
      '',
      ...todos.map((todo, index) => `${index + 1}. ${formatTodo(todo)}`),
    ];

    return {
      success: true,
      output: lines.join('\n'),
      result: { todos },
      metadata: {
        count: todos.length,
      },
    };
  },
};

export const desktopActivitySemanticSearchTool: Tool = {
  name: 'desktop_activity_semantic_search',
  description: `Semantically search derived desktop activity summaries.

Use this when you need to find:
- Which time slice mentioned a topic or task
- Work slices related to a document, issue, or domain
- Higher-level retrieval over derived summaries instead of raw keyword search

This searches vectorized time-slice summaries generated from local desktop activity.`,
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language query over derived desktop activity summaries.',
      },
      since_hours: {
        type: 'number',
        description: 'Restrict matches to summaries overlapping the last N hours. Default: 24.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of matches to return. Default: 5.',
      },
      refresh: {
        type: 'boolean',
        description: 'If true or omitted, refresh derived summaries before searching.',
      },
    },
    required: ['query'],
  },
  tags: ['memory', 'search'],
  aliases: ['desktop semantic search', 'activity semantic search', 'search work summaries'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const query = asString(params.query);
    if (!query) {
      return {
        success: false,
        error: 'query 参数不能为空。',
      };
    }

    await maybeRefresh(params);

    const sinceHours = asNumber(params.since_hours) || 24;
    const limit = asNumber(params.limit) || 5;
    const matches = await getDesktopActivityUnderstandingService().searchSummaries(query, {
      limit,
      sinceHours,
    });

    if (matches.length === 0) {
      return buildEmptyOutput(`没有找到与 "${query}" 相关的桌面活动时间片摘要。`);
    }

    const lines = [
      `找到 ${matches.length} 条与 "${query}" 相关的桌面活动时间片摘要：`,
      '',
      ...matches.map((match, index) => `${index + 1}. ${formatSearchMatch(match)}`),
    ];

    return {
      success: true,
      output: lines.join('\n'),
      result: { matches },
      metadata: {
        count: matches.length,
      },
    };
  },
};
