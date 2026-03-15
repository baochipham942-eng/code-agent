// ============================================================================
// Light Memory — Index Loader
// Reads ~/.code-agent/memory/INDEX.md at session start for system prompt injection.
// Part of the File-as-Memory architecture (replacing 13K+ line vector/embedding system).
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { getUserConfigDir } from '../config/configPaths';
import { createLogger } from '../services/infra/logger';

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
 * Truncates to ~200 lines to keep token cost low (~500 tokens).
 */
export async function loadMemoryIndex(): Promise<string | null> {
  const indexPath = getMemoryIndexPath();
  try {
    const content = await fs.readFile(indexPath, 'utf-8');
    if (!content.trim()) return null;

    // Truncate to 200 lines to keep system prompt lean
    const lines = content.split('\n');
    if (lines.length > 200) {
      logger.warn(`INDEX.md has ${lines.length} lines, truncating to 200`);
      return lines.slice(0, 200).join('\n') + '\n\n<!-- Truncated: INDEX.md exceeds 200 lines. Please consolidate. -->';
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
