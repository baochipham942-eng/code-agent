// ============================================================================
// Light Memory IPC Service — Backend for the settings panel
// Lists, reads, and deletes memory files from ~/.code-agent/memory/
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { getMemoryDir, getMemoryIndexPath } from './indexLoader';
import type { MemoryEntryStatus } from '../../shared/contract/memory';
// Logger available for future use: createLogger('LightMemoryIPC')

export { getMemoryIndexPath };

export interface LightMemoryFile {
  filename: string;
  name: string;
  description: string;
  type: string;
  content: string;
  entryId?: string;
  status?: MemoryEntryStatus;
  source?: string;
  schemaVersion?: number;
  /** File modification time (ISO) */
  updatedAt: string;
}

export interface LightMemoryStats {
  totalFiles: number;
  byType: Record<string, number>;
  sessionStats: SessionStatsData | null;
  recentConversations: string[];
}

export interface LightMemoryHealthReport {
  totalFiles: number;
  indexExists: boolean;
  indexLineCount: number;
  indexTooLong: boolean;
  missingInIndex: string[];
  orphanInIndex: string[];
  invalidFrontmatter: Array<{ filename: string; reason: string }>;
  unreadableFiles: Array<{ filename: string; reason: string }>;
  duplicateNames: Array<{ value: string; filenames: string[] }>;
  duplicateDescriptions: Array<{ value: string; filenames: string[] }>;
}

export interface LightMemoryRebuildResult {
  indexPath: string;
  totalFiles: number;
  indexedFiles: number;
  skippedFiles: Array<{ filename: string; reason: string }>;
}

interface SessionStatsData {
  activeDays: string[];
  totalSessions: number;
  recentSessionDepths: number[];
  modelUsage: Record<string, number>;
}

interface ParsedFrontmatter {
  name: string;
  description: string;
  type: string;
  body: string;
  hasFrontmatter: boolean;
  metadata: Record<string, string>;
}

interface IndexEntry {
  filename: string;
  rawTarget: string;
}

function isLightMemoryMarkdownFile(filename: string): boolean {
  return filename.endsWith('.md') && filename !== 'INDEX.md' && filename !== 'recent-conversations.md';
}

/**
 * Parse frontmatter from a markdown memory file.
 */
function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { name: '', description: '', type: 'unknown', body: content, hasFrontmatter: false, metadata: {} };
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
    hasFrontmatter: true,
    metadata: meta,
  };
}

function parseMemoryEntryStatus(value: string | undefined): MemoryEntryStatus | undefined {
  if (
    value === 'candidate'
    || value === 'active'
    || value === 'rejected'
    || value === 'stale'
    || value === 'archived'
  ) {
    return value;
  }
  return undefined;
}

function parseSchemaVersion(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sanitizeFrontmatterValue(value: string | number | boolean): string {
  return String(value).replace(/\r?\n/g, ' ').replace(/:/g, ' -').trim();
}

function sanitizeLightMemoryFilename(filename: string): string {
  const basename = path.basename(filename.trim());
  const withoutExt = basename.endsWith('.md') ? basename.slice(0, -3) : basename;
  const safe = withoutExt
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return `${safe || `memory-${Date.now()}`}.md`;
}

function toLightMemoryFile(filename: string, content: string, updatedAt: Date): LightMemoryFile {
  const { name, description, type, body, metadata } = parseFrontmatter(content);
  return {
    filename,
    name: name || filename.replace('.md', ''),
    description,
    type,
    content: body,
    entryId: metadata.entry_id,
    status: parseMemoryEntryStatus(metadata.status),
    source: metadata.source,
    schemaVersion: parseSchemaVersion(metadata.schema_version),
    updatedAt: updatedAt.toISOString(),
  };
}

function frontmatterHealthIssue(parsed: ParsedFrontmatter): string | null {
  if (!parsed.hasFrontmatter) return 'missing frontmatter';
  if (!parsed.description.trim()) return 'missing description';
  return null;
}

function parseIndexEntries(content: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^- \[[^\]]+\]\(([^)]+)\) — .*$/);
    if (!match) continue;
    const rawTarget = match[1].trim();
    const filename = path.basename(rawTarget);
    entries.push({ filename, rawTarget });
  }
  return entries;
}

