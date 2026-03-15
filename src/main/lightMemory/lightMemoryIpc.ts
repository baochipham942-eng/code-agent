// ============================================================================
// Light Memory IPC Service — Backend for the settings panel
// Lists, reads, and deletes memory files from ~/.code-agent/memory/
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { getMemoryDir, getMemoryIndexPath } from './indexLoader';
// Logger available for future use: createLogger('LightMemoryIPC')

export interface LightMemoryFile {
  filename: string;
  name: string;
  description: string;
  type: string;
  content: string;
  /** File modification time (ISO) */
  updatedAt: string;
}

export interface LightMemoryStats {
  totalFiles: number;
  byType: Record<string, number>;
  sessionStats: SessionStatsData | null;
  recentConversations: string[];
}

interface SessionStatsData {
  activeDays: string[];
  totalSessions: number;
  recentSessionDepths: number[];
  modelUsage: Record<string, number>;
}

/**
 * Parse frontmatter from a markdown memory file.
 */
function parseFrontmatter(content: string): { name: string; description: string; type: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { name: '', description: '', type: 'unknown', body: content };
  }

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      meta[key] = val;
    }
  }

  return {
    name: meta.name || '',
    description: meta.description || '',
    type: meta.type || 'unknown',
    body: match[2].trim(),
  };
}

/**
 * List all memory files with parsed frontmatter.
 */
export async function listMemoryFiles(): Promise<LightMemoryFile[]> {
  const dir = getMemoryDir();
  const files: LightMemoryFile[] = [];

  try {
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.md') || entry === 'INDEX.md') continue;

      const filePath = path.join(dir, entry);
      try {
        const [content, stat] = await Promise.all([
          fs.readFile(filePath, 'utf-8'),
          fs.stat(filePath),
        ]);
        const { name, description, type, body } = parseFrontmatter(content);
        files.push({
          filename: entry,
          name: name || entry.replace('.md', ''),
          description,
          type,
          content: body,
          updatedAt: stat.mtime.toISOString(),
        });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Memory dir doesn't exist yet
  }

  // Sort by modification time (newest first)
  files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return files;
}

/**
 * Read a single memory file.
 */
export async function readMemoryFile(filename: string): Promise<LightMemoryFile | null> {
  const sanitized = path.basename(filename);
  const filePath = path.join(getMemoryDir(), sanitized);

  try {
    const [content, stat] = await Promise.all([
      fs.readFile(filePath, 'utf-8'),
      fs.stat(filePath),
    ]);
    const { name, description, type, body } = parseFrontmatter(content);
    return {
      filename: sanitized,
      name: name || sanitized.replace('.md', ''),
      description,
      type,
      content: body,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Delete a memory file and remove from INDEX.md.
 */
export async function deleteMemoryFile(filename: string): Promise<boolean> {
  const sanitized = path.basename(filename);
  const filePath = path.join(getMemoryDir(), sanitized);

  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }

  // Remove from INDEX.md
  try {
    const indexPath = getMemoryIndexPath();
    const existing = await fs.readFile(indexPath, 'utf-8');
    const pattern = new RegExp(`^- \\[${sanitized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\].*$`, 'gm');
    const updated = existing.replace(pattern, '').replace(/\n{3,}/g, '\n\n');
    await fs.writeFile(indexPath, updated, 'utf-8');
  } catch {
    // INDEX.md might not exist
  }

  return true;
}

/**
 * Get comprehensive Light Memory stats for the panel.
 */
export async function getLightMemoryStats(): Promise<LightMemoryStats> {
  const files = await listMemoryFiles();

  const byType: Record<string, number> = {};
  for (const f of files) {
    byType[f.type] = (byType[f.type] || 0) + 1;
  }

  // Load session stats
  let sessionStats: SessionStatsData | null = null;
  try {
    const raw = await fs.readFile(path.join(getMemoryDir(), 'session-stats.json'), 'utf-8');
    sessionStats = JSON.parse(raw);
  } catch {
    // No stats yet
  }

  // Load recent conversations
  const recentConversations: string[] = [];
  try {
    const content = await fs.readFile(path.join(getMemoryDir(), 'recent-conversations.md'), 'utf-8');
    const lines = content.split('\n').filter(l => l.startsWith('- **'));
    recentConversations.push(...lines);
  } catch {
    // No conversations yet
  }

  return {
    totalFiles: files.length,
    byType,
    sessionStats,
    recentConversations,
  };
}
