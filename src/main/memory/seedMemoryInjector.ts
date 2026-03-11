// ============================================================================
// Seed Memory Injector - 会话启动时注入种子记忆
// ============================================================================
// At session start, loads a small "memory index" from the database
// (top N recent memories, ~200 tokens max) and formats it as a concise
// system prompt block for injection before the first model call.
// ============================================================================

import { getDatabase, type MemoryRecord } from '../services';
import { createLogger } from '../services/infra/logger';
import { sanitizeMemoryContent } from './sanitizeMemoryContent';

const logger = createLogger('SeedMemoryInjector');

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/** Maximum number of memories to query */
const MAX_SEED_MEMORIES = 10;

/** Maximum total tokens for the seed memory block (~200 tokens ≈ ~800 chars) */
const MAX_SEED_TOKENS = 200;

/** Approximate chars per token for English/mixed content */
const CHARS_PER_TOKEN = 4;

/** Maximum characters for the entire block */
const MAX_SEED_CHARS = MAX_SEED_TOKENS * CHARS_PER_TOKEN;

/** Maximum characters per individual memory entry */
const MAX_ENTRY_CHARS = 120;

// ----------------------------------------------------------------------------
// Category display labels
// ----------------------------------------------------------------------------

const CATEGORY_LABELS: Record<string, string> = {
  preference: 'Preference',
  pattern: 'Pattern',
  decision: 'Decision',
  context: 'Context',
  insight: 'Insight',
  error_solution: 'Solution',
  user_preference: 'Preference',
  code_pattern: 'Pattern',
  project_knowledge: 'Knowledge',
  conversation: 'Context',
  tool_usage: 'Tool',
};

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * Load recent memories from the database and format them as a concise
 * text block suitable for system prompt injection.
 *
 * Returns null if no memories exist or on any error.
 * Designed to be lightweight and non-blocking for the agent loop.
 */
export function buildSeedMemoryBlock(projectPath?: string): string | null {
  try {
    const db = getDatabase();
    if (!db || !db.isReady) {
      return null;
    }

    // Query recent memories, preferring high-confidence ones
    const memories = db.listMemories({
      projectPath,
      limit: MAX_SEED_MEMORIES,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    });

    if (!memories || memories.length === 0) {
      logger.debug('[SeedMemory] No memories found, skipping injection');
      return null;
    }

    // Sort: high confidence first, then by recency (already sorted by updated_at DESC)
    const sorted = [...memories].sort((a, b) => {
      // Primary: confidence DESC
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      // Secondary: updatedAt DESC (already the query order)
      return b.updatedAt - a.updatedAt;
    });

    // Build entries, respecting token budget
    const entries: string[] = [];
    let totalChars = 0;
    const headerChars = '## Stored Memories\n'.length;
    totalChars += headerChars;

    for (const mem of sorted) {
      const entry = formatMemoryEntry(mem);
      const entryChars = entry.length + 1; // +1 for newline

      if (totalChars + entryChars > MAX_SEED_CHARS) {
        break;
      }

      entries.push(entry);
      totalChars += entryChars;
    }

    if (entries.length === 0) {
      return null;
    }

    const block = `## Stored Memories\n${entries.join('\n')}`;
    logger.info(`[SeedMemory] Injecting ${entries.length} seed memories (~${Math.ceil(totalChars / CHARS_PER_TOKEN)} tokens)`);

    return block;
  } catch (error) {
    // Memory failures must never block the agent loop
    logger.warn('[SeedMemory] Failed to build seed memory block, skipping', { error: String(error) });
    return null;
  }
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

/**
 * Format a single memory record as a concise bullet point.
 * E.g.: "- [Preference]: User prefers TypeScript with strict mode"
 */
function formatMemoryEntry(mem: MemoryRecord): string {
  const label = CATEGORY_LABELS[mem.category] || CATEGORY_LABELS[mem.type] || 'Memory';

  // Use summary if available, otherwise truncate content
  let text = sanitizeMemoryContent(mem.summary || mem.content);

  // Clean up: single line, trim whitespace
  text = text.replace(/\n+/g, ' ').trim();

  // Truncation is handled by sanitizeMemoryContent()

  return `- [${label}]: ${text}`;
}
