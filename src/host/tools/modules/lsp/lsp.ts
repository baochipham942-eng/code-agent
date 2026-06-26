// ============================================================================
// LSP (Wave 1 — lsp: native ToolModule rewrite)
//
// 旧版: src/host/tools/lsp/lsp.ts (legacy Tool + wrapLegacyTool, 706 行)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + abort 检查 + onProgress 事件
// - 错误码规范化：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_INITIALIZED / DOMAIN_ERROR
// - 行为保真：legacy lsp.ts 所有分支与文案 1:1 复刻
//   * goToDefinition/findReferences/hover/documentSymbol/workspaceSymbol/
//     goToImplementation/prepareCallHierarchy/incomingCalls/outgoingCalls
//   * 所有 formatter helper 内联（formatLocationResult/formatHoverResult/...）
//   * install failure 提示走原文案（含 docUrl / installCmd）
//   * 1-based ↔ 0-based 行列转换
//   * incoming/outgoingCalls 二阶 LSP 调用
//
// ABORT 纪律：
//   LSP server 是共享 stdio 子进程单例，**绝对不在 abort 时 kill 进程**
//   （其他 tool 调用还在用同一个 server）。abort 时：
//   1) 立即返回 ABORTED
//   2) 已发的 LSP 请求由 manager 内部 30s timeout 自然清理 pending request
//   3) 不杀 LSP server 进程，不发 shutdown notification
//   这是基于"shared singleton"语义而非"per-tool session"的合理选择。
// ============================================================================

import * as path from 'path';
import * as fs from 'fs/promises';
import { pathToFileURL } from 'url';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getLSPManager } from '../../../lsp';
import { lspSchema as schema } from './lsp.schema';

// ============================================================================
// Types
// ============================================================================

type LSPOperation =
  | 'goToDefinition'
  | 'findReferences'
  | 'hover'
  | 'documentSymbol'
  | 'workspaceSymbol'
  | 'goToImplementation'
  | 'prepareCallHierarchy'
  | 'incomingCalls'
  | 'outgoingCalls';

interface NormalizedLocation {
  uri: string;
  range: LspRange;
}

type LspRequestParams = Record<string, unknown> | null;

interface LspRequest {
  method: string;
  requestParams: LspRequestParams;
}

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end?: LspPosition;
}

interface LocationShape {
  uri: string;
  range: LspRange;
}

interface LocationLinkShape {
  targetUri: string;
  targetRange?: LspRange;
  targetSelectionRange?: LspRange;
}

interface LocationContainerShape {
  location: LocationShape;
}

type LocationLike = LocationShape | LocationLinkShape | LocationContainerShape;

interface SymbolShape {
  name: string;
  kind: number;
  range?: LspRange;
  location?: LocationShape;
  containerName?: string;
  children?: SymbolShape[];
}

interface WorkspaceSymbolShape {
  name: string;
  kind: number;
  location: LocationShape;
  containerName?: string;
}

interface CallHierarchyItemShape {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
}

type CallHierarchyCallShape =
  | { from: CallHierarchyItemShape; fromRanges?: LspRange[] }
  | { to: CallHierarchyItemShape; fromRanges?: LspRange[] };

type MarkedStringShape = string | { language?: string; value: string };

interface HoverShape {
  contents: MarkedStringShape | MarkedStringShape[] | { kind?: string; value: string };
  range?: LspRange;
}

const ALLOWED_OPERATIONS: LSPOperation[] = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
];

function isLspOperation(value: unknown): value is LSPOperation {
  return typeof value === 'string' && ALLOWED_OPERATIONS.includes(value as LSPOperation);
}

// ============================================================================
// Abort utilities
// ============================================================================

/**
 * 把 LSP 请求 race 进 abort signal。abort 触发时立刻 reject，
 * 落在外层会被识别为 ABORTED 返回。
 *
 * 不 kill LSP server：server 是共享单例，pending request 由
 * manager 内部 30s timeout 清理。
 */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort);
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.message === 'aborted';
}

function sendLspRequest(
  manager: NonNullable<ReturnType<typeof getLSPManager>>,
  filePath: string,
  method: string,
  params: LspRequestParams,
): Promise<unknown> {
  return manager.sendRequest(filePath, method, params) as Promise<unknown>;
}

// ============================================================================
// Native execute
// ============================================================================

