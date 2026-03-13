// ============================================================================
// Desktop Activity Tools - Query locally collected native desktop events
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import type {
  DesktopActivityEvent,
  DesktopActivityStats,
  DesktopSearchQuery,
  DesktopTimelineQuery,
} from '../../../shared/types';
import { getNativeDesktopService } from '../../services/nativeDesktopService';

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveTimelineQuery(params: Record<string, unknown>, fallbackLimit: number): DesktopTimelineQuery {
  const sinceMinutes = asNumber(params.since_minutes);
  const fromMs = asNumber(params.from_ms);
  const toMs = asNumber(params.to_ms);
  const limit = asNumber(params.limit) || fallbackLimit;

  return {
    from: fromMs ?? (sinceMinutes ? Date.now() - (sinceMinutes * 60 * 1000) : undefined),
    to: toMs,
    appName: asString(params.app_name),
    hasUrl: asBoolean(params.has_url),
    limit,
  };
}

function formatTimestamp(timestampMs: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestampMs));
}

function formatEvent(event: DesktopActivityEvent): string {
  const parts = [event.appName];

  if (event.windowTitle) {
    parts.push(event.windowTitle);
  }

  if (event.browserTitle && event.browserTitle !== event.windowTitle) {
    parts.push(event.browserTitle);
  }

  if (event.browserUrl) {
    parts.push(event.browserUrl);
  } else if (event.documentPath) {
    parts.push(event.documentPath);
  }

  if (event.sessionState && event.sessionState !== 'active') {
    parts.push(`session:${event.sessionState}`);
  }

  if (typeof event.batteryPercent === 'number') {
    const powerLabel = event.powerSource || (event.onAcPower ? 'ac' : 'battery');
    parts.push(`power:${powerLabel} ${event.batteryPercent}%`);
  }

  return `${formatTimestamp(event.capturedAtMs)} | ${parts.join(' | ')}`;
}

function formatStats(stats: DesktopActivityStats): string[] {
  const lines = [
    `共 ${stats.totalEvents} 条事件，涉及 ${stats.uniqueApps} 个应用，带 URL 的事件 ${stats.withUrls} 条。`,
  ];

  if (stats.firstEventAtMs && stats.lastEventAtMs) {
    lines.push(`时间范围：${formatTimestamp(stats.firstEventAtMs)} - ${formatTimestamp(stats.lastEventAtMs)}。`);
  }

  if (stats.byApp.length > 0) {
    const topApps = stats.byApp
      .slice(0, 5)
      .map(({ appName, count }) => `${appName}(${count})`)
      .join('，');
    lines.push(`主要应用：${topApps}。`);
  }

  return lines;
}

function buildEmptyOutput(reason: string): ToolExecutionResult {
  return {
    success: true,
    output: reason,
    result: {
      events: [],
    },
  };
}

function getService() {
  return getNativeDesktopService();
}

export const desktopContextNowTool: Tool = {
  name: 'desktop_context_now',
  description: `Read the latest known native desktop context from the local machine.

Use this when you need:
- What am I doing right now?
- Which app/window/page was most recently active?
- A quick single-event desktop context snapshot.

This reads the most recent locally collected desktop activity event.`,
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  tags: ['memory', 'vision'],
  aliases: ['desktop now', 'current desktop context', 'what am i doing now'],
  source: 'builtin',
  async execute(_params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const event = getService().getCurrentContext();

    if (!event) {
      return buildEmptyOutput('没有可用的当前桌面上下文。请先开启 native desktop collector。');
    }

    const lines = [
      '最新桌面上下文：',
      `- ${formatEvent(event)}`,
    ];

    return {
      success: true,
      output: lines.join('\n'),
      result: { event },
      metadata: {
        timestamp: event.capturedAtMs,
        appName: event.appName,
      },
    };
  },
};

export const desktopActivityRecentTool: Tool = {
  name: 'desktop_activity_recent',
  description: `Read the most recent locally collected desktop activity events.

Use this when you need quick answers like:
- What was I just doing?
- Which apps or pages were active recently?
- Show the latest native desktop activity timeline.

This reads native desktop events collected on the local machine.`,
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of recent events to return. Default: 10.',
      },
    },
  },
  tags: ['memory', 'vision'],
  aliases: ['desktop recent', 'recent activity', 'what was i doing'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const limit = asNumber(params.limit) || 10;
    const events = getService().listRecent(limit);

    if (events.length === 0) {
      return buildEmptyOutput('没有找到本地桌面活动记录。请先开启 native desktop collector。');
    }

    const stats = getService().getStats({ limit });
    const lines = [
      ...formatStats(stats),
      '',
      '最近事件：',
      ...events.map((event) => `- ${formatEvent(event)}`),
    ];

    return {
      success: true,
      output: lines.join('\n'),
      result: { events, stats },
      metadata: {
        count: events.length,
      },
    };
  },
};

