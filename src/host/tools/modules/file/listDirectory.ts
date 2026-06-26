// ============================================================================
// ListDirectory (P0-5 Migrated to ToolModule)
//
// 旧版: src/main/tools/file/listDirectory.ts (registered as 'ListDirectory')
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 不 import services/infra/logger，走 ctx.logger
// - 不 import resolvePath（生产 helper），用 path.resolve
// - 输出格式保持和 legacy 一致（带 emoji 前缀），diff=true
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
import { buildSpillNotice, spillToolResultArchive, type ToolResultArchiveRef } from '../../../utils/toolResultSpill';
import { listDirectorySchema as schema } from './listDirectory.schema';

interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  children?: DirEntry[];
}

interface FlatDirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  depth: number;
}

type DirectorySort = 'path' | 'name' | 'type' | 'size';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DISCOVERY_ARCHIVE_CHAR_LIMIT = 12_000;
const NEXT_READ_HINT =
  '\n[next-read] Before Edit or overwrite Write on any listed file path, call Read on that exact file first.';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__',
]);

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

async function listDir(
  dirPath: string,
  recursive: boolean,
  maxDepth: number,
  currentDepth: number,
  rootPath: string,
  shouldIgnore: (relativePath: string, isDirectory: boolean) => boolean,
): Promise<DirEntry[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const result: DirEntry[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') {
      if (entry.isDirectory()) continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(rootPath, fullPath);
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    if (shouldIgnore(relativePath, entry.isDirectory())) continue;

    const dirEntry: DirEntry = {
      name: entry.name,
      path: fullPath,
      isDirectory: entry.isDirectory(),
    };

    if (!entry.isDirectory()) {
      try {
        const stats = await fs.stat(fullPath);
        dirEntry.size = stats.size;
      } catch {
        // ignore stat errors
      }
    }

    if (entry.isDirectory() && recursive && currentDepth < maxDepth) {
      try {
        dirEntry.children = await listDir(fullPath, recursive, maxDepth, currentDepth + 1, rootPath, shouldIgnore);
      } catch {
        // permission errors on subdir
      }
    }

    result.push(dirEntry);
  }

  result.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  return result;
}

function formatEntries(entries: FlatDirEntry[], rootPath: string): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const icon = entry.isDirectory ? '📁' : '📄';
    const size = entry.size ? ` (${formatFileSize(entry.size)})` : '';
    const rel = path.relative(rootPath, entry.path) || entry.name;
    const suffix = entry.isDirectory ? '/' : '';
    lines.push(`${icon} ${rel}${suffix}${size}`);
  }
  return lines.join('\n');
}

function flattenEntries(entries: DirEntry[], depth = 0): FlatDirEntry[] {
  const flat: FlatDirEntry[] = [];
  for (const entry of entries) {
    flat.push({
      name: entry.name,
      path: entry.path,
      isDirectory: entry.isDirectory,
      size: entry.size,
      depth,
    });
    if (entry.children) {
      flat.push(...flattenEntries(entry.children, depth + 1));
    }
  }
  return flat;
}

function parsePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(Math.floor(value), max));
}

function parseSort(value: unknown): DirectorySort {
  return value === 'name' || value === 'type' || value === 'size' ? value : 'path';
}

