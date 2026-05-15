// ============================================================================
// Tool Grouping — 自动合并连续同类工具调用
// 3+ 连续 Read/Grep/Glob/ListDir → context_gathering "收集上下文 (N files)"
// 3+ 连续 Edit/Write → file_operations "文件操作 (N edits)"
// 其他保持 single
// ============================================================================

import type { ToolCall } from '@shared/contract';
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

export function sanitizeThinkingForDisplay(text: string | undefined): string | undefined {
  if (!text?.trim()) return undefined;

  const compactedLines: string[] = [];
  let previousWasBlank = false;

  const normalizeLine = (line: string): string => (
    line
      .toLowerCase()
      .replace(/[.,;:!?，。；：！？]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[runtime]')) continue;

    if (!line) {
      previousWasBlank = true;
      continue;
    }

    const normalized = normalizeLine(line);
    const previousIndex = compactedLines.length - 1;
    const previousLine = previousIndex >= 0 ? compactedLines[previousIndex] : '';
    const previousNormalized = normalizeLine(previousLine);

    if (previousNormalized && normalized === previousNormalized) {
      previousWasBlank = false;
      continue;
    }
    if (previousNormalized && normalized.startsWith(`${previousNormalized} `)) {
      compactedLines[previousIndex] = line;
      previousWasBlank = false;
      continue;
    }
    if (previousNormalized && previousNormalized.startsWith(`${normalized} `)) {
      previousWasBlank = false;
      continue;
    }

    if (previousWasBlank && compactedLines.length > 0) {
      compactedLines.push('');
    }
    compactedLines.push(line);
    previousWasBlank = false;
  }

  const displayText = compactedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return displayText || undefined;
}

/**
 * Extract a thinking summary from reasoning/thinking text.
 * Looks for the first **bold** phrase or # heading.
 */
export function extractThinkingSummary(text: string | undefined): string | null {
  const displayText = sanitizeThinkingForDisplay(text);
  if (!displayText?.trim()) return null;

  // Try first **bold** text
  const boldMatch = displayText.match(/\*\*(.+?)\*\*/);
  if (boldMatch) {
    const summary = boldMatch[1].trim();
    if (summary.length > 0 && summary.length <= 80) return summary;
    if (summary.length > 80) return summary.slice(0, 77) + '...';
  }

  // Try first # heading
  const headingMatch = displayText.match(/^#{1,3}\s+(.+)$/m);
  if (headingMatch) {
    const summary = headingMatch[1].trim();
    if (summary.length > 0 && summary.length <= 80) return summary;
    if (summary.length > 80) return summary.slice(0, 77) + '...';
  }

  // Fallback: first non-empty line, truncated
  const firstLine = displayText.trim().split('\n')[0]?.trim();
  if (firstLine && firstLine.length > 0) {
    if (firstLine.length <= 60) return firstLine;
    return firstLine.slice(0, 57) + '...';
  }

  return null;
}

const PROGRESS_KEYWORDS = [
  '找到了',
  '发现',
  '定位',
  '问题所在',
  '加载成功',
  '验证通过',
  '修复',
  '启动',
  '初始化',
  '准备',
  '正在',
  '完成',
  '失败',
  '下一步',
  '现在',
  '问一下',
];

const LOW_SIGNAL_PROGRESS_PATTERNS = [
  /^用户(?:让|要|想|说|问)/,
  /^the user\b/i,
  /^i need\b/i,
  /^i should\b/i,
  /^let me\b/i,
  /^我需要/,
  /^我应该/,
  /^其实/,
  /^不过按照/,
  /本质是/,
  /可能只是/,
];

function normalizeProgressSummary(line: string): string {
  return line
    .replace(/^[-*]\s+/, '')
    .replace(/^好[，,]\s*/, '')
    .replace(/^现在(?:来)?/, '现在')
    .replace(/让我先/g, '先')
    .replace(/让我/g, '')
    .replace(/我先/g, '先')
    .replace(/我需要/g, '需要')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[：:]\s*$/, '');
}

function scoreProgressLine(line: string): number {
  let score = 0;
  const normalized = line.toLowerCase();

  for (const keyword of PROGRESS_KEYWORDS) {
    if (line.includes(keyword)) score += 1;
  }

  if (/^(找到了|发现|定位|已|正在|准备|先|现在|团队初始化|内容团队)/.test(line)) {
    score += 2;
  }

  if (/[。！？.!?]$/.test(line)) score += 1;

  for (const pattern of LOW_SIGNAL_PROGRESS_PATTERNS) {
    if (pattern.test(normalized) || pattern.test(line)) score -= 3;
  }

  if (line.length > 180) score -= 1;
  return score;
}

/**
 * Extract a small user-visible progress sentence from reasoning text.
 *
 * Some providers put high-level "I found/fixed/started X" status prose in the
 * reasoning stream even when the actual assistant content is empty before a
 * tool call. This helper only promotes concise, action/result-oriented lines;
 * broader internal deliberation stays inside the collapsed thinking block.
 */
export function extractAssistantProgressSummary(text: string | undefined): string | null {
  const displayText = sanitizeThinkingForDisplay(text);
  if (!displayText?.trim()) return null;

  const candidates = displayText
    .split(/\n+/)
    .map((line) => normalizeProgressSummary(line.trim()))
    .filter((line) => line.length >= 6 && line.length <= 220)
    .map((line) => ({ line, score: scoreProgressLine(line) }))
    .filter((candidate) => candidate.score >= 3)
    .sort((a, b) => b.score - a.score);

  const selected = candidates[0]?.line;
  if (!selected) return null;
  return selected.length <= 120 ? selected : `${selected.slice(0, 117)}...`;
}

function normalizeProgressForComparison(value: string): string {
  return normalizeProgressSummary(value)
    .replace(/\.\.\.$/, '')
    .replace(/[.,;:!?，。；：！？]+/g, '')
    .toLowerCase()
    .trim();
}

export function removePromotedAssistantProgressFromThinking(
  text: string | undefined,
  progressSummary: string | null | undefined,
): string | undefined {
  const displayText = sanitizeThinkingForDisplay(text);
  if (!displayText?.trim() || !progressSummary?.trim()) return displayText;

  const progressKey = normalizeProgressForComparison(progressSummary);
  if (progressKey.length < 6) return displayText;

  const lines = displayText.split('\n');
  const filteredLines = lines.filter((line) => {
    const lineKey = normalizeProgressForComparison(line);
    if (!lineKey) return true;
    return lineKey !== progressKey
      && !lineKey.startsWith(progressKey)
      && !progressKey.startsWith(lineKey);
  });

  const filtered = filteredLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return filtered || undefined;
}
