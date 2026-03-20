// ============================================================================
// Workspace Activity Search Tool - Unified retrieval over desktop + office artifacts
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import {
  searchWorkspaceActivity,
  formatWorkspaceActivitySearchItem,
  type WorkspaceActivitySource,
} from '../../desktop/workspaceActivitySearchService';

const ALL_SOURCES: WorkspaceActivitySource[] = ['desktop', 'mail', 'calendar', 'reminders'];

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

export const workspaceActivitySearchTool: Tool = {
  name: 'workspace_activity_search',
  description: `Unified search over recent desktop summaries and local office artifacts.

Use this when you need one retrieval entry for:
- recent desktop activity summaries
- local mail subjects/senders
- nearby calendar events
- reminders

This is a thin read-only aggregator over desktop summaries plus a minimal indexed office-artifact layer.`,
  requiresPermission: true,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language query over recent desktop work and local office artifacts.',
      },
      since_hours: {
        type: 'number',
        description: 'How far back to search desktop summaries and recent office artifacts. Default: 24.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of unified results to return. Default: 8.',
      },
      refresh: {
        type: 'boolean',
        description: 'If true or omitted, refresh desktop summaries and recent indexed office artifacts before searching.',
      },
      sources: {
        type: 'array',
        items: {
          type: 'string',
          enum: ALL_SOURCES,
        },
        description: 'Optional source filter. Default: desktop, mail, calendar, reminders.',
      },
      account: {
        type: 'string',
        description: 'Optional mail account filter.',
      },
      mailboxes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional mailbox names to search. If omitted, the tool searches a small prioritized mailbox set.',
      },
      mailbox_limit: {
        type: 'number',
        description: 'Maximum number of mailboxes to scan when mailboxes are not explicitly provided. Default: 6.',
      },
      calendar: {
        type: 'string',
        description: 'Optional calendar name filter.',
      },
      reminder_list: {
        type: 'string',
        description: 'Optional reminders list filter.',
      },
      include_completed_reminders: {
        type: 'boolean',
        description: 'Whether to include completed reminders in reminder matching.',
      },
    },
    required: ['query'],
  },
  tags: ['memory', 'search', 'planning'],
  aliases: ['workspace search', 'activity search', 'search recent work', 'unified activity search'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const query = asString(params.query);
    if (!query) {
      return {
        success: false,
        error: 'query 参数不能为空。',
      };
    }

    const sources = asStringArray(params.sources)
      .map((item) => item.toLowerCase())
      .filter((item): item is WorkspaceActivitySource => ALL_SOURCES.includes(item as WorkspaceActivitySource));

    const result = await searchWorkspaceActivity(query, {
      sinceHours: asNumber(params.since_hours),
      limit: asNumber(params.limit),
      refreshDesktop: asBoolean(params.refresh),
      refreshArtifacts: asBoolean(params.refresh),
      sources,
      account: asString(params.account),
      mailboxes: asStringArray(params.mailboxes),
      mailboxLimit: asNumber(params.mailbox_limit),
      calendar: asString(params.calendar),
      reminderList: asString(params.reminder_list),
      includeCompletedReminders: asBoolean(params.include_completed_reminders),
    });

    if (result.items.length === 0) {
      const warningText = result.warnings.length > 0
        ? `\n\n部分来源读取失败：\n- ${result.warnings.join('\n- ')}`
        : '';
      return {
        success: true,
        output: `没有找到与 "${query}" 相关的桌面活动或本地办公产物。${warningText}`,
        result,
        metadata: {
          count: 0,
          warnings: result.warnings,
          countsBySource: result.countsBySource,
        },
      };
    }

    const lines = [
      `工作区活动检索 "${query}" 返回 ${result.items.length} 条结果：`,
      '',
      ...result.items.map((item, index) => formatWorkspaceActivitySearchItem(item, index)),
    ];

    if (result.warnings.length > 0) {
      lines.push('', '部分来源读取失败：', ...result.warnings.map((warning) => `- ${warning}`));
    }

    return {
      success: true,
      output: lines.join('\n'),
      result,
      metadata: {
        count: result.items.length,
        warnings: result.warnings,
        countsBySource: result.countsBySource,
      },
    };
  },
};
