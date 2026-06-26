// ============================================================================
// Diagnostics (Wave 1 — lsp: native ToolModule rewrite)
//
// 旧版: src/main/tools/lsp/diagnostics.ts (legacy Tool + wrapLegacyTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + abort 检查 + onProgress 事件
// - 错误码规范化：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_INITIALIZED / DOMAIN_ERROR
// - 行为保真：legacy diagnostics 输出格式（包括 "No diagnostics found for X" /
//   严重度过滤 / file vs project 分组 / "Error L<line>:<char>: <msg> [<source>]"）
//   1:1 复刻
// - LSP manager 是共享 stdio 子进程单例：abort 时不杀进程（其他 tool 还在用），
//   只是放弃当前 query 让管理器内部 30s timeout 自然清理 pending request
// ============================================================================

import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getLSPManager, type LSPDiagnostic } from '../../../lsp';
import { diagnosticsSchema as schema } from './diagnostics.schema';

type SeverityFilter = 'error' | 'warning' | 'all';

function applySeverityFilter(diags: LSPDiagnostic[], filter: SeverityFilter): LSPDiagnostic[] {
  if (filter === 'error') return diags.filter((d) => d.severity === 1);
  if (filter === 'warning') return diags.filter((d) => d.severity === 2);
  // 'all' — 仅保留 Error (1) 和 Warning (2)，跳过 hint/info
  return diags.filter((d) => d.severity === 1 || d.severity === 2);
}

function uriToRelativePath(uri: string, workingDir: string): string {
  let decodedPath = uri.replace(/^file:\/\//, '');
  try {
    decodedPath = decodeURIComponent(decodedPath);
  } catch {
    /* use undecoded */
  }
  const relativePath = path.relative(workingDir, decodedPath);
  return relativePath.startsWith('..') ? decodedPath : relativePath;
}

function formatDiagnosticLine(d: LSPDiagnostic): string {
  const severity = d.severity === 1 ? 'Error' : 'Warning';
  const line = d.range.start.line + 1;
  const char = d.range.start.character + 1;
  const source = d.source ? ` [${d.source}]` : '';
  return `  ${severity} L${line}:${char}: ${d.message}${source}`;
}

export async function executeDiagnostics(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  // Schema 是 required:[]，所有字段可选，但要做类型校验
  const filePath = args.file_path === undefined ? undefined : args.file_path;
  if (filePath !== undefined && typeof filePath !== 'string') {
    return { ok: false, error: 'file_path must be a string', code: 'INVALID_ARGS' };
  }
  const rawSeverity = args.severity_filter;
  if (rawSeverity !== undefined && rawSeverity !== 'error' && rawSeverity !== 'warning' && rawSeverity !== 'all') {
    return {
      ok: false,
      error: "severity_filter must be one of: 'error', 'warning', 'all'",
      code: 'INVALID_ARGS',
    };
  }
  const severityFilter: SeverityFilter = (rawSeverity as SeverityFilter | undefined) ?? 'all';

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: 'lsp diagnostics' });

  const manager = getLSPManager();
  if (!manager) {
    return {
      ok: false,
      error:
        'LSP server manager not initialized. LSP features require language servers to be installed.',
      code: 'NOT_INITIALIZED',
    };
  }

  let diagnostics: LSPDiagnostic[];
  let scope: string;

  if (filePath) {
    const resolvedPath = path.resolve(ctx.workingDir, filePath as string);
    diagnostics = manager.getFileDiagnostics(resolvedPath);
    scope = path.relative(ctx.workingDir, resolvedPath) || resolvedPath;
  } else {
    const allDiagnostics = manager.getDiagnostics();
    diagnostics = [];
    for (const [, fileDiags] of allDiagnostics) {
      diagnostics.push(...fileDiags);
    }
    scope = 'project';
  }

  diagnostics = applySeverityFilter(diagnostics, severityFilter);

  if (diagnostics.length === 0) {
    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output: `No diagnostics found for ${scope} (filter: ${severityFilter})`,
      meta: { scope, errorCount: 0, warningCount: 0 },
    };
  }

  const errorCount = diagnostics.filter((d) => d.severity === 1).length;
  const warningCount = diagnostics.filter((d) => d.severity === 2).length;

  const summary: string[] = [];
  if (errorCount > 0) summary.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`);
  if (warningCount > 0) summary.push(`${warningCount} warning${warningCount > 1 ? 's' : ''}`);

  const lines = [`Diagnostics for ${scope}: ${summary.join(', ')}`];

  if (filePath) {
    // 单文件：直接列诊断
    for (const d of diagnostics) {
      lines.push(formatDiagnosticLine(d));
    }
  } else {
    // 项目级：按文件分组
    const allDiagnostics = manager.getDiagnostics();
    for (const [uri, fileDiags] of allDiagnostics) {
      const filtered = applySeverityFilter(fileDiags, severityFilter);
      if (filtered.length === 0) continue;
      const displayPath = uriToRelativePath(uri, ctx.workingDir);
      lines.push(`\n${displayPath}:`);
      for (const d of filtered) {
        lines.push(formatDiagnosticLine(d));
      }
    }
  }

  ctx.logger.debug('diagnostics', { scope, errorCount, warningCount });
  onProgress?.({ stage: 'completing', percent: 100 });

  return {
    ok: true,
    output: lines.join('\n'),
    meta: { errorCount, warningCount, scope },
  };
}

class DiagnosticsHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeDiagnostics(args, ctx, canUseTool, onProgress);
  }
}

export const diagnosticsModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new DiagnosticsHandler();
  },
};
