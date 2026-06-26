// ============================================================================
// Light Memory — Index Loader
// Reads ~/.code-agent/memory/INDEX.md at session start for system prompt injection.
// Part of the File-as-Memory architecture (replacing 13K+ line vector/embedding system).
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { getUserConfigDir } from '../config/configPaths';
import { createLogger } from '../services/infra/logger';
import { LIGHT_MEMORY } from '../../shared/constants';

const logger = createLogger('LightMemory');

/** Memory directory path: ~/.code-agent/memory/ */
export function getMemoryDir(): string {
  return path.join(getUserConfigDir(), 'memory');
}

/** INDEX.md path */
export function getMemoryIndexPath(): string {
  return path.join(getMemoryDir(), 'INDEX.md');
}

/**
 * Load INDEX.md content for system prompt injection.
 * Returns null if file doesn't exist (first run).
 * Truncates to INDEX_MAX_LINES to keep token cost low (~500 tokens).
 * Note: over-budget INDEX is now auto-compressed by the consolidation cron job;
 * this load-time truncation is only a last-resort guard between runs.
 */
export async function loadMemoryIndex(): Promise<string | null> {
  const indexPath = getMemoryIndexPath();
  try {
    const content = await fs.readFile(indexPath, 'utf-8');
    if (!content.trim()) return null;

    // Truncate to keep system prompt lean
    const lines = content.split('\n');
    if (lines.length > LIGHT_MEMORY.INDEX_MAX_LINES) {
      logger.warn(`INDEX.md has ${lines.length} lines, truncating to ${LIGHT_MEMORY.INDEX_MAX_LINES}`);
      return lines.slice(0, LIGHT_MEMORY.INDEX_MAX_LINES).join('\n')
        + '\n\n<!-- Truncated: INDEX.md exceeds budget; consolidation will compress on next run. -->';
    }

    return content.trim();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // First run — no memory yet, that's fine
      return null;
    }
    logger.error('Failed to load memory index:', err);
    return null;
  }
}

/**
 * Ensure memory directory exists.
 */
export async function ensureMemoryDir(): Promise<string> {
  const dir = getMemoryDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
