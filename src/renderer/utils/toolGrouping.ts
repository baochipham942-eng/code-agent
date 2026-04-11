// ============================================================================
// Tool Grouping — 自动合并连续同类工具调用
// 3+ 连续 Read/Grep/Glob/ListDir → context_gathering "收集上下文 (N files)"
// 3+ 连续 Edit/Write → file_operations "文件操作 (N edits)"
// 其他保持 single
// ============================================================================

import type { ToolCall } from '@shared/types';
import { UI } from '@shared/constants';

export type ToolGroupType = 'context_gathering' | 'file_operations' | 'single';

export interface ToolGroup {
  type: ToolGroupType;
  toolCalls: ToolCall[];
  summary: string;
}

const CONTEXT_GATHERING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'list_directory', 'read_pdf']);
const FILE_OPERATION_TOOLS = new Set(['Edit', 'Write']);

function classifyTool(name: string): ToolGroupType | null {
  if (CONTEXT_GATHERING_TOOLS.has(name)) return 'context_gathering';
  if (FILE_OPERATION_TOOLS.has(name)) return 'file_operations';
  return null;
}

function buildSummary(type: ToolGroupType, toolCalls: ToolCall[]): string {
  const count = toolCalls.length;
  switch (type) {
    case 'context_gathering': {
      // Count unique file paths from arguments
      const files = new Set<string>();
      for (const tc of toolCalls) {
        const fp = (tc.arguments?.file_path as string)
          || (tc.arguments?.path as string)
          || (tc.arguments?.pattern as string);
        if (fp) files.add(fp);
      }
      const fileCount = files.size || count;
      return `收集上下文 (${fileCount} files)`;
    }
    case 'file_operations':
      return `文件操作 (${count} edits)`;
    default:
      return `${count} tool calls`;
  }
}

/**
 * Group an array of ToolCalls into smart groups.
 * Consecutive tools of the same category (3+) are merged.
 * Others stay as `single`.
 */
export function groupToolCalls(toolCalls: ToolCall[]): ToolGroup[] {
  if (!toolCalls || toolCalls.length === 0) return [];

  const threshold = UI.TOOL_GROUP_THRESHOLD;
  const groups: ToolGroup[] = [];

  let i = 0;
  while (i < toolCalls.length) {
    const category = classifyTool(toolCalls[i].name);

    if (category) {
      // Try to extend a run of the same category
      let j = i + 1;
      while (j < toolCalls.length && classifyTool(toolCalls[j].name) === category) {
        j++;
      }

      const runLength = j - i;
      if (runLength >= threshold) {
        const run = toolCalls.slice(i, j);
        groups.push({
          type: category,
          toolCalls: run,
          summary: buildSummary(category, run),
        });
        i = j;
        continue;
      }
    }

    // Single tool (or run too short to group)
    groups.push({
      type: 'single',
      toolCalls: [toolCalls[i]],
      summary: '',
    });
    i++;
  }

  return groups;
}

/**
 * Extract a thinking summary from reasoning/thinking text.
 * Looks for the first **bold** phrase or # heading.
 */
export function extractThinkingSummary(text: string | undefined): string | null {
  if (!text?.trim()) return null;

  // Try first **bold** text
  const boldMatch = text.match(/\*\*(.+?)\*\*/);
  if (boldMatch) {
    const summary = boldMatch[1].trim();
    if (summary.length > 0 && summary.length <= 80) return summary;
    if (summary.length > 80) return summary.slice(0, 77) + '...';
  }

  // Try first # heading
  const headingMatch = text.match(/^#{1,3}\s+(.+)$/m);
  if (headingMatch) {
    const summary = headingMatch[1].trim();
    if (summary.length > 0 && summary.length <= 80) return summary;
    if (summary.length > 80) return summary.slice(0, 77) + '...';
  }

  // Fallback: first non-empty line, truncated
  const firstLine = text.trim().split('\n')[0]?.trim();
  if (firstLine && firstLine.length > 0) {
    if (firstLine.length <= 60) return firstLine;
    return firstLine.slice(0, 57) + '...';
  }

  return null;
}