export const desktopActivityStatsTool: Tool = {
  name: 'desktop_activity_stats',
  description: `Summarize locally collected desktop activity statistics over a time window.

Use this when you need:
- Top apps used in the last N minutes
- A compact activity summary instead of a full timeline
- Quick counts before deciding whether to inspect details

This reads native desktop events collected on the local machine.`,
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      since_minutes: {
        type: 'number',
        description: 'Look back this many minutes from now when from_ms is not provided.',
      },
      from_ms: {
        type: 'number',
        description: 'Inclusive start time in Unix milliseconds.',
      },
      to_ms: {
        type: 'number',
        description: 'Inclusive end time in Unix milliseconds.',
      },
      app_name: {
        type: 'string',
        description: 'Optional app name filter.',
      },
      has_url: {
        type: 'boolean',
        description: 'If true, only count events with a browser URL.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of events to scan. Default: 1000.',
      },
    },
  },
  tags: ['memory', 'search'],
  aliases: ['desktop stats', 'activity stats', 'app usage stats'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const query = resolveTimelineQuery(params, 1000);
    const stats = getService().getStats(query);

    if (stats.totalEvents === 0) {
      return buildEmptyOutput('在指定时间范围内没有可统计的本地桌面活动记录。');
    }

    return {
      success: true,
      output: formatStats(stats).join('\n'),
      result: { stats, query },
      metadata: {
        totalEvents: stats.totalEvents,
        uniqueApps: stats.uniqueApps,
      },
    };
  },
};

export const desktopActivityByAppTool: Tool = {
  name: 'desktop_activity_by_app',
  description: `Group locally collected desktop activity by app and show per-app usage summary.

Use this when you need:
- Which apps dominated a time window
- Compare activity between Terminal, Chrome, Cursor, etc.
- A compact per-app breakdown with latest observed context

This reads native desktop events collected on the local machine.`,
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      since_minutes: {
        type: 'number',
        description: 'Look back this many minutes from now when from_ms is not provided.',
      },
      from_ms: {
        type: 'number',
        description: 'Inclusive start time in Unix milliseconds.',
      },
      to_ms: {
        type: 'number',
        description: 'Inclusive end time in Unix milliseconds.',
      },
      has_url: {
        type: 'boolean',
        description: 'If true, only include events with a browser URL.',
      },
      top_n: {
        type: 'number',
        description: 'Number of apps to show. Default: 5.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of events to scan. Default: 500.',
      },
    },
  },
  tags: ['memory', 'search'],
  aliases: ['desktop by app', 'activity by app', 'top apps'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const query = resolveTimelineQuery(params, 500);
    const topN = asNumber(params.top_n) || 5;
    const events = getService().getTimeline(query);

    if (events.length === 0) {
      return buildEmptyOutput('在指定时间范围内没有可按应用分组的本地桌面活动记录。');
    }

    const byApp = new Map<string, { count: number; latest: DesktopActivityEvent }>();
    for (const event of events) {
      const existing = byApp.get(event.appName);
      if (!existing) {
        byApp.set(event.appName, { count: 1, latest: event });
        continue;
      }

      existing.count += 1;
      if (event.capturedAtMs > existing.latest.capturedAtMs) {
        existing.latest = event;
      }
    }

    const ranked = Array.from(byApp.entries())
      .map(([appName, entry]) => ({ appName, count: entry.count, latest: entry.latest }))
      .sort((a, b) => b.count - a.count || b.latest.capturedAtMs - a.latest.capturedAtMs)
      .slice(0, topN);

    const lines = [
      `按应用分组，共 ${events.length} 条事件，展示前 ${Math.min(topN, ranked.length)} 个应用：`,
      '',
      ...ranked.map((entry, index) => {
        const latestHint = entry.latest.browserUrl || entry.latest.windowTitle || entry.latest.documentPath || '无更多上下文';
        return `${index + 1}. ${entry.appName} (${entry.count})\n   最近活动：${formatTimestamp(entry.latest.capturedAtMs)} | ${latestHint}`;
      }),
    ];

    return {
      success: true,
      output: lines.join('\n'),
      result: {
        query,
        apps: ranked,
      },
      metadata: {
        appCount: ranked.length,
        totalEvents: events.length,
      },
    };
  },
};