export async function executeLsp(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  // ── 参数校验 ────────────────────────────────────────────
  const operation = args.operation;
  if (!isLspOperation(operation)) {
    return {
      ok: false,
      error: `Unsupported operation: ${operation}`,
      code: 'INVALID_ARGS',
    };
  }
  const filePath = args.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, error: 'file_path must be a non-empty string', code: 'INVALID_ARGS' };
  }
  const lineArg = args.line;
  const charArg = args.character;
  if (typeof lineArg !== 'number' || typeof charArg !== 'number') {
    return { ok: false, error: 'line and character must be numbers', code: 'INVALID_ARGS' };
  }

  // ── 权限闸门 / abort ───────────────────────────────────
  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: `lsp ${operation}` });

  // ── 取 manager / 解析路径 ──────────────────────────────
  const manager = getLSPManager();
  if (!manager) {
    return {
      ok: false,
      error:
        'LSP server manager not initialized. ' +
        'LSP features require language servers to be installed and configured.',
      code: 'NOT_INITIALIZED',
    };
  }

  const resolvedPath = path.resolve(ctx.workingDir, filePath);
  const workingDir = ctx.workingDir;

  const uri = pathToFileURL(resolvedPath).href;
  const position = {
    line: lineArg - 1, // 转 0-based
    character: charArg - 1,
  };

  try {
    // 打开文件（如未打开）
    if (!manager.isFileOpen(resolvedPath)) {
      const content = await withAbort(fs.readFile(resolvedPath, 'utf-8'), ctx.abortSignal);
      await withAbort(manager.openFile(resolvedPath, content), ctx.abortSignal);
    }

    // 一阶请求
    const { method, requestParams } = buildLSPRequest(operation, uri, position);
    let result = await withAbort(sendLspRequest(manager, resolvedPath, method, requestParams), ctx.abortSignal);

    if (result === undefined) {
      const ext = path.extname(resolvedPath);
      const failure = manager.getInstallFailureForFile(resolvedPath);
      if (failure?.source?.type === 'system') {
        const docHint = failure.source.docUrl ? ` (docs: ${failure.source.docUrl})` : '';
        return {
          ok: false,
          error: `No LSP server available for ${ext}: install failed. Run: ${failure.source.installCmd}${docHint}`,
          code: 'NOT_INITIALIZED',
        };
      }
      if (failure?.source?.type === 'npm') {
        return {
          ok: false,
          error: `No LSP server available for ${ext}: auto-install failed (${failure.message}). Check network and try again.`,
          code: 'NOT_INITIALIZED',
        };
      }
      return {
        ok: false,
        error: `No LSP server available for file type: ${ext}`,
        code: 'NOT_INITIALIZED',
      };
    }

    // incoming/outgoing calls 需要二阶请求
    if (operation === 'incomingCalls' || operation === 'outgoingCalls') {
      const items = asArray(result).filter(isCallHierarchyItem);

      if (items.length === 0) {
        ctx.logger.debug('lsp', { operation, result: 'no-call-hierarchy-item' });
        onProgress?.({ stage: 'completing', percent: 100 });
        return {
          ok: true,
          output: 'No call hierarchy item found at this position',
          meta: { operation, filePath: resolvedPath, resultCount: 0, fileCount: 0 },
        };
      }

      const secondMethod =
        operation === 'incomingCalls'
          ? 'callHierarchy/incomingCalls'
          : 'callHierarchy/outgoingCalls';

      result = await withAbort(
        sendLspRequest(manager, resolvedPath, secondMethod, { item: items[0] }),
        ctx.abortSignal,
      );

      if (result === undefined) {
        return {
          ok: false,
          error: 'LSP server did not return call hierarchy results',
          code: 'DOMAIN_ERROR',
        };
      }
    }

    // 格式化输出
    const { formatted, resultCount, fileCount } = formatResult(
      operation,
      result,
      workingDir,
    );

    ctx.logger.debug('lsp', { operation, resultCount, fileCount });
    onProgress?.({ stage: 'completing', percent: 100 });

    return {
      ok: true,
      output: formatted,
      meta: {
        operation,
        filePath: resolvedPath,
        resultCount,
        fileCount,
      },
    };
  } catch (error) {
    if (isAbortError(error) || ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Error performing ${operation}: ${message}`,
      code: 'DOMAIN_ERROR',
    };
  }
}

class LspHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeLsp(args, ctx, canUseTool, onProgress);
  }
}

export const lspModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new LspHandler();
  },
};

// ============================================================================
// Helper Functions (内联自 legacy src/host/tools/lsp/lsp.ts)
// ============================================================================

function buildLSPRequest(
  operation: LSPOperation,
  uri: string,
  position: { line: number; character: number },
): LspRequest {
  const textDocument = { uri };

  switch (operation) {
    case 'goToDefinition':
      return {
        method: 'textDocument/definition',
        requestParams: { textDocument, position },
      };

    case 'findReferences':
      return {
        method: 'textDocument/references',
        requestParams: { textDocument, position, context: { includeDeclaration: true } },
      };

    case 'hover':
      return {
        method: 'textDocument/hover',
        requestParams: { textDocument, position },
      };

    case 'documentSymbol':
      return {
        method: 'textDocument/documentSymbol',
        requestParams: { textDocument },
      };

    case 'workspaceSymbol':
      return {
        method: 'workspace/symbol',
        requestParams: { query: '' },
      };

    case 'goToImplementation':
      return {
        method: 'textDocument/implementation',
        requestParams: { textDocument, position },
      };

    case 'prepareCallHierarchy':
    case 'incomingCalls':
    case 'outgoingCalls':
      return {
        method: 'textDocument/prepareCallHierarchy',
        requestParams: { textDocument, position },
      };

    default:
      throw new Error(`Unsupported operation: ${operation}`);
  }
}

function formatResult(
  operation: LSPOperation,
  result: unknown,
  workingDir: string,
): { formatted: string; resultCount: number; fileCount: number } {
  switch (operation) {
    case 'goToDefinition':
    case 'goToImplementation':
      return formatLocationResult(result, workingDir);

    case 'findReferences':
      return formatReferencesResult(result, workingDir);

    case 'hover':
      return formatHoverResult(result);

    case 'documentSymbol':
      return formatDocumentSymbolResult(result);

    case 'workspaceSymbol':
      return formatWorkspaceSymbolResult(result, workingDir);

    case 'prepareCallHierarchy':
      return formatCallHierarchyResult(result, workingDir);

    case 'incomingCalls':
    case 'outgoingCalls':
      return formatCallsResult(operation, result, workingDir);

    default:
      return {
        formatted: JSON.stringify(result, null, 2),
        resultCount: 0,
        fileCount: 0,
      };
  }
}

function formatLocationResult(
  result: unknown,
  workingDir: string,
): { formatted: string; resultCount: number; fileCount: number } {
  const locations = Array.isArray(result) ? result : result ? [result] : [];
  const validLocations = locations.filter(isValidLocation);

  if (validLocations.length === 0) {
    return {
      formatted:
        'No definition found. The symbol may not be defined in the workspace, ' +
        'or the LSP server has not fully indexed the file.',
      resultCount: 0,
      fileCount: 0,
    };
  }

  if (validLocations.length === 1) {
    const normalized = normalizeLocation(validLocations[0]);
    const locationStr = formatLocationString(normalized, workingDir);
    return {
      formatted: `Definition found at ${locationStr}`,
      resultCount: 1,
      fileCount: 1,
    };
  }

  const normalizedLocations = validLocations.map(normalizeLocation);
  const grouped = groupByFile(normalizedLocations, workingDir);
  const lines = [`Found ${normalizedLocations.length} definitions across ${grouped.size} files:`];

  for (const [file, locs] of grouped) {
    lines.push(`\n${file}:`);
    for (const loc of locs) {
      const line = loc.range.start.line + 1;
      const char = loc.range.start.character + 1;
      lines.push(`  Line ${line}:${char}`);
    }
  }

  return {
    formatted: lines.join('\n'),
    resultCount: normalizedLocations.length,
    fileCount: grouped.size,
  };
}

function formatReferencesResult(
  result: unknown,
  workingDir: string,
): { formatted: string; resultCount: number; fileCount: number } {
  const references = asArray(result);

  if (references.length === 0) {
    return {
      formatted:
        'No references found. The symbol may not be used elsewhere, ' +
        'or the LSP server has not fully indexed the project.',
      resultCount: 0,
      fileCount: 0,
    };
  }

  const validReferences = references.filter(isValidLocation);

  if (validReferences.length === 0) {
    return {
      formatted: 'No references found.',
      resultCount: 0,
      fileCount: 0,
    };
  }

  const normalizedReferences = validReferences.map(normalizeLocation);
  const grouped = groupByFile(normalizedReferences, workingDir);
  const lines = [
    `Found ${normalizedReferences.length} reference${normalizedReferences.length === 1 ? '' : 's'} across ${grouped.size} file${grouped.size === 1 ? '' : 's'}:`,
  ];

  for (const [file, refs] of grouped) {
    lines.push(`\n${file}:`);
    for (const ref of refs) {
      const line = ref.range.start.line + 1;
      const char = ref.range.start.character + 1;
      lines.push(`  Line ${line}:${char}`);
    }
  }

  return {
    formatted: lines.join('\n'),
    resultCount: normalizedReferences.length,
    fileCount: grouped.size,
  };
}

function formatHoverResult(result: unknown): { formatted: string; resultCount: number; fileCount: number } {
  if (!isHover(result)) {
    return {
      formatted:
        'No hover information available. The cursor may not be on a symbol, ' +
        'or the LSP server has not fully indexed the file.',
      resultCount: 0,
      fileCount: 0,
    };
  }

  let content = '';

  if (Array.isArray(result.contents)) {
    content = result.contents.map(markedStringToText).join('\n\n');
  } else if (typeof result.contents === 'string') {
    content = result.contents;
  } else if (isRecord(result.contents) && typeof result.contents.value === 'string') {
    content = result.contents.value;
  }

  if (result.range) {
    const line = result.range.start.line + 1;
    const char = result.range.start.character + 1;
    content = `Hover info at ${line}:${char}:\n\n${content}`;
  }

  return {
    formatted: content,
    resultCount: 1,
    fileCount: 1,
  };
}

function formatDocumentSymbolResult(result: unknown): {
  formatted: string;
  resultCount: number;
  fileCount: number;
} {
  const symbols = asArray(result).filter(isDocumentSymbolLike);

  if (symbols.length === 0) {
    return {
      formatted: 'No symbols found in document.',
      resultCount: 0,
      fileCount: 0,
    };
  }

  const count = countSymbols(symbols);
  const lines = [`Found ${count} symbol${count === 1 ? '' : 's'} in document:`];

  for (const symbol of symbols) {
    const kind = symbolKindToString(symbol.kind);
    const line = getSymbolLine(symbol);
    let text = `  ${symbol.name} (${kind}) - Line ${line}`;

    if (typeof symbol.containerName === 'string') {
      text += ` in ${symbol.containerName}`;
    }

    lines.push(text);
  }

  return {
    formatted: lines.join('\n'),
    resultCount: count,
    fileCount: 1,
  };
}

function formatWorkspaceSymbolResult(
  result: unknown,
  workingDir: string,
): { formatted: string; resultCount: number; fileCount: number } {
  const workspaceSymbols = asArray(result);

  if (workspaceSymbols.length === 0) {
    return {
      formatted: 'No symbols found in workspace.',
      resultCount: 0,
      fileCount: 0,
    };
  }

  const symbols = workspaceSymbols.filter(isWorkspaceSymbolWithLocation);

  if (symbols.length === 0) {
    return {
      formatted: 'No symbols found in workspace.',
      resultCount: 0,
      fileCount: 0,
    };
  }

  const grouped = new Map<string, WorkspaceSymbolShape[]>();

  for (const sym of symbols) {
    const filePath = uriToPath(sym.location.uri, workingDir);
    if (!grouped.has(filePath)) {
      grouped.set(filePath, []);
    }
    const fileSymbols = grouped.get(filePath);
    if (fileSymbols) {
      fileSymbols.push(sym);
    }
  }

  const lines = [`Found ${symbols.length} symbol${symbols.length === 1 ? '' : 's'} in workspace:`];

  for (const [file, syms] of grouped) {
    lines.push(`\n${file}:`);
    for (const sym of syms) {
      const kind = symbolKindToString(sym.kind);
      const line = sym.location.range.start.line + 1;
      let text = `  ${sym.name} (${kind}) - Line ${line}`;

      if (typeof sym.containerName === 'string') {
        text += ` in ${sym.containerName}`;
      }

      lines.push(text);
    }
  }

  return {
    formatted: lines.join('\n'),
    resultCount: symbols.length,
    fileCount: grouped.size,
  };
}

function formatCallHierarchyResult(
  result: unknown,
  workingDir: string,
): { formatted: string; resultCount: number; fileCount: number } {
  const items = asArray(result).filter(isCallHierarchyItem);

  if (items.length === 0) {
    return {
      formatted: 'No call hierarchy item found at this position',
      resultCount: 0,
      fileCount: 0,
    };
  }

  if (items.length === 1) {
    const item = items[0];
    const filePath = uriToPath(item.uri, workingDir);
    const kind = symbolKindToString(item.kind);
    const line = item.range.start.line + 1;

    return {
      formatted: `Call hierarchy item: ${item.name} (${kind}) - ${filePath}:${line}`,
      resultCount: 1,
      fileCount: 1,
    };
  }

  const lines = [`Found ${items.length} call hierarchy items:`];
  for (const item of items) {
    const filePath = uriToPath(item.uri, workingDir);
    const kind = symbolKindToString(item.kind);
    const line = item.range.start.line + 1;
    lines.push(`  ${item.name} (${kind}) - ${filePath}:${line}`);
  }

  return {
    formatted: lines.join('\n'),
    resultCount: items.length,
    fileCount: new Set(items.map((i) => i.uri).filter(Boolean)).size,
  };
}

function formatCallsResult(
  operation: LSPOperation,
  result: unknown,
  workingDir: string,
): { formatted: string; resultCount: number; fileCount: number } {
  const calls = asArray(result);

  if (calls.length === 0) {
    const type = operation === 'incomingCalls' ? 'incoming' : 'outgoing';
    return {
      formatted: `No ${type} calls found`,
      resultCount: 0,
      fileCount: 0,
    };
  }

  const isIncoming = operation === 'incomingCalls';
  const callItem = isIncoming ? 'from' : 'to';

  const validCalls = calls.filter((call): call is CallHierarchyCallShape =>
    isCallHierarchyCall(call, callItem),
  );

  if (validCalls.length === 0) {
    const type = operation === 'incomingCalls' ? 'incoming' : 'outgoing';
    return {
      formatted: `No ${type} calls found`,
      resultCount: 0,
      fileCount: 0,
    };
  }

  const label = isIncoming ? 'caller' : 'callee';
  const lines = [`Found ${validCalls.length} ${label}${validCalls.length === 1 ? '' : 's'}:`];

  const grouped = new Map<string, CallHierarchyCallShape[]>();

  for (const call of validCalls) {
    const item = getCallItem(call, callItem);
    const filePath = uriToPath(item.uri, workingDir);
    if (!grouped.has(filePath)) {
      grouped.set(filePath, []);
    }
    const fileCalls = grouped.get(filePath);
    if (fileCalls) {
      fileCalls.push(call);
    }
  }

  for (const [file, fileCalls] of grouped) {
    lines.push(`\n${file}:`);
    for (const call of fileCalls) {
      const item = getCallItem(call, callItem);
      const kind = symbolKindToString(item.kind);
      const line = item.range.start.line + 1;
      lines.push(`  ${item.name} (${kind}) - Line ${line}`);
    }
  }

  return {
    formatted: lines.join('\n'),
    resultCount: validCalls.length,
    fileCount: grouped.size,
  };
}

// ============================================================================
// Utility Functions (内联自 legacy)
// ============================================================================

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPosition(value: unknown): value is LspPosition {
  return (
    isRecord(value) &&
    typeof value.line === 'number' &&
    typeof value.character === 'number'
  );
}

function isRange(value: unknown): value is LspRange {
  return isRecord(value) && isPosition(value.start);
}

function isLocation(value: unknown): value is LocationShape {
  return isRecord(value) && typeof value.uri === 'string' && isRange(value.range);
}

function isLocationLink(value: unknown): value is LocationLinkShape {
  if (!isRecord(value) || typeof value.targetUri !== 'string') {
    return false;
  }
  return isRange(value.targetSelectionRange) || isRange(value.targetRange);
}

function isLocationContainer(value: unknown): value is LocationContainerShape {
  return isRecord(value) && isLocation(value.location);
}

function isValidLocation(loc: unknown): loc is LocationLike {
  return isLocation(loc) || isLocationLink(loc) || isLocationContainer(loc);
}

function normalizeLocation(loc: LocationLike): NormalizedLocation {
  if (isLocationLink(loc)) {
    const range = loc.targetSelectionRange ?? loc.targetRange;
    if (!range) {
      throw new Error('LocationLink missing target range');
    }
    return {
      uri: loc.targetUri,
      range,
    };
  }
  if (isLocationContainer(loc)) {
    return {
      uri: loc.location.uri,
      range: loc.location.range,
    };
  }
  return {
    uri: loc.uri,
    range: loc.range,
  };
}

function formatLocationString(loc: NormalizedLocation, workingDir: string): string {
  const filePath = uriToPath(loc.uri, workingDir);
  const line = loc.range.start.line + 1;
  const char = loc.range.start.character + 1;
  return `${filePath}:${line}:${char}`;
}

function groupByFile(
  locations: NormalizedLocation[],
  workingDir: string,
): Map<string, NormalizedLocation[]> {
  const grouped = new Map<string, NormalizedLocation[]>();

  for (const loc of locations) {
    const filePath = uriToPath(loc.uri, workingDir);

    if (!grouped.has(filePath)) {
      grouped.set(filePath, []);
    }

    const fileLocations = grouped.get(filePath);
    if (fileLocations) {
      fileLocations.push(loc);
    }
  }

  return grouped;
}

function uriToPath(uri: string, workingDir?: string): string {
  let decoded = uri.replace(/^file:\/\//, '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Use undecoded path
  }

  if (workingDir) {
    const relativePath = path.relative(workingDir, decoded);
    return relativePath.startsWith('..') ? decoded : relativePath;
  }

  return decoded;
}

function hasNamedKind(
  value: unknown,
): value is Record<string, unknown> & { name: string; kind: number } {
  return isRecord(value) && typeof value.name === 'string' && typeof value.kind === 'number';
}

function isDocumentSymbolLike(value: unknown): value is SymbolShape {
  if (!isRecord(value) || !hasNamedKind(value)) {
    return false;
  }
  return isRange(value.range) || (isRecord(value.location) && isLocation(value.location));
}

function isWorkspaceSymbolWithLocation(value: unknown): value is WorkspaceSymbolShape {
  return (
    isRecord(value) &&
    hasNamedKind(value) &&
    isRecord(value.location) &&
    isLocation(value.location)
  );
}

function isCallHierarchyItem(value: unknown): value is CallHierarchyItemShape {
  return (
    isRecord(value) &&
    hasNamedKind(value) &&
    typeof value.uri === 'string' &&
    isRange(value.range)
  );
}

function isCallHierarchyCall(value: unknown, itemKey: 'from' | 'to'): value is CallHierarchyCallShape {
  return isRecord(value) && isCallHierarchyItem(value[itemKey]);
}

function isHover(value: unknown): value is HoverShape {
  return isRecord(value) && 'contents' in value;
}

function markedStringToText(content: MarkedStringShape): string {
  return typeof content === 'string' ? content : content.value;
}

function getSymbolLine(symbol: SymbolShape): number | '?' {
  const line = symbol.range?.start.line ?? symbol.location?.range.start.line;
  return typeof line === 'number' ? line + 1 : '?';
}

function getCallItem(call: CallHierarchyCallShape, itemKey: 'from' | 'to'): CallHierarchyItemShape {
  return itemKey === 'from' && 'from' in call ? call.from : (call as { to: CallHierarchyItemShape }).to;
}

function countSymbols(symbols: SymbolShape[]): number {
  let count = symbols.length;

  for (const sym of symbols) {
    const children = 'children' in sym ? sym.children?.filter(isDocumentSymbolLike) : undefined;
    if (children && children.length > 0) {
      count += countSymbols(children);
    }
  }

  return count;
}

function symbolKindToString(kind: number): string {
  const kinds: Record<number, string> = {
    1: 'File',
    2: 'Module',
    3: 'Namespace',
    4: 'Package',
    5: 'Class',
    6: 'Method',
    7: 'Property',
    8: 'Field',
    9: 'Constructor',
    10: 'Enum',
    11: 'Interface',
    12: 'Function',
    13: 'Variable',
    14: 'Constant',
    15: 'String',
    16: 'Number',
    17: 'Boolean',
    18: 'Array',
    19: 'Object',
    20: 'Key',
    21: 'Null',
    22: 'EnumMember',
    23: 'Struct',
    24: 'Event',
    25: 'Operator',
    26: 'TypeParameter',
  };

  return kinds[kind] || 'Unknown';
}
