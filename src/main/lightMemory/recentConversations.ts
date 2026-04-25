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
  try {
    await ensureMemoryDir();
    let summaries = await loadSummaries();

    summaries.push(summary);

    // Keep only the last MAX_ENTRIES
    if (summaries.length > MAX_ENTRIES) {
      summaries = summaries.slice(-MAX_ENTRIES);
    }

    const content = `# Recent Conversations\n\n${formatSummaries(summaries)}\n`;
    await fs.writeFile(getSummaryPath(), content, 'utf-8');

    logger.info(`Conversation summary appended: "${summary.title}" (${summaries.length} total)`);
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
    const summaries = await loadSummaries();
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
