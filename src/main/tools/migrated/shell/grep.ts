// ============================================================================
// Grep (P0-6.3 Batch 2b — shell: native ToolModule rewrite)
//
// 旧版: src/main/tools/shell/grep.ts (legacy Tool + wrapLegacyTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + onProgress 事件
// - 走 ctx.logger（不 import services/infra/logger）
// - 行为保真（对齐 legacy grep.ts 所有分支）：
//   * ripgrep 二进制解析（缓存 rgBinaryPath，候选路径同 legacy）
//   * rg → 系统 grep 自动降级（rg 不存在 / ENOENT / ENOENT fallback）
//   * EAGAIN 重试：降级为单线程 -j 1
//   * File type 映射（js/ts/py/rust/go/... → -g *.ext 过滤）
//   * include glob 过滤（rg -g / grep --include）
//   * case_insensitive -i
//   * before_context / after_context / context（alias）→ -B/-A，上限 MAX_CONTEXT_LINES
//   * head_limit / offset 按 match group 分页（`--` 分隔）
//   * MAX_TOTAL_MATCHES / MAX_MATCHES_PER_FILE / MAX_LINE_LENGTH 输出限制
//   * exit code 1 + 无 stderr → "No matches found" 软成功
//   * abortSignal → execFile signal 自动 kill 子进程
// - meta 字段：engine (rg|grep)、truncated、totalMatches
// ============================================================================

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { grepSchema as schema } from './grep.schema';
import { GREP, BASH } from '../../../../shared/constants';

const execFileAsync = promisify(execFile);

/**
 * File type → glob 映射，对齐 ripgrep 内置 type 定义。
 * 给 rg 用 `-g <ext>`，给 grep 用 `--include <ext>`。
 */
const FILE_TYPE_MAP: Record<string, string[]> = {
  js: ['*.js', '*.mjs', '*.cjs'],
  ts: ['*.ts', '*.mts', '*.cts'],
  jsx: ['*.jsx'],
  tsx: ['*.tsx'],
  py: ['*.py', '*.pyi'],
  rust: ['*.rs'],
  go: ['*.go'],
  java: ['*.java'],
  c: ['*.c', '*.h'],
  cpp: ['*.cpp', '*.cc', '*.cxx', '*.hpp', '*.hh', '*.hxx', '*.h'],
  css: ['*.css', '*.scss', '*.sass', '*.less'],
  html: ['*.html', '*.htm'],
  json: ['*.json'],
  yaml: ['*.yaml', '*.yml'],
  md: ['*.md', '*.markdown'],
  xml: ['*.xml'],
  sql: ['*.sql'],
  sh: ['*.sh', '*.bash', '*.zsh'],
  ruby: ['*.rb'],
  php: ['*.php'],
  swift: ['*.swift'],
  kotlin: ['*.kt', '*.kts'],
};

// ----------------------------------------------------------------------------
// ripgrep 二进制定位 — 对齐 legacy grep.ts 候选路径，首次查询后缓存
// ----------------------------------------------------------------------------

/** Cached rg binary path (undefined = not yet checked, null = not available) */
let rgBinaryPath: string | null | undefined;

function findRgBinary(): string | null {
  if (rgBinaryPath !== undefined) return rgBinaryPath;

  const home = process.env.HOME ?? '';
  const candidates = [
    // Homebrew
    '/opt/homebrew/bin/rg',
    '/usr/local/bin/rg',
    // Claude Code vendor
    `${home}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/arm64-darwin/rg`,
    `${home}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x64-darwin/rg`,
    `${home}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x64-linux/rg`,
    // System
    '/usr/bin/rg',
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      rgBinaryPath = candidate;
      return rgBinaryPath;
    }
  }

  rgBinaryPath = null;
  return null;
}

/** 测试钩子：覆盖 rg 定位结果（仅测试用） */
export function __setRgBinaryPathForTest(pathOrNull: string | null | undefined): void {
  rgBinaryPath = pathOrNull;
}

// ----------------------------------------------------------------------------
// EAGAIN 判定
// ----------------------------------------------------------------------------

