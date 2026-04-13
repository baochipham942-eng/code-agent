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
import { listDirectorySchema as schema } from './listDirectory.schema';

interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  children?: DirEntry[];
}

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
): Promise<DirEntry[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const result: DirEntry[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') {
      if (entry.isDirectory()) continue;
    }
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dirPath, entry.name);
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
        dirEntry.children = await listDir(fullPath, recursive, maxDepth, currentDepth + 1);
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

function formatEntries(entries: DirEntry[], indent = ''): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const icon = entry.isDirectory ? '📁' : '📄';
    const size = entry.size ? ` (${formatFileSize(entry.size)})` : '';
    lines.push(`${indent}${icon} ${entry.name}${size}`);
    if (entry.children && entry.children.length > 0) {
      lines.push(formatEntries(entry.children, indent + '  '));
    }
  }
  return lines.join('\n');
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
      const entries = await listDir(dirPath, recursive, maxDepth, 0);
      const output = formatEntries(entries);
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.info('ListDirectory done', { dirPath, count: entries.length, recursive });
      return { ok: true, output };
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