async function readGitignoreLines(rootPath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(path.join(rootPath, '.gitignore'), 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'))
      .map(line => line.replace(/^\//, ''));
  } catch {
    return [];
  }
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function buildGitignoreMatcher(lines: string[]): (relativePath: string, isDirectory: boolean) => boolean {
  const patterns = lines.map(line => ({
    raw: line,
    directoryOnly: line.endsWith('/'),
    regex: wildcardToRegExp(line.replace(/\/$/, '')),
  }));
  return (relativePath: string, isDirectory: boolean) => {
    const rel = relativePath.split(path.sep).join('/');
    return patterns.some(({ raw, directoryOnly, regex }) => {
      const base = raw.replace(/\/$/, '');
      if (directoryOnly && !isDirectory && !rel.startsWith(`${base}/`) && !rel.includes(`/${base}/`)) {
        return false;
      }
      if (regex.test(rel)) return true;
      if (!base.includes('/')) {
        return rel === base || rel.startsWith(`${base}/`) || rel.includes(`/${base}/`);
      }
      return rel === base || rel.startsWith(`${base}/`);
    });
  };
}

function sortEntries(entries: FlatDirEntry[], sort: DirectorySort): FlatDirEntry[] {
  return [...entries].sort((a, b) => {
    if (sort === 'type' && a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    if (sort === 'size') {
      return (b.size ?? 0) - (a.size ?? 0) || a.path.localeCompare(b.path);
    }
    const left = sort === 'name' ? a.name : a.path;
    const right = sort === 'name' ? b.name : b.path;
    return left.localeCompare(right) || a.path.localeCompare(b.path);
  });
}

function appendArchiveHint(output: string, archiveRef: ToolResultArchiveRef | undefined): string {
  if (!archiveRef) return output;
  return `${output}${buildSpillNotice(archiveRef)}${NEXT_READ_HINT}`;
}

class ListDirectoryHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const inputPath = (args.path as string | undefined) ?? ctx.workingDir;
    const recursive = Boolean(args.recursive);
    const maxDepth = (args.max_depth as number | undefined) ?? 3;
    const offset = parsePositiveInteger(args.offset, 0, Number.MAX_SAFE_INTEGER);
    const limit = parsePositiveInteger(args.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;
    const sort = parseSort(args.sort);
    const respectGitignore = args.respect_gitignore !== false;

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: `list ${path.basename(inputPath)}` });

    const dirPath = path.isAbsolute(inputPath)
      ? inputPath
      : path.resolve(ctx.workingDir, inputPath);

    try {
      const gitignoreLines = respectGitignore ? await readGitignoreLines(dirPath) : [];
      const shouldIgnore = buildGitignoreMatcher(gitignoreLines);
      const entries = await listDir(dirPath, recursive, maxDepth, 0, dirPath, shouldIgnore);
      const flatEntries = sortEntries(flattenEntries(entries), sort);
      const pageEntries = flatEntries.slice(offset, offset + limit);
      const nextOffset = offset + pageEntries.length < flatEntries.length ? offset + pageEntries.length : null;
      let output = formatEntries(pageEntries, dirPath) || '(empty page)';
      output += `\n\nnextOffset: ${nextOffset === null ? 'null' : nextOffset}`;
      const fullOutput = formatEntries(flatEntries, dirPath);
      const archive = (nextOffset !== null || fullOutput.length > DISCOVERY_ARCHIVE_CHAR_LIMIT)
        ? spillToolResultArchive({
            content: fullOutput,
            toolName: schema.name,
            sessionId: ctx.sessionId,
            toolCallId: ctx.currentToolCallId,
            reason: 'discovery-full-results',
          })
        : null;
      output = appendArchiveHint(output, archive?.archiveRef);
      const directoryCount = flatEntries.filter(entry => entry.isDirectory).length;
      const fileCount = flatEntries.length - directoryCount;
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.info('ListDirectory done', { dirPath, count: entries.length, recursive });
      return {
        ok: true,
        output,
        meta: {
          dirPath,
          recursive,
          maxDepth,
          offset,
          limit,
          sort,
          respectGitignore,
          entryCount: flatEntries.length,
          fileCount,
          directoryCount,
          entries: pageEntries,
          nextOffset,
          entriesTruncated: nextOffset !== null,
          ...(archive ? { archiveRef: archive.archiveRef } : {}),
          artifact: createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'text',
            sessionId: ctx.sessionId,
            name: `Directory: ${path.basename(dirPath) || dirPath}`,
            mimeType: 'text/plain',
            contentLength: output.length,
            preview: output.slice(0, 500),
            metadata: {
              dirPath,
              recursive,
              maxDepth,
              offset,
              limit,
              nextOffset,
              entryCount: flatEntries.length,
              fileCount,
              directoryCount,
              entriesTruncated: nextOffset !== null,
              ...(archive ? { archiveRef: archive.archiveRef } : {}),
            },
          }),
        },
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return { ok: false, error: `Directory not found: ${dirPath}`, code: 'ENOENT' };
      }
      return { ok: false, error: e.message ?? 'Failed to list directory', code: 'FS_ERROR' };
    }
  }
}

export const listDirectoryModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ListDirectoryHandler();
  },
};