function isEagainError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { stderr?: string; message?: string; code?: string };
  const text = (err.stderr || err.message || '').toLowerCase();
  return (
    text.includes('resource temporarily unavailable') ||
    text.includes('eagain') ||
    err.code === 'EAGAIN'
  );
}

interface RgResult {
  /** rg ran and (may have) found matches */
  found: boolean;
  /** rg ran but found zero matches */
  noMatches: boolean;
  stdout: string;
}

interface GrepMeta extends Record<string, unknown> {
  engine: 'rg' | 'grep';
  totalMatches?: number;
  shown?: number;
  truncated?: boolean;
}

// ----------------------------------------------------------------------------
// ripgrep 执行
// ----------------------------------------------------------------------------

async function tryRipgrep(
  pattern: string,
  searchPath: string,
  caseInsensitive: boolean,
  ctxBefore: number | undefined,
  ctxAfter: number | undefined,
  fileType: string | undefined,
  include: string | undefined,
  signal: AbortSignal,
): Promise<RgResult> {
  const rgPath = findRgBinary();
  if (!rgPath) {
    return { found: false, noMatches: false, stdout: '' };
  }

  const args = [
    '-n',
    '--color=never',
    '-M',
    String(GREP.MAX_LINE_LENGTH),
    '--max-count',
    String(GREP.MAX_MATCHES_PER_FILE),
  ];

  if (caseInsensitive) args.push('-i');
  if (ctxBefore !== undefined && ctxBefore > 0) {
    args.push('-B', String(Math.min(ctxBefore, GREP.MAX_CONTEXT_LINES)));
  }
  if (ctxAfter !== undefined && ctxAfter > 0) {
    args.push('-A', String(Math.min(ctxAfter, GREP.MAX_CONTEXT_LINES)));
  }

  if (fileType && FILE_TYPE_MAP[fileType]) {
    for (const ext of FILE_TYPE_MAP[fileType]) args.push('-g', ext);
  } else if (include) {
    args.push('-g', include);
  }

  args.push(
    '--glob',
    '!node_modules',
    '--glob',
    '!.git',
    '--glob',
    '!dist',
    '--glob',
    '!build',
  );
  args.push(pattern, searchPath);

  try {
    const result = await execFileAsync(rgPath, args, {
      maxBuffer: BASH.MAX_BUFFER,
      timeout: GREP.DEFAULT_TIMEOUT,
      signal,
    });
    return { found: true, noMatches: false, stdout: result.stdout };
  } catch (err: unknown) {
    const e = err as { code?: number | string; stderr?: string; message?: string };

    // EAGAIN: retry with single thread
    if (isEagainError(err)) {
      try {
        const retryArgs = ['-j', String(GREP.EAGAIN_RETRY_THREADS), ...args];
        const result = await execFileAsync(rgPath, retryArgs, {
          maxBuffer: BASH.MAX_BUFFER,
          timeout: GREP.DEFAULT_TIMEOUT,
          signal,
        });
        return { found: true, noMatches: false, stdout: result.stdout };
      } catch (retryErr: unknown) {
        const re = retryErr as { code?: number | string; stderr?: string };
        if (re.code === 1 && !re.stderr) {
          return { found: false, noMatches: true, stdout: '' };
        }
        throw retryErr;
      }
    }

    // Exit code 1 + no stderr = rg ran, no matches
    if (e.code === 1 && !e.stderr) {
      return { found: false, noMatches: true, stdout: '' };
    }

    // ENOENT / path not found → signal fallback to grep
    if (e.code === 'ENOENT' || (typeof e.message === 'string' && e.message.includes('ENOENT'))) {
      return { found: false, noMatches: false, stdout: '' };
    }

    // Other errors (bad pattern, invalid path, etc) bubble up
    throw err;
  }
}

// ----------------------------------------------------------------------------
// 系统 grep 降级
// ----------------------------------------------------------------------------