export const desktopActivityTimelineTool: Tool = {
  name: 'desktop_activity_timeline',
  description: `Query locally collected desktop activity over a time window.

Use this when you need:
- A timeline for the last N minutes
- Activity filtered by app
- A summary of what happened during a work period

This reads native desktop events collected on the local machine.`,
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      since_minutes: {
        type: 'number',
        description: 'Look back this many minutes from now when from_ms is not provided.',
      },
      from_ms: {
        type: 'number',
        description: 'Inclusive start time in Unix milliseconds.',
      },
      to_ms: {
        type: 'number',
        description: 'Inclusive end time in Unix milliseconds.',
      },
      app_name: {
        type: 'string',
        description: 'Filter to a specific app name, such as Chrome or Terminal.',
      },
      has_url: {
        type: 'boolean',
        description: 'If true, only return events with a browser URL.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of events to return. Default: 20.',
      },
    },
  },
  tags: ['memory', 'vision'],
  aliases: ['desktop timeline', 'activity timeline', 'screen history', 'work timeline'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const query = resolveTimelineQuery(params, 20);
    const events = getService().getTimeline(query);

    if (events.length === 0) {
      return buildEmptyOutput('在指定时间范围内没有找到本地桌面活动记录。');
    }

    const stats = getService().getStats({ ...query, limit: Math.max(query.limit || 20, 1000) });
    const filters: string[] = [];

    if (query.from) filters.push(`from=${formatTimestamp(query.from)}`);
    if (query.to) filters.push(`to=${formatTimestamp(query.to)}`);
    if (query.appName) filters.push(`app=${query.appName}`);
    if (query.hasUrl) filters.push('has_url=true');

    const lines = [
      ...formatStats(stats),
      filters.length > 0 ? `筛选条件：${filters.join('，')}。` : '筛选条件：无。',
      '',
      '时间线：',
      ...events.map((event) => `- ${formatEvent(event)}`),
    ];

    return {
      success: true,
      output: lines.join('\n'),
      result: { events, stats, query },
      metadata: {
        count: events.length,
      },
    };
  },
};

export const desktopActivitySearchTool: Tool = {
  name: 'desktop_activity_search',
  description: `Search locally collected desktop activity by keyword.

Use this when you need to find:
- A specific page, domain, or window title
- Activity related to a keyword or app
- Evidence of when a local activity happened

This searches native desktop events collected on the local machine.`,
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keyword to search across app name, window title, URL, and document path.',
      },
      since_minutes: {
        type: 'number',
        description: 'Look back this many minutes from now when from_ms is not provided.',
      },
      from_ms: {
        type: 'number',
        description: 'Inclusive start time in Unix milliseconds.',
      },
      to_ms: {
        type: 'number',
        description: 'Inclusive end time in Unix milliseconds.',
      },
      app_name: {
        type: 'string',
        description: 'Optional app name filter.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of matches to return. Default: 10.',
      },
    },
    required: ['query'],
  },
  tags: ['memory', 'search'],
  aliases: ['desktop search', 'activity search', 'search history', 'browser history'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const queryText = asString(params.query);
    if (!queryText) {
      return {
        success: false,
        error: 'query 参数不能为空。',
      };
    }

    const baseQuery = resolveTimelineQuery(params, 10);
    const query: DesktopSearchQuery = {
      ...baseQuery,
      query: queryText,
    };
    const matches = getService().search(query);

    if (matches.length === 0) {
      return buildEmptyOutput(`没有找到与 "${queryText}" 匹配的本地桌面活动记录。`);
    }

    const lines = [
      `找到 ${matches.length} 条与 "${queryText}" 匹配的本地桌面活动记录。`,
      '',
      '匹配结果：',
      ...matches.map((match) => `- [${match.score.toFixed(2)}] ${formatEvent(match.event)}`),
    ];

    return {
      success: true,
      output: lines.join('\n'),
      result: {
        query,
        matches,
      },
      metadata: {
        count: matches.length,
      },
    };
  },
};
