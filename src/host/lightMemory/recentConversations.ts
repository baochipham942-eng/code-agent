// ============================================================================
// Recent Conversations Summary — Cross-session continuity layer
// Inspired by ChatGPT's Recent Conversations layer.
// Maintains ~15 recent conversation summaries in a markdown file.
// Only user messages are summarized (not assistant replies).
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { UNSORTED_PROJECT_ID } from '../../shared/contract/project';
import { ensureMemoryDir, getMemoryDir } from './indexLoader';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('RecentConversations');

const SUMMARY_FILE = 'recent-conversations.md';
const MAX_ENTRIES = 15;
const RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const LOOP_AUTOMATION_SUMMARY_PATTERN = /(?:【循环模式\s*·\s*第\s*\d+\s*轮】|\[\[LOOP_WAIT\]\]|--max-turns|只回复一句|连续跑[一二两三四五六七八九十\d]+轮)/i;

function getSummaryPath(): string {
  return path.join(getMemoryDir(), SUMMARY_FILE);
}

export interface ConversationSummary {
  /** ISO date string */
  date: string;
  /** Short title/topic */
  title: string;
  /** Key user intents/requests (1-3 bullet points) */
  highlights: string[];
  /** Stable product Project.id from sessions.project_id. Missing means global/legacy. */
  projectId?: string;
}

function normalizeProjectId(projectId: string | null | undefined): string | undefined {
  const normalized = projectId?.trim();
  if (!normalized || normalized === UNSORTED_PROJECT_ID) return undefined;
  return normalized;
}

