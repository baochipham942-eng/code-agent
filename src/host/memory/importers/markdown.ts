import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { load as loadYaml } from 'js-yaml';
import type { MemoryEntryKind } from '../../../shared/contract/memory';

export interface ParsedImportMarkdown {
  title: string;
  description: string;
  body: string;
  metadata: Record<string, unknown>;
  kind: MemoryEntryKind;
  hasExplicitKind: boolean;
  archived: boolean;
}

const VALID_KINDS = new Set<MemoryEntryKind>([
  'directive',
  'user',
  'feedback',
  'project',
  'reference',
  'session',
  'pattern',
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3).trimEnd()}...`;
}

export function contentHash(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function parseImportMarkdown(raw: string, fallbackTitle: string): ParsedImportMarkdown {
  let metadata: Record<string, unknown> = {};
  let body = raw.trim();
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (match) {
    try {
      metadata = record(loadYaml(match[1]));
    } catch {
      metadata = { _frontmatterParseError: true, _rawFrontmatter: match[1] };
    }
    body = match[2].trim();
  }

  const explicitType = typeof metadata.type === 'string' ? metadata.type.trim() : '';
  const hasExplicitKind = VALID_KINDS.has(explicitType as MemoryEntryKind);
  const kind = hasExplicitKind ? explicitType as MemoryEntryKind : 'reference';
  const heading = body.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
  const title = compact(
    typeof metadata.name === 'string' ? metadata.name : heading || fallbackTitle,
    120,
  ) || fallbackTitle;
  const description = compact(
    typeof metadata.description === 'string' ? metadata.description : body,
    180,
  );
  const status = typeof metadata.status === 'string' ? metadata.status.toLowerCase() : '';
  const archived = status === 'archived'
    || Boolean(metadata.deprecated_by || metadata.deprecatedBy)
    || /^(?:#{1,3}\s*)?(?:已作废|已归档|被.+推翻|deprecated\b|archived\b|superseded\b)/i.test(body);

  return { title, description, body, metadata, kind, hasExplicitKind, archived };
}

export async function readMarkdownFile(filePath: string): Promise<{
  raw: string;
  mtimeMs: number;
} | null> {
  try {
    const [raw, stat] = await Promise.all([
      fs.readFile(filePath, 'utf8'),
      fs.stat(filePath),
    ]);
    return stat.isFile() ? { raw, mtimeMs: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

export async function directoryExists(root: string): Promise<boolean> {
  try {
    return (await fs.stat(root)).isDirectory();
  } catch {
    return false;
  }
}

export async function listMarkdownFiles(root: string, recursive = false): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(absolute);
      if (recursive && entry.isDirectory() && !entry.isSymbolicLink()) await walk(absolute);
    }
  }
  await walk(root);
  return files.sort();
}

export function splitMarkdownSections(raw: string, fallbackTitle: string): Array<{ title: string; content: string }> {
  const lines = raw.split(/\r?\n/);
  const sections: Array<{ title: string; content: string }> = [];
  let title = fallbackTitle;
  let body: string[] = [];
  const flush = () => {
    const content = body.join('\n').trim();
    if (content) sections.push({ title, content });
  };
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flush();
      title = heading[1].trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}