async function runSystemGrep(
  pattern: string,
  searchPath: string,
  caseInsensitive: boolean,
  ctxBefore: number | undefined,
  ctxAfter: number | undefined,
  fileType: string | undefined,
  include: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const grepArgs: string[] = ['-r', '-n', '-E'];

  if (caseInsensitive) grepArgs.push('-i');

  if (ctxBefore !== undefined && ctxBefore > 0) {
    grepArgs.push('-B', String(Math.min(ctxBefore, GREP.MAX_CONTEXT_LINES)));
  }
  if (ctxAfter !== undefined && ctxAfter > 0) {
    grepArgs.push('-A', String(Math.min(ctxAfter, GREP.MAX_CONTEXT_LINES)));
  }

  if (fileType && FILE_TYPE_MAP[fileType]) {
    for (const ext of FILE_TYPE_MAP[fileType]) {
      grepArgs.push('--include', ext);
    }
  } else if (include) {
    grepArgs.push('--include', include);
  }

  grepArgs.push(
    '--exclude-dir=node_modules',
    '--exclude-dir=.git',
    '--exclude-dir=dist',
    '--exclude-dir=build',
  );

  grepArgs.push(pattern, searchPath);

  const result = await execFileAsync('grep', grepArgs, {
    maxBuffer: BASH.MAX_BUFFER,
    timeout: GREP.DEFAULT_TIMEOUT,
    signal,
  });
  return result.stdout;
}

// ----------------------------------------------------------------------------
// 输出处理：分页 + 默认截断
// ----------------------------------------------------------------------------

interface PaginateResult {
  output: string;
  totalGroups: number;
  shownCount: number;
  truncated: boolean;
}

/**
 * 按 match group 分页。match group 由 `--` 分隔（rg/grep 上下文块分隔符）。
 * 无 `--` 时，每行即一个 group。
 */
