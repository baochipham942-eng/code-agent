// ============================================================================
// Glob (P0-6.3 Batch 1 — file-core: native ToolModule rewrite)
//
// 旧版: src/host/tools/file/glob.ts (legacy Tool + wrapLegacyTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + onProgress 事件
// - 走 ctx.logger
// - 行为保真：
//   * 使用 glob 库 (nodir: true)
//   * 固定 ignore 列表：node_modules / .git / dist / build / .next / coverage
//   * 结果截断到 200 条，超出部分追加 "... (N more files)"
//   * path 可选，默认 ctx.workingDir，支持 ~ 和相对路径
//   * 空结果返回 "No files matched the pattern"
// ============================================================================

import { glob as globLib } from 'glob';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
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
import { globSchema as schema } from './glob.schema';

const MAX_RESULTS = 200;
const MAX_LIMIT = 1000;
const DISCOVERY_ARCHIVE_CHAR_LIMIT = 12_000;
const NEXT_READ_HINT =
  '\n[next-read] Before Edit or overwrite Write on any search result path, call Read on that exact file first.';
const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
];
type GlobSort = 'path' | 'name' | 'mtime' | 'size';

function expandTilde(filePath: string): string {
  if (!filePath) return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function resolveInputPath(inputPath: string, workingDir: string): string {
  const expanded = expandTilde(inputPath);
  if (path.isAbsolute(expanded)) return expanded;
  return path.join(workingDir, expanded);
}

function parsePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(Math.floor(value), max));
}

function parseSort(value: unknown): GlobSort {
  return value === 'name' || value === 'mtime' || value === 'size' ? value : 'path';
}

async function readGitignorePatterns(searchPath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(path.join(searchPath, '.gitignore'), 'utf-8');
    const patterns: string[] = [];
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      const normalized = line.replace(/^\//, '');
      if (!normalized) continue;
      if (normalized.endsWith('/')) {
        patterns.push(`${normalized}**`, `**/${normalized}**`);
      } else if (normalized.includes('/')) {
        patterns.push(normalized);
      } else {
        patterns.push(normalized, `**/${normalized}`, `**/${normalized}/**`);
      }
    }
    return patterns;
  } catch {
    return [];
  }
}

async function statSortValue(searchPath: string, relativePath: string, sort: GlobSort): Promise<number> {
  if (sort !== 'mtime' && sort !== 'size') return 0;
  try {
    const stats = await fs.stat(path.join(searchPath, relativePath));
    return sort === 'mtime' ? stats.mtimeMs : stats.size;
  } catch {
    return 0;
  }
}

async function sortMatches(matches: string[], searchPath: string, sort: GlobSort): Promise<string[]> {
  if (sort === 'mtime' || sort === 'size') {
    const withStats = await Promise.all(
      matches.map(async match => ({
        match,
        value: await statSortValue(searchPath, match, sort),
      })),
    );
    return withStats
      .sort((a, b) => b.value - a.value || a.match.localeCompare(b.match))
      .map(entry => entry.match);
  }
  return [...matches].sort((a, b) => {
    const left = sort === 'name' ? path.basename(a) : a;
    const right = sort === 'name' ? path.basename(b) : b;
    return left.localeCompare(right) || a.localeCompare(b);
  });
}

function appendArchiveHint(output: string, archiveRef: ToolResultArchiveRef | undefined): string {
  if (!archiveRef) return output;
  return `${output}${buildSpillNotice(archiveRef)}${NEXT_READ_HINT}`;
}

class GlobHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const pattern = args.pattern;
    if (typeof pattern !== 'string' || !pattern) {
      return {
        ok: false,
        error: 'pattern is required and must be a string',
        code: 'INVALID_ARGS',
      };
    }

    const inputPath = (args.path as string | undefined) || ctx.workingDir;
    const offset = parsePositiveInteger(args.offset, 0, Number.MAX_SAFE_INTEGER);
    const limit = parsePositiveInteger(args.limit, MAX_RESULTS, MAX_LIMIT) || MAX_RESULTS;
    const sort = parseSort(args.sort);
    const respectGitignore = args.respect_gitignore !== false;

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return {
        ok: false,
        error: `permission denied: ${permit.reason}`,
        code: 'PERMISSION_DENIED',
      };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const searchPath = resolveInputPath(inputPath, ctx.workingDir);

    onProgress?.({ stage: 'starting', detail: `glob ${pattern}` });

    try {
      const ignore = respectGitignore
        ? [...DEFAULT_IGNORE, ...await readGitignorePatterns(searchPath)]
        : DEFAULT_IGNORE;
      const matches = await globLib(pattern, {
        cwd: searchPath,
        nodir: true,
        ignore,
      });
      const sortedMatches = await sortMatches(matches, searchPath, sort);

      if (sortedMatches.length === 0) {
        onProgress?.({ stage: 'completing', percent: 100 });
        const output = 'No files matched the pattern';
        return {
          ok: true,
          output,
          meta: {
            pattern,
            searchPath,
            matches: [],
            totalMatches: 0,
              returned: 0,
              offset,
              limit,
              nextOffset: null,
              truncated: false,
            artifact: createVirtualArtifact({
              sourceTool: schema.name,
              kind: 'search',
              sessionId: ctx.sessionId,
              name: `Glob: ${pattern}`,
              mimeType: 'text/plain',
              contentLength: output.length,
              preview: output,
              metadata: { pattern, searchPath, totalMatches: 0, returned: 0, offset, limit, nextOffset: null, truncated: false },
            }),
          },
        };
      }

      const sliced = sortedMatches.slice(offset, offset + limit);
      const nextOffset = offset + sliced.length < sortedMatches.length ? offset + sliced.length : null;
      let result = sliced.join('\n') || '(empty page)';
      result += `\n\nnextOffset: ${nextOffset === null ? 'null' : nextOffset}`;
      const fullOutput = sortedMatches.join('\n');
      const archive = (nextOffset !== null || fullOutput.length > DISCOVERY_ARCHIVE_CHAR_LIMIT)
        ? spillToolResultArchive({
            content: fullOutput,
            toolName: schema.name,
            sessionId: ctx.sessionId,
            toolCallId: ctx.currentToolCallId,
            reason: 'discovery-full-results',
          })
        : null;
      result = appendArchiveHint(result, archive?.archiveRef);

      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug('Glob done', {
        pattern,
        searchPath,
        total: sortedMatches.length,
        returned: sliced.length,
      });
      return {
        ok: true,
        output: result,
        meta: {
          pattern,
          searchPath,
          offset,
          limit,
          sort,
          respectGitignore,
          matches: sliced,
          totalMatches: sortedMatches.length,
          returned: sliced.length,
          nextOffset,
          truncated: nextOffset !== null,
          ...(archive ? { archiveRef: archive.archiveRef } : {}),
          artifact: createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'search',
            sessionId: ctx.sessionId,
            name: `Glob: ${pattern}`,
            mimeType: 'text/plain',
            contentLength: result.length,
            preview: result.slice(0, 500),
            metadata: {
              pattern,
              searchPath,
              totalMatches: sortedMatches.length,
              returned: sliced.length,
              offset,
              limit,
              nextOffset,
              truncated: nextOffset !== null,
              ...(archive ? { archiveRef: archive.archiveRef } : {}),
            },
          }),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message || 'Failed to search files',
        code: 'FS_ERROR',
      };
    }
  }
}

export const globModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new GlobHandler();
  },
};
