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

function indexTarget(line: string): string | null {
  const match = line.match(/^- \[[^\]]+\]\(([^)]+)\) — .*$/);
  if (!match) return null;
  const target = match[1].trim();
  return path.basename(target) === target && target.endsWith('.md') ? target : null;
}

async function filterArchivedIndexEntries(content: string): Promise<string> {
  const dir = getMemoryDir();
  const lines = content.split('\n');
  const kept = await Promise.all(lines.map(async (line) => {
    const target = indexTarget(line);
    if (!target) return line;
    try {
      const source = await fs.readFile(path.join(dir, target), 'utf-8');
      return /^status:\s*archived\s*$/m.test(source) ? null : line;
    } catch {
      // Health diagnostics owns missing/orphan reporting. Keep legacy INDEX
      // behavior here and only suppress archives we can positively identify.
      return line;
    }
  }));
  return kept.filter((line): line is string => line !== null).join('\n');
}

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
 * 截断仍是同步读取时的最后护栏；consolidation 周期任务会用软归档 + 指针更新
 * 收敛超预算 INDEX。截断标记必须对模型可见并带省略行数，避免把尾部省略伪装成完整召回。
 */
export async function loadMemoryIndex(): Promise<string | null> {
  const indexPath = getMemoryIndexPath();
  try {
    const rawContent = await fs.readFile(indexPath, 'utf-8');
    const content = await filterArchivedIndexEntries(rawContent);
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
