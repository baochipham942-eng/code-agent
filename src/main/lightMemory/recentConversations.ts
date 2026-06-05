// ============================================================================
// Recent Conversations Summary — Cross-session continuity layer
// Inspired by ChatGPT's Recent Conversations layer.
// Maintains ~15 recent conversation summaries in a markdown file.
// Only user messages are summarized (not assistant replies).
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureMemoryDir, getMemoryDir } from './indexLoader';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('RecentConversations');

const SUMMARY_FILE = 'recent-conversations.md';
const MAX_ENTRIES = 15;
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
}

function normalizeSummaryKey(summary: ConversationSummary): string {
  return `${summary.date}\u0000${summary.title.trim().replace(/\s+/g, ' ').toLowerCase()}`;
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
    // - **2026-03-15**: "Title" — highlight1, highlight2
    const match = line.match(/^- \*\*(.+?)\*\*: "(.+?)" — (.+)$/);
    if (match) {
      entries.push({
        date: match[1],
        title: match[2],
        highlights: match[3].split(', ').map(s => s.trim()),
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
  const lines = summaries.map(s =>
    `- **${s.date}**: "${s.title}" — ${s.highlights.join(', ')}`
  );
  return lines.join('\n');
}

/**
 * Append a new conversation summary. Keeps last MAX_ENTRIES entries.
 */
export async function appendConversationSummary(summary: ConversationSummary): Promise<void> {
  if (process.env.CODE_AGENT_DISABLE_RECENT_CONVERSATIONS === 'true') return;
  if (isLoopAutomationSummary(summary)) {
    logger.debug(`Skipping loop automation summary: "${summary.title}"`);
    return;
  }

  try {
    await ensureMemoryDir();
    let summaries = await loadSummaries();
    summaries = summaries.filter((item) => !isLoopAutomationSummary(item));

    const summaryKey = normalizeSummaryKey(summary);
    const existingIndex = summaries.findIndex((item) => normalizeSummaryKey(item) === summaryKey);
    if (existingIndex >= 0) {
      const existing = summaries[existingIndex];
      summaries.splice(existingIndex, 1);
      summaries.push({
        ...summary,
        highlights: mergeHighlights(existing.highlights, summary.highlights),
      });
    } else {
      summaries.push(summary);
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
export async function buildRecentConversationsBlock(): Promise<string | null> {
  if (process.env.CODE_AGENT_DISABLE_RECENT_CONVERSATIONS === 'true') return null;
  try {
    const summaries = (await loadSummaries()).filter((item) => !isLoopAutomationSummary(item));
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