function duplicateGroups(values: Array<{ value: string; filename: string }>): Array<{ value: string; filenames: string[] }> {
  const groups = new Map<string, string[]>();
  for (const item of values) {
    const value = item.value.trim();
    if (!value) continue;
    const existing = groups.get(value) ?? [];
    existing.push(item.filename);
    groups.set(value, existing);
  }
  return Array.from(groups.entries())
    .filter(([, filenames]) => filenames.length > 1)
    .map(([value, filenames]) => ({ value, filenames: filenames.sort() }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      if (!isLightMemoryMarkdownFile(entry)) continue;

      const filePath = path.join(dir, entry);
      try {
        const [content, stat] = await Promise.all([
          fs.readFile(filePath, 'utf-8'),
          fs.stat(filePath),
        ]);
        files.push(toLightMemoryFile(entry, content, stat.mtime));
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
    return toLightMemoryFile(sanitized, content, stat.mtime);
  } catch {
    return null;
  }
}

export async function writeLightMemoryFile(input: {
  filename: string;
  name: string;
  description: string;
  type: string;
  content: string;
  entryId?: string;
  status?: MemoryEntryStatus;
  source?: string;
  schemaVersion?: number;
}): Promise<LightMemoryFile> {
  const dir = getMemoryDir();
  await fs.mkdir(dir, { recursive: true });

  const filename = sanitizeLightMemoryFilename(input.filename);
  const metadata: Array<[string, string | number | boolean | undefined]> = [
    ['name', input.name || filename.replace('.md', '')],
    ['description', input.description || input.name || filename.replace('.md', '')],
    ['type', input.type || 'reference'],
    ['entry_id', input.entryId],
    ['status', input.status],
    ['source', input.source],
    ['schema_version', input.schemaVersion],
  ];

  const frontmatter = metadata
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${sanitizeFrontmatterValue(value as string | number | boolean)}`)
    .join('\n');
  const body = input.content.trim();
  const fileContent = `---\n${frontmatter}\n---\n\n${body}\n`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, fileContent, 'utf-8');

  const written = await readMemoryFile(filename);
  if (!written) {
    throw new Error(`Failed to write Light Memory file: ${filename}`);
  }
  return written;
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

/**
 * Check source files against INDEX.md without throwing on partial failures.
 */
export async function getLightMemoryHealth(): Promise<LightMemoryHealthReport> {
  const dir = getMemoryDir();
  const indexPath = getMemoryIndexPath();
  const validFiles = new Set<string>();
  const allMemoryFiles: string[] = [];
  const invalidFrontmatter: LightMemoryHealthReport['invalidFrontmatter'] = [];
  const unreadableFiles: LightMemoryHealthReport['unreadableFiles'] = [];
  const names: Array<{ value: string; filename: string }> = [];
  const descriptions: Array<{ value: string; filename: string }> = [];

  try {
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      if (!isLightMemoryMarkdownFile(entry)) continue;
      allMemoryFiles.push(entry);
      try {
        const content = await fs.readFile(path.join(dir, entry), 'utf-8');
        const parsed = parseFrontmatter(content);
        const issue = frontmatterHealthIssue(parsed);
        if (issue) {
          invalidFrontmatter.push({ filename: entry, reason: issue });
          continue;
        }
        validFiles.add(entry);
        names.push({ value: parsed.name, filename: entry });
        descriptions.push({ value: parsed.description, filename: entry });
      } catch (error) {
        unreadableFiles.push({ filename: entry, reason: errorMessage(error) });
      }
    }
  } catch {
    // Missing memory dir is a healthy empty state.
  }

  let indexExists = false;
  let indexLineCount = 0;
  const indexFiles = new Set<string>();
  const orphanInIndex = new Set<string>();

  try {
    const indexContent = await fs.readFile(indexPath, 'utf-8');
    indexExists = true;
    indexLineCount = indexContent.split('\n').length;
    for (const entry of parseIndexEntries(indexContent)) {
      if (entry.rawTarget !== entry.filename || !entry.filename.endsWith('.md')) {
        orphanInIndex.add(entry.rawTarget);
        continue;
      }
      indexFiles.add(entry.filename);
      if (!validFiles.has(entry.filename)) {
        orphanInIndex.add(entry.filename);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      unreadableFiles.push({ filename: 'INDEX.md', reason: errorMessage(error) });
    }
  }

  const missingInIndex = Array.from(validFiles)
    .filter((filename) => !indexFiles.has(filename))
    .sort();

  return {
    totalFiles: allMemoryFiles.length,
    indexExists,
    indexLineCount,
    indexTooLong: indexLineCount > 200,
    missingInIndex,
    orphanInIndex: Array.from(orphanInIndex).sort(),
    invalidFrontmatter: invalidFrontmatter.sort((a, b) => a.filename.localeCompare(b.filename)),
    unreadableFiles: unreadableFiles.sort((a, b) => a.filename.localeCompare(b.filename)),
    duplicateNames: duplicateGroups(names),
    duplicateDescriptions: duplicateGroups(descriptions),
  };
}

/**
 * Rebuild INDEX.md from valid memory file frontmatter.
 */
export async function rebuildLightMemoryIndex(): Promise<LightMemoryRebuildResult> {
  const dir = getMemoryDir();
  await fs.mkdir(dir, { recursive: true });

  const skippedFiles: LightMemoryRebuildResult['skippedFiles'] = [];
  const indexEntries: Array<{ filename: string; description: string }> = [];
  let totalFiles = 0;

  const entries = await fs.readdir(dir);
  for (const entry of entries.sort()) {
    if (!isLightMemoryMarkdownFile(entry)) continue;
    totalFiles++;
    try {
      const content = await fs.readFile(path.join(dir, entry), 'utf-8');
      const parsed = parseFrontmatter(content);
      const issue = frontmatterHealthIssue(parsed);
      if (issue) {
        skippedFiles.push({ filename: entry, reason: issue });
        continue;
      }
      indexEntries.push({ filename: entry, description: parsed.description.trim() });
    } catch (error) {
      skippedFiles.push({ filename: entry, reason: errorMessage(error) });
    }
  }

  const indexPath = getMemoryIndexPath();
  const lines = [
    '# Memory Index',
    '',
    ...indexEntries.map((entry) => `- [${entry.filename}](${entry.filename}) — ${entry.description}`),
    '',
  ];
  await fs.writeFile(indexPath, lines.join('\n'), 'utf-8');

  return {
    indexPath,
    totalFiles,
    indexedFiles: indexEntries.length,
    skippedFiles,
  };
}
