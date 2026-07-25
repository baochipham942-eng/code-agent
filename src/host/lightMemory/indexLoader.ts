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
 * ⚠️ 现实：consolidation cron 目前是 dry-run（MEMORY_CONSOLIDATION.DRY_RUN_DEFAULT=true，
 * 复查 2026-08-25），从不落盘压缩——本截断不是「兜底」，而是超预算 INDEX 的唯一真实
 * 处置：尾部每个会话都会被静默省略。因此截断标记必须对模型可见并带省略行数，
 * 让它在记忆相关回答里能向用户说明缺口（2026-07-25 费曼审计 P1-3）。
 */
export async function loadMemoryIndex(): Promise<string | null> {
  const indexPath = getMemoryIndexPath();
  try {
    const content = await fs.readFile(indexPath, 'utf-8');
    if (!content.trim()) return null;

    // Truncate to keep system prompt lean
    const lines = content.split('\n');
    if (lines.length > LIGHT_MEMORY.INDEX_MAX_LINES) {
      const omitted = lines.length - LIGHT_MEMORY.INDEX_MAX_LINES;
      logger.warn(`INDEX.md has ${lines.length} lines, truncating to ${LIGHT_MEMORY.INDEX_MAX_LINES} (${omitted} lines omitted this session)`);
      return lines.slice(0, LIGHT_MEMORY.INDEX_MAX_LINES).join('\n')
        + `\n\n[记忆索引超出预算：本次省略了尾部 ${omitted} 行。若用户问到较旧的记忆，请说明索引被截断，并建议整理 INDEX.md。]`;
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
