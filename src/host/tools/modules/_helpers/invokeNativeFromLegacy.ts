// ============================================================================
// invokeNativeFromLegacy
//
// Tier C legacy wrappers (WebFetchUnified / PdfAutomate / ExcelAutomate) need
// to delegate to native ToolModules (http_request / read_pdf / read_xlsx).
// This helper builds a minimal ProtocolToolContext and adapts the native
// ToolResult back to legacy ToolExecutionResult shape — single source of truth
// instead of one shim per call site.
//
// Permission gate is intentionally allow-all: the parent legacy tool has
// already been permissioned by its own middleware, so the child call is an
// internal delegation, not a fresh user request.
// ============================================================================

import type { ToolContext, ToolExecutionResult } from '../../types';
import type {
  ToolContext as ProtocolToolContext,
  ToolResult as ProtocolToolResult,
  CanUseToolFn,
} from '../../../protocol/tools';

type NativeExecuteFn = (
  params: Record<string, unknown>,
  ctx: ProtocolToolContext,
  canUseTool: CanUseToolFn,
) => Promise<ProtocolToolResult<string>>;

export async function invokeNativeFromLegacy(
  executeFn: NativeExecuteFn,
  params: Record<string, unknown>,
  legacyCtx: ToolContext,
  sessionIdTag: string,
): Promise<ToolExecutionResult> {
  const protocolCtx: ProtocolToolContext = {
    sessionId: sessionIdTag,
    workingDir: legacyCtx.workingDirectory,
    abortSignal: new AbortController().signal,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    emit: () => {},
  };

  const result = await executeFn(params, protocolCtx, async () => ({ allow: true }));

  if (result.ok) {
    return { success: true, output: result.output, metadata: result.meta };
  }
  return { success: false, error: result.error, metadata: result.meta };
}