function paginateOutput(stdout: string, headLimit: number, offset: number): PaginateResult {
  const rawLines = stdout.split('\n');

  const groups: string[][] = [];
  let currentGroup: string[] = [];

  for (const line of rawLines) {
    if (line === '--') {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [];
      }
    } else if (line) {
      currentGroup.push(line);
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  // 无 `--` 分隔 → 每行拆成独立 group
  if (groups.length === 1 && rawLines.filter(Boolean).length > 1 && !rawLines.includes('--')) {
    const allLines = rawLines.filter(Boolean);
    groups.length = 0;
    for (const line of allLines) {
      groups.push([line]);
    }
  }

  const totalGroups = groups.length;
  const effectiveOffset = Math.min(offset, totalGroups);
  const sliced =
    headLimit > 0
      ? groups.slice(effectiveOffset, effectiveOffset + headLimit)
      : groups.slice(effectiveOffset);

  const shownCount = sliced.length;
  const output = sliced.map((g) => g.join('\n')).join('\n--\n');
  const pagination = `(showing ${effectiveOffset + 1}-${effectiveOffset + shownCount} of ${totalGroups} matches)`;

  return {
    output: output + '\n\n' + pagination,
    totalGroups,
    shownCount,
    truncated: effectiveOffset + shownCount < totalGroups,
  };
}

/** 默认输出限制 — 超过 MAX_TOTAL_MATCHES 行截断并追加提示 */
function applyDefaultLimit(stdout: string): {
  output: string;
  totalMatches: number;
  truncated: boolean;
} {
  const lines = stdout.split('\n').filter(Boolean);
  const totalMatches = lines.length;
  if (totalMatches <= GREP.MAX_TOTAL_MATCHES) {
    return { output: lines.join('\n'), totalMatches, truncated: false };
  }
  const output =
    lines.slice(0, GREP.MAX_TOTAL_MATCHES).join('\n') +
    `\n\n... (${totalMatches - GREP.MAX_TOTAL_MATCHES} more matches)`;
  return { output, totalMatches, truncated: true };
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------

class GrepHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const pattern = args.pattern;
    if (typeof pattern !== 'string' || !pattern) {
      return { ok: false, error: 'pattern is required and must be a string', code: 'INVALID_ARGS' };
    }

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

    onProgress?.({ stage: 'starting', detail: `rg: ${pattern.slice(0, 40)}` });

    // 参数解析
    const rawPath = (args.path as string | undefined) ?? ctx.workingDir;
    const searchPath = path.isAbsolute(rawPath) ? rawPath : path.join(ctx.workingDir, rawPath);
    const include = args.include as string | undefined;
    const fileType = args.type as string | undefined;
    const caseInsensitive = Boolean(args.case_insensitive);
    const beforeContext = args.before_context as number | undefined;
    const afterContext = args.after_context as number | undefined;
    const contextLines = args.context as number | undefined;
    const headLimit = (args.head_limit as number | undefined) ?? 0;
    const offset = (args.offset as number | undefined) ?? 0;

    // context 覆写 before/after
    const ctxBefore = contextLines ?? beforeContext;
    const ctxAfter = contextLines ?? afterContext;

    try {
      let stdout: string;
      let engine: 'rg' | 'grep';

      // 1) 尝试 ripgrep
      const rgResult = await tryRipgrep(
        pattern,
        searchPath,
        caseInsensitive,
        ctxBefore,
        ctxAfter,
        fileType,
        include,
        ctx.abortSignal,
      );

      if (rgResult.found) {
        stdout = rgResult.stdout;
        engine = 'rg';
      } else if (rgResult.noMatches) {
        onProgress?.({ stage: 'completing', percent: 100 });
        return {
          ok: true,
          output: 'No matches found',
          meta: { engine: 'rg', totalMatches: 0, shown: 0, truncated: false } as GrepMeta,
        };
      } else {
        // 2) rg 不可用 → 系统 grep 降级
        try {
          stdout = await runSystemGrep(
            pattern,
            searchPath,
            caseInsensitive,
            ctxBefore,
            ctxAfter,
            fileType,
            include,
            ctx.abortSignal,
          );
          engine = 'grep';
        } catch (grepErr: unknown) {
          const ge = grepErr as { code?: number | string; stderr?: string; message?: string };
          if (ge.code === 1 && !ge.stderr) {
            onProgress?.({ stage: 'completing', percent: 100 });
            return {
              ok: true,
              output: 'No matches found',
              meta: { engine: 'grep', totalMatches: 0, shown: 0, truncated: false } as GrepMeta,
            };
          }
          throw grepErr;
        }
      }

      // 输出处理
      let output: string;
      let meta: GrepMeta;

      if (headLimit > 0 || offset > 0) {
        const p = paginateOutput(stdout, headLimit, offset);
        output = p.output;
        meta = {
          engine,
          totalMatches: p.totalGroups,
          shown: p.shownCount,
          truncated: p.truncated,
        };
      } else {
        const limited = applyDefaultLimit(stdout);
        output = limited.output;
        meta = {
          engine,
          totalMatches: limited.totalMatches,
          shown: Math.min(limited.totalMatches, GREP.MAX_TOTAL_MATCHES),
          truncated: limited.truncated,
        };
      }

      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug('Grep done', {
        pattern: pattern.slice(0, 80),
        engine,
        totalMatches: meta.totalMatches,
      });

      return {
        ok: true,
        output: output || 'No matches found',
        meta,
      };
    } catch (error: unknown) {
      const errObj = (error ?? {}) as Record<string, unknown>;
      const errMsg = error instanceof Error ? error.message : String(error);

      // Abort 检测：signal 取消后 execFile 会抛 AbortError
      if (
        ctx.abortSignal.aborted ||
        (typeof errObj.name === 'string' && errObj.name === 'AbortError')
      ) {
        return { ok: false, error: 'aborted', code: 'ABORTED' };
      }

      // 超时：child_process killed + SIGTERM
      if (errObj.killed && errObj.signal === 'SIGTERM') {
        return {
          ok: false,
          error: `Grep timed out after ${GREP.DEFAULT_TIMEOUT / 1000} seconds`,
          code: 'TIMEOUT',
        };
      }

      // 没匹配（兜底，理论上 tryRipgrep / runSystemGrep 已处理）
      if (errObj.code === 1 && !errObj.stderr) {
        return {
          ok: true,
          output: 'No matches found',
          meta: { engine: 'grep', totalMatches: 0, shown: 0, truncated: false } as GrepMeta,
        };
      }

      // ENOENT — 路径不存在
      if (errObj.code === 'ENOENT') {
        return {
          ok: false,
          error: `Path not found: ${errMsg}`,
          code: 'ENOENT',
        };
      }

      return {
        ok: false,
        error: errMsg || 'Grep search failed',
        code: 'FS_ERROR',
      };
    }
  }
}

export const grepModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new GrepHandler();
  },
};