function normalizeSummaryKey(summary: ConversationSummary): string {
  return `${normalizeProjectId(summary.projectId) ?? ''}\u0000${summary.date}\u0000${summary.title.trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

function mergeHighlights(existing: string[], next: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of [...existing, ...next]) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
    if (merged.length >= 3) break;
  }
  return merged;
}

export function isLoopAutomationSummaryText(text: string | undefined): boolean {
  return Boolean(text && LOOP_AUTOMATION_SUMMARY_PATTERN.test(text));
}

function isLoopAutomationSummary(summary: ConversationSummary): boolean {
  return isLoopAutomationSummaryText(summary.title)
    || summary.highlights.some((highlight) => isLoopAutomationSummaryText(highlight));
}

/**
 * Load existing conversation summaries.
 */
async function loadSummaries(): Promise<ConversationSummary[]> {
  try {
    const content = await fs.readFile(getSummaryPath(), 'utf-8');
    return parseSummaries(content);
  } catch {
    return [];
  }
}

/**
 * Parse markdown summaries back into structured data.
 * Format:
 * - **Dec 8**: "Building a load balancer" — connection pooling, Go concurrency
 */
function parseSummaries(content: string): ConversationSummary[] {
  const entries: ConversationSummary[] = [];
  const lines = content.split('\n').filter(l => l.startsWith('- **'));

  for (const line of lines) {
    // New:    - **2026-03-15** [project:proj_abc]: "Title" — highlight1, highlight2
    // Legacy: - **2026-03-15**: "Title" — highlight1, highlight2
    const match = line.match(/^- \*\*(.+?)\*\*(?: \[project:([^\]]+)\])?: "(.+?)" — (.*)$/);
    if (match) {
      entries.push({
        date: match[1],
        ...(normalizeProjectId(match[2]) ? { projectId: normalizeProjectId(match[2]) } : {}),
        title: match[3],
        highlights: match[4] ? match[4].split(', ').map(s => s.trim()) : [],
      });
    }
  }
  return entries;
}

/**
 * Format summaries to markdown for storage and prompt injection.
 */
function formatSummaries(summaries: ConversationSummary[]): string {
  if (summaries.length === 0) return '';
  const lines = summaries.map((summary) => {
    const projectId = normalizeProjectId(summary.projectId);
    const projectTag = projectId ? ` [project:${projectId}]` : '';
    return `- **${summary.date}**${projectTag}: "${summary.title}" — ${summary.highlights.join(', ')}`;
  });
  return lines.join('\n');
}

function isWithinRecentWindow(summary: ConversationSummary, now: Date): boolean {
  // Summary dates are calendar dates. Treat the whole recorded day as eligible so an
  // entry does not expire midway through its fourteenth day.
  const endOfSummaryDay = Date.parse(`${summary.date}T23:59:59.999Z`);
  if (!Number.isFinite(endOfSummaryDay)) return false;
  const nowMs = now.getTime();
  return endOfSummaryDay >= nowMs - RECENT_WINDOW_MS
    && summary.date <= now.toISOString().slice(0, 10);
}

/**
 * Append a new conversation summary. Keeps last MAX_ENTRIES entries.
 */
export async function appendConversationSummary(
  summary: ConversationSummary,
  options: { enabled?: boolean } = {},
): Promise<void> {
  if (options.enabled === false) return;
  if (isLoopAutomationSummary(summary)) {
    logger.debug(`Skipping loop automation summary: "${summary.title}"`);
    return;
  }

  try {
    await ensureMemoryDir();
    let summaries = await loadSummaries();
    summaries = summaries.filter((item) => !isLoopAutomationSummary(item));

    const normalizedSummary: ConversationSummary = { ...summary };
    const normalizedProjectId = normalizeProjectId(summary.projectId);
    if (normalizedProjectId) normalizedSummary.projectId = normalizedProjectId;
    else delete normalizedSummary.projectId;
    const summaryKey = normalizeSummaryKey(normalizedSummary);
    const existingIndex = summaries.findIndex((item) => normalizeSummaryKey(item) === summaryKey);
    if (existingIndex >= 0) {
      const existing = summaries[existingIndex];
      summaries.splice(existingIndex, 1);
      summaries.push({
        ...normalizedSummary,
        highlights: mergeHighlights(existing.highlights, normalizedSummary.highlights),
      });
    } else {
      summaries.push(normalizedSummary);
    }

    // Keep only the last MAX_ENTRIES
    if (summaries.length > MAX_ENTRIES) {
      summaries = summaries.slice(-MAX_ENTRIES);
    }

    const content = `# Recent Conversations\n\n${formatSummaries(summaries)}\n`;
    await fs.writeFile(getSummaryPath(), content, 'utf-8');

    logger.info(`Conversation summary saved: "${summary.title}" (${summaries.length} total)`);
  } catch (err) {
    logger.error('Failed to append conversation summary:', err);
  }
}

/**
 * Build recent conversations block for system prompt injection.
 * Returns null if no summaries exist.
 */
export async function buildRecentConversationsBlock(options: {
  projectId?: string | null;
  now?: Date;
  enabled?: boolean;
} = {}): Promise<string | null> {
  if (options.enabled === false) return null;
  try {
    const recentSummaries = (await loadSummaries())
      .filter((item) => !isLoopAutomationSummary(item))
      .filter((item) => isWithinRecentWindow(item, options.now ?? new Date()));
    const projectId = normalizeProjectId(options.projectId);
    const projectSummaries = projectId
      ? recentSummaries.filter((item) => normalizeProjectId(item.projectId) === projectId)
      : recentSummaries;
    // A project sees only its own recent work. If it has none, legacy/unscoped
    // entries are the safe global fallback; another project's entries never leak in.
    const summaries = projectId && projectSummaries.length === 0
      ? recentSummaries.filter((item) => !normalizeProjectId(item.projectId))
      : projectSummaries;
    if (summaries.length === 0) return null;

    const formatted = formatSummaries(summaries);
    return `<recent_conversations>
Recent user topics (last ${summaries.length} sessions, only user intent summarized):

${formatted}
</recent_conversations>`;
  } catch (err) {
    logger.error('Failed to build recent conversations block:', err);
    return null;
  }
}
